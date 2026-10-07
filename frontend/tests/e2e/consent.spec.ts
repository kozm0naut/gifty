import { test, expect } from '@playwright/test';
import {
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiClaimItem,
  apiShareList,
  loginViaUI,
  logoutViaUI,
  uniqueEmail,
  E2E_PASSWORD,
} from './helpers';
import type { Page } from '@playwright/test';

/**
 * Log in as a given user for UI navigation, logging out any currently active
 * UI session first. The auth page is a PublicRoute, so navigating to /auth
 * while another session is active redirects to / and the login form never
 * renders — hence the logout-first switch.
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
 * US5 (T033) — consent-gated identity disclosure, end to end.
 *
 * Flow: two recipients (A claims, B views) + owner. A's name must be
 * invisible to B until A consents to name disclosure on the list; the
 * consent prompt appears once, and A can flip consent back and forth via
 * the self-serve control in the Sharing section (003 FR-021/003 FR-022/003 FR-023/003 FR-024,
 * 003 SC-008).
 */

test.describe('consent-gated identity disclosure (US5, T033)', () => {
  test('reveal → name visible to co-recipients; prompt not repeated; self-serve control re-hides', async ({ page }) => {
    const ownerEmail = uniqueEmail('c1-owner');
    const claimerEmail = uniqueEmail('c1-claimer');
    const viewerEmail = uniqueEmail('c1-viewer');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Owner');
    const claimer = await apiRegister(claimerEmail, E2E_PASSWORD, 'Claimer');
    const viewer = await apiRegister(viewerEmail, E2E_PASSWORD, 'Viewer');

    const { list } = await apiCreateList(owner.cookie, { title: 'Consent List' });
    await apiShareList(owner.cookie, list.id, claimerEmail);
    await apiShareList(owner.cookie, list.id, viewerEmail);
    const { item } = await apiCreateItem(owner.cookie, list.id, { name: 'Secret Gift' });

    // Claimer claims the item (before consenting to disclosure).
    await apiClaimItem(claimer.cookie, item.id);

    // Viewer: the claim state is visible, but the claimant identity is not (003 FR-024).
    await switchUser(page, viewerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByText('claimed', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Claimer')).toHaveCount(0);

    // Claimer opens the list: the one-time consent prompt appears (003 FR-022).
    await switchUser(page, claimerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    const prompt = page.getByRole('dialog', { name: /name disclosure/i });
    await expect(prompt).toBeVisible();

    // Affirm → the claimer's name becomes visible to the viewer (003 FR-022/003 FR-024).
    await prompt.getByRole('button', { name: /reveal/i }).click();
    await expect(prompt).toBeHidden();

    await switchUser(page, viewerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByText('Claimer', { exact: false }).first()).toBeVisible();

    // Re-opening: the prompt is NOT repeated (consent is no longer pending).
    await switchUser(page, claimerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByRole('dialog', { name: /name disclosure/i })).toHaveCount(0);

    // Self-serve control (003 FR-023): the claimer reopens the consent prompt…
    const toggle = page.getByRole('button', { name: /hide my name/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    // …and confirms "Keep me anonymous" in the modal to hide their name again.
    const prompt2 = page.getByRole('dialog', { name: /name disclosure/i });
    await expect(prompt2).toBeVisible();
    await prompt2.getByRole('button', { name: /keep me anonymous/i }).click();
    await expect(prompt2).toBeHidden();

    // …and the viewer sees the placeholder again.
    await switchUser(page, viewerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByText('Claimer', { exact: false })).toHaveCount(0);
  });

  test('decline → prompt not repeated and the placeholder persists for co-recipients', async ({ page }) => {
    const ownerEmail = uniqueEmail('c2-owner');
    const claimerEmail = uniqueEmail('c2-claimer');
    const viewerEmail = uniqueEmail('c2-viewer');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'Owner');
    const claimer = await apiRegister(claimerEmail, E2E_PASSWORD, 'Hidden Claimer');
    const viewer = await apiRegister(viewerEmail, E2E_PASSWORD, 'Viewer');

    const { list } = await apiCreateList(owner.cookie, { title: 'Decline List' });
    await apiShareList(owner.cookie, list.id, claimerEmail);
    await apiShareList(owner.cookie, list.id, viewerEmail);
    const { item } = await apiCreateItem(owner.cookie, list.id, { name: 'Anonymous Gift' });

    await apiClaimItem(claimer.cookie, item.id);

    // Claimer declines disclosure (003 FR-021/003 FR-022).
    await switchUser(page, claimerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    const prompt = page.getByRole('dialog', { name: /name disclosure/i });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: /keep me anonymous|decline/i }).click();
    await expect(prompt).toBeHidden();

    // The prompt is not repeated on subsequent visits…
    await page.goto(`/list/${list.id}`);
    await expect(page.getByRole('dialog', { name: /name disclosure/i })).toHaveCount(0);

    // …and the viewer never learns the claimant's identity (003 SC-008).
    await switchUser(page, viewerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await expect(page.getByText('claimed', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Hidden Claimer', { exact: false })).toHaveCount(0);
  });
});
