import { test, expect } from '@playwright/test';
import {
  apiRegister,
  apiCreateList,
  apiFetchLists,
  apiShareList,
  loginViaUI,
  logoutViaUI,
  uniqueEmail,
  E2E_PASSWORD,
} from './helpers';
import type { Page } from '@playwright/test';

/**
 * Log in as a given user for UI navigation, logging out any currently active
 * UI session first (the auth page is a PublicRoute and bounces /auth while a
 * session is active).
 */
async function switchUser(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  const logout = page.locator('button.nav-logout');
  if (await logout.count()) {
    await logout.click();
    await page.waitForSelector('#auth-email', { timeout: 10000 });
  } else {
    await page.waitForSelector('#auth-email', { timeout: 10000 });
  }
  await loginViaUI(page, email, password);
}

/**
 * US5 (T033) — pending invitations, end to end.
 *
 * Sharing to an email with no account yet must not 404 (003 FR-010/003 SC-009);
 * when that email later registers, the invitation converts to access and
 * the new user lands on a list with the consent prompt pending (003 FR-011).
 */

test.describe('pending invitations (US5, T033)', () => {
  test('share to an unknown email succeeds; registering that email grants access and shows the consent prompt', async ({ page }) => {
    const ownerEmail = uniqueEmail('pi-owner');
    const inviteeEmail = uniqueEmail('pi-invitee');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Owner');
    const { list } = await apiCreateList(owner.cookie, { title: 'Pending Invitation List' });

    // Share with an email that has no account yet (003 FR-010: no 404).
    const shareRes = await apiShareList(owner.cookie, list.id, inviteeEmail);
    expect(shareRes.sharePermission.id).toBeTruthy();
    expect(shareRes.sharePermission.permission).toBe('shared');
    expect(shareRes.sharePermission.recipientUserId).toBeNull();

    // Registering the invitee converts the invitation (003 FR-011).
    const invitee = await apiRegister(inviteeEmail, E2E_PASSWORD, 'New Invitee');
    const { lists } = await apiFetchLists(invitee.cookie);
    expect(lists.some((l) => l.id === list.id)).toBe(true);

    // The invitee sees the list in the UI…
    await switchUser(page, inviteeEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByText('Pending Invitation List', { exact: false })).toBeVisible();

    // …and the consent prompt is pending for them (003 FR-022).
    await expect(page.getByRole('dialog', { name: /name disclosure/i })).toBeVisible();
  });

  test('a different user is not affected by the pending invitation, and the owner sees the pending invitee', async ({ page }) => {
    const ownerEmail = uniqueEmail('pi2-owner');
    const strangerEmail = uniqueEmail('pi2-stranger');
    const inviteeEmail = uniqueEmail('pi2-invitee');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Owner');
    const stranger = await apiRegister(strangerEmail, E2E_PASSWORD, 'Stranger');

    const { list } = await apiCreateList(owner.cookie, { title: 'Pending List Two' });
    await apiShareList(owner.cookie, list.id, inviteeEmail);

    // The pending invitee is not an account yet, so no one can log in as them —
    // a stranger with a different email has no access at all (003 FR-010).
    const { lists: strangerLists } = await apiFetchLists(stranger.cookie);
    expect(strangerLists.some((l) => l.id === list.id)).toBe(false);

    // The owner's sharing view lists the invitee by email (the owner's source
    // of truth) WITHOUT revealing registration status (T061, 003 FR-010/003 FR-021):
    // no "not registered yet" label, no separate pending-invitations section.
    await switchUser(page, ownerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    // The manage-sharing button has an explicit aria-label; the surrounding
    // avatar stack also carries a "Manage Sharing" accessible name, so target
    // the real button directly.
    await page.locator('button.share-btn[aria-label="Manage Sharing"]').click();
    await expect(page.getByText(inviteeEmail, { exact: false })).toBeVisible();
    await expect(page.getByText(/not registered yet/i)).toHaveCount(0);
    await expect(page.getByText(/Pending invitations/i)).toHaveCount(0);
  });

  test('re-sharing to the same unknown email does not create duplicates', async ({ page }) => {
    const ownerEmail = uniqueEmail('pi3-owner');
    const inviteeEmail = uniqueEmail('pi3-invitee');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Owner');
    const { list } = await apiCreateList(owner.cookie, { title: 'Pending List Three' });

    // Both shares must succeed with the same shape (no duplicate error).
    const first = await apiShareList(owner.cookie, list.id, inviteeEmail);
    const second = await apiShareList(owner.cookie, list.id, inviteeEmail);
    expect(first.sharePermission.permission).toBe('shared');
    expect(second.sharePermission.permission).toBe('shared');
  });
});
