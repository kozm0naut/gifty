import { prisma } from '../prisma.js';
import { Prisma } from '@prisma/client';

/**
 * T048 [US7] — Account removal cascade (003 FR-014, 003 FR-028; research D12 single
 * transaction).
 *
 * `DELETE /account` must remove the user atomically:
 *   1. revoke the user's live sessions → the account can no longer authenticate;
 *   2. clear the user's claims on OTHERS' items (item reverts to `available`,
 *      claimant identity + timestamps cleared);
 *   3. delete the user's owned lists (items / shares / pending invitations
 *      cascade via FK `onDelete: Cascade`);
 *   4. REVERT the user's recipient-side `SharePermission` rows on others' lists
 *      to pending invitations (upsert on the (giftListId, inviteeEmail) unique
 *      key) — this conceals the deletion from the list owner (the owner sees
 *      the same pending invite addressed to the same email, indistinguishable
 *      from an unregistered invitee) and lets the user rejoin those lists upon
 *      re-creating the account (registration matches the pending invitation
 *      into a fresh SharePermission, auth/router.ts);
 *   5. discard the user's pending invitations as owner (FK cascade on ownerUserId
 *      also covers this, but we set them explicitly for clarity);
 *   6. record `account_removal` (inside the transaction, before the delete so
 *      it commits atomically; the `actorUserId` FK is SetNull on the subsequent
 *      user delete, so the row survives with identity preserved via target);
 *   7. delete the user row LAST (all FKs that RESTRICT are already cleared).
 *
 * Audit rows survive (append-only, 003 FR-013) with their `actorUserId` nulled
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

    // (4) Revert the user's recipient-side permissions on OTHERS' lists to
    //     pending invitations, then delete the permission rows. Two goals:
    //     (a) Concealment — the list owner's share view now shows the same
    //         email as a pending invite, indistinguishable from an invitee
    //         who never registered; nothing signals the account was deleted.
    //     (b) Rejoin — if the account is re-created under the same email, the
    //         registration flow (auth/router.ts) matches the pending
    //         invitation back into a fresh SharePermission (invitation_matched).
    //     Upsert on the (giftListId, inviteeEmail) unique key so both "no
    //     invitation row" and "already matched/discarded" end as pending.
    //     ownerUserId != userId: shares on the user's own lists already went
    //     with the cascade in step (3), and those lists no longer exist.
    //     (FK SharePermission.recipientUserId is RESTRICT, so the delete must
    //     still happen before the user row is removed.)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
    const recipientShares = user
      ? await tx.sharePermission.findMany({
          where: { recipientUserId: userId, ownerUserId: { not: userId } },
          select: { giftListId: true, ownerUserId: true },
        })
      : [];
    if (user) {
      await Promise.all(
        recipientShares.map((share) =>
          tx.pendingInvitation.upsert({
            where: {
              giftListId_inviteeEmail: { giftListId: share.giftListId, inviteeEmail: user.email! },
            },
            create: {
              giftListId: share.giftListId,
              inviteeEmail: user.email!,
              ownerUserId: share.ownerUserId,
            },
            update: { status: 'pending' },
          }),
        ),
      );
    }

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
    //     nulled — identity is preserved via `targetType`/`targetId` (003 FR-013).
    // No credential/token/password data is stored in the audit row (003 FR-013).
    await tx.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'account_removal',
        targetType: 'user',
        targetId: userId,
        outcome: 'success',
        ip: ip ?? null,
        // Operator-facing context (audit is operator-only, so this does not
        // leak to the list owner): how many recipient shares were reverted
        // to pending invitations by step (4).
        detail: recipientShares.length > 0 ? { revertedShares: recipientShares.length } : Prisma.JsonNull,
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
