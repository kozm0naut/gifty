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

  it('the owner sees the recipient identity and the invite email in the sharing view', async () => {
    const app = await createApp();
    const owner = await register(app, 'vis5-owner', 'Owner');
    const anon = await register(app, 'vis5-anon', 'Owner Visible Recip');
    const listId = await createList(app, owner, 'Visibility List 5');
    await shareWith(app, owner, listId, anon);

    const res = await request(app)
      .get(`/lists/${listId}/share-permissions`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(res.status).toBe(200);
    const entry = res.body.permissions.find((p: any) => p.recipientUserId === anon.id);
    expect(entry).toBeTruthy();
    // Owner sees the name…
    expect(entry.recipientDisplayName).toBe('Owner Visible Recip');
    // …and the invite email (source of truth for the owner's sharing view).
    expect(entry.recipientEmail).toBe(anon.email);
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
    const permId = perms.body.permissions.find((p: any) => p.recipientUserId === re.id).id;
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
