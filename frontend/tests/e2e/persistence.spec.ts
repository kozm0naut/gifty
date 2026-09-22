import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiShareList,
  apiClaimItem,
  loginViaUI,
  logoutViaUI,
  uniqueEmail,
} from './helpers';

test.describe('T044: Persistence across sessions', () => {
  test('claim state persists after logout and login', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 1 item
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Persistence List',
    });
    const item = (await apiCreateItem(owner.token, list.id, { name: 'Sneakers' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient logs in via UI and claims the item
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Sneakers');

    const card = page.locator('.card', { hasText: 'Sneakers' });
    await card.locator('button', { hasText: 'Claim' }).click();
    await expect(card.locator('.badge')).toContainText('claimed');
    await expect(card.locator('.badge')).toContainText('BY YOU');

    // Recipient logs out
    await logoutViaUI(page);

    // Recipient logs back in
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Sneakers');

    // The claim state should persist
    const cardAfter = page.locator('.card', { hasText: 'Sneakers' });
    await expect(cardAfter.locator('.badge')).toContainText('claimed');
    await expect(cardAfter.locator('.badge')).toContainText('BY YOU');
  });

  test('owner privacy persists after logout and login', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 1 item
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Persistence List',
    });
    const item = (await apiCreateItem(owner.token, list.id, { name: 'Cookbook' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient claims the item via API
    await apiClaimItem(recipient.token, item.id);

    // Owner logs in via UI and sees no state
    await loginViaUI(page, ownerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Cookbook');

    const card = page.locator('.card', { hasText: 'Cookbook' });
    await expect(card.locator('.badge')).toHaveCount(0);

    // Owner logs out
    await logoutViaUI(page);

    // Owner logs back in
    await loginViaUI(page, ownerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Cookbook');

    // Owner still sees no state (privacy boundary persists)
    const cardAfter = page.locator('.card', { hasText: 'Cookbook' });
    await expect(cardAfter.locator('.badge')).toHaveCount(0);
  });
});
