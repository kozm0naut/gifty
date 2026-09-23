import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiShareList,
  apiClaimItem,
  loginViaUI,
  uniqueEmail,
} from './helpers';

test.describe('T035: Share & claim UX success flows', () => {
  test('owner and recipient complete share → claim → purchase flow', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 2 items
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Birthday List',
    });
    const item1 = (await apiCreateItem(owner.token, list.id, { name: 'Espresso Machine' })).item;
    const item2 = (await apiCreateItem(owner.token, list.id, { name: 'Wireless Headphones' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient logs in via UI and claims item 1
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Espresso Machine');

    const espressoCard = page.locator('.card', { hasText: 'Espresso Machine' });
    await espressoCard.locator('button', { hasText: 'Claim' }).click();

    // Verify the item is now "claimed · BY YOU"
    await expect(espressoCard.locator('.badge')).toContainText('claimed');
    await expect(espressoCard.locator('.badge')).toContainText('BY YOU');

    // Recipient marks the item as purchased
    await espressoCard.locator('button', { hasText: 'Purchased' }).click();
    await expect(espressoCard.locator('.badge')).toContainText('purchased');
    await expect(espressoCard.locator('.badge')).toContainText('BY YOU');

    // Verify the second item is still available
    const headphonesCard = page.locator('.card', { hasText: 'Wireless Headphones' });
    await expect(headphonesCard.locator('.badge')).toContainText('available');
  });
});

test.describe('T036: Duplicate-claim conflict messaging', () => {
  test('second recipient sees item as claimed with no Claim button', async ({ page }) => {
    // Setup: register owner + 2 recipients via API
    const ownerEmail = uniqueEmail('owner');
    const recipient1Email = uniqueEmail('recipient1');
    const recipient2Email = uniqueEmail('recipient2');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient1 = await apiRegister(recipient1Email, E2E_PASSWORD, 'E2E Recipient 1');
    const recipient2 = await apiRegister(recipient2Email, E2E_PASSWORD, 'E2E Recipient 2');

    // Owner creates a list with 1 item
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Conflict List',
    });
    const item1 = (await apiCreateItem(owner.token, list.id, { name: 'Scented Candle Set' })).item;

    // Owner shares the list with both recipients
    await apiShareList(owner.token, list.id, recipient1Email);
    await apiShareList(owner.token, list.id, recipient2Email);

    // Recipient 1 claims the item via API
    await apiClaimItem(recipient1.token, item1.id);

    // Recipient 2 logs in via UI and sees the item as claimed
    await loginViaUI(page, recipient2Email, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Scented Candle Set');

    const candleCard = page.locator('.card', { hasText: 'Scented Candle Set' });

    // The item should show as "claimed" (not "BY YOU")
    await expect(candleCard.locator('.badge')).toContainText('claimed');
    await expect(candleCard.locator('.badge')).not.toContainText('BY YOU');

    // There should be no "Claim" button (item is not available)
    await expect(candleCard.locator('button', { hasText: 'Claim' })).toHaveCount(0);
  });
});
