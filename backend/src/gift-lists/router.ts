import { Router } from 'express';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { authorizeList } from '../auth/middleware.js';
import {
  ANONYMOUS_DISPLAY_NAME,
  decorateItemIdentity,
  resolveConsentedIdentityNames,
} from '../common/identity.js';
import { recordAuditEvent } from '../audit/events.js';
import { clientIp } from '../auth/rate-limit.js';

/**
 * Attach the owner identity for a list, honoring feature 003 (US5, FR-025 /
 * SC-008): the owner's email is NEVER sent to recipients. The viewer-aware
 * `viewerId` decides which owner fields are exposed:
 *  - owner (viewerId === ownerUserId): id, displayName, email;
 *  - any recipient: id, displayName only (no email).
 */
async function withOwnerIdentity(list: { ownerUserId: string }, viewerId?: string) {
  const owner = await prisma.user.findUnique({
    where: { id: list.ownerUserId },
    select: { id: true, displayName: true, email: true },
  });
  const { ownerUserId, ...rest } = list;
  if (!owner) {
    return { ...rest, owner: null };
  }
  const isOwner = viewerId !== undefined && viewerId === owner.id;
  return {
    ...rest,
    owner: isOwner
      ? { id: owner.id, displayName: owner.displayName, email: owner.email }
      : { id: owner.id, displayName: owner.displayName },
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
    // the claimant display name per list, honoring name-disclosure consent
    // (FR-021/FR-024): a claimant's name appears only when they consented
    // `revealed` on THAT list, otherwise the `????` placeholder.
    const decoratedSharedLists = await Promise.all(
      sharedLists.map(async (list) => ({
        ...list,
        items: decorateItemIdentity(
          list.items ?? [],
          await resolveConsentedIdentityNames(list.items ?? [], list.id),
        ),
      })),
    );

    const allLists = [...suppressedOwnedLists, ...decoratedSharedLists];

    const listsWithOwner = await Promise.all(
      allLists.map((list) => withOwnerIdentity(list, req.user!.id)),
    );
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

      const listWithOwner = await withOwnerIdentity(newList, req.user!.id);
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
      // Recipient view (FR-009): full state + consent-aware claimant name
      // (FR-021/FR-024).
      visibleItems = decorateItemIdentity(
        updated.items,
        await resolveConsentedIdentityNames(updated.items, updated.id),
      );
    }

    const listWithOwner = await withOwnerIdentity(updated, req.user!.id);
    return res.status(200).json({ list: { ...listWithOwner, items: visibleItems } });
  });

  router.post('/:listId/share', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const { recipientUserId, recipientEmail, permission } = req.body ?? {};

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    // Feature 003 (US5, FR-010/FR-011, SC-009): the response to a registered
    // recipient and to an unregistered email must be INDISTINGUISHABLE —
    // same status, same body shape. Only the underlying record differs:
    // registered users get a SharePermission row (the email is stored as the
    // invite email for the owner's view); unregistered emails get a
    // PendingInvitation that converts transactionally at registration.
    const emailProvided = Boolean(recipientEmail && typeof recipientEmail === 'string');
    let normalizedEmail = emailProvided
      ? (recipientEmail as string).trim().toLowerCase()
      : null;

    // Resolve the recipient's user id when the account already exists.
    let targetUserId: string | null | undefined =
      recipientUserId && typeof recipientUserId === 'string' ? recipientUserId : null;

    if (targetUserId === null && normalizedEmail) {
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (user) {
        targetUserId = user.id;
      }
    }

    if (!targetUserId && !normalizedEmail) {
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_share',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'denied',
        ip: clientIp(req),
        detail: { reason: 'recipient_identifier_required' },
      });
      return res.status(400).json({ message: 'Recipient identifier (userId or email) is required' });
    }

    // For a resolved user, the invite email is the source of truth for the
    // owner's sharing view (FR-011/FR-025). If the caller shared by userId
    // rather than email, populate it from the account so the owner always sees
    // the recipient's email.
    if (targetUserId && !normalizedEmail) {
      const recipientUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { email: true },
      });
      normalizedEmail = recipientUser?.email ?? null;
    }

    if (targetUserId === req.user!.id) {
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_share',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'denied',
        ip: clientIp(req),
        detail: { reason: 'self_share' },
      });
      return res.status(400).json({ message: 'A list owner cannot share with themselves' });
    }

    if (permission !== 'shared') {
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_share',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'denied',
        ip: clientIp(req),
        detail: { reason: 'invalid_permission' },
      });
      return res.status(400).json({ message: 'Permission must be shared' });
    }

    /**
     * FR-010 / SC-009 (US6 scenario 1): the response to an EMAIL share must
     * be indistinguishable from a share to a registered recipient, so it can
     * never reveal whether the email is an account. Both branches therefore
     * return the SAME uniform body — a neutral id (never the underlying
     * record's `share_*`/`invite_*` id, which would be a fingerprint), a
     * `null` recipientUserId (no identity), and the invite email. The
     * underlying record still differs (SharePermission vs PendingInvitation);
     * only the response is uniform.
     */
    const uniformShareResponse = (email: string) => ({
      sharePermission: {
        // Neutral id — never the underlying record's real id, which is
        // prefixed `share_*` (registered) or `invite_*` (invitation) and
        // would fingerprint registration.
        id: makeId('sp'),
        permission: 'shared',
        recipientUserId: null,
        recipientEmail: email,
      },
    });

    if (targetUserId) {
      // Registered recipient: materialize a SharePermission row (the
      // recipient gets access immediately). A re-invite after revocation is a
      // FRESH permission with consent reset to `pending` (consent is per-invite).
      const existing = await prisma.sharePermission.findUnique({
        where: {
          giftListId_recipientUserId: {
            giftListId: listId,
            recipientUserId: targetUserId,
          },
        },
      });

      let sharePermission;
      if (existing) {
        sharePermission = await prisma.sharePermission.update({
          where: { id: existing.id },
          data: { permission: 'shared' },
        });
      } else {
        sharePermission = await prisma.sharePermission.create({
          data: {
            id: makeId('share'),
            giftListId: listId,
            ownerUserId: req.user!.id,
            recipientUserId: targetUserId,
            permission: 'shared',
            nameDisclosureConsent: 'pending',
            recipientEmail: normalizedEmail ?? undefined,
          },
        });
      }

      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_share',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'success',
        ip: clientIp(req),
        detail: { recipientUserId: targetUserId },
      });
      // Explicit userId (owner-directed, not an email probe): return the full
      // record, including the real id the client uses to revoke later. This
      // path is not the email-registration enumeration vector.
      if (!emailProvided) {
        return res.status(201).json({ sharePermission: { ...sharePermission } });
      }

      // Email-directed: uniform, indistinguishable from the unregistered path.
      return res.status(201).json(uniformShareResponse(normalizedEmail as string));
    }

    // Unregistered email: hold as a PendingInvitation (normalized email).
    // Always a 201 with the SAME uniform body as the registered-email path —
    // no 404, no different status or shape — so a probe cannot tell which
    // emails are accounts (SC-009).
    const invitation = await prisma.pendingInvitation.upsert({
      where: {
        giftListId_inviteeEmail: {
          giftListId: listId,
          inviteeEmail: normalizedEmail as string,
        },
      },
      update: { status: 'pending' },
      create: {
        id: makeId('invite'),
        giftListId: listId,
        inviteeEmail: normalizedEmail as string,
        ownerUserId: req.user!.id,
        status: 'pending',
      },
    });

    recordAuditEvent({
      actorUserId: req.user!.id,
      action: 'list_share',
      targetType: 'giftList',
      targetId: listId,
      outcome: 'success',
      ip: clientIp(req),
      detail: { inviteeEmail: invitation.inviteeEmail },
    });
    return res.status(201).json(uniformShareResponse(invitation.inviteeEmail));
  });

  router.delete('/:listId/share/:permissionId', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const { listId, permissionId } = req.params;

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    // Phase 12 uniform view: the owner revokes entries by the same `id`
    // whether the underlying row is a SharePermission (registered) or a
    // PendingInvitation (unregistered invitee) — the owner cannot tell which,
    // so revocation must work for both.
    const permission = await prisma.sharePermission.findUnique({
      where: { id: permissionId },
    });

    if (permission && permission.giftListId === listId) {
      await prisma.sharePermission.delete({ where: { id: permissionId } });
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_revoke',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'success',
        ip: clientIp(req),
        detail: { permissionId },
      });
      return res.status(204).send();
    }

    const invitation = await prisma.pendingInvitation.findUnique({
      where: { id: permissionId },
    });

    if (invitation && invitation.giftListId === listId && invitation.status === 'pending') {
      await prisma.pendingInvitation.update({
        where: { id: permissionId },
        data: { status: 'discarded' },
      });
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'list_revoke',
        targetType: 'giftList',
        targetId: listId,
        outcome: 'success',
        ip: clientIp(req),
        detail: { permissionId, inviteeEmail: invitation.inviteeEmail },
      });
      return res.status(204).send();
    }

    recordAuditEvent({
      actorUserId: req.user!.id,
      action: 'list_revoke',
      targetType: 'giftList',
      targetId: listId,
      outcome: 'denied',
      ip: clientIp(req),
      detail: { reason: 'permission_not_found' },
    });
    return res.status(404).json({ message: 'Permission not found for this list' });
  });

  router.get('/:listId/share-permissions', authorizeList('manage'), async (req: AuthenticatedRequest, res) => {
    const { listId } = req.params;

    const list = await prisma.giftList.findUnique({ where: { id: listId } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    // Owner-only sharing view (FR-010/FR-021/FR-025, Phase 12 uniform view):
    // ONE uniform `permissions` array covering both registered recipients
    // (SharePermission) and unregistered invitees (PendingInvitation). The
    // owner sees the invite email (source of truth) for every entry, and a
    // recipient's display name ONLY when that recipient's name-disclosure
    // consent on the list is `revealed`. Nothing in the response shape
    // distinguishes registered from unregistered invitees.
    const [permissions, pendingInvitations] = await Promise.all([
      prisma.sharePermission.findMany({
        where: { giftListId: listId },
        include: {
          recipient: {
            select: {
              id: true,
              displayName: true,
            },
          },
        },
      }),
      prisma.pendingInvitation.findMany({
        where: { giftListId: listId, status: 'pending' },
      }),
    ]);

    // Uniform entry shape: { id, recipientDisplayName?, permission,
    // recipientEmail }. Deliberately NO `recipientUserId` (non-null would
    // fingerprint "registered") and NO `consent` (non-null would do the same) —
    // the owner cannot distinguish registered from unregistered invitees, and
    // consent state is the recipient's private choice, not owner-queryable.
    const uniform = [
      ...permissions.map((p) => ({
        id: p.id,
        recipientDisplayName:
          p.nameDisclosureConsent === 'revealed' ? p.recipient.displayName : null,
        permission: p.permission,
        recipientEmail: p.recipientEmail,
      })),
      ...pendingInvitations.map((i) => ({
        id: i.id,
        recipientDisplayName: null,
        permission: 'shared' as const,
        recipientEmail: i.inviteeEmail,
      })),
    ];

    res.status(200).json({ permissions: uniform });
  });

  // Feature 003 (US5, FR-021/FR-022/FR-023): name-disclosure consent.
  // The consent choice belongs to the RECIPIENT — even the list owner gets a
  // 403 here (it is not owner-queryable data). Consent is identity-only: it
  // never grants or revokes view/claim access.
  router.get('/:listId/consent', async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;

    const list = await prisma.giftList.findUnique({ where: { id: listId }, select: { id: true } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const permission = await prisma.sharePermission.findUnique({
      where: {
        giftListId_recipientUserId: { giftListId: listId, recipientUserId: req.user!.id },
      },
    });
    if (!permission) {
      return res.status(403).json({ message: 'You do not have access to this list' });
    }

    // The caller's own display name — always visible to themselves.
    return res.status(200).json({
      consent: permission.nameDisclosureConsent,
      displayName: req.user!.displayName,
    });
  });

  router.post('/:listId/consent', async (req: AuthenticatedRequest, res) => {
    const listId = Array.isArray(req.params.listId) ? req.params.listId[0] : req.params.listId;
    const { consent } = req.body ?? {};

    if (consent !== 'revealed' && consent !== 'declined') {
      return res.status(400).json({ message: "Consent must be 'revealed' or 'declined'" });
    }

    const list = await prisma.giftList.findUnique({ where: { id: listId }, select: { id: true } });
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }

    const permission = await prisma.sharePermission.findUnique({
      where: {
        giftListId_recipientUserId: { giftListId: listId, recipientUserId: req.user!.id },
      },
    });
    if (!permission) {
      return res.status(403).json({ message: 'You do not have access to this list' });
    }

    await prisma.sharePermission.update({
      where: { id: permission.id },
      data: { nameDisclosureConsent: consent },
    });

    void recordAuditEvent({
      actorUserId: req.user!.id,
      action: 'consent_updated',
      outcome: 'success',
      targetType: 'giftList',
      targetId: listId,
      detail: { consent },
    });

    return res.status(200).json({ consent });
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

    // Registration-enumeration guard (FR-010/FR-021, Phase 12): return BOTH
    // registered recipients (SharePermission) AND unregistered pending
    // invitees (PendingInvitation) so the row count is identical to the
    // owner's uniform share view. A co-recipient can therefore no longer
    // infer who is unregistered from the number of entries they see — a
    // pending invitee is indistinguishable from a registered recipient who
    // has not yet consented to reveal their name.
    const [permissions, pendingInvitations] = await Promise.all([
      prisma.sharePermission.findMany({
        where: { giftListId: listId },
        include: {
          recipient: {
            select: {
              id: true,
              displayName: true,
            },
          },
        },
      }),
      prisma.pendingInvitation.findMany({
        where: { giftListId: listId, status: 'pending' },
      }),
    ]);

    const isOwner = list.ownerUserId === req.user!.id;

    // Feature 003 (US5, FR-024 / SC-008): a co-recipient only sees another
    // recipient's display name when THAT recipient has consented `revealed`
    // on this list. The recipient always sees their own name (it is their
    // own identity), and the owner always sees names (the owner's sharing
    // view is the source of truth).
    const recipients = [
      ...permissions.map((p) => {
        const ownEntry = p.recipientUserId === req.user!.id;
        const visibleName =
          isOwner ||
          ownEntry ||
          p.nameDisclosureConsent === 'revealed'
            ? p.recipient.displayName
            : ANONYMOUS_DISPLAY_NAME;
        return {
          id: p.id,
          recipientUserId: p.recipientUserId,
          recipientDisplayName: visibleName,
        };
      }),
      // Unregistered invitees: same anonymous placeholder for every viewer,
      // with NO email and NO userId (either would fingerprint registration
      // status or leak the invitee's email to a co-recipient).
      ...pendingInvitations.map((i) => ({
        id: i.id,
        recipientUserId: null,
        recipientDisplayName: ANONYMOUS_DISPLAY_NAME,
      })),
    ];

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
      // Recipient view (FR-009): full state + consent-aware claimant name
      // (FR-021/FR-024).
      visibleItems = decorateItemIdentity(
        list.items,
        await resolveConsentedIdentityNames(list.items, list.id),
      );
    }

    const listWithOwner = await withOwnerIdentity(list, req.user!.id);
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
