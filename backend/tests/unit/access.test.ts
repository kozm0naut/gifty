import { describe, it, expect, vi, beforeEach } from 'vitest';

// `permissions/access.ts` imports the Prisma client at module scope. Unit tests
// must not depend on a live database, so we mock the client before importing
// the module under test (vi.mock is hoisted above the imports).
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    giftList: { findUnique: vi.fn() },
    giftItem: { findUnique: vi.fn() },
    sharePermission: { findFirst: vi.fn() },
  },
}));

// Import AFTER the mock registration so the factory is already in place.
const { hasListPermission, hasItemPermission } = await import('../../src/permissions/access.js');
const { prisma } = await import('../../src/prisma.js');

beforeEach(() => {
  vi.resetAllMocks();
});

describe('hasListPermission (unit)', () => {
  it('denies when the list does not exist (deny-by-default, FR-005)', async () => {
    (prisma.giftList.findUnique as any).mockResolvedValue(null);

    const result = await hasListPermission('user-1', 'list-1', 'view');

    expect(result).toBe(false);
  });

  it('grants the owner view and manage but not claim (owner cannot claim own items)', async () => {
    (prisma.giftList.findUnique as any).mockResolvedValue({ id: 'list-1', ownerUserId: 'owner-1' });

    await expect(hasListPermission('owner-1', 'list-1', 'view')).resolves.toBe(true);
    // Spec: owners can't claim per spec — only shared recipients act on items.
    await expect(hasListPermission('owner-1', 'list-1', 'claim')).resolves.toBe(false);
    await expect(hasListPermission('owner-1', 'list-1', 'manage')).resolves.toBe(true);
    // The owner short-circuits — no sharePermission lookup should happen.
    expect(prisma.sharePermission.findFirst).not.toHaveBeenCalled();
  });

  it('grants a recipient view and claim but never manage (least-privilege sharing)', async () => {
    (prisma.giftList.findUnique as any).mockResolvedValue({ id: 'list-1', ownerUserId: 'owner-1' });
    (prisma.sharePermission.findFirst as any).mockResolvedValue({ id: 'perm-1' });

    await expect(hasListPermission('recipient-1', 'list-1', 'view')).resolves.toBe(true);
    await expect(hasListPermission('recipient-1', 'list-1', 'claim')).resolves.toBe(true);
    await expect(hasListPermission('recipient-1', 'list-1', 'manage')).resolves.toBe(false);
  });

  it('denies a stranger with no share permission (FR-005)', async () => {
    (prisma.giftList.findUnique as any).mockResolvedValue({ id: 'list-1', ownerUserId: 'owner-1' });
    (prisma.sharePermission.findFirst as any).mockResolvedValue(null);

    await expect(hasListPermission('stranger-1', 'list-1', 'view')).resolves.toBe(false);
    await expect(hasListPermission('stranger-1', 'list-1', 'claim')).resolves.toBe(false);
    await expect(hasListPermission('stranger-1', 'list-1', 'manage')).resolves.toBe(false);
  });
});

describe('hasItemPermission (unit)', () => {
  it('denies when the item does not exist', async () => {
    (prisma.giftItem.findUnique as any).mockResolvedValue(null);

    const result = await hasItemPermission('user-1', 'item-1', 'claim');

    expect(result).toBe(false);
    // The item lookup failed before any list-level check could run.
    expect(prisma.giftList.findUnique).not.toHaveBeenCalled();
  });

  it('delegates to the owning list, granting the recipient claim', async () => {
    (prisma.giftItem.findUnique as any).mockResolvedValue({ id: 'item-1', giftListId: 'list-1' });
    (prisma.giftList.findUnique as any).mockResolvedValue({ id: 'list-1', ownerUserId: 'owner-1' });
    (prisma.sharePermission.findFirst as any).mockResolvedValue({ id: 'perm-1' });

    const result = await hasItemPermission('recipient-1', 'item-1', 'claim');

    expect(result).toBe(true);
  });

  it('delegates to the owning list, denying a stranger', async () => {
    (prisma.giftItem.findUnique as any).mockResolvedValue({ id: 'item-1', giftListId: 'list-1' });
    (prisma.giftList.findUnique as any).mockResolvedValue({ id: 'list-1', ownerUserId: 'owner-1' });
    (prisma.sharePermission.findFirst as any).mockResolvedValue(null);

    const result = await hasItemPermission('stranger-1', 'item-1', 'view');

    expect(result).toBe(false);
  });
});
