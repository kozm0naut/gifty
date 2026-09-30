import express, { Express, Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuthRouter } from './auth/router.js';
import { createListRouter } from './gift-lists/router.js';
import { createItemRouter } from './gift-items/router.js';
import { requireAuth, type AuthenticatedRequest } from './auth/middleware.js';
import { loadConfig, validateConfig } from './config/index.js';
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

function securityHeaders(config: ReturnType<typeof loadConfig>) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // FR-004: content/scripts/styles confined to self + the permitted font source.
    // The app loads its fonts as a <link rel=stylesheet> from the font origin,
    // so that origin is allowed in both style-src (the stylesheet) and
    // font-src (the woff2 binaries). script-src stays locked to self.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; " +
        `style-src 'self' 'unsafe-inline' ${config.cspFontOrigin}; ` +
        `font-src 'self' ${config.cspFontOrigin}; ` +
        "img-src 'self' data:; connect-src 'self'",
    );
    // FR-012 / US2: HSTS is a production-only directive (edge TLS assumed).
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/**
 * CORS policy (FR-003, research D11):
 *   - production: closed by default — no origin is reflected unless the caller
 *     is in `CORS_ORIGINS`; a listed origin is opened exactly (not to all others),
 *     with `Access-Control-Allow-Credentials: true` (cookies require it).
 *   - development: permissive (reflect the caller origin) so the Vite dev flow
 *     and cross-origin dev tooling keep working.
 */
function corsOptions(config: ReturnType<typeof loadConfig>): CorsOptions {
  if (config.isProduction) {
    if (config.corsOrigins && config.corsOrigins.length > 0) {
      // Allowlist mode (FR-003): reflect only the listed origins, deny all others.
      // The origin callback returns the origin string (not an object) so the
      // cors package's configureOrigin reflects it correctly; `credentials` is
      // a top-level option so configureCredentials emits the header only when
      // cors() actually runs (i.e. the origin was permitted).
      const allowlist = config.corsOrigins;
      return {
        origin: (origin, callback) => {
          if (!origin) return callback(null, false);
          if (allowlist.includes(origin)) return callback(null, origin);
          return callback(null, false);
        },
        credentials: true,
      };
    }
    // Closed by default: no origin is reflected (FR-003, research D11).
    return { origin: false };
  }
  // Development: permissive default for the Vite dev flow — reflect the caller origin.
  return { origin: true, credentials: true };
}

export async function createApp(): Promise<Express> {
  validateConfig();
  const config = loadConfig();

  const app = express();
  // FR-012 / US2: never advertise the framework.
  app.disable('x-powered-by');

  // CORS closed by default in production; permissive in development (FR-003).
  app.use(cors(corsOptions(config)));

  app.use(securityHeaders(config));
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  // Readiness/liveness signal (FR-013): 200 when the API process is up.
  // Registered before any static/SPA fallback so it always takes precedence.
  app.get('/healthz', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Test-only probe (FR-011 / US6): registered ONLY when `GIFTY_ENABLE_TEST_PROBES`
  // is set, so it never exists in a normal app. It throws a realistic
  // server-side failure (a database-initialization error) so the production
  // error handler's 5xx collapse can be exercised end-to-end — proving the
  // raw message (which names a driver and carries a stack) is never echoed.
  if (process.env.GIFTY_ENABLE_TEST_PROBES === '1') {
    app.post('/__test/internal-error', (_req: Request, _res: Response) => {
      const failure = new Error(
        'Simulated internal failure: DB connection pool exhausted (ECONNREFUSED) at /srv/gifty/src/db.js:42'
      );
      failure.name = 'PrismaClientInitializationError';
      throw failure;
    });
  }

  app.use('/auth', createAuthRouter());
  app.use('/lists', createListRouter());
  app.use('/', createItemRouter());

  // GET /account — the caller's own profile (feature 003 contract). Now
  // cookie-authenticated; this is the endpoint the client uses to bootstrap
  // its session from the HttpOnly `gifty_access` cookie (US4 / T027).
  app.get(
    '/account',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      res.status(200).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    },
  );

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
