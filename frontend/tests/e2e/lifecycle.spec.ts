import { test, expect } from '@playwright/test';
import {
  E2E_PASSWORD,
  apiRegister,
  apiCreateList,
  apiCreateItem,
  apiShareList,
  apiFetchSharePermissions,
  apiRevokePermission,
  loginViaUI,
  uniqueEmail,
} from './helpers';

test.describe('T025: Lifecycle edge cases (claim, cancel, purchase, reset)', () => {
  test('full lifecycle: claim → cancel → claim → purchase → revert purchase → cancel', async ({ page }) => {
    // Accept all confirm dialogs (revert claim / revert purchase)
    page.on('dialog', (dialog) => dialog.accept());

    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 1 item
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Lifecycle List',
    });
    const item = (await apiCreateItem(owner.token, list.id, { name: 'Robot Vacuum' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient logs in via UI
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Robot Vacuum');

    const card = page.locator('.card', { hasText: 'Robot Vacuum' });

    // 1. Claim
    await card.locator('button', { hasText: 'Claim' }).click();
    await expect(card.locator('.badge')).toContainText('claimed');
    await expect(card.locator('.badge')).toContainText('BY YOU');

    // 2. Revert claim (confirm dialog auto-accepted)
    await card.locator('button[title="Cancel"]').click();
    await expect(card.locator('.badge')).toContainText('available');

    // 3. Claim again
    await card.locator('button', { hasText: 'Claim' }).click();
    await expect(card.locator('.badge')).toContainText('claimed');
    await expect(card.locator('.badge')).toContainText('BY YOU');

    // 4. Mark purchased
    await card.locator('button', { hasText: 'Mark as Purchased' }).click();
    await expect(card.locator('.badge')).toContainText('purchased');
    await expect(card.locator('.badge')).toContainText('BY YOU');

    // 5. Revert purchase (confirm dialog auto-accepted)
    await card.locator('button[title="Cancel"]').click();
    await expect(card.locator('.badge')).toContainText('claimed');
    await expect(card.locator('.badge')).toContainText('BY YOU');

    // 6. Revert claim (confirm dialog auto-accepted)
    await card.locator('button[title="Cancel"]').click();
    await expect(card.locator('.badge')).toContainText('available');
  });
});

test.describe('T038: Lifecycle & permission UX', () => {
  test('owner revokes recipient access, recipient loses access', async ({ page }) => {
    // Setup: register owner + recipient via API
    const ownerEmail = uniqueEmail('owner');
    const recipientEmail = uniqueEmail('recipient');

    const owner = await apiRegister(ownerEmail, E2E_PASSWORD, 'E2E Owner');
    const recipient = await apiRegister(recipientEmail, E2E_PASSWORD, 'E2E Recipient');

    // Owner creates a list with 1 item
    const { list } = await apiCreateList(owner.token, {
      title: 'E2E Revoke List',
    });
    const item = (await apiCreateItem(owner.token, list.id, { name: 'Throw Blanket' })).item;

    // Owner shares the list with the recipient
    await apiShareList(owner.token, list.id, recipientEmail);

    // Recipient logs in via UI and sees the list
    await loginViaUI(page, recipientEmail, E2E_PASSWORD);
    await page.goto(`/list/${list.id}`);
    await page.waitForSelector('text=Throw Blanket');

    // Owner revokes recipient's access via API
    const { permissions } = await apiFetchSharePermissions(owner.token, list.id);
    const permission = permissions.find((p) => p.recipientUserId === recipient.user.id);
    if (permission) {
      await apiRevokePermission(owner.token, list.id, permission.id);
    }

    // Recipient tries to access the list again
    await page.goto(`/list/${list.id}`);

    // The list should show a 403 error
    await expect(page.locator('.alert-error')).toContainText('You do not have access to this list');
  });
});
