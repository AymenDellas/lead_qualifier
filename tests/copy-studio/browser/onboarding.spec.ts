import { test, expect } from '@playwright/test';
import { briefSchema, copyContextSchema } from '../../../src/lib/copy-studio/shared/contracts';
import { draft } from '../fixtures';

const onboarding = {
  id: 'client-a', revision: 3, clientName: 'Example Coach', businessName: 'Example Coaching', projectName: 'Executive funnel',
  updatedAt: '2026-10-12T12:00:00Z', website: 'https://coach.example', landingPageUrl: 'https://coach.example/executive',
  formStatus: 'COMPLETE', template: 'direct_to_call',
  brief: briefSchema.parse({ offerName: 'Executive Program', description: 'Six individual coaching sessions', audience: 'Newly promoted executives', problem: 'Managing former peers', outcome: 'Set clear expectations with their team' }),
  context: copyContextSchema.parse({ mustKeep: 'Use the approved program name', avoid: 'Exclude the group course' }),
};

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
}

test('onboarding is chosen in the studio, reviewed, saved, and sent with generation direction', async ({ page }) => {
  let records = [onboarding];
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: records } }));
  let body: Record<string, any> | undefined;
  await page.route('**/api/copy-studio/generate', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { draft, issues: [] } })}\n\n` });
  });
  await openStudio(page);
  await page.getByRole('button', { name: 'Choose client onboarding' }).click();
  await page.getByLabel('Find a client or paste their page URL').fill('https://www.coach.example/executive?utm_source=test');
  await expect(page.getByText('Matches this page’s website')).toBeVisible();
  await page.getByRole('radio', { name: /Example Coach/ }).check();
  await expect(page.getByRole('checkbox', { name: /Offer name/ })).toBeChecked();
  await page.getByRole('button', { name: 'Use this onboarding' }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('Executive Program');
  await expect(page.getByRole('textbox', { name: 'Who is it for?', exact: true })).toHaveValue('Newly promoted executives');
  await page.getByText('Creative direction & client notes', { exact: true }).click();
  await page.getByLabel('What should this page do differently?').fill('Position the call as a fit assessment');
  await expect(page.getByLabel('What should we avoid?')).toHaveValue('Exclude the group course');
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/onboarding-connected-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Generate my copy' }).click();
  await expect(page.getByRole('heading', { name: 'Make your offer easier to understand', exact: true })).toBeVisible();
  expect(body?.brief.offerName).toBe('Executive Program');
  expect(body?.context.direction).toBe('Position the call as a fit assessment');
  expect(body?.context.mustKeep).toBe('Use the approved program name');
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.locator('.onboarding-trigger')).toContainText('Example Coach');
  records = [{ ...onboarding, revision: 4 }];
  await page.locator('.onboarding-trigger').click();
  await page.getByRole('button', { name: 'Close onboarding picker' }).click();
  await expect(page.getByText('New onboarding answers are available.', { exact: false })).toBeVisible();
});

test('offer modes keep independent facts and persist them across reload', async ({ page }) => {
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: [] } }));
  await openStudio(page);
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('radio', { name: 'A new offer', exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('A new executive retreat');
  await page.getByRole('radio', { name: 'My current offer', exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('The Clear Offer Sprint');
  await page.getByRole('radio', { name: 'One specific offer', exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('');
  await page.getByRole('radio', { name: 'A new offer', exact: true }).check();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('A new executive retreat');
  await page.reload();
  await page.getByRole('button', { name: 'Copy Studio', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('A new executive retreat');
  await page.getByRole('radio', { name: 'My current offer', exact: true }).check();
  await page.getByText('Terms, voice & next step', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Price & payment terms', exact: false })).toHaveValue('$750 for the two-week sprint');
});

test('multi-offer pages require a choice and switching offers leaves the original project intact', async ({ page }) => {
  await page.route('**/api/copy-studio/onboardings', (route) => route.fulfill({ json: { onboardings: [onboarding] } }));
  const source = { title: 'Coaching offers', url: 'https://coach.example/executive', headings: [], text: 'Executive Program: six individual coaching sessions. Group Course: four weekly workshops. Coaching offers for newly promoted executives and team leaders.' };
  const offers = [
    { name: 'Executive Program', summary: 'Individual coaching', quote: 'Executive Program: six individual coaching sessions.' },
    { name: 'Group Course', summary: 'Group workshops', quote: 'Group Course: four weekly workshops.' },
  ];
  let targetSeen = '';
  await page.route('**/api/copy-studio/import', (route) => {
    const target = route.request().postDataJSON().targetOffer;
    targetSeen = target;
    return route.fulfill({ json: { source, selectedOffer: target || '', extraction: {
      offers, fields: target ? { offerName: 'Executive Program', description: 'Six individual coaching sessions', audience: 'Newly promoted executives' } : {},
      evidence: [{ field: 'offerName', quote: offers[0].quote }], warnings: [],
    } } });
  });
  await openStudio(page);
  await page.getByRole('button', { name: 'Try a sample brief' }).click();
  await page.getByRole('button', { name: 'Start with an existing page' }).click();
  await page.getByLabel('Page URL', { exact: true }).fill(source.url);
  await page.getByRole('button', { name: 'Extract offer facts' }).click();
  await expect(page.getByRole('heading', { name: 'Choose the offer for this page', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply \d+ field/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Executive Program Individual coaching', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review what we found' })).toBeVisible();
  expect(targetSeen).toBe('Executive Program');
  await page.getByRole('button', { name: 'Apply 3 fields', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('Executive Program');
  await page.getByText('Terms, voice & next step', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Price & payment terms', exact: false })).toHaveValue('');
  await page.getByText('Give the copy substance', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Evidence & testimonials', exact: false })).toHaveValue('');
  await expect(page.getByText('Client onboarding found for this website.', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Choose a copy project' }).selectOption({ label: 'The Clear Offer Sprint' });
  await expect(page.getByRole('textbox', { name: 'Offer name', exact: true })).toHaveValue('The Clear Offer Sprint');
});

test('mobile client picker handles long names and onboarding failures leave a manual brief usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let failed = false;
  await page.route('**/api/copy-studio/onboardings', (route) => failed
    ? route.fulfill({ status: 503, json: { error: 'Onboarding could not be loaded. Retry or continue with a manual brief.' } })
    : route.fulfill({ json: { onboardings: [{ ...onboarding, clientName: 'Example Coach with a very long business and client name for mobile review' }] } }));
  await openStudio(page);
  await page.getByRole('button', { name: 'Choose client onboarding' }).click();
  await page.getByRole('radio', { name: /Example Coach/ }).check();
  await expect(page.getByRole('checkbox', { name: /Offer name/ })).toBeChecked();
  await page.screenshot({ path: 'tmp/copy-studio-screenshots/onboarding-picker-mobile.png', fullPage: true });
  expect(await page.locator('.onboarding-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close onboarding picker' }).click();
  failed = true;
  await page.getByRole('button', { name: 'Choose client onboarding' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Onboarding could not be loaded');
  await page.getByRole('button', { name: 'Close onboarding picker' }).click();
  await page.getByRole('textbox', { name: 'Offer name', exact: true }).fill('Manual brief');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
