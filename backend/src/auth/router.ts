import { Router } from 'express';
import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { parseCookie, stringifySetCookie } from 'cookie';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';
import { getJwtSecret } from './middleware.js';
import { loadConfig } from '../config/index.js';
import {
  createSession,
  rotateSession,
  revokeSession,
  resolveSessionForAccess,
} from './session.js';
import { recordAuditEvent } from '../audit/events.js';
import { validatePasswordPolicy } from './password-policy.js';
import {
  isRateLimited,
  recordFailure,
  retryAfterSeconds,
  clientIp,
} from './rate-limit.js';

/**
 * Serialize a Set-Cookie header per the feature 003 contract:
 *   gifty_access  — HttpOnly; Secure (production); SameSite=Lax; Path=/
 *   gifty_refresh — HttpOnly; Secure (production); SameSite=Lax; Path=/auth/refresh
 */
function serializeCookie(
  name: string,
  value: string,
  path: string,
  maxAgeSeconds?: number,
): string {
  const { cookies } = loadConfig();
  const attrs: Record<string, string | boolean | number> = {
    path,
    httpOnly: true,
    sameSite: 'lax',
  };
  if (cookies.secure) attrs.secure = true;
  if (maxAgeSeconds !== undefined) attrs.maxAge = maxAgeSeconds;
  return stringifySetCookie({ name, value, ...attrs });
}

function clearAccessCookie(): string {
  return serializeCookie(loadConfig().cookies.accessName, '', '/', 0);
}

function clearRefreshCookie(): string {
  return serializeCookie(loadConfig().cookies.refreshName, '', '/auth/refresh', 0);
}

/**
 * Precomputed bcrypt hash used ONLY to equalize response timing between an
 * unknown email and a wrong password (FR-020 constant-time guard). The value
 * is never a real credential; it exists so both sign-in failure paths perform
 * exactly one bcrypt.compare and thus land in the same timing class.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'gifty-timing-equalizer-not-a-real-password',
  10,
);

/** Prisma unique-constraint violation (P2002) — the concurrent registration race. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Issue the HttpOnly cookie pair for a live session (T017). */
function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  const { cookies } = loadConfig();
  res.set('Set-Cookie', [
    serializeCookie(cookies.accessName, accessToken, '/'),
    serializeCookie(cookies.refreshName, refreshToken, '/auth/refresh'),
  ]);
}

export function createAuthRouter() {
  const router = Router();

  router.post('/register', async (req, res, next) => {
    try {
      const { email, password, displayName } = req.body ?? {};

      if (!email || !password || !displayName) {
        return res.status(400).json({ message: 'Email, password, and displayName are required' });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const ip = clientIp(req);

      // Throttle per-source registration failures FIRST (FR-001). The 429 body
      // mirrors the stable 409 "already exists" signal so a rate-limited source
      // cannot distinguish "throttled" from "email taken" (FR-020 / SC-002).
      if (isRateLimited('register-source', ip)) {
        res.set('Retry-After', String(retryAfterSeconds()));
        void recordAuditEvent({
          action: 'auth_rate_limited',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: { endpoint: 'register' },
        });
        return res.status(429).json({ message: 'A user with this email already exists' });
      }

      // Password policy (FR-002): reject weak passwords with the stable message.
      const policy = validatePasswordPolicy(String(password));
      if (!policy.ok) {
        void recordAuditEvent({
          action: 'auth_register_failure',
          outcome: 'denied',
          ip,
          targetType: 'auth',
          detail: { reason: 'weak_password' },
        });
        return res.status(400).json({ message: policy.message });
      }

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        recordFailure('register-source', ip);
        void recordAuditEvent({
          action: 'auth_register_failure',
          outcome: 'denied',
          ip,
          targetType: 'auth',
          detail: { reason: 'email_exists' },
        });
        return res.status(409).json({ message: 'A user with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      let user;
      try {
        user = await prisma.user.create({
          data: {
            id: makeId('user'),
            email: normalizedEmail,
            passwordHash,
            displayName: String(displayName),
          },
        });
      } catch (err) {
        // Concurrent registration of the same email (FR-020 edge case): exactly
        // one account wins; the loser gets the clean "already exists" signal.
        if (isUniqueViolation(err)) {
          recordFailure('register-source', ip);
          void recordAuditEvent({
            action: 'auth_register_failure',
            outcome: 'denied',
            ip,
            targetType: 'auth',
            detail: { reason: 'email_exists' },
          });
          return res.status(409).json({ message: 'A user with this email already exists' });
        }
        throw err;
      }

      // Feature 003 (US5, FR-011 / SC-009): convert any pending
      // invitations addressed to this email into SharePermissions, in the
      // SAME transaction as the account creation (transactional — a failure
      // rolls back the user too). Consent starts at `pending` (FR-021): the
      // new user must make the name-disclosure choice themselves.
      const invitations = await prisma.pendingInvitation.findMany({
        where: { inviteeEmail: normalizedEmail, status: 'pending' },
      });
      if (invitations.length > 0) {
        await prisma.$transaction([
          ...invitations.map((inv) =>
            prisma.sharePermission.create({
              data: {
                id: makeId('share'),
                giftListId: inv.giftListId,
                ownerUserId: inv.ownerUserId,
                recipientUserId: user.id,
                permission: 'shared',
                nameDisclosureConsent: 'pending',
                recipientEmail: normalizedEmail,
              },
            }),
          ),
          ...invitations.map((inv) =>
            prisma.pendingInvitation.update({
              where: { id: inv.id },
              data: { status: 'matched' },
            }),
          ),
        ]);
        void recordAuditEvent({
          actorUserId: user.id,
          action: 'invitation_matched',
          outcome: 'success',
          ip,
          targetType: 'auth',
          detail: { matchedCount: invitations.length },
        });
      }

      // Success: open a session and issue the HttpOnly cookie pair (T017).
      // The legacy `token` bridge field is formally retired in US4 — the
      // credential is now exclusively the `gifty_access` cookie.
      const { accessToken, refreshToken } = await createSession(user.id);
      void recordAuditEvent({
        actorUserId: user.id,
        action: 'auth_register_success',
        outcome: 'success',
        ip,
        targetType: 'auth',
      });
      setSessionCookies(res, accessToken, refreshToken);

      return res.status(201).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      const normalizedEmail = String(email ?? '').trim().toLowerCase();
      const ip = clientIp(req);

      // Throttle sign-in on BOTH dimensions (FR-001): per-source (client IP)
      // and per-account (email — defeats source-IP rotation). A 429 body is
      // indistinguishable from a failed sign-in (FR-020 / SC-002).
      if (
        isRateLimited('login-source', ip) ||
        (normalizedEmail && isRateLimited('login-account', normalizedEmail))
      ) {
        res.set('Retry-After', String(retryAfterSeconds()));
        void recordAuditEvent({
          action: 'auth_rate_limited',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: { endpoint: 'login' },
        });
        return res.status(429).json({ message: 'Invalid email or password' });
      }

      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      // FR-020 constant-time guard: always perform exactly one bcrypt.compare,
      // against a dummy hash when the account does not exist, so an unknown
      // email and a wrong password land in the same timing class.
      const hashToCheck = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const passwordOk = await bcrypt.compare(String(password ?? ''), hashToCheck);

      if (!user || !passwordOk) {
        recordFailure('login-source', ip);
        if (normalizedEmail) recordFailure('login-account', normalizedEmail);
        void recordAuditEvent({
          actorUserId: user?.id ?? null,
          action: 'auth_login_failure',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: { email: normalizedEmail },
        });
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      // Success: open a session and issue the HttpOnly cookie pair (T017).
      // The legacy `token` bridge field is formally retired in US4 — the
      // credential is now exclusively the `gifty_access` cookie.
      const { accessToken, refreshToken } = await createSession(user.id);
      void recordAuditEvent({
        actorUserId: user.id,
        action: 'auth_login_success',
        outcome: 'success',
        ip,
        targetType: 'auth',
      });
      setSessionCookies(res, accessToken, refreshToken);

      return res.status(200).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      const cookieHeader = req.headers.cookie;
      const cookies = parseCookie(cookieHeader ?? '');
      const refreshToken = cookies[loadConfig().cookies.refreshName];

      if (!refreshToken) {
        res.status(401).json({ error: 'Session is no longer active.', reason: 'revoked' });
        return;
      }

      const result = await rotateSession(refreshToken);
      const ip = (req.socket.remoteAddress ?? null) as string | null;

      if (!result.ok) {
        // Audit the theft/expiry signal (FR-026) without exposing the token.
        void recordAuditEvent({
          actorUserId: null,
          action: result.reason === 'stale_refresh' ? 'session_reuse_detected' : 'session_revoked',
          targetType: 'session',
          targetId: null,
          outcome: 'failure',
          ip,
          detail: { reason: result.reason },
        });

        res.set('Set-Cookie', [clearAccessCookie(), clearRefreshCookie()]);
        res.status(401).json({
          error: 'Session is no longer active.',
          reason: result.reason,
        });
        return;
      }

      const { sessionId, user, newRefreshToken } = result;
      const accessToken = jwt.sign(
        { sub: user.id, sid: sessionId },
        getJwtSecret(),
        { expiresIn: loadConfig().session.accessTtlSeconds },
      );

      res.set('Set-Cookie', [
        serializeCookie(loadConfig().cookies.accessName, accessToken, '/'),
        serializeCookie(loadConfig().cookies.refreshName, newRefreshToken, '/auth/refresh'),
      ]);
      res.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const cookies = parseCookie(req.headers.cookie ?? '');
      const accessToken = cookies[loadConfig().cookies.accessName];
      const resolved = await resolveSessionForAccess(accessToken);

      if (!resolved) {
        res.set('Set-Cookie', [clearAccessCookie(), clearRefreshCookie()]);
        res.status(401).json({ error: 'Session is no longer active.' });
        return;
      }

      await revokeSession(resolved.sessionId);
      void recordAuditEvent({
        actorUserId: resolved.userId,
        action: 'session_revoked',
        targetType: 'session',
        targetId: resolved.sessionId,
        outcome: 'success',
        ip: (req.socket.remoteAddress ?? null) as string | null,
      });

      res.set('Set-Cookie', [clearAccessCookie(), clearRefreshCookie()]);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
