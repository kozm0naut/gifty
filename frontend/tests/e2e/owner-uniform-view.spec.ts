import { test, expect } from '@playwright/test';
import {
  apiRegister,
  apiCreateList,
  apiShareList,
  loginViaUI,
  uniqueEmail,
  E2E_PASSWORD,
} from './helpers';
import type { Page } from '@playwright/test';

// API origin mirrors helpers.ts (BASE_URL when targeting the container).
const API_BASE = process.env.BASE_URL || 'http://localhost:4000';

/** Set the recipient's name-disclosure consent directly (003 FR-023). */
async function setConsent(cookie: string, listId: string, consent: 'revealed' | 'declined'): Promise<string> {
  const response = await fetch(`${API_BASE}/lists/${listId}/consent`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent }),
  });
  if (!response.ok) throw new Error(`consent failed: ${response.status}`);
  const data = (await response.json().catch(() => ({}))) as { consent?: string };
  return data.consent ?? consent;
}

/**
 * Phase 12 (T062) — the owner's share-management view is uniform (003 FR-010,
 * 003 FR-021, US5/AC consent):
 *
 * A list owner must NOT be able to tell — from the owner's share view —
 * which invited emails are registered users and which are not, and must NOT
 * see a recipient's display name unless that recipient is a registered user
 * that has consented to reveal. A registered-not-consented invitee and an
 * unregistered invitee must therefore render as identical entries
 * (email only, no "not registered yet" label).
 */

async function switchToOwner(page: Page, email: string): Promise<void> {
  await page.goto('/');
  const logout = page.locator('button.nav-logout');
  if (await logout.count()) {
    await logout.click();
    await page.waitForSelector('#auth-email', { timeout: 10000 });
  } else {
    await page.waitForSelector('#auth-email', { timeout: 10000 });
  }
  await loginViaUI(page, email, E2E_PASSWORD);
}

async function openSharingView(page: Page, listId: string): Promise<void> {
  await page.goto(`/list/${listId}`);
  // The manage-sharing button has an explicit aria-label; the surrounding
  // avatar stack also carries a "Manage Sharing" accessible name, so target
  // the real button directly.
  await page.locator('button.share-btn[aria-label="Manage Sharing"]').click();
}

test.describe('owner uniform share view (T062, 003 FR-010/003 FR-021)', () => {
  test('registered-unconsented and unregistered invitees render identically; the name appears only after consent', async ({ page }) => {
    const ownerEmail = uniqueEmail('ouv-owner');
    const regEmail = uniqueEmail('ouv-reg');
    const ghostEmail = uniqueEmail('ouv-ghost');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Uniform Owner');
    const registered = await apiRegister(regEmail, E2E_PASSWORD, 'Uniform Reg Name');
    const { list } = await apiCreateList(owner.cookie, { title: 'Uniform View E2E' });

    // Invite one registered user (who will NOT consent) and one unregistered email.
    await apiShareList(owner.cookie, list.id, regEmail);
    await apiShareList(owner.cookie, list.id, ghostEmail);

    // ── Owner view BEFORE consent: both entries identical, email only ──
    await switchToOwner(page, ownerEmail);
    await openSharingView(page, list.id);

    // Both invite emails are listed…
    await expect(page.getByText(regEmail, { exact: false })).toBeVisible();
    await expect(page.getByText(ghostEmail, { exact: false })).toBeVisible();
    // …with no registration-status signal of any kind…
    await expect(page.getByText(/not registered yet/i)).toHaveCount(0);
    await expect(page.getByText(/Pending invitations/i)).toHaveCount(0);
    // …and no display name for the registered invitee (consent not yet given).
    await expect(page.getByText('Uniform Reg Name')).toHaveCount(0);

    // ── Recipient consents to reveal ──
    await expect(setConsent(registered.cookie, list.id, 'revealed')).resolves.toBe('revealed');

    // ── Owner view AFTER consent: the registered invitee's name is now visible ──
    await openSharingView(page, list.id);
    await expect(page.getByText('Uniform Reg Name')).toBeVisible();
    // The unregistered invitee still renders as email only — still no name.
    await expect(page.getByText(ghostEmail, { exact: false })).toBeVisible();
    await expect(page.getByText(/not registered yet/i)).toHaveCount(0);
  });
});
