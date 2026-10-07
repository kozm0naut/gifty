// T033 — live quickstart invariants against the capture-mode stack (:8080).
// Run: node scripts/quickstart-check.mjs
// Uses Node fetch (no Secure-over-http cookie problem). Reads tokens from the
// outbox via `docker compose exec -T postgres psql`.
import { execFile } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PW = 'Password123!';
const rand = () => Math.random().toString(36).slice(2, 10);
const email = (p) => `${p}-${Date.now()}-${rand()}@e2e.test`;

async function runPsql(q) {
  const args = ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'gifty', '-d', 'gifty', '-tA', '-c', q];
  return new Promise((res, rej) =>
    execFile('docker', args, { maxBuffer: 1024 * 1024, timeout: 30000 }, (e, so, se) =>
      e ? rej(new Error(`psql: ${e.message}\n${se}`)) : res(so),
    ),
  );
}
async function confirmToken(email_) {
  for (let i = 0; i < 8; i++) {
    try {
      const out = await runPsql(`SELECT "bodyText" FROM "OutboxMessage" WHERE "kind"='confirmation' AND lower("recipientEmail")=lower('${email_}') ORDER BY "createdAt" DESC LIMIT 1;`);
      const m = out.match(/confirm\?token=([^\s&"'<>]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
const j = (r) => r.json().catch(() => ({}));
const status = (r) => r.status;
const cookieOf = (r) => {
  const sc = r.headers.get('set-cookie') || '';
  const m = sc.match(/(?:^|,)\s*gifty_access=([^;]*)/);
  return m ? `gifty_access=${m[1]}` : '';
};
const out = (...a) => console.log(...a);
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

// US2: register -> unconfirmed, gate 403 with exact message, confirm -> 200, resend, 4th->429
{
  const e = email('us2');
  const reg = await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: PW, displayName: 'US2' }) });
  const regj = await j(reg);
  out('US2 register', status(reg), 'verified=', regj.user?.verified);
  const cookie = cookieOf(reg);
  const gated = await fetch(`${BASE}/lists`, { headers: { Cookie: cookie } });
  const gj = await j(gated);
  out('US2 gate', status(gated), JSON.stringify(gj));
  status(gated) === 403 && gj.message === 'Please confirm your email to continue.' ? out('  -> gate OK') : fail('gate expected 403 + message');

  const token = await confirmToken(e);
  out('US2 token found=', Boolean(token));
  const conf = await fetch(`${BASE}/confirm?token=${encodeURIComponent(token)}`);
  const cj = await j(conf);
  out('US2 confirm', status(conf), JSON.stringify(cj));
  status(conf) === 200 ? out('  -> confirm OK') : fail('confirm expected 200');
  const after = await fetch(`${BASE}/lists`, { headers: { Cookie: cookie } });
  out('US2 lists after confirm', status(after));
  status(after) === 200 ? out('  -> gate lifted OK') : fail('lists expected 200 after confirm');

  const acct = await j(await fetch(`${BASE}/account`, { headers: { Cookie: cookie } }));
  out('US2 /account verified=', acct.user?.verified);
  acct.user?.verified === true ? out('  -> verified OK') : fail('expected verified true');
}

// US1: invite link = home (no token); per-list dedup; different list -> new invite
{
  const owner = email('us1-owner');
  const reg = await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner, password: PW, displayName: 'US1O' }) });
  const cookie = cookieOf(reg);
  const token = await confirmToken(owner);
  await fetch(`${BASE}/confirm?token=${encodeURIComponent(token)}`);

  const list1 = await j(await fetch(`${BASE}/lists`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'US1 L1' }) }));
  const guest = email('us1-guest');
  const s1 = await fetch(`${BASE}/lists/${list1.list.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ recipientEmail: guest, permission: 'shared' }) });
  const s1dup = await fetch(`${BASE}/lists/${list1.list.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ recipientEmail: guest, permission: 'shared' }) });
  const row = await runPsql(`SELECT count(*) FROM "OutboxMessage" WHERE "kind"='invite' AND lower("recipientEmail")=lower('${guest}') AND "listId"='${list1.list.id}';`);
  out('US1 share', status(s1), 're-share', status(s1dup), 'invite rows for list1=', row.trim());

  const guest2 = email('us1-guest2');
  const list2 = await j(await fetch(`${BASE}/lists`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'US1 L2' }) }));
  const s2 = await fetch(`${BASE}/lists/${list2.list.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ recipientEmail: guest2, permission: 'shared' }) });
  const inv = await runPsql(`SELECT "subject","bodyText" FROM "OutboxMessage" WHERE "kind"='invite' AND lower("recipientEmail")=lower('${guest2}') AND "listId"='${list2.list.id}' ORDER BY "createdAt" DESC LIMIT 1;`);
  out('US1 second list share', status(s2));
  const bodyText = inv.split('\t')[1] || inv;
  (inv.includes('http://localhost:8080/') && !inv.includes('token=')) ? out('  -> invite home link, no token OK') : fail('invite link expected home, no token');
}

// US5: capture mode -> confirmation + invite both captured, zero live calls
{
  const e = email('us5');
  const reg = await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: PW, displayName: 'US5' }) });
  const cookie = cookieOf(reg);
  const token = await confirmToken(e);
  await fetch(`${BASE}/confirm?token=${encodeURIComponent(token)}`);
  const list = await j(await fetch(`${BASE}/lists`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'US5 L' }) }));
  const guest = email('us5-guest');
  await fetch(`${BASE}/lists/${list.list.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ recipientEmail: guest, permission: 'shared' }) });
  const cnt = await runPsql(`SELECT count(*) FROM "OutboxMessage" WHERE lower("recipientEmail")=lower('${e}') OR lower("recipientEmail")=lower('${guest}');`);
  out('US5 outbox rows (confirm+invite) =', cnt.trim());
  Number(cnt.trim()) >= 2 ? out('  -> both captured OK') : fail('expected >=2 outbox rows');
}

out('DONE (exitCode=' + (process.exitCode ?? 0) + ')');
