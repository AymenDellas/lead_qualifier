const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

const filename = path.join(__dirname, '..', 'src', 'lib', 'case-study-post-url.ts');
const source = fs.readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(compiled, filename);
const { resolveCaseStudyPostUrl } = loaded.exports;

const post = 'https://www.linkedin.com/posts/aymen-dellas-0a3134220_getting-visitors-to-your-coaching-website-share-7508534233297129472-oprJ/';
const redirect = (location) => new Response(null, { status: 301, headers: { location } });

(async () => {
    assert.equal(await resolveCaseStudyPostUrl(post), post);
    assert.equal(await resolveCaseStudyPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:123/'),
        'https://www.linkedin.com/feed/update/urn:li:activity:123/');

    let requested = '';
    assert.equal(await resolveCaseStudyPostUrl('https://lnkd.in/p/dUg83upv', async (url, options) => {
        requested = url;
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        return redirect(post);
    }), post);
    assert.equal(requested, 'https://lnkd.in/p/dUg83upv');

    await assert.rejects(resolveCaseStudyPostUrl('https://lnkd.in.evil.example/p/dUg83upv'), /valid LinkedIn post URL/);
    await assert.rejects(resolveCaseStudyPostUrl('https://lnkd.in/p/dUg83upv', async () => redirect('https://example.com/')), /valid LinkedIn post URL/);
    await assert.rejects(resolveCaseStudyPostUrl('https://lnkd.in/p/dUg83upv', async () => redirect('https://www.linkedin.com/in/example/')), /does not open a LinkedIn post/);
    await assert.rejects(resolveCaseStudyPostUrl('https://www.linkedin.com/in/example/'), /does not point to a LinkedIn post/);
    console.log('Case Study post URL checks passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
