import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { draft } from '../fixtures';

async function generate(page: Page) {
  await page.route('**/api/copy-studio/onboardings', route => route.fulfill({ json: { onboardings: [] } }));
  await page.route('**/api/copy-studio/generate', route => route.fulfill({
    contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`,
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Design prompt', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.getByRole('heading', { name: draft.sections[0].headline, exact: true })).toBeVisible();
}

test('a design prompt is ready with the copy, follows edits and undo, downloads, and survives reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await generate(page);
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  const field = page.getByLabel('Landing page design prompt', { exact: true });
  const original = await field.inputValue();
  expect(original).toContain(draft.sections[0].headline);
  expect(original).toContain('No navbar');
  expect(original).toContain('No mesh gradients');
  expect(original).toContain('No repeated cards');
  await page.getByRole('button', { name: 'Copy design prompt', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(original);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download prompt', exact: true }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('the-clear-offer-sprint-design-prompt.txt');
  expect(await readFile((await file.path())!, 'utf8')).toBe(original);
  await page.locator('.draft-panel').screenshot({ path: 'tmp/copy-studio-screenshots/design-prompt-desktop.png' });
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByRole('button', { name: 'Edit The first impression', exact: true }).click();
  await page.getByLabel('Headline', { exact: true }).fill('A final headline for the designer');
  await page.getByRole('button', { name: 'Save section', exact: true }).click();
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(field).toHaveValue(/A final headline for the designer/);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByRole('button', { name: 'Undo the last draft change', exact: true }).click();
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(field).toHaveValue(original);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(field).toHaveValue(original);
});

test('mobile prompt controls fit, and changing the brief does not mix an ungenerated offer into the prompt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await generate(page);
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('UNGENERATED_NEW_OFFER');
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(page.getByText('Your brief has changed.', { exact: true })).toBeVisible();
  const prompt = await page.getByLabel('Landing page design prompt', { exact: true }).inputValue();
  expect(prompt).toContain('The Clear Offer Sprint');
  expect(prompt).not.toContain('UNGENERATED_NEW_OFFER');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Copy design prompt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download prompt', exact: true })).toBeVisible();
  await page.locator('.design-prompt-panel').screenshot({ path: 'tmp/copy-studio-screenshots/design-prompt-mobile.png' });
});
