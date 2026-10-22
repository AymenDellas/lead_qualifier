import { test, expect, type Page } from '@playwright/test';
import { briefSchema, copyContextSchema } from '../../../src/lib/copy-studio/shared/contracts';
import { input, draft } from '../fixtures';

const originalText = 'Say it straight. Make it useful. Our original page speaks with short sentences and direct questions. Your offer deserves to sound like you, with a clear reason to take the next step. END_OF_ORIGINAL_COPY';
const source = { title: 'Pasted page copy', url: '', headings: [], text: originalText };
const onboarding = {
  id: 'reference-client', revision: 1, clientName: 'Example Coach', businessName: 'Example Coaching', projectName: 'Example funnel',
  updatedAt: '2026-10-12T12:00:00Z', website: 'https://coach.example', landingPageUrl: 'https://coach.example/offer',
  formStatus: 'COMPLETE', template: 'direct_to_call', brief: briefSchema.parse(input.brief), context: copyContextSchema.parse({ avoid: 'Leave out the group course' }),
};
async function openStudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
}
async function attach(page: Page) {
  await page.getByRole('button', { name: 'Prefill from page' }).click();
  await page.getByRole('button', { name: 'Paste text', exact: true }).click();
  await page.getByLabel('Visible page copy', { exact: true }).fill(originalText);
  await page.getByRole('button', { name: 'Add as reference only', exact: true }).click();
  await expect(page.getByLabel('How to use the original copy')).toHaveValue('preserve_voice');
}

test('onboarding, full original copy, and requested changes travel together through generation, rewrites, and reload', async ({ page }) => {
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: [onboarding] } }));
  await page.route('**/api/copy-studio/reference', (route) => route.fulfill({ json: source }));
  let extractionCalls = 0;
  await page.route('**/api/copy-studio/import', (route) => { extractionCalls++; return route.fulfill({ status: 500, json: { error: 'Extraction should be optional' } }); });
  const bodies: any[] = [];
  await page.route('**/api/copy-studio/generate', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n` });
  });
  let revision: any;
  await page.route('**/api/copy-studio/revise', (route) => {
    revision = route.request().postDataJSON();
    return route.fulfill({ json: { section: draft.sections[0], issues: [] } });
  });
  await openStudio(page);
  await page.getByRole('button', { name: 'Prefill from onboarding' }).click();
  await page.getByRole('radio', { name: /Example Coach/ }).check();
  await expect(page.getByRole('checkbox', { name: /Offer name/ })).toBeChecked();
  await page.getByRole('button', { name: 'Use this onboarding' }).click();
  await attach(page);
  expect(extractionCalls).toBe(0);
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(input.brief.offerName);
  await page.getByText('View original copy', { exact: false }).click();
  await expect(page.getByRole('textbox', { name: 'Original copy reference', exact: true })).toHaveValue(originalText);
  await page.getByText('Creative direction & client notes', { exact: true }).click();
  await page.getByLabel('What should this page do differently?').fill('Keep the voice and sharpen the booking invitation');
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/full-reference-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true })).toBeVisible();
  expect(bodies[0].reference.text).toBe(originalText);
  expect(bodies[0].reference.tone).toBe('preserve');
  expect(bodies[0].brief.offerName).toBe(input.brief.offerName);
  expect(bodies[0].context.direction).toBe('Keep the voice and sharpen the booking invitation');
  expect(bodies[0].context.avoid).toBe('Leave out the group course');
  await page.getByLabel('Rewrite The first impression', { exact: true }).click();
  await page.getByRole('button', { name: 'Make it clearer' }).first().click();
  await expect(page.getByText('Section updated.', { exact: false })).toBeVisible();
  expect(revision.reference.text).toBe(originalText);
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByLabel('How to use the original copy')).toHaveValue('preserve_voice');
  await page.getByLabel('How to use the original copy').selectOption('off');
  await page.getByRole('button', { name: 'Generate a new draft', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(page.getByText('Your draft is ready.', { exact: false })).toBeVisible();
  expect(bodies[1].reference).toBeUndefined();
  await page.getByLabel('How to use the original copy').selectOption('rework_voice');
  await page.getByRole('button', { name: 'Generate a new draft', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(3);
  await expect(page.getByText('Your draft is ready.', { exact: false })).toBeVisible();
  expect(bodies[2].reference.tone).toBe('rework');
});

test('an existing imported page is also sent as a full reference without reimporting', async ({ page }) => {
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: [] } }));
  await page.route('**/api/copy-studio/import', (route) => route.fulfill({ json: {
    source, extraction: { fields: { audience: input.brief.audience }, evidence: [{ field: 'audience', quote: 'Your offer deserves to sound like you' }], warnings: [] },
  } }));
  let sent: any;
  await page.route('**/api/copy-studio/generate', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n` });
  });
  await openStudio(page);
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Prefill from page' }).click();
  await page.getByRole('button', { name: 'Paste text', exact: true }).click();
  await page.getByLabel('Visible page copy').fill(originalText);
  await page.getByRole('button', { name: 'Read page and prefill', exact: true }).click();
  await page.getByRole('checkbox', { name: /Who is it for/ }).check();
  await page.getByRole('button', { name: 'Apply 1 field', exact: true }).click();
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true })).toBeVisible();
  expect(sent.reference.text).toBe(originalText);
});

test('mobile reference controls fit and a failed replacement preserves the previous reference and brief', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: [] } }));
  let failed = false;
  await page.route('**/api/copy-studio/reference', (route) => failed
    ? route.fulfill({ status: 503, json: { error: 'This page could not be read. Paste its visible copy.' } })
    : route.fulfill({ json: source }));
  await openStudio(page);
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  const offerBefore = await page.getByRole('textbox', { name: 'Offer name', exact: true }).inputValue();
  await attach(page);
  await page.getByText('View original copy', { exact: false }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/full-reference-mobile.png', fullPage: true });
  failed = true;
  await page.locator('.reference-heading').getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByRole('button', { name: 'Use full copy as reference', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be read');
  await page.getByRole('button', { name: 'Close import' }).click();
  await expect(page.getByRole('textbox', { name: 'Original copy reference', exact: true })).toHaveValue(originalText);
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue(offerBefore);
});
