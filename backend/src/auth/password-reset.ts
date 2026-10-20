/**
 * Password reset (feature 005, US1) — T011 / T012.
 *
 * Two unauthenticated endpoints mounted under `/auth`:
 *   - `POST /auth/reset-request` — issue a single-use reset link for an email
 *     (005 FR-001, FR-002). Every outcome returns the SAME uniform body `U`
 *     so the endpoint never reveals whether the email is registered
 *     (005 FR-002, 005 SC-002). The raw token is only ever embedded in the
 *     outbox link; it is never returned to the client nor logged (005 FR-006).
 *   - `POST /auth/reset` — consume a reset link to rewrite the password
 *     (005 FR-003, FR-004, FR-005, FR-008, FR-012, FR-013, FR-014).
 *
 * Token mechanics (005 FR-004/FR-005, research D4): a 256-bit opaque
 * `base64url` token; only its SHA-256 digest is persisted
 * (`PasswordResetToken.tokenHash`); single-use + bounded validity are enforced
 * by ONE atomic `updateMany` (where `tokenHash` AND `consumedAt IS NULL` AND
 * `expiresAt >= now`) so a replay / expired / unknown token all collapse to the
 * uniform `400 I` body with no state change.
 */
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../prisma.js';
import { loadConfig } from '../config/index.js';
import { clientIp, isRateLimited, recordFailure, retryAfterSeconds } from './rate-limit.js';
import { DUMMY_PASSWORD_HASH, setSessionCookies } from './router.js';
import { createSession } from './session.js';
import {
  PASSWORD_POLICY_MESSAGE,
  validatePasswordPolicy,
} from './password-policy.js';
import { recordAuditEvent } from '../audit/events.js';
import { enqueueReset } from '../email/outbox.js';
import { buildResetLink } from '../email/links.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Pinned uniform reset-request body (contracts/api.md, 005 FR-002). */
const U_BODY = { message: 'Please check your email for the password reset link' };

/** Pinned invalid-link body (contracts/api.md, 005 FR-004). */
const I_BODY = { message: 'This reset link is invalid or has expired.' };

export function createPasswordResetRouter(): Router {
  const router = Router();

  // POST /auth/reset-request — 005 FR-001 / FR-002 / FR-006 / FR-009.
  // Uniform 200 `U` for every input (registered, unregistered, malformed,
  // missing, disabled mode). A reset token + outbox row are produced ONLY when
  // the email maps to a real account AND email is enabled; the no-match path
  // burns one bcrypt.compare against a dummy hash so registration state is not
  // leakable by timing (005 FR-002).
  router.post('/reset-request', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = clientIp(req);
      const normalizedEmail = String((req.body ?? {}).email ?? '').trim().toLowerCase();
      const emailEnabled = loadConfig().email.mode !== 'disabled';

      // 005 FR-007: throttle reset requests on BOTH dimensions (per-source client
      // IP and per-account normalized email) so neither source rotation nor a
      // single account can flood the endpoint. Each request MAY issue a link, so
      // the budget is counted on EVERY request, not just failures. The 429 body
      // is the same uniform `U` as a normal response so a throttled caller cannot
      // distinguish "throttled" from "requested" (005 FR-002 / 005 SC-002).
      if (
        isRateLimited('reset-source', ip) ||
        (normalizedEmail && isRateLimited('reset-account', normalizedEmail))
      ) {
        res.set('Retry-After', String(retryAfterSeconds()));
        void recordAuditEvent({
          actorUserId: null,
          action: 'password_reset_rate_limited',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: { endpoint: 'reset-request' },
        });
        return res.status(429).json(U_BODY);
      }

      // Every non-throttled request erodes BOTH budgets, whether or not the email
      // is registered (005 FR-007).
      recordFailure('reset-source', ip);
      if (normalizedEmail) recordFailure('reset-account', normalizedEmail);

      const user = normalizedEmail
        ? await prisma.user.findUnique({ where: { email: normalizedEmail } })
        : null;

      if (user && emailEnabled) {
        const { reset } = loadConfig();
        const raw = randomBytes(32).toString('base64url');
        const tokenHash = sha256(raw);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + reset.tokenTtlHours * 3_600_000);

        await prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash, expiresAt },
        });

        const link = buildResetLink(raw);
        const subject = 'Reset your Gifty password';
        const bodyText =
          `Hi ${user.displayName},\n\n` +
          `We received a request to reset the password for your Gifty account. ` +
          `Open the link below to choose a new password:\n` +
          `${link}\n\n` +
          `This link expires after ${reset.tokenTtlHours} hours and can only be used once.\n\n` +
          `If you did not request a password reset, you can ignore this email.\n`;

        await enqueueReset(prisma, {
          userId: user.id,
          recipientEmail: normalizedEmail,
          subject,
          bodyText,
        });
      } else if (!user) {
        // 005 FR-002 timing equalization: burn CPU comparable to the registered
        // path so an attacker cannot tell registered from unregistered emails by
        // response time. The result is discarded.
        await bcrypt.compare('gifty-timing-equalizer', DUMMY_PASSWORD_HASH);
      }

      // 005 FR-009: the request is audited. `actorUserId` is null when the
      // email is unknown; the raw token is NEVER placed in `detail` (005 FR-006)
      // — and the audit scrub would strip any credential-like key anyway.
      void recordAuditEvent({
        actorUserId: user?.id ?? null,
        action: 'password_reset_requested',
        outcome: 'success',
        ip,
        targetType: 'auth',
        detail: null,
      });

      return res.status(200).json(U_BODY);
    } catch (error) {
      next(error);
    }
  });

  // POST /auth/reset — 005 FR-003 / FR-004 / FR-005 / FR-008 / FR-012 /
  // FR-013 / FR-014. Order is mandated (005 FR-003): body shape →
  // mismatch → policy → atomic claim. A policy/mismatch rejection MUST NOT
  // consume the token, so the claim runs only after all validations pass.
  router.post('/reset', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = clientIp(req);
      const body = req.body ?? {};
      const token = String(body.token ?? '');
      const newPassword = String(body.newPassword ?? '');
      const confirmPassword = String(body.confirmPassword ?? '');

      // 1. Shape: a token is required. (FR-004 uniform invalid body.)
      if (!token) {
        return res.status(400).json(I_BODY);
      }

      // 2. Mismatch + 3. policy — both return the SAME stable `P` body and
      // leave the token untouched (005 FR-003 / 005 FR-008).
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: PASSWORD_POLICY_MESSAGE });
      }
      const policy = validatePasswordPolicy(newPassword);
      if (!policy.ok) {
        return res.status(400).json({ message: policy.message ?? PASSWORD_POLICY_MESSAGE });
      }

      // 4. Atomic single-use claim (005 FR-004 / FR-005): exactly one caller can
      // flip `consumedAt`; a replay / expired / unknown token yields count 0 and
      // the uniform `400 I` body with no state change.
      const now = new Date();
      const tokenHash = sha256(token);
      const claimed = await prisma.passwordResetToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gte: now } },
        data: { consumedAt: now },
      });
      if (claimed.count === 0) {
        // 005 FR-009: presenting an invalid-link-class token (unknown, expired,
        // or already consumed) is a security-relevant event — fire the audit
        // BEFORE the uniform `400 I` response. `actorUserId` is intentionally
        // null: the token is invalid, so we neither can nor should identify the
        // account, and doing so would turn the audit trail into a token-probe
        // lookup table (005 FR-002 / FR-006).
        void recordAuditEvent({
          actorUserId: null,
          action: 'password_reset_failed',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: null,
        });
        return res.status(400).json(I_BODY);
      }

      const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
      const userId = row!.userId;
      const before = await prisma.user.findUnique({
        where: { id: userId },
        select: { verifiedAt: true },
      });

      const passwordHash = await bcrypt.hash(newPassword, 10);

      try {
        // 005 FR-008 (rewrite), FR-013 (confirm if unconfirmed), FR-012 (revoke
        // every other session + invalidate sibling pending tokens) — one
        // transaction so a partial failure cannot leave a half-reset account.
        const { revokedSessionCount } = await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: userId },
            data: {
              passwordHash,
              ...(before?.verifiedAt == null ? { verifiedAt: now } : {}),
            },
          });
          const sessions = await tx.userSession.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now },
          });
          await tx.passwordResetToken.updateMany({
            where: { userId, id: { not: row!.id }, consumedAt: null },
            data: { consumedAt: now },
          });
          return { revokedSessionCount: sessions.count };
        });

        // 005 FR-014: a fresh session is issued on the resetting device.
        const session = await createSession(userId);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        setSessionCookies(res, session.accessToken, session.refreshToken);

        void recordAuditEvent({
          actorUserId: userId,
          action: 'password_reset_success',
          outcome: 'success',
          ip,
          targetType: 'auth',
          detail: {
            revokedSessionCount,
            confirmedEmail: before?.verifiedAt == null,
          },
        });

        return res.status(200).json({
          status: 'reset',
          user: {
            id: user!.id,
            email: user!.email,
            displayName: user!.displayName,
            verified: true,
          },
        });
      } catch (err) {
        // The token was already consumed; surface the failure without leaking
        // the cause (005 FR-009).
        void recordAuditEvent({
          actorUserId: userId,
          action: 'password_reset_failed',
          outcome: 'failure',
          ip,
          targetType: 'auth',
          detail: null,
        });
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
