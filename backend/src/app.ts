import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createAuthRouter } from './auth/router.js';
import { createListRouter } from './gift-lists/router.js';
import { createItemRouter } from './gift-items/router.js';
import { validateConfig } from './config/index.js';
import { errorHandler } from './common/errors.js';

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    console.log(`[${level}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
}

function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

export async function createApp(): Promise<Express> {
  validateConfig();

  const app = express();

  // CORS: restrict to configured origins in production; allow all in development.
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim());
  app.use(cors(corsOrigins ? { origin: corsOrigins } : {}));

  app.use(securityHeaders);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  app.use('/auth', createAuthRouter());
  app.use('/lists', createListRouter());
  app.use('/', createItemRouter());

  // 404 handler for unmatched routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ message: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}
