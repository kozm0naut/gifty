// Demo scaffold for Spec 003 Phase 12 (uniform owner share view).
// Registers a fresh owner + a registered recipient, creates a list, and shares
// it with (a) the recipient's email and (b) an unregistered ghost email.
// Prints the credentials/ids needed to drive the browser demo.
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PASSWORD = 'Password123!';
const stamp = Date.now();

function cookie(header) {
  const m = String(header || '').match(/(?:^|,)\s*gifty_access=([^;]*)/);
  if (!m) throw new Error('no gifty_access cookie');
  return `gifty_access=${m[1]}`;
}

async function post(path, body, ck) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.message || res.statusText}`);
  return { res, data };
}

const ownerEmail = `owner-${stamp}@demo.test`;
const recipEmail = `friend-${stamp}@demo.test`;
const ghostEmail = `ghost-${stamp}@nowhere.test`;

const o = await post('/auth/register', { email: ownerEmail, password: PASSWORD, displayName: 'Owner of the List' });
const ownerCookie = cookie(o.res.headers.get('set-cookie'));

const r = await post('/auth/register', { email: recipEmail, password: PASSWORD, displayName: 'Revealed Friend' });
const recipCookie = cookie(r.res.headers.get('set-cookie'));

const created = await post('/lists', { title: `Phase 12 Demo List (${stamp})` }, ownerCookie);
const listId = created.data.list.id;

// Share with the registered recipient's email + an unregistered ghost email.
await post(`/lists/${listId}/share`, { recipientEmail: recipEmail, permission: 'shared' }, ownerCookie);
await post(`/lists/${listId}/share`, { recipientEmail: ghostEmail, permission: 'shared' }, ownerCookie);

const perms = await (await fetch(`${BASE}/lists/${listId}/share-permissions`, { headers: { Cookie: ownerCookie } })).json();

console.log(JSON.stringify({
  base: BASE,
  ownerEmail,
  recipientEmail: recipEmail,
  ghostEmail,
  listId,
  listUrl: `${BASE}/list/${listId}`,
  ownerCookie,
  recipCookie,
  ownerViewBeforeConsent: perms.permissions,
}, null, 2));
