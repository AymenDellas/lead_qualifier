import { test, expect } from '@playwright/test';

test('live provider connects, generates a complete page, and exports it', async ({ page }) => {
  test.skip(
    process.env.LIVE_AI !== '1',
    'Explicitly opt in to paid provider requests with LIVE_AI=1.',
  );
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.locator('.copy-tools > summary').click();
  await page.getByRole('button', { name: 'Setup & storage' }).click();
  await page.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(page.getByText('AI connected', { exact: true })).toBeVisible({ timeout: 100000 });
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.locator('.copy-section')).toHaveCount(8, { timeout: 180000 });
  await expect(page.locator('.strategy-card')).toBeVisible();
  const headline = await page.locator('.copy-section').first().getByRole('heading').textContent();
  expect(headline?.trim().length).toBeGreaterThan(10);
  await expect(page.locator('.copy-studio').getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/live-browser.png', fullPage: true });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('the-clear-offer-sprint.md');
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.locator('.copy-section')).toHaveCount(8);
  expect(await page.locator('.copy-section').first().getByRole('heading').textContent()).toBe(
    headline,
  );
  expect(errors).toEqual([]);
});
