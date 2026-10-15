const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

(async () => {
    const baseUrl = process.env.CASE_STUDY_PREVIEW_URL || 'http://127.0.0.1:3010';
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1000 });
        await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.$$eval('button', (buttons) => {
            const target = buttons.find((button) => button.offsetParent && button.textContent?.includes('Case Study Hunter'));
            if (!target) throw new Error('Case Study Hunter navigation button was not found.');
            target.click();
        });
        await page.waitForFunction(() => document.body.innerText.includes('Headline gate'), { timeout: 20000 });
        await page.$$eval('button', (buttons) => {
            const target = buttons.find((button) => button.textContent?.trim() === 'Scanner');
            if (!target) throw new Error('Scanner view button was not found.');
            target.click();
        });
        await page.waitForFunction(() => document.body.innerText.includes('Scan visible profiles'), { timeout: 20000 });
        const scannerControls = await page.$$eval('button', (buttons) => buttons
            .filter((button) => ['Scan visible profiles', 'Stop run'].includes(button.textContent?.trim() || ''))
            .map((button) => ({ label: button.textContent?.trim(), disabled: button.disabled })));
        assert.deepEqual(scannerControls, [
            { label: 'Scan visible profiles', disabled: false },
            { label: 'Stop run', disabled: true },
        ]);
        await page.$$eval('button', (buttons) => {
            const target = buttons.find((button) => button.textContent?.trim() === 'Pipeline');
            if (!target) throw new Error('Pipeline view button was not found.');
            target.click();
        });
        await page.waitForFunction(() => document.body.innerText.includes('Sarah Jones'), { timeout: 20000 });
        await page.$$eval('tr', (rows) => {
            const target = rows.find((row) => row.textContent?.includes('Sarah Jones'));
            if (!target) throw new Error('Seeded prospect was not found.');
            target.click();
        });
        await page.waitForFunction(() => document.body.innerText.includes('Profile and website'), { timeout: 20000 });
        const text = await page.$eval('body', (body) => body.innerText);
        assert.doesNotMatch(text, /Case Study Score/);
        assert.match(text, /Case study delivery archive/i);
        assert.doesNotMatch(text, /Specific outreach angle/);
        assert.match(text, /There is no qualifying-question step/);
        assert.doesNotMatch(text, /Rendered funnel evidence/);
        console.log('Case Study Hunter UI check passed.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
