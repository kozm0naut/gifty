import { randomUUID } from 'crypto';

/**
 * Generates a prefixed, collision-resistant identifier (e.g. `user_<uuid>`).
 *
 * All persistence is handled by Prisma (see `src/prisma.ts`); this is a
 * standalone helper kept out of the storage layer it originally lived in.
 */
export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
