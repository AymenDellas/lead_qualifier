const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { qualifyHeadline } = require('../case-study-worker-core.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'case-study-worker.cjs'), 'utf8');
const profileCode = source.slice(source.indexOf('function profileAssessment('), source.indexOf('async function saveResult('));
function harness(headline, website = 'https://coach.example/') {
    let discoveryCalls = 0;
    const phases = [];
    const context = vm.createContext({
        qualifyHeadline, ENV_TARGET_TITLES: ['Executive Coach'],
        throwIfCancelled() {},
        setPhase: (phase) => phases.push(phase), log() {},
        readProfile: async () => ({ firstName: 'Alex', lastName: 'Coach', headline, slug: 'alex', profilePayload: { private: true } }),
        findWebsite: async () => { discoveryCalls += 1; return website; },
        // A regression that adds any page crawl or analysis back into this path
        // fails immediately, rather than silently passing with mocked results.
        crawlWebsite: async () => { throw new Error('Funnel crawling must not run'); },
        analyzeFunnelPages: () => { throw new Error('Funnel analysis must not run'); },
        scoreProspect: () => { throw new Error('Funnel scoring must not run'); },
        buildOutreach: () => { throw new Error('Automated outreach generation must not run'); },
    });
    vm.runInContext(profileCode, context);
    return { run: () => context.processProfile({ linkedinUrl: 'https://www.linkedin.com/in/alex/' }), phases, calls: () => discoveryCalls };
}

test('a matching coach saves both URLs without crawling, scoring, or generating a DM', async () => {
    const h = harness('Executive Coach for founders');
    const result = await h.run();
    assert.equal(result.status, 'QUALIFIED');
    assert.equal(result.url, 'https://www.linkedin.com/in/alex/');
    assert.equal(result.website, 'https://coach.example/');
    assert.equal(result.caseStudy.websiteScan.method, 'FOUND');
    assert.equal(result.caseStudy.headlineQualification.qualified, true);
    assert.equal(result.caseStudy.suggestedDm, '');
    assert.equal(result.caseStudy.observations.length, 0);
    assert.equal(result.profilePayload, undefined);
    assert.equal(result.slug, undefined);
    assert.equal(h.calls(), 1);
    assert.ok(!h.phases.includes('ANALYZING_FUNNEL'));
});

test('a non-matching headline still stops before website discovery', async () => {
    const h = harness('Software Engineer');
    const result = await h.run();
    assert.equal(result.status, 'REJECTED_HEADLINE');
    assert.equal(result.caseStudy.coachFit, 'NO');
    assert.equal(result.website, '');
    assert.equal(h.calls(), 0);
});

test('a matching profile with no website remains qualified for manual review', async () => {
    const h = harness('Executive Coach', '');
    const result = await h.run();
    assert.equal(result.status, 'QUALIFIED');
    assert.equal(result.caseStudy.coachFit, 'YES');
    assert.equal(result.website, '');
    assert.equal(result.caseStudy.websiteScan.method, 'NOT_FOUND');
    assert.match(result.caseStudy.recommendedNextAction, /Find the public website/);
});
