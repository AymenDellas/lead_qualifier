'use strict';
// Render the real app with intercepted fixture APIs. Never enqueue real leads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { prospect } = require('./fixtures.cjs');
const output = path.resolve('tmp/prospect-batches');
fs.mkdirSync(output, { recursive: true });

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [], polling = [];
    let completeRest = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = new URL(request.url());
        const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
        if (request.method() !== 'GET' && request.method() !== 'HEAD') {
            // The app may call unrelated overview actions on startup. Block
            // those too, so this rendering check cannot mutate live state.
            return request.abort();
        }
        if (url.pathname === '/api/prospects') return respond({
            leads: [prospect('fixture-preview', { prospect_assessment: null, first_name: 'TEST · Batch', last_name: 'Preview' })],
            counts: { A: 0, B: 0, C: 0, UNREVIEWED: 2400, OUTSIDE_ICP: 0 }, total: 1, offset: 0, limit: 50,
        });
        if (url.pathname === '/api/prospects/jobs') {
            const ids = url.searchParams.get('ids').split(',');
            polling.push(ids);
            return respond({ jobs: ids.map(id => {
                const index = Number(id.split('_').at(-1));
                return { id, status: index === 0 ? 'error' : index < 40 || completeRest ? 'done' : 'queued' };
            }), worker: { ready: true, dailyLimit: 400 } });
        }
        if (url.pathname.startsWith('/api/')) return respond({ queueSize: 0, workerStatus: null, recentResults: [] });
        request.continue();
    });
    const open = async () => {
        await page.goto(process.env.PROSPECT_BROWSER_URL || 'http://localhost:3000', { waitUntil: 'networkidle2', timeout: 120000 });
        await page.waitForSelector('button', { timeout: 90000 });
        await page.evaluate(() => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Prospects').click());
        await page.waitForSelector('#prospect-batch-size');
        await page.waitForFunction(() => !document.querySelector('.prospect-workspace').getAttribute('aria-busy') || document.querySelector('.prospect-workspace').getAttribute('aria-busy') === 'false');
    };
    const change = async value => {
        await page.click('#prospect-batch-size', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        if (value) await page.type('#prospect-batch-size', value);
    };
    try {
        await page.setViewport({ width: 1440, height: 1000 });
        await open();
        assert.equal(await page.$eval('#prospect-batch-size', el => el.value), '200');
        await change('1001');
        assert.equal(await page.$eval('.prospect-batch-row button', el => el.disabled), true);
        await change('');
        assert.equal(await page.$eval('#prospect-batch-size', el => el.getAttribute('aria-invalid')), 'true');
        await change('500');
        await page.waitForFunction(() => localStorage.getItem('compelProspectBatchSize') === '500');
        assert.equal(await page.$eval('.prospect-batch-row button', el => el.textContent.trim()), 'Research next 500');
        await open();
        assert.equal(await page.$eval('#prospect-batch-size', el => el.value), '500');
        await page.click('.prospect-priority:nth-child(4)');
        await page.waitForFunction(() => document.querySelector('.prospect-priority:nth-child(4)').getAttribute('aria-pressed') === 'true');
        await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewport({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.ok(await page.$eval('.prospect-batch-row button', el => el.getBoundingClientRect().right <= innerWidth));
        assert.ok(await page.evaluate(() => [...document.querySelectorAll('.prospect-priority')].every(button => {
            const count = button.querySelector('.num').getBoundingClientRect();
            const box = button.getBoundingClientRect();
            return count.left >= box.left && count.right <= box.right;
        })));
        await page.evaluate(() => {
            localStorage.setItem('compelProspectResearchJobs', JSON.stringify(Array.from({ length: 1000 }, (_, i) => `job_test_${i}`)));
        });
        await open();
        await page.waitForFunction(() => document.body.innerText.includes('40 of 1000 research jobs finished.'));
        assert.equal(await page.$eval('.prospect-batch-row button', el => el.disabled), true);
        assert.equal(polling.length, 10);
        assert.ok(polling.every(ids => ids.length <= 100));
        completeRest = true;
        await page.waitForFunction(() => document.body.innerText.includes('Research finished; 1 jobs need a retry.'), { timeout: 20000 });
        assert.ok(polling.slice(10).every(ids => ids.every(id => Number(id.split('_').at(-1)) >= 40)));
        await page.waitForFunction(() => localStorage.getItem('compelProspectResearchJobs') === null);
        assert.deepEqual(errors, []);
        console.log('PASS editable/persisted batch size, invalid-size controls, desktop/mobile layout and restored 1,000-job polling with cached completions');
        console.log(`Screenshots: ${output}`);
    } catch (error) {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
        throw error;
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
