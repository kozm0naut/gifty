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
import { issueToken } from '../email/verification.js';
import { enqueueConfirmation } from '../email/outbox.js';
import { buildConfirmationLink } from '../email/links.js';

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

export function clearAccessCookie(): string {
  return serializeCookie(loadConfig().cookies.accessName, '', '/', 0);
}

export function clearRefreshCookie(): string {
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

      // Feature 004 (US2, FR-003): issue a confirmation email for the new
      // account — UNLESS the email feature is disabled, in which case the
      // account auto-confirms (FR-016) and no email is sent.
      //
      // T017 (FR-006 / lesson from T014): the user row already committed in
      // autocommit (single statement), so the token + enqueue are SEPARATE
      // best-effort writes on the base client — deliberately NOT in a
      // transaction. A failure here only means "no confirmation email yet";
      // the account still exists and can confirm via resend.
      const emailEnabled = loadConfig().email.mode !== 'disabled';
      if (emailEnabled) {
        try {
          const token = await issueToken(user.id);
          const link = buildConfirmationLink(token);
          const subject = 'Confirm your email address';
          const bodyText =
            `Hi ${user.displayName},\n\n` +
            `Thanks for signing up. Please confirm your email address by opening this link:\n` +
            `${link}\n\n` +
            `If you did not create a Gifty account, you can ignore this email.\n`;
          const confirmation = await enqueueConfirmation(prisma, {
            userId: user.id,
            recipientEmail: normalizedEmail,
            subject,
            bodyText,
          });
          void recordAuditEvent({
            actorUserId: user.id,
            action: 'email_confirmation_queued',
            targetType: 'emailOutbox',
            targetId: confirmation.outboxMessageId,
            outcome: 'success',
            ip,
          });
        } catch (err) {
          // FR-006: registration must not fail because of email.
          console.error(
            `[auth/register] confirmation enqueue failed (user=${user.id}, email=${normalizedEmail}):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        // Disabled mode: auto-confirm the account (FR-016).
        await prisma.user.update({
          where: { id: user.id },
          data: { verifiedAt: new Date() },
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
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          // Feature 004 (US2): false when a confirmation email is required
          // (email enabled); true when disabled (account auto-confirmed).
          verified: !emailEnabled,
        },
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
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          // Feature 004 (US2): the client routes an unconfirmed account to the
          // confirm page right after sign-in.
          verified: user.verifiedAt != null,
        },
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

  // Feature 004 (US2, FR-014): re-issue the confirmation email for an
  // unconfirmed account that holds a live session.
  //   - 401 — no live session (the credential is the `gifty_access` cookie).
  //   - 403 — the account is already confirmed (nothing to resend).
  //   - 429 — the per-account resend budget (default 3 / window) is exhausted.
  //   - 202 — a new confirmation email was enqueued; the new token supersedes
  //     the old (issueToken overwrites the stored hash, invalidating the prior
  //     link).
  router.post('/resend-confirmation', async (req, res, next) => {
    try {
      const cookies = parseCookie(req.headers.cookie ?? '');
      const accessToken = cookies[loadConfig().cookies.accessName];
      if (!accessToken) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      const payload = jwt.verify(accessToken, getJwtSecret()) as { sub?: string; sid?: string };
      const userId = typeof payload.sub === 'string' ? payload.sub : null;
      if (!userId) {
        return res.status(401).json({ message: 'Invalid or expired token' });
      }
      // Require a live session row (reject revoked/expired sessions).
      if (typeof payload.sid === 'string') {
        const resolved = await resolveSessionForAccess(accessToken);
        if (!resolved || resolved.userId !== userId) {
          return res.status(401).json({ message: 'Your account is no longer active.' });
        }
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true, verifiedAt: true },
      });
      if (!user) {
        return res.status(401).json({ message: 'Your account is no longer active.' });
      }

      // Already confirmed → nothing to resend.
      if (user.verifiedAt != null) {
        return res.status(403).json({ message: 'Your email is already confirmed.' });
      }

      // Per-account resend budget (FR-014). Counted on every successful send
      // so a legitimate user is still capped at a few per window.
      const ip = clientIp(req);
      if (isRateLimited('resend-confirmation', userId)) {
        res.set('Retry-After', String(retryAfterSeconds()));
        void recordAuditEvent({
          actorUserId: userId,
          action: 'auth_rate_limited',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: { endpoint: 'resend-confirmation' },
        });
        return res.status(429).json({
          message: 'Too many confirmation requests. Please wait a moment and try again.',
        });
      }
      recordFailure('resend-confirmation', userId);

      // Re-issue (supersedes) + enqueue as a separate best-effort write (FR-006).
      try {
        const token = await issueToken(userId);
        const link = buildConfirmationLink(token);
        const subject = 'Confirm your email address';
        const bodyText =
          `Hi ${user.displayName},\n\n` +
          `You asked to confirm your email address. Open this link to finish:\n` +
          `${link}\n\n` +
          `If you did not create a Gifty account, you can ignore this email.\n`;
        const confirmation = await enqueueConfirmation(prisma, {
          userId,
          recipientEmail: user.email,
          subject,
          bodyText,
        });
        void recordAuditEvent({
          actorUserId: userId,
          action: 'email_confirmation_queued',
          targetType: 'emailOutbox',
          targetId: confirmation.outboxMessageId,
          outcome: 'success',
          ip,
        });
      } catch (err) {
        console.error(
          `[auth/resend-confirmation] enqueue failed (user=${userId}, email=${user.email}):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      return res.status(202).json({ message: 'A new confirmation email is on its way.' });
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
