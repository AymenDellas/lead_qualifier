/* Run against the isolated --preview database and local Next server. */
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const output = path.resolve('tmp/discovery-call-screenshots');
    mkdirSync(output, { recursive: true });
    const button = name => page.getByRole('button', { name, exact: true });
    const saved = () => page.getByRole('status').filter({ hasText: 'All changes saved' }).waitFor({ timeout: 15000 });
    const openWorkspace = async () => {
        // The overview appears after the first client action, so navigation is hydrated.
        await page.locator('.overview').waitFor({ timeout: 45000 });
        await button('Discovery Calls').click();
        await button('Prepare a call').first().waitFor({ timeout: 45000 });
    };
    try {
        await page.goto(process.env.DISCOVERY_PREVIEW_URL || 'http://127.0.0.1:3015', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await openWorkspace();
        await page.screenshot({ path: path.join(output, 'desktop-list.png'), fullPage: true });
        await button('Prepare a call').first().click();
        await button('Add manually').click();
        const name = `TEST · Browser discovery ${Date.now()}`;
        await page.getByRole('textbox', { name: /^Prospect name/ }).fill(name);
        await page.getByLabel('Business name', { exact: true }).fill('Example Coaching');
        await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
        await page.getByLabel('Website', { exact: true }).fill('https://example.com');
        await page.getByLabel('What do you already know?', { exact: true }).fill('Interested in improving bookings. Available October 7.');
        await button('Create call prep').click();
        await page.getByRole('heading', { name: 'What are we really trying to improve?', exact: true }).waitFor({ timeout: 30000 });
        await page.getByLabel('Their answer / your notes').fill('More qualified discovery calls from existing traffic.');
        await button('Next question').click();
        await page.getByLabel('Their answer / your notes').fill('Executive coaching programme');
        await button('Next question').click();
        await page.getByLabel('Their answer / your notes').fill('Senior leaders in growing companies');
        await saved();
        await page.screenshot({ path: path.join(output, 'desktop-questions.png'), fullPage: true });
        await button('Call mode').click();
        assert.equal(await button('Exit call mode').getAttribute('aria-pressed'), 'true');
        await button('Explain your offer').click();
        const pitch = await page.getByLabel('What you’ll say', { exact: true }).inputValue();
        assert.match(pitch, /three pillars/);
        assert.match(pitch, /frictionless booking flow/);
        await page.getByLabel('What you’ll say', { exact: true }).fill(pitch + '\n\nFor you, we’ll start with qualified calls.');
        await saved();
        await button('Call notes').click();
        await page.getByLabel('Call notes', { exact: true }).fill('Keep the existing logo. Client is comfortable with the rebuild.');
        await page.getByLabel('Agreed scope', { exact: true }).fill('Landing page, booking flow, nurture emails');
        await page.getByLabel('Outside scope', { exact: true }).fill('Paid advertising');
        await saved();
        await button('Exit call mode').click();
        // Leave before the debounce fires: the device draft must survive navigation.
        await page.getByLabel('Call notes', { exact: true }).fill('Keep the existing logo. Client is comfortable with the rebuild. Draft recovered after navigation.');
        await button('Overview').click();
        await openWorkspace();
        await page.getByRole('button').filter({ hasText: name }).click();
        await button('Call notes').click();
        assert.match(await page.getByLabel('Call notes', { exact: true }).inputValue(), /Draft recovered after navigation/);
        await saved();
        await button('All calls').click();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openWorkspace();
        await page.getByRole('button').filter({ hasText: name }).click();
        await button('Call notes').click();
        assert.match(await page.getByLabel('Call notes', { exact: true }).inputValue(), /existing logo/);
        await button('Wrap-up').click();
        await page.getByRole('combobox', { name: 'Call outcome' }).selectOption('AGREED');
        await page.getByLabel('Next action', { exact: true }).fill('Send the formal onboarding brief.');
        await saved();
        assert.match(await page.locator('.call-recap').innerText(), /Senior leaders in growing companies/);
        await page.screenshot({ path: path.join(output, 'desktop-wrap-up.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'mobile-wrap-up.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page must not overflow horizontally');
        await page.getByRole('button', { name: /^Questions/ }).click();
        await page.screenshot({ path: path.join(output, 'mobile-questions.png'), fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile questions must not overflow');
        await button('Wrap-up').click();
        await button('Start onboarding').click();
        await page.getByRole('heading', { name: 'Free case-study agreement', exact: true }).waitFor({ timeout: 30000 });
        assert.match(await page.locator('body').innerText(), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        await page.screenshot({ path: path.join(output, 'onboarding-handoff.png'), fullPage: true });
        assert.deepEqual(errors, []);
        console.log('PASS manual prep, editable pitch, autosave, reload persistence, recap, mobile layout, and onboarding navigation');
        console.log(`Screenshots: ${output}`);
    } catch (error) {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
        console.error((await page.locator('body').innerText()).slice(-6000));
        throw error;
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
