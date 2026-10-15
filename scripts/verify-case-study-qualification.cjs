const assert = require('node:assert/strict');
const { DEFAULT_TARGET_TITLES, normalizeTitles, qualifyHeadline, isMissedCoachCandidate } = require('../src/lib/case-study-qualification.cjs');

const positives = [
    'Executive Coaching | Occupational Therapy | Mental Health & Performance',
    'Executive & Business Coach',
    'Executive Leadership Coaching for founders',
    'Certified Career Transition Coach',
    'Career Ownership Coach',
    'Career Clarity | Mentor and Coach Helping Students and Professionals | CEO, Diamond Opticals Ltd',
    'Business Communication Coach | Writer & Editor',
    'ICF Certified Leadership & Communication Coach | Executive Coaching',
    'PCC Coach | Talent Management | Leadership & Organisation Development',
    'Corporate Trainer | Soft Skills Coach | Retail Learning Specialist',
    'International Corporate Trainer | Business & Sales Coach | Team Building',
    'Leadership Trainer and Coach, HBR Advisory Council',
    'Career Consultant | Business School | Coach | Trainer',
    'Coach, Facilitator, Speaker',
    'Author, Educator, Master Coach | Take the first step with a discovery call',
    'Professional Coach',
    'Life & Mindset Coach',
    'I coach business owners to grow sustainable businesses',
    'Coaching leaders through difficult transitions',
    'ICF PCC | Leadership development for executives',
    'CEO Coach | Founder of a coaching practice',
    'Professional Development Coach',
    'Well-being Coach',
];
const negatives = [
    '', '--',
    'Founder, ENEP-Africa',
    'CEO of Splash | Careers, Recruitment and Culture',
    'Health & Performance Executive | Organizational Leadership',
    'Fractional CFO for growing companies',
    'I help coaches turn attention into qualified booked calls | Founder @ Compel',
    'Helping Coaches & Advisors Create High-Quality Podcasts',
    'I create websites for Executive Coaches',
    'Founder | Funnels for business coaches',
    'Seeking a Career Coach',
    'I work with my executive coach',
    'I am not a Career Coach',
    'Aspiring Life Coach',
    'Professional Football Coach',
    'Performance Coach | NCAA athletes',
    'High Performance Strength & Conditioning Coach | Para-Sport | Badminton',
    'PCC member | Franchise Developer | CFA and GCC',
    'Agile Coach | Delivery Champion',
    'Professional Coach | Scrum Coach',
    'VP, Financial Sales Leader | Inspiring & Coaching people to thrive',
    'Career Strategy & Professional Branding Expert | Entrepreneur',
    'Executive Coaching Platform | SaaS Founder',
];
for (const headline of positives) assert.equal(qualifyHeadline(headline).qualified, true, headline);
for (const headline of negatives) assert.equal(qualifyHeadline(headline).qualified, false, headline);

assert.equal(qualifyHeadline('Executive Coaching', ['Career Coach']).qualified, false);
assert.equal(qualifyHeadline('Executive & Business Coach', ['Executive Coach']).qualified, true);
assert.equal(qualifyHeadline('Professional Development Coach', ['Career Coach']).qualified, true);
assert.equal(qualifyHeadline('PCC Coach | Leadership Development', ['Leadership Coach']).qualified, true);
assert.equal(qualifyHeadline('Coach, Facilitator, Speaker', ['Executive Coach']).qualified, false);
assert.equal(qualifyHeadline('Career Clarity | Mentor and Coach | CEO, Diamond Opticals', ['Executive Coach']).qualified, false);
assert.equal(qualifyHeadline('Career Consultant | Business School | Coach', ['Business Coach']).qualified, false);
assert.equal(qualifyHeadline('Career Ownership Coach', ['Career Transition Coach']).qualified, false);
assert.equal(qualifyHeadline('Career Transition Coach', ['Career Transition Coach']).qualified, true);
assert.equal(qualifyHeadline('Certified Breathwork Coach', ['Breathwork Coach']).qualified, true);
assert.equal(qualifyHeadline('Agile Coach', ['Agile Coach']).qualified, true);
assert.equal(qualifyHeadline('Football Coach', ['Football Coach']).qualified, true);
assert.deepEqual(normalizeTitles('Executive Coach\nExecutive Coaching, Career Coach'), ['Executive Coach', 'Career Coach']);
assert.equal(DEFAULT_TARGET_TITLES.length <= 30, true);
const configured = qualifyHeadline('Executive Coaching', ['Executive Coach']);
assert.deepEqual(configured.targetTitles, ['Executive Coach']);

const rejected = { source: 'CONNECTION', scanStatus: 'COMPLETE', stage: 'FOUND', headline: 'Career Ownership Coach', headlineQualification: { qualified: false } };
assert.equal(isMissedCoachCandidate(rejected), true);
for (const override of [{ source: 'MANUAL' }, { crmLeadId: 'crm-id' }, { stage: 'DO_NOT_CONTACT' }, { stage: 'MESSAGED' },
    { lastContactedAt: '2026-09-28T00:00:00Z' }, { scanStatus: 'QUEUED' }, { scanStatus: 'ERROR' },
    { headlineQualification: { qualified: true } }, { headline: 'Agile Coach' }])
    assert.equal(isMissedCoachCandidate({ ...rejected, ...override }), false, JSON.stringify(override));
assert.equal(isMissedCoachCandidate(rejected, ['Executive Coach']), false);
console.log(`Case Study qualification checks passed: ${positives.length} positive headlines, ${negatives.length} exclusions, custom titles and recovery guards.`);
