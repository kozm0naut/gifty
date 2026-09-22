import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiShareList,
  apiClaimItem,
  apiPurchaseItem,
  loginViaUI,
  uniqueEmail,
} from './helpers';

test.describe('T037: Owner privacy visibility', () => {
  test('owner sees no claim/purchase state on their own list', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 2 items
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Privacy List',
    });
    const item1 = (await apiCreateItem(owner.token, list.id, { name: 'Espresso Machine' })).item;
    const item2 = (await apiCreateItem(owner.token, list.id, { name: 'Cookbook' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient claims + purchases item 1 via API
    await apiClaimItem(recipient.token, item1.id);
    await apiPurchaseItem(recipient.token, item1.id);

    // Owner logs in via UI
    await loginViaUI(page, ownerEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Espresso Machine');

    const espressoCard = page.locator('.card', { hasText: 'Espresso Machine' });
    const cookbookCard = page.locator('.card', { hasText: 'Cookbook' });

    // Owner sees NO state badges on any item (privacy boundary)
    await expect(espressoCard.locator('.badge')).toHaveCount(0);
    await expect(cookbookCard.locator('.badge')).toHaveCount(0);

    // Owner sees no claim/purchase buttons
    await expect(espressoCard.locator('button', { hasText: 'Claim' })).toHaveCount(0);
    await expect(espressoCard.locator('button', { hasText: 'Mark as Purchased' })).toHaveCount(0);
  });

  test('recipient sees correct claim/purchase state on shared list', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 2 items
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Privacy List',
    });
    const item1 = (await apiCreateItem(owner.token, list.id, { name: 'Espresso Machine' })).item;
    const item2 = (await apiCreateItem(owner.token, list.id, { name: 'Cookbook' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient claims + purchases item 1 via API
    await apiClaimItem(recipient.token, item1.id);
    await apiPurchaseItem(recipient.token, item1.id);

    // Recipient logs in via UI
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Espresso Machine');

    const espressoCard = page.locator('.card', { hasText: 'Espresso Machine' });
    const cookbookCard = page.locator('.card', { hasText: 'Cookbook' });

    // Recipient sees item 1 as "purchased · BY YOU"
    await expect(espressoCard.locator('.badge')).toContainText('purchased');
    await expect(espressoCard.locator('.badge')).toContainText('BY YOU');

    // Recipient sees the resolved purchaser identity (FR-009 / T047)
    await expect(espressoCard).toContainText('Purchased by E2E Recipient');

    // Recipient sees item 2 as "available"
    await expect(cookbookCard.locator('.badge')).toContainText('available');

    // Recipient sees the revert-purchase control (badge dismiss button) on item 1
    await expect(espressoCard.locator('button[title="Cancel"]')).toHaveCount(1);
  });
});
