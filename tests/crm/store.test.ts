import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/lib/pg_setup';
import { crmLead, getCrmLeads, getCrmPage, setCrmContacted } from '../../src/lib/crm-store';
import { assessProspect, hasQualifiedEmail, isQualifiedRecord } from '../../src/lib/prospect-qualification.cjs';
import { prospect, research } from '../prospects/fixtures.cjs';

const query = pool.query;
afterEach(() => { pool.query = query; });

test('compact assessment preserves qualification, ownership, priority and current activity gates', () => {
    for (const changes of [{}, { profileIdentityConfirmed: false }, { lastActivityAt: new Date(Date.now()-40*86400000).toISOString() },
        { contacts: [] }, { segments: [], headline: 'Fitness coach' }]) {
        const value = prospect('compact', { prospect_assessment: assessProspect(research(changes), { email: 'ava@avamorgan.test' }) });
        const compact = crmLead(value);
        assert.equal(hasQualifiedEmail(compact), hasQualifiedEmail(value));
        assert.equal(isQualifiedRecord(compact), isQualifiedRecord(value));
        assert.equal(compact.prospect_assessment?.score, assessProspect(value.prospect_assessment.research, { email: value.email }).score);
        assert.equal((compact.prospect_assessment?.research as any)?.pages, undefined);
        assert.equal((compact.prospect_assessment as any)?.baseResearch, undefined);
    }
});
test('current email and manual ownership reviews remain authoritative', () => {
    const value = prospect('ownership', { email: 'new@avamorgan.test', prospect_review: { facts: {}, contactEmail: 'new@avamorgan.test', contactOwnership: 'CONFIRMED' } });
    assert.equal(crmLead(value).prospect_assessment?.contact.ownership, 'MANUAL_CONFIRMED');
    value.prospect_review.contactOwnership = 'UNCONFIRMED';
    assert.equal(hasQualifiedEmail(crmLead(value)), false);
});
test('legacy labels are sanitized without writing to the database; suppression and bounce evidence remain', () => {
    for (const status of ['VALID','INVALID','RISKY']) {
        const value = prospect('legacy', { email_status: status, email_verification_method: null, email_verification_reason: null });
        assert.equal(crmLead(value).email_status, 'UNVERIFIED');
        assert.equal(value.email_status, status);
        if (status !== 'VALID') {
            assert.equal(crmLead({ ...value, outcome: 'BOUNCED' }).email_status, status);
            assert.equal(crmLead({ ...value, do_not_contact: true }).email_status, status);
        }
    }
});
test('Hunter membership reserves contact without replacing stronger existing evidence', () => {
    const value = prospect('hunter', { contacted: false, contacted_source: null, in_hunter: true });
    assert.equal(crmLead(value).contacted, true);
    assert.equal(crmLead(value).contacted_source, 'HUNTER');
    assert.equal(crmLead({ ...value, contacted_source: 'PLATFORM' }).contacted_source, 'PLATFORM');
});
test('CRM loading uses one read-only projected query and no maintenance actions', async () => {
    let calls = 0;
    (pool as any).query = async (sql: string) => { calls++; assert.doesNotMatch(sql, /\bUPDATE\b|SELECT \*/); assert.match(sql, /WITH ORDINALITY/); return { rows: [prospect('read')] }; };
    assert.equal((await getCrmLeads()).length, 1);
    assert.equal(calls, 1);
});
test('a bulk contact update makes one atomic query, deduplicates IDs and returns only contact fields', async () => {
    let calls = 0;
    (pool as any).query = async (sql: string, args: unknown[]) => {
        calls++; assert.deepEqual(args, [['a','b'], true]); assert.match(sql, /COUNT\(\*\) FROM target\)=cardinality/);
        assert.match(sql, /SELECT t.id FROM target t/); // Evaluate protected evidence from the locked row.
        assert.match(sql, /NOT EXISTS\(SELECT 1 FROM blocked\)/); assert.doesNotMatch(sql, /RETURNING \*/);
        return { rows: [{ id:'a', contacted:true, contacted_source:'MANUAL' },{ id:'b', contacted:true, contacted_source:'PLATFORM' }] };
    };
    assert.equal((await setCrmContacted(['a','b','a'], true)).length, 2);
    assert.equal(calls, 1);
});
test('page bounds are applied before research projection and each page carries the total', async () => {
    (pool as any).query = async (sql: string, args: unknown[]) => {
        assert.deepEqual(args,[100,2000]);assert.match(sql,/page AS MATERIALIZED/);
        assert.match(sql,/WHERE l.id IN \(SELECT id FROM page\)/);assert.doesNotMatch(sql,/UPDATE|SELECT \*/);
        return { rows: [{ ...prospect('page'),total_count:14406 }] };
    };
    const page = await getCrmPage(100,2000);
    assert.equal(page.total,14406);assert.equal(page.data.length,1);assert.equal((page.data[0] as any).total_count,undefined);
});
test('blocked/failed saves reject and empty selections do not issue queries', async () => {
    let calls = 0;
    (pool as any).query = async () => { calls++; return { rows: [] }; };
    assert.deepEqual(await setCrmContacted([], true), []);
    assert.equal(calls, 0);
    await assert.rejects(setCrmContacted(['hunter'], false), /Hunter/);
    (pool as any).query = async () => { throw Object.assign(new Error('Database unavailable'), { code:'08006' }); };
    await assert.rejects(setCrmContacted(['a'], true), /unavailable/);
});
