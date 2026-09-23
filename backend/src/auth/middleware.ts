import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma.js';

export type AuthenticatedRequest = Request & {
  user?: { id: string; email: string };
};

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
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { sub: string; email: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) {
      return res.status(401).json({ message: 'Your account is no longer active.' });
    }

    req.user = { id: user.id, email: user.email };
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
