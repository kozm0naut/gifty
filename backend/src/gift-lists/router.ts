import { Router } from 'express';
import { prisma } from '../prisma.js';
import { makeId } from '../common/id.js';
import { requireAuth, requireConfirmed, type AuthenticatedRequest } from '../auth/middleware.js';
import { authorizeList } from '../auth/middleware.js';
import {
  ANONYMOUS_DISPLAY_NAME,
  decorateItemIdentity,
  projectOwnerVisibleItem,
  resolveConsentedIdentityNames,
} from '../common/identity.js';
import { recordAuditEvent } from '../audit/events.js';
import { clientIp } from '../auth/rate-limit.js';
import { loadConfig } from '../config/index.js';
import { buildInviteLink } from '../email/links.js';
import { enqueueInvite } from '../email/outbox.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * FR-008 / contracts/api.md: build the US1 invite email content. Subject and
 * bodies are fixed; the only dynamic data is the owner's display name and the
 * public origin. The link is the home page — no token, no deep link, no raw
 * list id (FR-013).
 */
function buildInviteContent(ownerDisplayName: string | null | undefined) {
  const link = buildInviteLink();
  const subject = "You've been shared a gift list";
  const name = ownerDisplayName || 'Someone';
  const bodyText =
    `${name} shared their Gifty gift list with you.\n` +
    `Open the list: ${link}\n` +
    `You don't need an account to view a shared list. If you'd like to claim or manage items, ` +
    `you can sign in or create an account at ${link}.`;
  const bodyHtml =
    `<p>${escapeHtml(name)} shared their Gifty gift list with you.</p>` +
    `<p><a href="${escapeHtml(link)}">Open the list</a></p>` +
    `<p>You don't need an account to view a shared list. If you'd like to claim or manage items, ` +
    `you can sign in or create an account at <a href="${escapeHtml(link)}">Gifty</a>.</p>`;
  return { subject, bodyText, bodyHtml };
}

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
  // Feature 004 (US2, FR-012): every list route requires a confirmed email.
  router.use(requireConfirmed);

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
      items: (list.items ?? []).map(projectOwnerVisibleItem),
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
      visibleItems = updated.items.map(projectOwnerVisibleItem);
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

    // Email mode is resolved once per request (FR-016): in `disabled` mode the
    // share still succeeds but no invite is enqueued — the share response body
    // and status are identical regardless of email mode.
    const emailEnabled = loadConfig().email.mode !== 'disabled';

    // Owner's display name personalizes the invite (FR-008). Fetched once; on
    // failure we fall back to the neutral 'Someone' phrasing so the share
    // never fails because of a display-name lookup (FR-006).
    let ownerDisplayName: string | null = null;
    try {
      const ownerRow = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { displayName: true },
      });
      ownerDisplayName = ownerRow?.displayName ?? null;
    } catch {
      ownerDisplayName = null;
    }

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

      // T014 (FR-006/SC-007): the share write commits on its own; the invite
      // enqueue is a SEPARATE best-effort write on the base client. It is
      // deliberately NOT in the same transaction: (a) the share must never
      // fail or roll back because of email (FR-006), and (b) `enqueueInvite`'
      // P2002 dedup recovery re-queries, which Postgres forbids inside an
      // aborted transaction (25P02) — so it runs in autocommit.
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

      let invite: { outboxMessageId: string; inserted: boolean } | null = null;
      if (emailEnabled) {
        const { subject, bodyText, bodyHtml } = buildInviteContent(ownerDisplayName);
        try {
          invite = await enqueueInvite(prisma, {
            listId,
            recipientEmail: normalizedEmail as string,
            subject,
            bodyText,
            bodyHtml,
          });
        } catch (err) {
          // FR-006: the share itself must not fail because of email.
          console.error(
            `[gift-lists/share] invite enqueue failed (list=${listId}, recipient=${normalizedEmail}):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (invite) {
        recordAuditEvent({
          actorUserId: req.user!.id,
          action: 'email_invite_queued',
          targetType: 'emailOutbox',
          targetId: invite.outboxMessageId,
          outcome: 'success',
          ip: clientIp(req),
          detail: { listId, recipientEmail: normalizedEmail },
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
    // T014 (FR-006/SC-007): the PendingInvitation write commits on its own;
    // the invite enqueue is a SEPARATE best-effort write on the base client
    // (see the registered branch for why it is not transactional).
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

    let invite: { outboxMessageId: string; inserted: boolean } | null = null;
    if (emailEnabled) {
      const { subject, bodyText, bodyHtml } = buildInviteContent(ownerDisplayName);
      try {
        invite = await enqueueInvite(prisma, {
          listId,
          recipientEmail: normalizedEmail as string,
          subject,
          bodyText,
          bodyHtml,
        });
      } catch (err) {
        console.error(
          `[gift-lists/share] invite enqueue failed (list=${listId}, recipient=${normalizedEmail}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (invite) {
      recordAuditEvent({
        actorUserId: req.user!.id,
        action: 'email_invite_queued',
        targetType: 'emailOutbox',
        targetId: invite.outboxMessageId,
        outcome: 'success',
        ip: clientIp(req),
        detail: { listId, recipientEmail: normalizedEmail },
      });
    }

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
    // Merge both sources, then sort by createdAt so the owner sees entries
    // in the order they were invited (not "all registered, then all pending").
    // This matters because the two tables are queried independently; without
    // a temporal sort, a pending invitation that was sent before a registered
    // permission would appear after it, vaguely leaking account existence.
    const merged = [
      ...permissions.map((p) => ({
        id: p.id,
        recipientDisplayName:
          p.nameDisclosureConsent === 'revealed' ? p.recipient.displayName : null,
        permission: p.permission,
        recipientEmail: p.recipientEmail,
        createdAt: p.createdAt,
      })),
      ...pendingInvitations.map((i) => ({
        id: i.id,
        recipientDisplayName: null,
        permission: 'shared' as const,
        recipientEmail: i.inviteeEmail,
        createdAt: i.createdAt,
      })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Drop the internal sort key before sending.
    const uniform = merged.map(({ createdAt: _createdAt, ...entry }) => entry);

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
    // Merge both sources with createdAt, then sort by it so the relative
    // order of entries reflects invite timing rather than table membership
    // (registered-then-pending would leak which invitees have registered).
    const merged = [
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
          createdAt: p.createdAt,
        };
      }),
      // Unregistered invitees: same anonymous placeholder for every viewer,
      // with NO email and NO userId (either would fingerprint registration
      // status or leak the invitee's email to a co-recipient).
      ...pendingInvitations.map((i) => ({
        id: i.id,
        recipientUserId: null,
        recipientDisplayName: ANONYMOUS_DISPLAY_NAME,
        createdAt: i.createdAt,
      })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Drop the internal sort key before sending.
    const recipients = merged.map(({ createdAt: _createdAt, ...entry }) => entry);

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
      visibleItems = list.items.map(projectOwnerVisibleItem);
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
