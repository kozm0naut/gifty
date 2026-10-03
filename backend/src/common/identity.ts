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
 * Placeholder shown in place of a name that the viewer has no right to see
 * (feature 003, FR-024 / SC-008: non-consented identities are masked).
 */
export const ANONYMOUS_DISPLAY_NAME = '????';

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
 * Feature 003 (US5, FR-021/FR-024): resolves claimant display names on a
 * SPECIFIC list, honoring each claimant's name-disclosure consent on that
 * list. A claimant whose consent is `revealed` resolves to their display
 * name; every other state (`pending`, `declined`, no permission row) resolves
 * to the `????` placeholder — the name is never leaked by accident.
 *
 * The result map only contains claimants present on the given items, so the
 * caller can distinguish "resolved (name or placeholder)" from "not claimed".
 */
export async function resolveConsentedIdentityNames(
  items: IdentitySource[],
  listId: string,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.claimantUserId) ids.add(item.claimantUserId);
  }

  if (ids.size === 0) {
    return new Map();
  }

  const claimantIds = [...ids];

  // Single query: every share-permission row on this list whose recipient is
  // one of the claimants. The consent column lives on the permission row, so
  // this is the authoritative source (FR-021: consent is per-list, per-user).
  const permissions = await prisma.sharePermission.findMany({
    where: {
      giftListId: listId,
      recipientUserId: { in: claimantIds },
    },
    select: { recipientUserId: true, nameDisclosureConsent: true },
  });

  const consentByUser = new Map(permissions.map((p) => [p.recipientUserId, p.nameDisclosureConsent]));

  const users = await prisma.user.findMany({
    where: { id: { in: claimantIds } },
    select: { id: true, displayName: true },
  });

  const namesByUser = new Map(users.map((u) => [u.id, u.displayName]));

  const result = new Map<string, string>();
  for (const userId of claimantIds) {
    const consent = consentByUser.get(userId);
    result.set(
      userId,
      consent === 'revealed' ? (namesByUser.get(userId) ?? ANONYMOUS_DISPLAY_NAME) : ANONYMOUS_DISPLAY_NAME,
    );
  }

  return result;
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

/**
 * The minimum structural shape of a `GiftItem` row needed to build the
 * owner-safe projection. Declared independently of the Prisma client so this
 * helper stays decoupled from the ORM's generated types (and from
 * `Prisma.Decimal`).
 */
export interface OwnerSafeItemSource {
  id: string;
  giftListId: string;
  name: string;
  description: string | null;
  quantity: number | null;
  unitPrice: unknown;
  createdAt: Date;
}

/**
 * Owner-safe projection of a gift item (FR-009 / SC-005, Constitution I–II).
 *
 * The list owner must NEVER see claim/purchase state or claimant identity on
 * their own lists. This is a WHITELIST, not a blacklist: only the fields an
 * owner is entitled to are copied out, so a field added to `GiftItem` later is
 * hidden from the owner automatically (fail-closed). `state` is forced to
 * `available` because the owner's view has no claim/purchase concept.
 *
 * Excluded on purpose (owner must not observe):
 *   - claimantUserId / claimedAt / purchasedAt — claim/purchase state + identity
 *   - updatedAt — mutated by every claim/purchase, an activity beacon
 *
 * Use ONLY for owner-facing responses. Recipient-facing responses keep full
 * state and use `decorateItemIdentity` instead.
 */
export function projectOwnerVisibleItem<T extends OwnerSafeItemSource>(item: T): {
  id: string;
  giftListId: string;
  name: string;
  description: string | null;
  quantity: number | null;
  unitPrice: unknown;
  state: 'available';
  createdAt: Date;
} {
  return {
    id: item.id,
    giftListId: item.giftListId,
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    state: 'available',
    createdAt: item.createdAt,
  };
}
