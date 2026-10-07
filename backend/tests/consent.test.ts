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

type User = { id: string; access: string };

async function register(app: any, prefix: string, displayName: string): Promise<User> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: uniqueEmail(prefix), password: 'Password123!', displayName });
  return { id: res.body.user.id, access: accessCookie(res.headers['set-cookie']) };
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

describe('consent endpoints (T030, 003 FR-021/003 FR-023)', () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-secret-32-characters-long-0000';
    await prisma.pendingInvitation.deleteMany();
    await prisma.sharePermission.deleteMany();
    await prisma.giftItem.deleteMany();
    await prisma.giftList.deleteMany();
    await prisma.userSession.deleteMany();
    await prisma.user.deleteMany();
  });

  it('GET /lists/:listId/consent returns the pending state and the caller own display name', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent-owner', 'Owner');
    const recipient = await register(app, 'consent-recipient', 'Recip Name');
    const listId = await createList(app, owner, 'Consent List');
    await shareWith(app, owner, listId, recipient);

    const res = await request(app)
      .get(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ consent: 'pending', displayName: 'Recip Name' });
  });

  it('GET /lists/:listId/consent is 403 for non-recipients and 404 for a missing list', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent403-owner', 'Owner');
    const outsider = await register(app, 'consent403-outsider', 'Outsider');
    const listId = await createList(app, owner, 'Consent 403 List');

    // Non-recipient (even the owner) cannot read the consent state — it is
    // the recipient's own choice, not data the owner may query.
    const ownerRes = await request(app)
      .get(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(ownerRes.status).toBe(403);

    const outsiderRes = await request(app)
      .get(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${outsider.access}`);
    expect(outsiderRes.status).toBe(403);

    const missingRes = await request(app)
      .get(`/lists/list_does-not-exist/consent`)
      .set('Cookie', `gifty_access=${owner.access}`);
    expect(missingRes.status).toBe(404);
  });

  it('POST /lists/:listId/consent sets revealed and declined in either direction at any time', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent-set-owner', 'Owner');
    const recipient = await register(app, 'consent-set-recipient', 'Set Recip');
    const listId = await createList(app, owner, 'Consent Set List');
    await shareWith(app, owner, listId, recipient);

    const reveal = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ consent: 'revealed' });
    expect(reveal.status).toBe(200);
    expect(reveal.body).toEqual({ consent: 'revealed' });

    // Re-set back to declined (revocable in either direction — 003 FR-023).
    const decline = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ consent: 'declined' });
    expect(decline.status).toBe(200);
    expect(decline.body).toEqual({ consent: 'declined' });

    // And back to revealed again.
    const revealAgain = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ consent: 'revealed' });
    expect(revealAgain.status).toBe(200);
    expect(revealAgain.body).toEqual({ consent: 'revealed' });

    // The persisted state matches.
    const stored = await prisma.sharePermission.findFirst({
      where: { giftListId: listId, recipientUserId: recipient.id },
    });
    expect(stored?.nameDisclosureConsent).toBe('revealed');
  });

  it('POST /lists/:listId/consent rejects a bad body with 400', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent400-owner', 'Owner');
    const recipient = await register(app, 'consent400-recipient', 'Bad Body');
    const listId = await createList(app, owner, 'Consent 400 List');
    await shareWith(app, owner, listId, recipient);

    const missing = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({});
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ consent: 'maybe' });
    expect(invalid.status).toBe(400);
  });

  it('POST /lists/:listId/consent is 403 for non-recipients and 404 for a missing list', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent403b-owner', 'Owner');
    const outsider = await register(app, 'consent403b-outsider', 'Outsider');
    const listId = await createList(app, owner, 'Consent 403b List');

    const outsiderRes = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${outsider.access}`)
      .send({ consent: 'revealed' });
    expect(outsiderRes.status).toBe(403);

    // No list → 404 regardless of the caller.
    const missingListRes = await request(app)
      .post(`/lists/list_does-not-exist/consent`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ consent: 'revealed' });
    expect(missingListRes.status).toBe(404);
  });

  it('setting consent does not affect the recipient ability to view or claim (003 FR-023)', async () => {
    const app = await createApp();
    const owner = await register(app, 'consent-view-owner', 'Owner');
    const recipient = await register(app, 'consent-view-recipient', 'View Recip');
    const listId = await createList(app, owner, 'Consent View List');
    await shareWith(app, owner, listId, recipient);

    const createItem = await request(app)
      .post(`/lists/${listId}/items`)
      .set('Cookie', `gifty_access=${owner.access}`)
      .send({ name: 'Claimable Gift', quantity: 1 });
    const itemId = createItem.body.item.id as string;

    const declined = await request(app)
      .post(`/lists/${listId}/consent`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ consent: 'declined' });
    expect(declined.status).toBe(200);

    // The recipient can still view the list…
    const listRes = await request(app)
      .get(`/lists/${listId}`)
      .set('Cookie', `gifty_access=${recipient.access}`);
    expect(listRes.status).toBe(200);

    // …and still claim items (consent is identity-only, not access).
    const claim = await request(app)
      .post(`/items/${itemId}/claim`)
      .set('Cookie', `gifty_access=${recipient.access}`)
      .send({ claimantUserId: recipient.id });
    expect(claim.status).toBe(200);
  });
});
