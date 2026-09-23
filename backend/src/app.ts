import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  // Readiness/liveness signal (FR-013): 200 when the API process is up.
  // Registered before any static/SPA fallback so it always takes precedence.
  app.get('/healthz', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/auth', createAuthRouter());
  app.use('/lists', createListRouter());
  app.use('/', createItemRouter());

  // Production static serving (research D2/D12): when running with
  // NODE_ENV=production and a frontend build is present, serve the SPA
  // same-origin with the API. In development the Vite dev server serves the
  // SPA, so none of this is mounted and the dev flow is unaffected.
  if (process.env.NODE_ENV === 'production') {
    // This file compiles to backend/dist/src/app.js, so the frontend build
    // lives two levels up at backend/dist/../frontend/dist = <repo>/frontend/dist.
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.resolve(currentDir, '../../frontend/dist');
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
      app.use(express.static(distDir));
      // SPA fallback: non-API GET routes that no static file matched resolve
      // to index.html so React Router deep links survive a hard refresh.
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  // 404 handler for unmatched routes (non-GET API paths, unknown assets, dev)
  app.use((req: Request, res: Response) => {
    res.status(404).json({ message: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}
