import { prisma } from '../prisma.js';

/**
 * Minimal shape describing an item's claimant reference. This is intentionally
 * structural so it applies to both Prisma `GiftItem` rows and the plain objects
 * we return in API responses. The purchaser is always the claimant, so a single
 * claimant field is authoritative even in the purchased state.
 */
export interface IdentitySource {
  claimantUserId?: string | null;
}

export interface ItemIdentity {
  claimantDisplayName?: string | null;
}

/**
 * Resolves a batch of claimant user IDs to their display names in a single
 * query (FR-009: authorized recipients must be able to see who claimed an
 * item). The purchaser is always the claimant (only the claimant may purchase),
 * so resolving the claimant covers both. Returns a Map of userId -> displayName.
 */
export async function resolveIdentityNames(items: IdentitySource[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.claimantUserId) ids.add(item.claimantUserId);
  }

  if (ids.size === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, displayName: true },
  });

  return new Map(users.map((u) => [u.id, u.displayName]));
}

/**
 * Attaches the recipient-visible `claimantDisplayName` to a list of items using
 * a pre-resolved name map. Only the ID that actually exists is resolved; an
 * absent claimant yields `null` rather than throwing. The purchaser is always
 * the claimant, so a single name covers both the "claimed by" and "purchased
 * by" cases.
 *
 * IMPORTANT (Constitution I/II, FR-009): this must only be applied to
 * recipient-facing responses. List-owner responses keep their state/identity
 * suppression and must NOT receive these fields.
 */
export function decorateItemIdentity<T extends IdentitySource>(
  items: T[],
  names: Map<string, string>,
): (T & ItemIdentity)[] {
  return items.map((item) => ({
    ...item,
    claimantDisplayName: item.claimantUserId ? (names.get(item.claimantUserId) ?? null) : null,
  }));
}
