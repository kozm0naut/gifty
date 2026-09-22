import 'dotenv/config';

export function validateConfig(): void {
  const errors: string[] = [];
  const jwtSecret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV || 'development';

  if (!jwtSecret || jwtSecret === 'development-secret') {
    if (nodeEnv === 'production') {
      errors.push('JWT_SECRET must be set in production');
    }
  }

  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL must be set');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }
}
