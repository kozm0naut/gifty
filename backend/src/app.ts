import express, { Express, Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuthRouter, clearAccessCookie, clearRefreshCookie } from './auth/router.js';
import { createListRouter } from './gift-lists/router.js';
import { createItemRouter } from './gift-items/router.js';
import { requireAuth, requireConfirmed, type AuthenticatedRequest } from './auth/middleware.js';
import { clientIp } from './auth/rate-limit.js';
import { consumeToken } from './email/verification.js';
import { removeAccount } from './account/removal.js';
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
    // 003 FR-004: content/scripts/styles confined to self + the permitted font source.
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
    // 003 FR-012 / US2: HSTS is a production-only directive (edge TLS assumed).
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/**
 * CORS policy (003 FR-003, research D11):
 *   - production: closed by default — no origin is reflected unless the caller
 *     is in `CORS_ORIGINS`; a listed origin is opened exactly (not to all others),
 *     with `Access-Control-Allow-Credentials: true` (cookies require it).
 *   - development: permissive (reflect the caller origin) so the Vite dev flow
 *     and cross-origin dev tooling keep working.
 */
function corsOptions(config: ReturnType<typeof loadConfig>): CorsOptions {
  if (config.isProduction) {
    if (config.corsOrigins && config.corsOrigins.length > 0) {
      // Allowlist mode (003 FR-003): reflect only the listed origins, deny all others.
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
    // Closed by default: no origin is reflected (003 FR-003, research D11).
    return { origin: false };
  }
  // Development: permissive default for the Vite dev flow — reflect the caller origin.
  return { origin: true, credentials: true };
}

export async function createApp(): Promise<Express> {
  validateConfig();
  const config = loadConfig();

  const app = express();
  // 003 FR-012 / US2: never advertise the framework.
  app.disable('x-powered-by');

  // Location of the built SPA (frontend/dist), independent of NODE_ENV so the
  // /confirm hand-off below can check it once. In dev the Vite server serves the
  // SPA instead, so these resolve to a non-existent path and are never used.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const spaIndexHtml = path.resolve(currentDir, '../../frontend/dist/index.html');
  const spaAvailable = fs.existsSync(spaIndexHtml);

  // 003 FR-001: client-IP trust. Honor a fronting proxy only when explicitly
  // configured (TRUST_PROXY); otherwise `req.ip` is the direct TCP peer so a
  // client cannot spoof `X-Forwarded-For` to rotate the per-source budget.
  app.set('trust proxy', config.trustProxy);

  // CORS closed by default in production; permissive in development (003 FR-003).
  app.use(cors(corsOptions(config)));

  app.use(securityHeaders(config));
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  // Readiness/liveness signal (002 FR-013): 200 when the API process is up.
  // Registered before any static/SPA fallback so it always takes precedence.
  app.get('/healthz', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Test-only probe (003 FR-011 / US6): registered ONLY when `GIFTY_ENABLE_TEST_PROBES`
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

  // GET /confirm?token= — public, single-use email-confirmation endpoint
  // (feature 004, US2, 004 FR-010). Registered BEFORE any SPA/404 fallback so the
  // token link always resolves here. Every outcome — valid, already used,
  // expired, unknown, or missing token — yields the SAME uniform result
  // `{ status: 'confirmed' }`, so the endpoint never reveals which failure
  // mode occurred (004 FR-004 / 004 FR-010). The token is read only to hash+lookup; it is never
  // echoed, logged, or persisted anywhere else.
  //
  // The token is ALWAYS consumed server-side (one call, uniform side-effect).
  // The *presentation* differs by client: a programmatic/test caller (Accept
  // without text/html) gets the uniform JSON body; a browser navigation (Accept
  // includes text/html) is handed the SPA index.html, so React's ConfirmPage
  // renders and derives its state from `GET /account` → `user.verified` rather
  // than from this response (T021 — the uniform body closes the oracle and is
  // intentionally uninformative for UX). In dev the Vite server serves the SPA,
  // so this hand-off is a no-op there.
  app.get('/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.query.token;
      const token = typeof raw === 'string' ? raw : '';
      // consumeToken resolves `false` for every failure mode; a truthy token
      // is required so an empty/absent token short-circuits to the same result.
      if (token) await consumeToken(token);
    } catch (_error) {
      // Never let a lookup failure change the uniform outcome.
    }
    const accept = req.get('accept') || '';
    if (accept.includes('text/html') && spaAvailable) {
      res.status(200).type('html').sendFile(spaIndexHtml);
      return;
    }
    res.status(200).json({ status: 'confirmed' });
  });

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
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          // Feature 004 (US2, 004 FR-003/004 FR-012): the client derives its
          // confirm/dashboard routing from this flag.
          verified: user.verifiedAt != null,
        },
      });
    },
  );

  // DELETE /account — irreversible account removal (feature 003, US7, 003 FR-014 /
  // 003 FR-028). Requires a live session (401 otherwise). On success: 204 and both
  // session cookies are cleared; the user row, owned lists, recipient-side
  // permissions, sessions, and pending invitations are removed atomically, and
  // the user's claims on others' items are reverted (T048, research D12).
  // DELETE /account is gated on a confirmed email (feature 004, US2, 004 FR-012):
  // account removal is a privileged, irreversible action, so it is NOT in the
  // allow-list of routes an unconfirmed account may reach.
  app.delete('/account', requireAuth, requireConfirmed, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await removeAccount(req.user!.id, clientIp(req));
      res.set('Set-Cookie', [clearAccessCookie(), clearRefreshCookie()]);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // Production static serving (research D2/D12): when running with
  // NODE_ENV=production and a frontend build is present, serve the SPA
  // same-origin with the API. In development the Vite dev server serves the
  // SPA, so none of this is mounted and the dev flow is unaffected.
  if (process.env.NODE_ENV === 'production') {
    if (spaAvailable) {
      const distDir = path.resolve(currentDir, '../../frontend/dist');
      app.use(express.static(distDir));
      // SPA fallback: non-API GET routes that no static file matched resolve
      // to index.html so React Router deep links survive a hard refresh.
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(spaIndexHtml);
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
