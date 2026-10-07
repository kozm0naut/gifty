import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { parseCookie } from 'cookie';
import { prisma } from '../prisma.js';
import { loadConfig } from '../config/index.js';
import { resolveSessionForAccess } from './session.js';

export type AuthenticatedRequest = Request & {
  user?: { id: string; email: string; displayName: string; verifiedAt: Date | null };
};

/**
 * Feature 004 (US2, 004 FR-012): gate authenticated routes on a confirmed email.
 *
 * Composed AFTER `requireAuth` (which populates `req.user`). The gate is a
 * no-op when the email feature is `disabled` (accounts auto-confirm), so a
 * single code path serves both modes. An unconfirmed caller (verifiedAt null)
 * receives a STABLE 403 body on every gated route — the message never varies
 * by route, so the surface does not reveal which endpoints exist (004 FR-010).
 */
export function requireConfirmed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (loadConfig().email.mode === 'disabled') {
    return next();
  }
  if (req.user?.verifiedAt != null) {
    return next();
  }
  return res.status(403).json({ message: 'Please confirm your email to continue.' });
}

/**
 * Returns the JWT signing secret, failing fast when it is not configured.
 * There is deliberately NO default/fallback secret (Constitution §IV):
 * production backstopped by `validateConfig()`, tests set `JWT_SECRET` explicitly.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // Feature 003 (US4 / T012 / T017 / 003 SC-007): the `Authorization: Bearer`
  // header and the legacy `token` bridge are formally RETIRED. The access
  // credential is now exclusively the script-unreadable `gifty_access`
  // HttpOnly cookie (contracts/api.md, 003 FR-009).
  const cookieToken = parseCookie(req.headers.cookie ?? '')[loadConfig().cookies.accessName];

  if (!cookieToken) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(cookieToken, getJwtSecret()) as { sub?: string; email?: string; sid?: string };
    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    if (!userId) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // Cookie-backed access JWTs carry the `sid` claim — confirm the
    // UserSession row is live, rejecting revoked/expired sessions even before
    // the token's own `exp` (003 FR-008).
    if (typeof payload.sid === 'string') {
      const resolved = await resolveSessionForAccess(cookieToken);
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

    req.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      verifiedAt: user.verifiedAt,
    };
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

import { hasListPermission, type RequiredPermission } from '../permissions/access.js';

export function authorizeList(requiredPermission: RequiredPermission) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const listId = req.params.listId;
    if (!listId) {
      return res.status(400).json({ message: 'listId is required' });
    }

    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const authorized = await hasListPermission(req.user.id, listId, requiredPermission);
    if (!authorized) {
      return res.status(403).json({ message: 'You do not have access to this list' });
    }

    next();
  };
}

export function authorizeItem(requiredPermission: RequiredPermission) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const itemId = req.params.itemId;
    if (!itemId) {
      return res.status(400).json({ message: 'itemId is required' });
    }

    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { hasItemPermission } = await import('../permissions/access.js');
    const authorized = await hasItemPermission(req.user.id, itemId, requiredPermission);
    if (!authorized) {
      // Action-specific message so the caller can understand the rule (e.g.
      // the list owner is denied the 'claim' action because only shared
      // recipients act on items — see specs/.../contracts/gift-list-api.md).
      const message =
        requiredPermission === 'claim'
          ? 'Only shared recipients can claim items'
          : 'Insufficient permissions for this item';
      return res.status(403).json({ message });
    }

    next();
  };
}
