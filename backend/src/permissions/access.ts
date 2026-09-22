import { prisma } from '../prisma.js';

export type RequiredPermission = 'view' | 'claim' | 'manage';

export async function hasListPermission(userId: string, listId: string, requiredPermission: RequiredPermission): Promise<boolean> {
  const list = await prisma.giftList.findUnique({
    where: { id: listId },
  });
  if (!list) {
    return false;
  }

  if (list.ownerUserId === userId) {
    // The owner manages the list (share/revoke/delete, add items) but may NOT
    // claim or purchase items on it — only shared recipients act on items
    // (spec: "owners can't claim per spec").
    return requiredPermission !== 'claim';
  }

  const permission = await prisma.sharePermission.findFirst({
    where: {
      giftListId: listId,
      recipientUserId: userId,
    },
  });

  if (!permission) {
    return false;
  }

  // A shared recipient can 'view' and 'claim', but only the owner can 'manage'.
  return requiredPermission !== 'manage';
}

export async function hasItemPermission(userId: string, itemId: string, requiredPermission: RequiredPermission): Promise<boolean> {
  const item = await prisma.giftItem.findUnique({
    where: { id: itemId },
    select: { giftListId: true },
  });
  if (!item) {
    return false;
  }

  return hasListPermission(userId, item.giftListId, requiredPermission);
}
