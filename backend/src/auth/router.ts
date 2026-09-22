import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';

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

      const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET || 'development-secret', {
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

      const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET || 'development-secret', {
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

  return router;
}
