import { Request, Response, NextFunction } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log full stack in development; only the message in production to avoid leaking internals.
  if (isProduction) {
    console.error(`[Error] ${req.method} ${req.path} — ${err.message}`);
  } else {
    console.error(`[Error] ${req.method} ${req.path} — ${err.stack}`);
  }

  const status = (err as any).status || 500;
  // In production, hide internal error messages for 5xx to avoid leaking implementation details.
  const message = status >= 500 && isProduction
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  // Flat { message } shape — consistent with inline router errors and the frontend's handleResponse.
  res.status(status).json({ message });
}
