import { prisma } from '../prisma.js';
import { Prisma } from '@prisma/client';

/**
 * T048 [US7] — Account removal cascade (FR-014, FR-028; research D12 single
 * transaction).
 *
 * `DELETE /account` must remove the user atomically:
 *   1. revoke the user's live sessions → the account can no longer authenticate;
 *   2. clear the user's claims on OTHERS' items (item reverts to `available`,
 *      claimant identity + timestamps cleared);
 *   3. delete the user's owned lists (items / shares / pending invitations
 *      cascade via FK `onDelete: Cascade`);
 *   4. delete the user's recipient-side `SharePermission` rows on others' lists;
 *   5. discard the user's pending invitations as owner (FK cascade on ownerUserId
 *      also covers this, but we set them explicitly for clarity);
 *   6. record `account_removal` (inside the transaction, before the delete so
 *      it commits atomically; the `actorUserId` FK is SetNull on the subsequent
 *      user delete, so the row survives with identity preserved via target);
 *   7. delete the user row LAST (all FKs that RESTRICT are already cleared).
 *
 * Audit rows survive (append-only, FR-013) with their `actorUserId` nulled
 * (FK `onDelete: SetNull`). No credential/token/password data is stored — the
 * audit capture carries none.
 */
export async function removeAccount(userId: string, ip: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // (1) Revoke every live session → the account can no longer authenticate.
    await tx.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // (2) Clear the user's claims on OTHERS' items: revert to `available`,
    //     drop the claimant identity and the claim/purchase timestamps.
    //     (The `claimantUserId` FK is `onDelete: SetNull`, but the item's
    //     `state`/`claimedAt`/`purchasedAt` would be left orphaned otherwise.)
    await tx.giftItem.updateMany({
      where: { claimantUserId: userId },
      data: {
        state: 'available',
        claimantUserId: null,
        claimedAt: null,
        purchasedAt: null,
        updatedAt: new Date(),
      },
    });

    // (3) Delete the user's owned lists. FKs cascade:
    //     GiftItem.giftListId (Cascade), SharePermission.giftListId (Cascade),
    //     PendingInvitation.giftListId (Cascade).
    //     (Collecting owned-list ids first is not required for correctness —
    //     `deleteMany` on ownerUserId covers all of them — but it documents
    //     the cascade.)
    await tx.giftList.deleteMany({
      where: { ownerUserId: userId },
    });

    // (4) Delete the user's recipient-side permissions on OTHERS' lists.
    //     (FK SharePermission.recipientUserId is RESTRICT, so this must happen
    //     before the user row is deleted.)
    await tx.sharePermission.deleteMany({
      where: { recipientUserId: userId },
    });

    // (5) Discard the user's pending invitations as owner. (FK
    //     PendingInvitation.ownerUserId is Cascade, so this is belt-and-suspenders
    //     and also covers invitations the user received as owner before (4).)
    await tx.pendingInvitation.deleteMany({
      where: { ownerUserId: userId },
    });

    // (6) Record the removal INSIDE the transaction, before the user delete.
    //     It commits atomically with the rest. The `actorUserId` FK is
    //     `onDelete: SetNull`, so after (7) the row survives with `actorUserId`
    //     nulled — identity is preserved via `targetType`/`targetId` (FR-013).
    // No credential/token/password data is stored in the audit row (FR-013).
    await tx.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'account_removal',
        targetType: 'user',
        targetId: userId,
        outcome: 'success',
        ip: ip ?? null,
        detail: Prisma.JsonNull,
      },
    });

    // (7) Delete the user row LAST. All RESTRICT FKs (owned lists,
    //     recipient permissions) are already cleared; the rest cascade or
    //     SetNull.
    await tx.user.delete({
      where: { id: userId },
    });
  });
}
