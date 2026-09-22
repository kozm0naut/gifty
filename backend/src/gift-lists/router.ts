import { Router } from 'express';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { authorizeList } from '../auth/middleware.js';
import { resolveIdentityNames, decorateItemIdentity } from '../common/identity.js';

async function withOwnerIdentity(list: { ownerUserId: string }) {
  const owner = await prisma.user.findUnique({
    where: { id: list.ownerUserId },
    select: { id: true, displayName: true, email: true },
  });
  const { ownerUserId, ...rest } = list;
  return {
    ...rest,
    owner: owner
      ? { id: owner.id, displayName: owner.displayName, email: owner.email }
      : null,
  };
}

export function createListRouter() {
  const router = Router();

  router.use(requireAuth);

  router.get('/', async (req: AuthenticatedRequest, res) => {
    const [ownedLists, sharedPermissions] = await Promise.all([
      prisma.giftList.findMany({ 
        where: { ownerUserId: req.user!.id },
        include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }
      }),
      prisma.sharePermission.findMany({
        where: { recipientUserId: req.user!.id },
        include: { list: { include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } } },
      }),
    ]);

    const sharedLists = sharedPermissions.map((permission) => permission.list);

    // Owner-privacy boundary (FR-009 / SC-005): the list owner must never see
    // claim/purchase state or claimant identity for items on a list
    // they own.
    const suppressedOwnedLists = ownedLists.map((list) => ({
      ...list,
      items: (list.items ?? []).map((item) => ({
        ...item,
        claimantUserId: undefined,
        state: 'available' as const,
      })),
    }));

    // Shared lists (the requester is a recipient): keep full state AND resolve
    // the claimant display name so shared recipients can see who acted.
    const sharedItems = sharedLists.flatMap((list) => list.items ?? []);
    const identityNames = await resolveIdentityNames(sharedItems);
    const decoratedSharedLists = sharedLists.map((list) => ({
      ...list,
      items: decorateItemIdentity(list.items ?? [], identityNames),
    }));

    const allLists = [...suppressedOwnedLists, ...decoratedSharedLists];

    const listsWithOwner = await Promise.all(allLists.map((list) => withOwnerIdentity(list)));
    res.status(200).json({
      lists: listsWithOwner,
    });
  });

  router.post('/', async (req: AuthenticatedRequest, res, next) => {
    try {
      const { title, description } = req.body ?? {};
      if (!title || typeof title !== 'string') {
        return res.status(400).json({ message: 'List title is required' });
      }

      const newList = await prisma.giftList.create({
        data: {
          id: makeId('list'),
          ownerUserId: req.user!.id,
          title: String(title),
          description: description ? String(description) : null,
        },
      });

      const listWithOwner = await withOwnerIdentity(newList);
      return res.status(201).json({ list: listWithOwner });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:listId', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const { title, description } = req.body ?? {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'List title is required' });
    }

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const updated = await prisma.giftList.update({
      where: { id: listId },
      data: {
        title: title.trim(),
        description: description !== undefined ? (description ? String(description) : null) : undefined,
      },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });

    // Return the full list (items included) so the caller's UI state stays
    // consistent with a GET detail read. Renaming must never drop items.
    const isOwner = updated.ownerUserId === req.user!.id;
    let visibleItems;
    if (isOwner) {
      // Owner-privacy boundary (FR-009 / SC-005): no state or identity.
      visibleItems = updated.items.map((item) => ({
        ...item,
        claimantUserId: undefined,
        state: 'available',
      }));
    } else {
      // Recipient view (FR-009): full state + resolved claimant name.
      const identityNames = await resolveIdentityNames(updated.items);
      visibleItems = decorateItemIdentity(updated.items, identityNames);
    }

    const listWithOwner = await withOwnerIdentity(updated);
    return res.status(200).json({ list: { ...listWithOwner, items: visibleItems } });
  });

  router.post('/:listId/share', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const { recipientUserId, recipientEmail, permission } = req.body ?? {};

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    let targetUserId = recipientUserId;

    if (recipientEmail && typeof recipientEmail === 'string') {
      const normalizedEmail = recipientEmail.trim().toLowerCase();
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (!user) {
        return res.status(404).json({ message: 'Recipient user with this email not found' });
      }
      targetUserId = user.id;
    }

    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ message: 'Recipient identifier (userId or email) is required' });
    }

    if (targetUserId === req.user!.id) {
      return res.status(400).json({ message: 'A list owner cannot share with themselves' });
    }

    if (permission !== 'shared') {
      return res.status(400).json({ message: 'Permission must be shared' });
    }

    const sharePermission = await prisma.sharePermission.upsert({
      where: {
        giftListId_recipientUserId: {
          giftListId: listId,
          recipientUserId: targetUserId,
        },
      },
      update: { permission: 'shared' },
      create: {
        id: makeId('share'),
        giftListId: listId,
        ownerUserId: req.user!.id,
        recipientUserId: targetUserId,
        permission: 'shared',
      },
    });

    return res.status(sharePermission.createdAt ? 201 : 200).json({ sharePermission });
  });

  router.delete('/:listId/share/:permissionId', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const { listId, permissionId } = req.params;

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const permission = await prisma.sharePermission.findUnique({
      where: { id: permissionId },
    });

    if (!permission || permission.giftListId !== listId) {
      return res.status(404).json({ message: 'Permission not found for this list' });
    }

    await prisma.sharePermission.delete({
      where: { id: permissionId },
    });

    res.status(204).send();
  });

  router.get('/:listId/share-permissions', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const { listId } = req.params;

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const permissions = await prisma.sharePermission.findMany({
      where: { giftListId: listId },
      include: {
        recipient: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    const formattedPermissions = permissions.map((p) => ({
      id: p.id,
      recipientUserId: p.recipientUserId,
      recipientDisplayName: p.recipient.displayName,
      permission: p.permission,
    }));

    res.status(200).json({ permissions: formattedPermissions });
  });

  // Recipient-facing endpoint: returns the other recipients on the list so any
  // authorized viewer (owner or recipient) can render the shared-with avatar
  // stack. Deliberately minimal — only display names, no permission rows or
  // other sensitive metadata.
  router.get('/:listId/recipients', authorizeList('view'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const permissions = await prisma.sharePermission.findMany({
      where: { giftListId: listId },
      include: {
        recipient: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    const recipients = permissions.map((p) => ({
      id: p.id,
      recipientUserId: p.recipientUserId,
      recipientDisplayName: p.recipient.displayName,
    }));

    res.status(200).json({ recipients });
  });

  router.get('/:listId', authorizeList('view'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const list = await prisma.giftList.findUnique({
      where: { id: listId },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const isOwner = list.ownerUserId === req.user!.id;

    let visibleItems;
    if (isOwner) {
      // Owner-privacy boundary (FR-009 / SC-005): no state or identity.
      visibleItems = list.items.map((item) => ({
        ...item,
        claimantUserId: undefined,
        state: 'available',
      }));
    } else {
      // Recipient view (FR-009): full state + resolved claimant name.
      const identityNames = await resolveIdentityNames(list.items);
      visibleItems = decorateItemIdentity(list.items, identityNames);
    }

    const listWithOwner = await withOwnerIdentity(list);
    return res.status(200).json({ list: { ...listWithOwner, items: visibleItems } });
  });

  router.delete('/:listId', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const list = await prisma.giftList.findUnique({ where: { id: listId } });

    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    await prisma.giftList.delete({ where: { id: listId } });

    return res.status(200).json({
      message: 'List deleted',
      listId,
    });
  });

  return router;
}
