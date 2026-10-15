'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = require.resolve('../../src/lib/prospect-research.cjs');
const localRequire = createRequire(file);

function fetcher({ html = '<p>Readable business page</p>', status = 200, type = 'text/html', redirect, encoding } = {}) {
    const calls = [];
    const transport = { get(url, options, callback) {
        calls.push({ url: url.href, options });
        const request = new EventEmitter();
        queueMicrotask(() => {
            const response = new EventEmitter();
            response.statusCode = status;
            response.headers = { 'content-type': type, ...(redirect ? { location: redirect } : {}),...(encoding?{'content-encoding':encoding}:{}) };
            // Node emits aborted when a response is deliberately destroyed.
            response.destroy = () => response.emit('aborted');
            callback(response);
            response.emit('data', Buffer.from(html));
            response.emit('end');
        });
        return request;
    } };
    const context = { module: { exports: {} }, Buffer, URL, AbortSignal, process,
        require: name => ['node:http', 'node:https'].includes(name) ? transport : localRequire(name) };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
    return { fetch: context.module.exports.fetchPublicPage, calls };
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('compressed responses decode into real HTML and decompression cannot exceed the research size limit',async()=>{
 const zlib=require('node:zlib'),html='<html><body>Contact ava@practice.test</body></html>';
 for(const [encoding,compress]of [['gzip',zlib.gzipSync],['br',zlib.brotliCompressSync],['deflate',zlib.deflateSync]]){
  const reader=fetcher({html:compress(Buffer.from(html)),encoding});
  assert.equal((await reader.fetch('https://practice.test/',{lookup:publicLookup})).html,html);
  assert.match(reader.calls[0].options.headers['Accept-Encoding'],/gzip/);
 }
 const bomb=fetcher({html:zlib.gzipSync(Buffer.alloc(4*1024*1024+1,65)),encoding:'gzip'});
 await assert.rejects(bomb.fetch('https://practice.test/',{lookup:publicLookup}),/size limit/);
});

test('large HTML above the old 900 KB limit is readable and the real size error survives response destruction', async () => {
    const large = fetcher({ html: '<p>' + 'x'.repeat(1242384) + '</p>' });
    assert.ok((await large.fetch('https://practice.test/', { lookup: publicLookup })).html.length > 1200000);
    const oversized = fetcher({ html: 'x'.repeat(4 * 1024 * 1024 + 1) });
    await assert.rejects(oversized.fetch('https://practice.test/', { lookup: publicLookup }), /4 MB research size limit/);
});

test('a missing www DNS record retries the apex with the observed path, and validates its addresses again', async () => {
    const instance = fetcher(), names = [];
    const result = await instance.fetch('https://www.practice.test/actual-contact', { lookup: async hostname => {
        names.push(hostname);
        if (hostname.startsWith('www.')) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        return publicLookup();
    } });
    assert.deepEqual(names, ['www.practice.test', 'practice.test']);
    assert.equal(result.url, 'https://practice.test/actual-contact');
    assert.equal(instance.calls.length, 1);
    const privateApex = fetcher();
    await assert.rejects(privateApex.fetch('https://www.practice.test/', { lookup: async hostname => {
        if (hostname.startsWith('www.')) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return [{ address: '127.0.0.1', family: 4 }];
    } }), /private/);
    assert.equal(privateApex.calls.length, 0);
});

test('HTTP and non-HTML errors keep their actionable cause, and redirects cannot enter private networks', async () => {
    const denied = fetcher({ status: 403 });
    await assert.rejects(denied.fetch('https://practice.test/', { lookup: publicLookup }), error => error.httpStatus === 403 && /HTTP 403/.test(error.message));
    const download = fetcher({ type: 'application/pdf' });
    await assert.rejects(download.fetch('https://practice.test/', { lookup: publicLookup }), error => error.code === 'NON_HTML');
    const redirect = fetcher({ status: 302, redirect: 'http://127.0.0.1/private' });
    await assert.rejects(redirect.fetch('https://practice.test/', { lookup: publicLookup }), /public HTTP/);
    assert.equal(redirect.calls.length, 1);
});
