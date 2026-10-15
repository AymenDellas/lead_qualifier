import { test, expect } from '@playwright/test';
import { draft, input } from '../fixtures';
import { fingerprint } from '../../../src/lib/copy-studio/shared/contracts';

const coachBio = 'Jordan Lee is a positioning consultant for independent business coaches. Jordan reviews customer conversations to clarify their messaging.';
const about = { id: 'about', headline: 'About Jordan Lee', body: 'I’m Jordan Lee, a positioning consultant for independent business coaches. My work starts with your actual customer conversations.', bullets: [], cta: '' };

test('approved coach facts persist and the About me section reaches preview and design prompt', async ({ page }) => {
  await page.route('**/api/copy-studio/onboardings', route => route.fulfill({ json: { onboardings: [] } }));
  let sent: any;
  await page.route('**/api/copy-studio/generate', route => {
    sent = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { draft: { ...draft, sections: draft.sections.map(section => section.id === 'about' ? about : section) }, issues: [] } })}\n\n` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByText('Give the copy substance', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Coach background & credentials', exact: false }).fill(coachBio);
  await page.getByRole('button', { name: 'Generate my copy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Jordan Lee', exact: true })).toBeVisible();
  expect(sent.brief.coachBio).toBe(coachBio);
  await page.locator('.copy-section').filter({ hasText: 'About Jordan Lee' }).screenshot({ path: 'tmp/copy-studio-screenshots/about-section-desktop.png' });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.preview-about')).toContainText(about.body);
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(page.getByLabel('Landing page design prompt', { exact: true })).toHaveValue(/About Jordan Lee/);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.getByText('Give the copy substance', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Coach background & credentials', exact: false })).toHaveValue(coachBio);
  await expect(page.getByRole('heading', { name: 'About Jordan Lee', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.copy-section').filter({ hasText: 'About Jordan Lee' }).screenshot({ path: 'tmp/copy-studio-screenshots/about-section-mobile.png' });
});

test('legacy project imports retain their copy and ask for regeneration to adopt the new outline', async ({ page }) => {
  const old = { ...draft, sections: draft.sections.filter(section => section.id !== 'about') };
  const backup = { id: 'legacy', name: 'Saved legacy draft', updatedAt: '', ...input, source: null, result: { draft: old, issues: [] }, generatedFrom: fingerprint(input), history: [] };
  await page.route('**/api/copy-studio/onboardings', route => route.fulfill({ json: { onboardings: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await page.locator('.copy-studio input[type=file]').setInputFiles({ name: 'legacy.copy-studio.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByText('This draft uses the earlier template.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: draft.sections[0].headline, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit The first impression', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Design prompt', exact: true }).click();
  await expect(page.getByLabel('Landing page design prompt', { exact: true })).toHaveValue(new RegExp(draft.sections[0].headline));
  await expect(page.locator('.copy-studio').getByRole('alert')).toHaveCount(0);
});
