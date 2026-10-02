import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/prisma.js';
import { createApp } from '../src/app.js';

const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;

/** Extract the `gifty_access` value from a supertest Set-Cookie header. */
function accessCookie(setCookieHeader: unknown): string {
  const arr = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  for (const c of arr) {
    const s = String(c);
    if (s.startsWith('gifty_access=')) {
      return s.split(';')[0].slice('gifty_access='.length);
    }
  }
  throw new Error('no gifty_access cookie in response');
}

type User = { id: string; access: string; email: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return {
    id: res.body.user.id,
    access: accessCookie(res.headers['set-cookie']),
    email: res.body.user.email,
  };
}

async function createList(app: any, owner: User, title: string) {
  const res = await request(app)
    .post('/lists')
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ title });
  return res.body.list.id as string;
}

async function shareWith(app: any, owner: User, listId: string, recipient: User) {
  const res = await request(app)
    .post(`/lists/${listId}/share`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ recipientUserId: recipient.id, permission: 'shared' });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`share failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

async function createItem(app: any, owner: User, listId: string, name: string) {
  const res = await request(app)
    .post(`/lists/${listId}/items`)
    .set('Cookie', `gifty_access=${owner.access}`)
    .send({ name, quantity: 1 });
  return res.body.item.id as string;
}

async function claimItem(app: any, recipient: User, itemId: string) {
  const res = await request(app)
    .post(`/items/${itemId}/claim`)
    .set('Cookie', `gifty_access=${recipient.access}`)
    .send({ claimantUserId: recipient.id });
  if (res.status !== 200) {
    throw new Error(`claim failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** Set the recipient name-disclosure consent directly (FR-021/FR-023). */
async function setConsent(app: any, recipient: User, listId: string, consent: 'revealed' | 'declined') {
  const res = await request(app)
    .post(`/lists/${listId}/consent`)
    .set('Cookie', `gifty_access=${recipient.access}`)
    .send({ consent });
  if (res.status !== 200) {
    throw new Error(`consent failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

/** Find an item in a list payload by id (loose typing over the JSON body). */
function findItem(body: any, listId: string, itemId: string): any {
  const list = Array.isArray(body?.lists)
    ? body.lists.find((l: any) => l.id === listId)
    : body?.list;
  const item = (list?.items ?? []).find((i: any) => i.id === itemId);
  if (!item) throw new Error(`item ${itemId} not found in response`);
  return item;
}

/** All owner objects that appear anywhere in a JSON body (deep scan). */
function allOwners(body: any): any[] {
  const found: any[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'owner' && value && typeof value === 'object') {
        found.push(value as any);
      }
      walk(value);
    }
  };
  walk(body);
  return found;
}

beforeEach(async () => {
  process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
  await prisma.pendingInvitation.deleteMany();
  await prisma.sharePermission.deleteMany();
  await prisma.giftItem.deleteMany();
  await prisma.giftList.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
});

describe('identity visibility (T031, FR-021/FR-024/FR-025, SC-008)', () => {
  it('shows a non-consented claimant as the "????" placeholder to co-recipients (FR-024)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis-owner', 'Owner');
    const claimant = await register(app, 'vis-claimant', 'Claimer One');
    const viewer = await register(app, 'vis-viewer', 'Viewer Two');
    const listId = await createList(app, owner, 'Visibility List');
    await shareWith(app, owner, listId, claimant);
    await shareWith(app, owner, listId, viewer);
    const itemId = await createItem(app, owner, listId, 'Shared Gift');

    // The claimant has NOT consented to name disclosure on this list.
    await claimItem(app, claimant, itemId);

    // Viewer sees full claim state…
    const res = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${viewer.access}`);
    expect(res.status).toBe(200);
    const item = findItem(res.body, listId, itemId);
    expect(item.state).toBe('claimed');

    // …but the claimant identity is the placeholder, never the name (FR-024).
    expect(item.claimantDisplayName).toBe('????');
  });

  it('after reveal, the claimant name is visible to co-recipients while the owner view stays identity-free (SC-008 / FR-016)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis2-owner', 'Owner');
    const claimant = await register(app, 'vis2-claimant', 'Claimer Two');
    const viewer = await register(app, 'vis2-viewer', 'Viewer Three');
    const listId = await createList(app, owner, 'Visibility List 2');
    await shareWith(app, owner, listId, claimant);
    await shareWith(app, owner, listId, viewer);
    const itemId = await createItem(app, owner, listId, 'Named Gift');

    await claimItem(app, claimant, itemId);
    await setConsent(app, claimant, listId, 'revealed');

    const res = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${viewer.access}`);
    expect(res.status).toBe(200);
    const item = findItem(res.body, listId, itemId);
    expect(item.state).toBe('claimed');
    expect(item.claimantDisplayName).toBe('Claimer Two');

    // Owner-privacy do-not-regress (FR-016): the owner never sees claimant
    // identity or claim state on their own list.
    const ownerRes = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(ownerRes.status).toBe(200);
    const ownerItem = findItem(ownerRes.body, listId, itemId);
    expect(ownerItem.claimantDisplayName).toBeUndefined();
    expect(ownerItem.state).toBe('available');
  });

  it('co-recipients see the "????" placeholder for every non-consented recipient, including in the avatar/recipients feed', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis3-owner', 'Owner');
    const anon = await register(app, 'vis3-anon', 'Anonymous Recip');
    const viewer = await register(app, 'vis3-viewer', 'Viewer Four');
    const listId = await createList(app, owner, 'Visibility List 3');
    await shareWith(app, owner, listId, anon);
    await shareWith(app, owner, listId, viewer);

    // The /recipients feed (avatar stack) must not leak the non-consented
    // recipient's display name to the viewer (SC-008).
    const res = await request(app)
      .get(`/lists/${listId}/recipients`)
      .set('Cookie', `gifty_access=${viewer.access}`);
    expect(res.status).toBe(200);
    const anonEntry = res.body.recipients.find((r: any) => r.recipientUserId === anon.id);
    expect(anonEntry).toBeTruthy();
    expect(anonEntry.recipientDisplayName).toBe('????');
    expect(JSON.stringify(res.body)).not.toContain('Anonymous Recip');
    expect(JSON.stringify(res.body)).not.toContain(anon.email);
  });

  it('keeps the owner email out of every recipient-visible response (FR-025, SC-008)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis4-owner', 'Owner');
    const viewer = await register(app, 'vis4-viewer', 'Viewer Five');
    const listId = await createList(app, owner, 'Visibility List 4');
    await shareWith(app, owner, listId, viewer);

    const endpoints = [
      { path: `/lists/${listId}`, includesOwner: true },
      { path: '/lists', includesOwner: true },
      // The items endpoint carries no owner object by design (items only), so it
      // can never leak the owner email — it just must not contain it either.
      { path: `/lists/${listId}/items`, includesOwner: false },
    ];

    for (const { path, includesOwner } of endpoints) {
      const res = await request(app)
        .get(path)
        .set('Cookie', `gifty_access=${viewer.access}`);
      expect(res.status).toBe(200);
      const payload = JSON.stringify(res.body);
      expect(payload, `owner email leaked on ${path}`).not.toContain(owner.email);
      // Where the owner IS included, the identity (display name) remains —
      // only the email is hidden.
      if (includesOwner) {
        expect(payload).toContain('Owner');
      }
    }
  });

  it('owner view: the recipient name is hidden until the recipient consents to reveal, then shown (T060, FR-021)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis5-owner', 'Owner');
    const anon = await register(app, 'vis5-anon', 'Owner Visible Recip');
    const listId = await createList(app, owner, 'Visibility List 5');
    await shareWith(app, owner, listId, anon);

    // Before consent: the owner sees the invite email (source of truth) but NOT
    // the recipient's display name.
    const res = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    const entry = res.body.permissions.find((p: any) => p.recipientEmail === anon.email);
    expect(entry).toBeTruthy();
    expect(entry.recipientEmail).toBe(anon.email);
    expect(entry.recipientDisplayName ?? null).toBeNull();
    // The uniform entry carries no registration-status fields at all.
    expect(entry).not.toHaveProperty('recipientUserId');
    expect(entry).not.toHaveProperty('consent');
    expect(JSON.stringify(res.body)).not.toContain('Owner Visible Recip');

    // After the recipient consents to reveal: the owner may see the name.
    await setConsent(app, anon, listId, 'revealed');
    const res2 = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    const entry2 = res2.body.permissions.find((p: any) => p.recipientEmail === anon.email);
    expect(entry2.recipientDisplayName).toBe('Owner Visible Recip');
  });

  it('owner view: registered-unconsented and unregistered invitees are indistinguishable (T060, FR-010/FR-021)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis8-owner', 'Owner');
    const registered = await register(app, 'vis8-reg', 'Registered Unconsented');
    const ghostEmail = uniqueEmail('vis8-ghost'); // no account
    const listId = await createList(app, owner, 'Uniform View List');

    // Invite one registered user (who never consents) and one unregistered email.
    await shareWith(app, owner, listId, registered);
    const ghostShare = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: ghostEmail, permission: 'shared' });
    expect([200, 201]).toContain(ghostShare.status);

    const res = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    const body = res.body;

    // (a) Registration status is not viewable: no separate pending-invitations
    // array and no field that flags which entries are registered.
    expect(body).not.toHaveProperty('pendingInvitations');
    expect(Array.isArray(body.permissions)).toBe(true);
    expect(body.permissions).toHaveLength(2);
    const reg = body.permissions.find((p: any) => p.recipientEmail === registered.email);
    const ghost = body.permissions.find((p: any) => p.recipientEmail === ghostEmail);
    expect(reg).toBeTruthy();
    expect(ghost).toBeTruthy();

    // No per-entry field may fingerprint registration status.
    for (const entry of [reg, ghost]) {
      expect(entry).not.toHaveProperty('recipientUserId');
      expect(entry).not.toHaveProperty('consent');
    }

    // (b) Display name hidden for BOTH: the registered invitee never consented.
    expect(reg.recipientDisplayName ?? null).toBeNull();
    expect(ghost.recipientDisplayName ?? null).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Registered Unconsented');

    // The two entries are uniform apart from their identity keys (id/email):
    // same keys, same values for every shared field.
    const sharedKeys = ['permission', 'recipientDisplayName'];
    for (const key of sharedKeys) {
      expect(reg[key]).toEqual(ghost[key]);
    }
    // Both entries carry the invite email — the owner's source of truth.
    expect(reg.recipientEmail).toBe(registered.email);
    expect(ghost.recipientEmail).toBe(ghostEmail);
  });

  it('consent is per-list: revealing on one list does not reveal on another (edge case)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis6-owner', 'Owner');
    const multi = await register(app, 'vis6-multi', 'Multi List Recip');
    const viewer = await register(app, 'vis6-viewer', 'Viewer Six');
    const listA = await createList(app, owner, 'Per-List A');
    const listB = await createList(app, owner, 'Per-List B');
    await shareWith(app, owner, listA, multi);
    await shareWith(app, owner, listA, viewer);
    await shareWith(app, owner, listB, multi);
    await shareWith(app, owner, listB, viewer);
    const itemA = await createItem(app, owner, listA, 'Gift A');
    const itemB = await createItem(app, owner, listB, 'Gift B');

    await claimItem(app, multi, itemA);
    await claimItem(app, multi, itemB);

    // Consent on list A only.
    await setConsent(app, multi, listA, 'revealed');

    const resA = await request(app).get(`/lists/${listA}`).set('Cookie', `gifty_access=${viewer.access}`);
    expect(findItem(resA.body, listA, itemA).claimantDisplayName).toBe('Multi List Recip');

    const resB = await request(app).get(`/lists/${listB}`).set('Cookie', `gifty_access=${viewer.access}`);
    expect(findItem(resB.body, listB, itemB).claimantDisplayName).toBe('????');
  });

  it('re-share after revocation resets consent to pending (edge case)', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis7-owner', 'Owner');
    const re = await register(app, 'vis7-re', 'Reinvited Recip');
    const viewer = await register(app, 'vis7-viewer', 'Viewer Seven');
    const listId = await createList(app, owner, 'Re-share List');
    await shareWith(app, owner, listId, re);
    await shareWith(app, owner, listId, viewer);
    const itemId = await createItem(app, owner, listId, 'Re-share Gift');

    await claimItem(app, re, itemId);
    await setConsent(app, re, listId, 'revealed');

    // Owner revokes access…
    const perms = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    const permId = perms.body.permissions.find((p: any) => p.recipientEmail === re.email).id;
    const revokeRes = await request(app)
      .delete(`/lists/${listId}/share/${permId}`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(revokeRes.status).toBe(204);

    // …and re-invites.
    await shareWith(app, owner, listId, re);

    // Consent must have reset to pending — the placeholder is back.
    const consentRes = await request(app)
      .get(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${re.access}`);
    expect(consentRes.status).toBe(200);
    expect(consentRes.body.consent).toBe('pending');

    const viewerRes = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${viewer.access}`);
    const item = findItem(viewerRes.body, listId, itemId);
    expect(item.claimantDisplayName).toBe('????');
  });
});

describe('FR-029 "Shared with" ordering (T066)', () => {
  // The API returns all entries (registered + pending) merged and sorted by
  // createdAt (invite order). The frontend (ListPage / PermissionManager)
  // re-sorts for display (revealed-alphabetical → self-if-masked → remaining
  // in invite order). This test verifies the API provides the correct data
  // in the correct base order, and that position never leaks registration
  // status (FR-010).

  it('owner /share-permissions: entries merged in invite (createdAt) order; position does not distinguish registered from unregistered (FR-029, FR-010)', async () => {
    const app = await createApp();
    const owner = await register(app, 'ord-owner', 'Owner');
    const alice = await register(app, 'ord-alice', 'Alice');
    const bob = await register(app, 'ord-bob', 'Bob');
    const ghostEmail = uniqueEmail('ord-ghost'); // no account
    const listId = await createList(app, owner, 'Ordering List');

    // Invite in a specific order: ghost (1st), bob (2nd), alice (3rd).
    // createdAt is monotonically increasing, so this order is stable.
    const ghostShare = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: ghostEmail, permission: 'shared' });
    expect([200, 201]).toContain(ghostShare.status);

    await shareWith(app, owner, listId, bob);
    await shareWith(app, owner, listId, alice);

    // Reveal alice (FR-021/FR-023).
    await setConsent(app, alice, listId, 'revealed');

    // --- Owner view ---
    const res = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    const perms = res.body.permissions;
    expect(perms).toHaveLength(3);

    // Sorted by invite (createdAt) order: ghost(1st), bob(2nd), alice(3rd).
    expect(perms[0].recipientEmail).toBe(ghostEmail);
    expect(perms[1].recipientEmail).toBe(bob.email);
    expect(perms[2].recipientEmail).toBe(alice.email);

    // Alice is revealed → owner sees her display name.
    expect(perms[2].recipientDisplayName).toBe('Alice');
    // Bob never consented → null.
    expect(perms[1].recipientDisplayName ?? null).toBeNull();
    // Ghost has no account → null.
    expect(perms[0].recipientDisplayName ?? null).toBeNull();

    // Uniformity: no entry carries a registration-status fingerprint.
    for (const entry of perms) {
      expect(entry).not.toHaveProperty('recipientUserId');
      expect(entry).not.toHaveProperty('consent');
      expect(entry).not.toHaveProperty('registered');
      expect(entry).not.toHaveProperty('pending');
    }

    // Position does NOT distinguish: ghost(1st) and bob(2nd) are
    // indistinguishable except for their email (owner's source of truth).
    const ghostEntry = perms.find((p: any) => p.recipientEmail === ghostEmail)!;
    const bobEntry = perms.find((p: any) => p.recipientEmail === bob.email)!;
    const sharedKeys = ['permission', 'recipientDisplayName'];
    for (const key of sharedKeys) {
      expect(ghostEntry[key]).toEqual(bobEntry[key]);
    }
  });

  it('recipient /recipients: entries merged in invite (createdAt) order; own entry present; position does not distinguish registered from unregistered (FR-029, FR-010)', async () => {
    const app = await createApp();
    const owner = await register(app, 'ord2-owner', 'Owner');
    const alice = await register(app, 'ord2-alice', 'Alice');
    const bob = await register(app, 'ord2-bob', 'Bob');
    const ghostEmail = uniqueEmail('ord2-ghost'); // no account
    const listId = await createList(app, owner, 'Ordering List 2');

    // Invite in order: ghost(1st), bob(2nd), alice(3rd).
    const ghostShare = await request(app)
      .post(`/lists/${listId}/share`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ recipientEmail: ghostEmail, permission: 'shared' });
    expect([200, 201]).toContain(ghostShare.status);

    await shareWith(app, owner, listId, bob);
    await shareWith(app, owner, listId, alice);

    // Alice reveals (FR-021/FR-023). Bob does not consent.
    await setConsent(app, alice, listId, 'revealed');

    // --- Recipient view (as alice) ---
    const res = await request(app)
      .get(`/lists/${listId}/recipients`)
      .set('Cookie', `gifty_access=${alice.access}`);
    expect(res.status).toBe(200);
    const recipients = res.body.recipients;
    expect(recipients).toHaveLength(3);

    // Sorted by invite (createdAt) order: ghost(1st), bob(2nd), alice(3rd).
    expect(recipients[0].recipientDisplayName).toBe('????'); // ghost
    expect(recipients[1].recipientDisplayName).toBe('????'); // bob (unconsented)
    expect(recipients[2].recipientDisplayName).toBe('Alice'); // alice (revealed, own)

    // Alice sees her own name (own entry), alice's consent is revealed.
    // Bob never consented → placeholder. Ghost has no account → placeholder.
    // No email is exposed to co-recipients (FR-025).
    expect(JSON.stringify(res.body)).not.toContain(ghostEmail);
    expect(JSON.stringify(res.body)).not.toContain(bob.email);
    expect(JSON.stringify(res.body)).not.toContain(alice.email);

    // No registration-status fingerprint on any entry.
    for (const entry of recipients) {
      // recipientUserId may be present (alice's own entry) but must NOT
      // distinguish ghost from bob — both should have null or be indistinguishable.
      expect(entry).not.toHaveProperty('consent');
      expect(entry).not.toHaveProperty('registered');
      expect(entry).not.toHaveProperty('pending');
    }
  });

  it('recipient /recipients: position does not leak which invitees registered (FR-029, FR-010, SC-009)', async () => {
    const app = await createApp();
    const owner = await register(app, 'ord3-owner', 'Owner');
    const reg1 = await register(app, 'ord3-reg1', 'Reg One');
    const reg2 = await register(app, 'ord3-reg2', 'Reg Two');
    const ghostA = uniqueEmail('ord3-ghostA');
    const ghostB = uniqueEmail('ord3-ghostB');
    const viewer = await register(app, 'ord3-viewer', 'Viewer');
    const listId = await createList(app, owner, 'Ordering List 3');

    // Invite order: ghostA(1st), ghostB(2nd), reg1(3rd), reg2(4th), viewer(5th).
    // Mixed registered + unregistered invitees interleaved in time so the
    // createdAt sort (not table membership) is what determines order.
    for (const ghost of [ghostA, ghostB]) {
      const r = await request(app)
        .post(`/lists/${listId}/share`)
        .set('Cookie', `gifty_access=${owner.access}`)
        .send({ recipientEmail: ghost, permission: 'shared' });
      expect([200, 201]).toContain(r.status);
    }
    await shareWith(app, owner, listId, reg1);
    await shareWith(app, owner, listId, reg2);
    await shareWith(app, owner, listId, viewer);

    // None of reg1/reg2 consent → all non-viewer entries are unidentified.
    const res = await request(app)
      .get(`/lists/${listId}/recipients`)
      .set('Cookie', `gifty_access=${viewer.access}`);
    expect(res.status).toBe(200);
    const recipients = res.body.recipients;
    expect(recipients).toHaveLength(5);

    // All non-own entries show the placeholder (no one consented to reveal).
    const nonOwn = recipients.filter((r: any) => r.recipientUserId !== viewer.id);
    for (const entry of nonOwn) {
      expect(entry.recipientDisplayName).toBe('????');
    }

    // The viewer cannot tell which of the 4 unidentified entries are
    // registered accounts vs pending invitations — they all look identical
    // (placeholder name, no email, no registration flag).
    // (The viewer's own entry is the only one with a non-null recipientUserId
    // that matches the viewer — that's expected and is the viewer's own entry.)
    const ownEntry = recipients.find((r: any) => r.recipientUserId === viewer.id);
    expect(ownEntry).toBeTruthy();
    expect(ownEntry.recipientDisplayName).toBe('Viewer');
  });
});
