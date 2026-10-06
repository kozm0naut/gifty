import { test, expect } from '@playwright/test';
import {
  loginViaUI,
  uniqueEmail,
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiShareList,
  apiClaimItem,
  apiFetchList,
  dismissConsentPromptIfPresent,
  E2E_PASSWORD,
} from './helpers';

/**
 * T046 [US7] — Account removal (FR-014, FR-028).
 *
 * UI flow: the user confirms an IRREVERSIBLE removal from the account area
 * (explicit confirmation naming the finality: owned lists permanently deleted,
 * claims on others' lists cleared, no undo / grace period); the app signs the
 * user out. Afterwards the account can no longer authenticate, the user's
 * recipient-side access to others' lists is removed, and any claim the user
 * held is cleared (item back to "available", seen by another recipient).
 * No undo / grace-period UI is offered.
 */
test.describe('Account removal (US7)', () => {
  test('removal is explicit, irreversible, clears the user everywhere, and offers no undo', async ({ page }) => {
    const ownerEmail = uniqueEmail('owner');
    const userEmail = uniqueEmail('user');
    const otherEmail = uniqueEmail('other');
    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Removal Owner');
    const user = await apiRegister(userEmail, E2E_PASSWORD, 'Removal User');
    const other = await apiRegister(otherEmail, E2E_PASSWORD, 'Removal Other');

    // The user owns a list of their own (covered in depth by the backend
    // cascade test, T045)…
    await apiCreateList(user.cookie, { title: 'My List' });
    // …and is a recipient on the owner's list, where they claim an item. A
    // second recipient ("other") survives so we can observe the cleared claim.
    const ownerList = (await apiCreateList(owner.cookie, { title: 'Owner List' })).list;
    const item = (await apiCreateItem(owner.cookie, ownerList.id, { name: 'Portable Speaker' })).item;
    await apiShareList(owner.cookie, ownerList.id, userEmail);
    await apiShareList(owner.cookie, ownerList.id, otherEmail);
    const claim = await apiClaimItem(user.cookie, item.id);
    expect(claim.item.state).toBe('claimed');

    // The user removes their account from the account area.
    await loginViaUI(page, userEmail, E2E_PASSWORD);
    // The account area is at /me (the /account path is the API session
    // bootstrap endpoint, not an SPA route).
    await page.goto('/me');
    await expect(page).toHaveURL(/\/me$/);

    // Danger action with an explicit, finality-naming confirmation.
    await page.getByRole('button', { name: /delete account/i }).click();
    const confirm = page.getByRole('button', { name: /permanently delete account/i });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/permanently/i);
    await confirm.click();

    // Signed out back to the sign-in screen; no undo / grace UI anywhere.
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.locator('body')).not.toContainText(/undo|grace period|restore account/i);

    // The account can no longer authenticate (credential no longer valid).
    await page.fill('#auth-email', userEmail);
    await page.fill('#auth-password', E2E_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    await expect(page.locator('.alert-error')).toContainText(/invalid email or password/i);

    // The user's recipient-side access to the owner's list is gone. The
    // removal cascade revokes the user's sessions, so the stale cookie now
    // yields 401 ("account is no longer active"); a 403 (permission row
    // deleted) is also an acceptable form of "no longer a recipient".
    await expect(apiFetchList(user.cookie, ownerList.id)).rejects.toThrow(/401|403|no longer active|do not have access/i);

    // A surviving recipient sees the item back to "available" — the user's
    // claim was cleared, and their name is no longer shown.
    await loginViaUI(page, otherEmail, E2E_PASSWORD);
    await page.goto(`/list/${ownerList.id}`);
    await dismissConsentPromptIfPresent(page);
    const itemCard = page.locator('.item-card', { hasText: 'Portable Speaker' });
    await expect(itemCard).toContainText(/available/i);
    await expect(itemCard).not.toContainText('Removal User');

    // The owner's own world is unaffected: their list still exists.
    const ownerLists = await apiFetchList(owner.cookie, ownerList.id);
    expect(ownerLists.list.id).toBe(ownerList.id);
  });
});
