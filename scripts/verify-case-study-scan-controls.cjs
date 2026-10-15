const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

function clickButton(page, label) {
    return page.$$eval('button', (buttons, expected) => {
        const button = buttons.find((candidate) => candidate.offsetParent && candidate.textContent?.trim() === expected);
        if (!button) throw new Error(`${expected} button was not found.`);
        button.click();
    }, label);
}

(async () => {
    const baseUrl = process.env.CASE_STUDY_PREVIEW_URL || 'http://127.0.0.1:3000';
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1000 });
        await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await clickButton(page, 'Case Study Hunter');
        await page.waitForFunction(() => document.body.innerText.includes('Headline gate'), { timeout: 20000 });
        await clickButton(page, 'Scanner');
        await page.waitForFunction(() => document.body.innerText.includes('Scan visible profiles'), { timeout: 20000 });
        const inputMax = await page.$eval('input[type="number"]', (input) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, '150');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return input.max;
        });
        assert.equal(inputMax, '150');

        const initial = await page.$$eval('button', (buttons) => buttons
            .filter((button) => ['Scan visible profiles', 'Stop run'].includes(button.textContent?.trim() || ''))
            .map((button) => ({ label: button.textContent?.trim(), disabled: button.disabled })));
        assert.deepEqual(initial, [
            { label: 'Scan visible profiles', disabled: false },
            { label: 'Stop run', disabled: true },
        ]);

        await clickButton(page, 'Scan visible profiles');
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
            button.textContent?.trim() === 'Scan running…' && button.disabled), { timeout: 10000 });
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
            button.textContent?.trim() === 'Stop run' && !button.disabled), { timeout: 10000 });
        await clickButton(page, 'Stop run');
        await page.waitForFunction(() => document.body.innerText.includes('Stop requested.'), { timeout: 15000 });
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
            button.textContent?.trim() === 'Scan visible profiles' && !button.disabled), { timeout: 30000 });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const idlePosts = [];
        page.on('request', (request) => {
            if (request.method() === 'POST') idlePosts.push(request.url());
        });
        await new Promise((resolve) => setTimeout(resolve, 13_000));
        assert.deepEqual(idlePosts, [], 'The idle Case Study page must not invoke a rendering server action on a timer.');
        console.log('Case Study scanner controls check passed.');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
