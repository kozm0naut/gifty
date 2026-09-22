import { Router } from 'express';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { authorizeItem, authorizeList } from '../auth/middleware.js';
import { validateCreateGiftItem } from './gift-item.validation.js';
import { resolveIdentityNames, decorateItemIdentity } from '../common/identity.js';

export function createItemRouter() {
  const router = Router();

  router.post('/lists/:listId/items', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const { listId } = req.params;
    const { name, description, quantity, unitPrice } = req.body ?? {};

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const validationError = validateCreateGiftItem({ name, description, quantity, unitPrice });
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const item = await prisma.giftItem.create({
      data: {
        id: makeId('item'),
        giftListId: list.id,
        name: String(name),
        description: description ? String(description) : null,
        quantity: typeof quantity === 'number' ? quantity : null,
        unitPrice: typeof unitPrice === 'number' ? unitPrice : null,
        state: 'available',
      },
    });

    return res.status(201).json({ item });
  });

  router.post('/items/:itemId/claim', requireAuth, authorizeItem('claim'), async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const { claimantUserId } = req.body ?? {};
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    const list = await prisma.giftList.findUnique({ where: { id: item.giftListId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    // Only shared recipients may claim (enforced by the authorizeItem('claim')
    // middleware — the owner is rejected there with 403).
    if (claimantUserId !== undefined && claimantUserId !== req.user!.id) {
      return res.status(403).json({ message: 'Claim ownership must match the authenticated user' });
    }

    if (item.state !== 'available') {
      return res.status(409).json({ message: 'This item is no longer available to claim' });
    }

    // Atomic transition: available -> claimed, only if still available.
    const result = await prisma.giftItem.updateMany({
      where: { id: itemId, state: 'available' },
      data: {
        state: 'claimed',
        claimantUserId: req.user!.id,
        claimedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res.status(409).json({ message: 'This item is no longer available to claim' });
    }

    const updatedItem = await prisma.giftItem.findUnique({ where: { id: itemId } });
    return res.status(200).json({ item: updatedItem });
  });

  router.post('/items/:itemId/purchase', requireAuth, authorizeItem('claim'), async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    const list = await prisma.giftList.findUnique({ where: { id: item.giftListId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    if (item.state !== 'claimed') {
      return res.status(409).json({ message: 'This item must be claimed before it can be purchased' });
    }

    if (item.claimantUserId !== req.user!.id) {
      return res.status(403).json({ message: 'Only the claimant can purchase this item' });
    }

    // Atomic transition: claimed -> purchased, only if still claimed by this user.
    const result = await prisma.giftItem.updateMany({
      where: { id: itemId, state: 'claimed', claimantUserId: req.user!.id },
      data: {
        state: 'purchased',
        purchasedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res.status(409).json({ message: 'This item must be claimed before it can be purchased' });
    }

    const updatedItem = await prisma.giftItem.findUnique({ where: { id: itemId } });
    return res.status(200).json({ item: updatedItem });
  });

  router.post('/items/:itemId/unclaim', requireAuth, authorizeItem('claim'), async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;

    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    const list = await prisma.giftList.findUnique({ where: { id: item.giftListId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    if (item.state !== 'claimed') {
      return res.status(409).json({ message: 'This item is not in a claimed state' });
    }

    if (item.claimantUserId !== req.user!.id) {
      return res.status(403).json({ message: 'Only the current claimant can revert this claim' });
    }

    // Atomic transition: claimed -> available, only if still claimed by this user.
    const result = await prisma.giftItem.updateMany({
      where: { id: itemId, state: 'claimed', claimantUserId: req.user!.id },
      data: {
        state: 'available',
        claimantUserId: null,
        claimedAt: null,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res.status(409).json({ message: 'This item is no longer available to unclaim' });
    }

    const updatedItem = await prisma.giftItem.findUnique({ where: { id: itemId } });
    return res.status(200).json({ item: updatedItem });
  });

  router.post('/items/:itemId/unpurchase', requireAuth, authorizeItem('claim'), async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;

    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    const list = await prisma.giftList.findUnique({ where: { id: item.giftListId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    if (item.state !== 'purchased') {
      return res.status(409).json({ message: 'This item is not in a purchased state' });
    }

    // The purchaser is always the claimant, so authorization is anchored to the claimant.
    if (item.claimantUserId !== req.user!.id) {
      return res.status(403).json({ message: 'Only the current claimant can revert this purchase' });
    }

    // Atomic transition: purchased -> claimed, only if still claimed by this user.
    // The claimant identity is preserved through the revert (US4-AC2).
    const result = await prisma.giftItem.updateMany({
      where: { id: itemId, state: 'purchased', claimantUserId: req.user!.id },
      data: {
        state: 'claimed',
        purchasedAt: null,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return res.status(409).json({ message: 'This item is no longer available to revert' });
    }

    const updatedItem = await prisma.giftItem.findUnique({ where: { id: itemId } });
    return res.status(200).json({ item: updatedItem });
  });

  router.get('/lists/:listId/items', authorizeList('view'), async (req: AuthenticatedRequest, res) => {
    const { listId } = req.params;
    const items = await prisma.giftItem.findMany({
      where: { giftListId: listId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    const isOwner = list?.ownerUserId === req.user?.id;

    if (isOwner) {
      // Owner-privacy boundary (FR-009 / SC-005): strip all claim/purchase
      // state and identity from the owner's own list.
      const visibleItems = items.map((item) => ({
        ...item,
        claimantUserId: undefined,
        state: 'available' as const,
      }));
      return res.status(200).json({ items: visibleItems });
    }

    // Recipient view (FR-009): expose full state plus the resolved claimant
    // display name so shared recipients can see who acted (the purchaser is
    // always the claimant).
    const names = await resolveIdentityNames(items);
    const visibleItems = decorateItemIdentity(items, names);
    return res.status(200).json({ items: visibleItems });
  });

  router.patch('/items/:itemId', requireAuth, async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    return res.status(403).json({ message: 'Gift items are immutable once created' });
  });

  router.delete('/items/:itemId', requireAuth, async (req: AuthenticatedRequest, res) => {
    const { itemId } = req.params;
    const item = await prisma.giftItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }

    return res.status(403).json({ message: 'Gift items are immutable once created' });
  });

  return router;
}
