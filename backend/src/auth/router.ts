import { Router } from 'express';
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

export function createAuthRouter() {
  const router = Router();

  router.post('/register', async (req, res, next) => {
    try {
      const { email, password, displayName } = req.body ?? {};

      if (!email || !password || !displayName) {
        return res.status(400).json({ message: 'Email, password, and displayName are required' });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) {
        return res.status(409).json({ message: 'A user with this email already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: {
          id: makeId('user'),
          email: normalizedEmail,
          passwordHash,
          displayName: String(displayName),
        },
      });

      const token = jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), {
        expiresIn: '7d',
      });

      return res.status(201).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
        token,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      const normalizedEmail = String(email ?? '').trim().toLowerCase();
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (!user) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      const validPassword = await bcrypt.compare(String(password ?? ''), user.passwordHash);
      if (!validPassword) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      const token = jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), {
        expiresIn: '7d',
      });

      return res.status(200).json({
        token,
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
