import { Request, Response, NextFunction } from 'express';

/**
 * FR-011: the single stable body for internal (server-side) failures in
 * production. It never carries a stack trace, file path, query, or driver
 * detail — the only thing a caller learns is that *something* went wrong.
 */
const INTERNAL_ERROR = 'An internal error occurred.';

/**
 * Read at request time (not module-load time) so the handler reflects the
 * environment it is actually running under — including tests that set
 * `NODE_ENV` after import.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log full stack in development; only the message in production to avoid leaking internals.
  if (isProduction()) {
    console.error(`[Error] ${req.method} ${req.path} — ${err.message}`);
  } else {
    console.error(`[Error] ${req.method} ${req.path} — ${err.stack}`);
  }

  const status = (err as any).status || 500;
  // FR-011: in production, every 5xx collapses to the stable generic body —
  // the raw error text (which may name a file, table, or driver) is never
  // echoed. 4xx keep their specific, stable message (the `{ message }` shape
  // the client and inline router errors use).
  const body =
    status >= 500 && isProduction()
      ? { error: INTERNAL_ERROR }
      : { message: (err as any).message || (status >= 500 ? 'Internal Server Error' : 'Request failed') };

  res.status(status).json(body);
}
