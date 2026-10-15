'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { NOW } = require('./fixtures.cjs');
const { researchProspect, publicUrl, fetchPublicPage } = require('../../src/lib/prospect-research.cjs');
const { assessProspect } = require('../../src/lib/prospect-qualification.cjs');
const input = { firstName: 'Ava', lastName: 'Morgan', headline: 'Independent Executive Coach | Founder', profileIdentityConfirmed: true, profileLocation: 'Toronto, Canada', linkedinUrl: 'https://www.linkedin.com/in/ava-morgan', websites: ['https://avamorgan.test'] };
const html = `<html><head><title>Ava Morgan Executive Coaching</title></head><body><h1>Executive coaching with Ava Morgan</h1><p>I am Ava Morgan. I coach senior leaders through transitions. Work with me through my 12-week executive coaching program. Investment: $4000.</p><h2>Client testimonials</h2><p>“Ava helped me prepare for my VP role.” — Casey Williams, VP at Delta.</p><a href="/coaching">Coaching programme</a><a href="mailto:ava@avamorgan.test">Contact Ava</a><a href="mailto:apisupport@xecurify.com">Vendor</a><a href="mailto:hello@othercompany.test">Unrelated company</a><a href="mailto:avamorgan@gmail.com">My personal inbox</a><footer>johndoe@yourmail.com</footer></body></html>`;
const fakeFetch = async url => ({ url, html });

function researchWithProvider(respond, env = {}) {
    const filename = require.resolve('../../src/lib/prospect-research.cjs');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    class Groq {
        constructor(options) { this.chat = { completions: { create: request => respond(request, options) } }; }
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8')+'\nmodule.exports.providerExtract=extractWithAI;', {
        module, exports: module.exports, require: name => name === 'groq-sdk' ? Groq : realRequire(name),
        process: { env: { GROQ_API_KEY: 'fixture-secret', ...env } }, URL, Buffer, AbortSignal, setTimeout, clearTimeout,
    }, { filename });
    // Exercise provider interpretation explicitly even when the evidence rules already suffice.
    return (value,options={})=>module.exports.researchProspect(value,{...options,extract:(sources,profile)=>module.exports.providerExtract(sources,profile,options)});
}

test('provider research uses a supported configurable model and enough output space for reasoning plus findings', async () => {
    for (const configured of ['', 'custom-supported-model']) {
        let request;
        const livePath = researchWithProvider(async value => {
            request = value;
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ facts: { clientProof: { state: 'OBSERVED', value: 'Named coaching client', evidence: [{ sourceIndex: 1, excerpt: 'Ava helped me prepare for my VP role.' }] } } }) } }] };
        }, { PROSPECT_RESEARCH_MODEL: configured });
        const r = await livePath(input, { now: NOW, fetchPage: fakeFetch });
        assert.equal(request.model, configured || 'openai/gpt-oss-120b');
        assert.equal(request.max_completion_tokens,3000);
        assert.equal(request.reasoning_effort, configured ? undefined : 'low');
        assert.equal(r.engine, 'ai'); assert.equal(r.facts.clientProof.state, 'OBSERVED');
    }
});

test('five large pages and many long links stay within the provider input budget while retaining client and offer excerpts', async () => {
    let request;
    const livePath = researchWithProvider(async value => {
        request = value; return { choices: [{ finish_reason: 'stop', message: { content: '{"facts":{}}' } }] };
    });
    const longPage = '<html><head><title>Ava Morgan Executive Coaching</title></head><body><p>I am Ava Morgan. I coach leaders.</p><nav>'
        + 'Navigation content '.repeat(620) + '</nav><h2>Client testimonials</h2><p>Ava helped me prepare for my VP role.</p><p>Executive coaching program. Investment: $4000.</p>'
        + Array.from({ length: 50 }, (_, i) => `<a href="/coaching-${i}?tracking=${'x'.repeat(300)}">Coaching services</a>`).join('') + '</body></html>';
    const r = await livePath({ ...input, about: 'Personal background '.repeat(250), latestPostText: 'Relevant activity '.repeat(150), lastActivityAt: NOW }, { now: NOW, fetchPage: async url => ({ url, html: longPage }) });
    const payload = request.messages[1].content;
    assert.ok(payload.length <= 8000, `Provider input was ${payload.length} characters`);
    const sources = JSON.parse(payload).sources;
    assert.ok(sources.length >= 6);
    assert.ok(sources.filter(source => source.ownershipConfirmed).every(source => source.passages.some(p => p.text.includes('Ava helped me prepare for my VP role.')) && source.passages.some(p => p.text.includes('Investment: $4000.'))));
    assert.match(sources[0].passages[0].text, /Profile location: Toronto, Canada/);
    assert.equal(r.engine, 'ai');
});

test('provider passage citations resolve to original source text and invented IDs cannot establish client proof', async () => {
    for (const valid of [true, false]) {
        let original;
        const livePath = researchWithProvider(async request => {
            const payload = JSON.parse(request.messages[1].content);
            const website = payload.sources.find(source => source.ownershipConfirmed);
            original = website.passages.find(p => p.text.includes('Ava helped me prepare for my VP role.'));
            assert.ok(original);
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ facts: { clientProof: { state: 'OBSERVED', value: 'Named VP-transition client', evidence: [{ sourceIndex: website.index, passageId: valid ? original.id : 'invented', excerpt: 'Fabricated client success' }] } } }) } }] };
        });
        const r = await livePath(input, { now: NOW, fetchPage: fakeFetch });
        assert.equal(r.facts.clientProof.state, valid ? 'OBSERVED' : 'INDICATED');
        if (valid) assert.equal(r.facts.clientProof.evidence[0].excerpt, original.text);
        assert.ok(r.facts.clientProof.evidence.every(e => !e.excerpt.includes('Fabricated client success')));
    }
});

test('provider failures expose a safe actionable cause, never secrets or invented qualification', async () => {
    for (const [status, cause] of [[404, 'model is unavailable'], [429, 'rate limit'], [413, 'size limit']]) {
        const livePath = researchWithProvider(async () => { throw Object.assign(new Error('secret fixture-secret and private provider payload'), { status }); });
        const r = await livePath(input, { now: NOW, fetchPage: fakeFetch });
        assert.equal(r.engine, 'rules'); assert.equal(assessProspect(r, { now: NOW }).tier, 'A');
        assert.ok(r.limitations.some(note => note.includes(cause) && note.includes(`HTTP ${status}`)));
        assert.ok(r.limitations.every(note => !note.includes('fixture-secret') && !note.includes('private provider')));
    }
});

test('truncated and malformed AI responses cannot be treated as completed interpretation', async () => {
    for (const choice of [{ finish_reason: 'length', message: { content: '{"facts":{}}' } }, { finish_reason: 'stop', message: { content: '{}' } }]) {
        const livePath = researchWithProvider(async () => ({ choices: [choice] }));
        const r = await livePath(input, { now: NOW, fetchPage: fakeFetch });
        assert.equal(r.engine, 'rules'); assert.equal(r.facts.clientProof.state, 'INDICATED');
        assert.ok(r.limitations.some(note => /AI response was (?:incomplete|invalid)/.test(note)));
    }
});

test('shared quota waits preserve unknown findings and never call the provider early',async()=>{
    let calls=0,issue;
    const livePath=researchWithProvider(async()=>{calls++;return {choices:[]};});
    const retryAt=new Date(Date.now()+60000).toISOString();
    const r=await livePath(input,{fetchPage:fakeFetch,aiBudget:{reserve:async()=>({ready:false,retryAt})},onAIError:error=>{issue=error;}});
    assert.equal(calls,0);assert.equal(issue.code,'AI_DEFERRED');assert.equal(issue.retryAt,retryAt);
    assert.ok(r.limitations.some(note=>note.includes('shared AI token budget')));assert.equal(r.facts.clientProof.state,'INDICATED');
});
test('provider Retry-After cools the shared budget and retains a scheduled recovery time',async()=>{
    let cooled,issue;
    const livePath=researchWithProvider(async()=>{throw Object.assign(new Error('Rate limit'),{status:429,headers:{get:()=> '120'}});});
    await livePath(input,{fetchPage:fakeFetch,aiBudget:{reserve:async()=>({ready:true}),cool:async(model,retryAt)=>{cooled={model,retryAt};}},onAIError:error=>{issue=error;}});
    assert.equal(cooled.retryAt,issue.retryAt);assert.ok(Date.parse(issue.retryAt)>Date.now()+119000);
});
test('clear public evidence can qualify without spending an AI request',async()=>{
    let reserved=0;
    const r=await researchProspect(input,{now:NOW,fetchPage:fakeFetch,aiBudget:{reserve:async()=>{reserved++;throw new Error('No AI expected');}}});
    assert.equal(reserved,0);assert.equal(assessProspect(r,{now:NOW}).tier,'A');
    assert.ok(!r.limitations.some(note=>/interpretation.*unavailable/.test(note)));
});

test('owned practice pages retain attributable contacts and exclude third-party addresses', async () => {
    const r = await researchProspect(input, { ai: false, now: NOW, fetchPage: fakeFetch });
    assert.equal(r.websiteStatus, 'OWNED'); assert.equal(r.facts.independentBusiness.state, 'OBSERVED');
    assert.deepEqual(r.contacts.map(c => c.address).sort(), ['ava@avamorgan.test', 'avamorgan@gmail.com']);
    assert.equal(r.facts.clientProof.state, 'INDICATED'); assert.equal(r.facts.economics.state, 'UNKNOWN');
    assert.equal(assessProspect(r, { now: NOW }).tier, 'A');
});

test('a confirmed independent coach can qualify from a profile offer without a readable website', async () => {
    const r = await researchProspect({ ...input, websites: [], about: 'Work with me through my 12-week executive coaching program. My clients are senior leaders.' }, { ai: false, now: NOW });
    assert.equal(r.websiteStatus, 'NONE');
    assert.equal(r.facts.independentBusiness.state, 'INDICATED');
    assert.equal(r.facts.paidOffer.state, 'INDICATED');
    assert.equal(assessProspect(r, { now: NOW }).tier, 'A');
});

test('website addresses supplied without a scheme are normalized and researched normally', async () => {
    const fetched = [];
    const r = await researchProspect({ ...input, websites: ['www.avamorgan.test'] }, { ai: false, now: NOW, fetchPage: async url => {
        fetched.push(url); return fakeFetch(url);
    } });
    assert.equal(fetched[0], 'https://www.avamorgan.test/');
    assert.equal(r.websiteStatus, 'OWNED'); assert.equal(assessProspect(r, { now: NOW }).tier, 'A');
});

test('business owners mentioned as clients do not establish that the coach owns a practice', async () => {
    const r = await researchProspect({ ...input, headline: 'Business Coach', websites: [], about: 'I coach business owners through our coaching program at the local university.' }, { ai: false, now: NOW });
    assert.equal(r.facts.independentBusiness.state, 'UNKNOWN');
    assert.equal(assessProspect(r, { now: NOW }).tier, 'B');
});

test('confirmed profile evidence can establish a commercial practice through AI when the website is unavailable', async () => {
    const about = 'I founded Ava Morgan Coaching and offer a paid 12-week executive coaching program for senior leaders.';
    let called = false;
    const r = await researchProspect({ ...input, headline: 'Executive Coach', websites: [], about }, { now: NOW, extract: async sources => {
        called = true;
        return { facts: Object.fromEntries(['independentBusiness', 'paidOffer'].map(key => [key, { state: 'OBSERVED', value: 'Named personal coaching practice and programme', evidence: [{ sourceIndex: 0, excerpt: about }] }])) };
    } });
    assert.equal(called, true); assert.equal(r.engine, 'ai');
    assert.equal(r.facts.independentBusiness.state, 'OBSERVED');
    assert.equal(r.facts.paidOffer.state, 'OBSERVED');
    assert.equal(assessProspect(r, { now: NOW }).tier, 'A');
});

test('AI indications do not weaken facts already observed on the identified practice', async () => {
    const r = await researchProspect(input, { now: NOW, fetchPage: fakeFetch, extract: async () => ({ facts: {
        independentBusiness: { state: 'INDICATED', value: 'Possible owner', evidence: [{ sourceIndex: 0, excerpt: input.headline }] },
    } }) });
    assert.equal(r.facts.independentBusiness.state, 'OBSERVED');
});
test('public platform profile URLs are retained intact and are never crawled at the platform root', async () => {
    const fetched = [];
    const r = await researchProspect({ ...input, websites: ['https://www.instagram.com/ava', 'https://topmate.io/ava'], email: 'ava@instagram.com', emailSource: 'pattern_guess' }, { ai: false, now: NOW, fetchPage: async url => { fetched.push(url); return fakeFetch(url); } });
    assert.deepEqual(fetched, []); assert.equal(r.contacts.length, 0); assert.equal(r.website, 'https://www.instagram.com/ava');
    assert.equal(assessProspect(r, { now: NOW }).tier, 'B');
});
test('a guessed domain serving another coach is not evidence of this person’s practice', async () => {
    const r = await researchProspect(input, { ai: false, now: NOW, fetchPage: async url => ({ url, html: html.replaceAll('Ava Morgan', 'Other Coach').replaceAll('ava@avamorgan.test', 'other@avamorgan.test') }) });
    assert.equal(r.websiteStatus, 'UNCONFIRMED'); assert.notEqual(r.facts.independentBusiness.state, 'OBSERVED'); assert.equal(r.contacts.length, 0);
});

test('a matching staff biography does not establish ownership of the employer’s website', async () => {
    const r = await researchProspect({ ...input, websites: ['https://company.test/team/ava'] }, { ai: false, now: NOW, fetchPage: fakeFetch });
    assert.equal(r.websiteStatus, 'UNCONFIRMED'); assert.equal(r.contacts.length, 0);
    assert.notEqual(r.facts.independentBusiness.state, 'OBSERVED');
});
test('blocked websites keep business facts unknown and preserve a published LinkedIn email', async () => {
    const r = await researchProspect({ ...input, emails: ['ava@avamorgan.test'], emailSource: 'linkedin' }, { ai: false, now: NOW, fetchPage: async () => { throw new Error('Website returned HTTP 403.'); } });
    assert.equal(r.contacts[0].ownership, 'PUBLISHED'); assert.equal(r.facts.paidOffer.state, 'UNKNOWN'); assert.equal(assessProspect(r, { now: NOW }).tier, 'B');
});
test('grounded interpretation can establish client proof while leaving actual traffic and finances unverified', async () => {
    const post = 'Book a call for my executive coaching program. I have two new client places available.';
    const r = await researchProspect({ ...input, latestPostText: post, lastActivityAt: NOW }, { now: NOW, fetchPage: fakeFetch, extract: async sources => {
        const websiteIndex = sources.findIndex(s => s.kind === 'WEBSITE');
        return { facts: {
            clientProof: { state: 'OBSERVED', value: 'Attributed VP-transition client example', reason: 'A named client describes the relevant outcome.', evidence: [{ sourceIndex: websiteIndex, excerpt: 'Ava helped me prepare for my VP role.' }] },
            funnelOpportunity: { state: 'INDICATED', value: 'Review programme positioning', reason: 'The broad transition copy could be compared with the specific programme.', evidence: [{ sourceIndex: websiteIndex, excerpt: 'I coach senior leaders through transitions.' }] },
            demandSignals: { state: 'OBSERVED', value: 'Promotion', reason: 'Visible activity; not visitor counts.', evidence: [{ sourceIndex: 1, excerpt: post }] },
            economics: { state: 'OBSERVED', value: '$4k profit', evidence: [{ sourceIndex: websiteIndex, excerpt: 'Investment: $4000.' }] },
            capacity: { state: 'OBSERVED', value: 'Two seats', evidence: [{ sourceIndex: 1, excerpt: post }] },
        } };
    } });
    assert.equal(r.facts.clientProof.state, 'OBSERVED'); assert.equal(r.facts.demandSignals.state, 'INDICATED');
    assert.equal(r.facts.economics.state, 'UNKNOWN'); assert.equal(r.facts.capacity.state, 'UNKNOWN');
    const a = assessProspect(r, { now: NOW }); assert.equal(a.tier, 'A'); assert.equal(a.engagementReady, false);
});
test('invented findings and interpretation errors fall back to conservative evidence', async () => {
    const r = await researchProspect(input, { now: NOW, fetchPage: fakeFetch, extract: async () => { throw new Error('Provider unavailable'); } });
    assert.equal(r.engine, 'rules'); assert.equal(r.facts.clientProof.state, 'INDICATED'); assert.ok(r.limitations.length);
    const unsupported = await researchProspect(input, { now: NOW, fetchPage: fakeFetch, extract: async () => ({ facts: { clientProof: { state: 'OBSERVED', value: 'Invented', evidence: [{ sourceIndex: 1, excerpt: 'A million paid clients with perfect conversion.' }] } } }) });
    assert.equal(unsupported.facts.clientProof.state, 'INDICATED');
});
test('website research follows every discovered route once, without guessing contact or about paths', async () => {
    const calls = [];
    const r = await researchProspect(input, { ai: false, now: NOW, fetchPage: async url => { calls.push(url); return { url, html: html + Array.from({ length: 30 }, (_, i) => `<a href="/coaching-${i}">Coaching</a>`).join('') }; } });
    assert.equal(calls.length, 32); assert.equal(new Set(calls).size, 32);
    assert.ok(!calls.some(url => /\/(contact|about)/.test(url)));
    assert.equal(r.crawl.complete, true); assert.equal(r.crawl.inspected, 32);
});

test('undated and stale promotional posts cannot establish current demand', async () => {
    for (const lastActivityAt of [null, '2024-01-01T12:00:00.000Z']) {
        const r = await researchProspect({ ...input, latestPostText: 'Book a call for my executive coaching program.', lastActivityAt }, { ai: false, now: NOW, fetchPage: fakeFetch });
        assert.equal(r.facts.demandSignals.state, 'UNKNOWN');
        assert.equal(r.facts.independentBusiness.state, 'OBSERVED');
    }
});

test('a testimonial’s occupation does not change the coach’s segment', async () => {
    const r = await researchProspect(input, { ai: false, now: NOW, fetchPage: async url => ({ url, html: html + '<p>One client is a business founder and another client is a career coach.</p>' }) });
    assert.deepEqual(r.segments, ['EXECUTIVE']);
});
test('private URLs, credentials, custom ports and private DNS resolutions cannot be fetched', async () => {
    for (const url of ['http://127.0.0.1', 'http://[::1]', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1', 'http://localhost', 'https://coach.test:8080', 'https://user:pass@coach.test', 'file:///etc/passwd']) assert.throws(() => publicUrl(url), undefined, url);
    await assert.rejects(fetchPublicPage('https://coach.test', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), /private/);
});
