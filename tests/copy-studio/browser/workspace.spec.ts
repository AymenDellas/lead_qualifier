import { test, expect } from '@playwright/test';
import { draft } from '../fixtures';

test('project backups import through the dashboard project menu', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project backup' }).click();
  const backup = await downloading;
  expect(backup.suggestedFilename()).toBe('the-clear-offer-sprint.copy-studio.json');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('');
  await page.locator('.copy-studio input[type=file]').setInputFiles((await backup.path())!);
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('The Clear Offer Sprint');
  await expect(page.getByRole('combobox', { name: 'Choose a copy project' }).locator('option')).toHaveCount(4);
  await page.getByRole('combobox', { name: 'Choose a copy project' }).selectOption({ index: 1 });
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('');
});

test('blank brief is validated, sample generates, edits undo, export and reload preserve work', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/copy-studio/generate', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`,
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByText('Custom Prompt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('AI Consultation', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.locator('.copy-studio').getByRole('alert')).toContainText('five essential');
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(
    'The Clear Offer Sprint',
  );
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'tmp/copy-studio-screenshots/generated-draft.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Edit The first impression', exact: true }).click();
  await page.getByLabel('Headline', { exact: true }).fill('A clearer offer starts here');
  await page.getByRole('button', { name: 'Save section' }).click();
  await expect(page.getByRole('heading', { name: 'A clearer offer starts here' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo the last draft change' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.page-preview')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('the-clear-offer-sprint.md');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(
    'The Clear Offer Sprint',
  );
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('provider errors preserve existing content and can be retried', async ({ page }) => {
  let count = 0;
  await page.route('**/api/copy-studio/generate', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(++count === 1 ? { type: 'error', error: 'The AI provider is busy. Please retry.' } : { type: 'result', result: { draft, issues: [] } })}\n\n`,
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.locator('.copy-studio').getByRole('alert')).toContainText('provider is busy');
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(
    'The Clear Offer Sprint',
  );
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
});

test('source facts need explicit selection before replacing user input', async ({ page }) => {
  await page.route('**/api/copy-studio/import', (route) =>
    route.fulfill({
      json: {
        source: {
          title: 'Example offer',
          url: 'https://example.com',
          text: 'A different offer.',
          headings: [],
        },
        extraction: {
          fields: { offerName: 'Imported offer', audience: 'Business coaches' },
          evidence: [{ field: 'offerName', quote: 'A different offer.' }],
          warnings: [],
        },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('Keep my name');
  await page.getByRole('button', { name: 'Prefill from page' }).click();
  await page
    .locator('.copy-studio')
    .getByLabel('Page URL', { exact: true })
    .fill('https://example.com');
  await page.getByRole('button', { name: 'Read page and prefill' }).click();
  await expect(page.getByRole('heading', { name: 'Review your page prefill' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Offer name/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Who is it for/ })).toBeChecked();
  await page.getByRole('button', { name: 'Apply 1 field', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(
    'Keep my name',
  );
  await expect(page.getByRole('textbox', { name: 'Who is it for?', exact: true })).toHaveValue(
    'Business coaches',
  );
});

test('mobile layout fits the dashboard and retains work across tabs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('Keep this draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Clean URLs', exact: true }).click();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(
    'Keep this draft',
  );
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/mobile.png', fullPage: true });
});

test('desktop workspace screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'tmp/copy-studio-screenshots/desktop-workspace.png',
    fullPage: true,
  });
});

test('brief changes mark a draft stale and prevent mismatched section revisions', async ({
  page,
}) => {
  await page.route('**/api/copy-studio/generate', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`,
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('A changed offer');
  await expect(page.getByText('Your brief has changed.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Edit The first impression', exact: true }),
  ).toBeDisabled();
});

test('corrupt storage is preserved and automatic overwrites are paused', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('compel:copy-studio:library:v2', 'corrupt-but-recoverable'),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.locator('.copy-studio').getByRole('alert')).toContainText(
    'Automatic saving is paused',
  );
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('Temporary edits');
  expect(await page.evaluate(() => localStorage.getItem('compel:copy-studio:library:v2'))).toBe(
    'corrupt-but-recoverable',
  );
  await expect(page.getByRole('button', { name: 'Download saved data' })).toBeVisible();
});

test('section revision keeps other sections, and connection test reports success', async ({
  page,
}) => {
  await page.route('**/api/copy-studio/generate', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`,
    }),
  );
  await page.route('**/api/copy-studio/revise', (route) =>
    route.fulfill({
      json: {
        section: { ...draft.sections[0], headline: 'Explain your offer with confidence' },
        issues: [],
      },
    }),
  );
  await page.route('**/api/copy-studio/connection', (route) =>
    route.fulfill({ json: { connected: true, model: 'test-model' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Rewrite The first impression', { exact: true }).click();
  await page.getByRole('button', { name: 'Make it clearer' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Explain your offer with confidence' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: draft.sections[1].headline, exact: true }),
  ).toBeVisible();
  await page.locator('.copy-tools > summary').click();
  await page.getByRole('button', { name: 'Setup & storage' }).click();
  await page.getByRole('button', { name: 'Test AI connection' }).click();
  await expect(page.getByText('AI connected', { exact: true })).toBeVisible();
});

test('cancelling regeneration keeps the last complete draft', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/copy-studio/generate', async (route) => {
    calls++;
    if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 2000));
    await route
      .fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n`,
      })
      .catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Generate a new draft' }).click();
  await page.getByRole('button', { name: 'Cancel request', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Generate a new draft' })).toBeEnabled();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Request cancelled. Your previous draft is unchanged.', { exact: true }),
  ).toBeVisible();
});

test('generation continues across tabs without restyling the dashboard navigation', async ({
  page,
}) => {
  await page.route('**/api/copy-studio/generate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ type: 'result', result: { draft, issues: [] } }) + '\n\n',
    });
  });
  await page.goto('/');
  const rail = page.locator('aside.sidebar');
  const before = await rail.evaluate((element) => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
    width: element.getBoundingClientRect().width,
  }));
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await page.getByRole('button', { name: 'Clean URLs', exact: true }).click();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true }),
  ).toBeVisible();
  expect(
    await rail.evaluate((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      width: element.getBoundingClientRect().width,
    })),
  ).toEqual(before);
});
