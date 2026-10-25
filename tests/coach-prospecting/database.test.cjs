"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { Pool } = require("pg"),
  core = require("../../src/lib/linkedin-workers.cjs"),
  store = require("../../src/lib/coach-prospecting-store.cjs");
require("@next/env").loadEnvConfig(
  require("node:path").resolve(__dirname, "../.."),
);
test("prospecting shares account leases and budgets, persists jobs and protects existing outreach in an isolated PostgreSQL schema", async () => {
  const raw = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });
  const schema = "compel_prospect_test_" + randomUUID().replaceAll("-", "");
  assert.match(schema, /^compel_prospect_test_[a-f0-9]{32}$/);
  const names =
    "compel_worker_events|compel_worker_config|compel_linkedin_accounts|compel_worker_usage|compel_worker_profile_usage|compel_worker_account_profiles|compel_worker_day|compel_worker_sessions|compel_worker_jobs|compel_research_budget|compel_prospect_runs|case_study_prospects|case_study_activities|leads";
  const qualify = (sql) =>
    sql.replace(new RegExp("\\b(" + names + ")\\b", "g"), `"${schema}".$1`);
  const pool = {
    query: (sql, values) => raw.query(qualify(sql), values),
    connect: async () => {
      const c = await raw.connect();
      return {
        query: (sql, values) => c.query(qualify(sql), values),
        release: () => c.release(),
      };
    },
  };
  try {
    await raw.query(`CREATE SCHEMA "${schema}"`);
    await store.ensure(pool);
    await pool.query(
      "CREATE TABLE leads(id TEXT PRIMARY KEY,linkedin_url TEXT,do_not_contact BOOLEAN,contacted BOOLEAN)",
    );
    await core.importAccounts(pool, [
      { email: "one@example.test", password: "fixture" },
      { email: "two@example.test", password: "fixture" },
    ]);
    let config = await core.settings(pool);
    await core.saveSettings(pool, {
      ...config,
      activeCount: 2,
      accounts: config.accounts.map((a) => ({
        ...a,
        password: "",
        dailyLimit: 4,
      })),
    });
    await pool.query("UPDATE compel_linkedin_accounts SET processing_enabled=TRUE,processing_until=NOW()+interval '2 hours',connected_at=NOW()");
  await core.acquireSession(pool, "legacy-0", "owner-one");
    await core.acquireSession(pool, "legacy-1", "owner-two");
    const runId = await store.createRun(pool, {
      accountId: "legacy-0",
      source: "CONNECTION",
      limit: 3,
    });
    await assert.rejects(
      store.createRun(pool, {
        accountId: "legacy-0",
        source: "CONNECTION",
        limit: 3,
      }),
      /current prospecting run/,
    );
    assert.equal(
      await store.claimSource(pool, "legacy-1", "owner-two"),
      null,
      "a discovery run cannot use another account",
    );
    const [run, duplicate] = await Promise.all([
      store.claimSource(pool, "legacy-0", "owner-one"),
      store.claimSource(pool, "legacy-0", "owner-one"),
    ]);
    assert.ok(run);
    assert.equal(duplicate, null);
    assert.equal(
      (await core.settings(pool)).accounts[0].dailyCount,
      0,
      "source lists are not profile reads",
    );
    const urls = [
      "https://www.linkedin.com/in/coach-one/",
      "https://www.linkedin.com/in/coach-two/",
      "https://www.linkedin.com/in/excluded/",
    ];
    await pool.query("INSERT INTO leads VALUES($1,$2,TRUE,FALSE)", [
      "excluded",
      urls[2],
    ]);
    await store.sourceProgress(
      pool,
      runId,
      "owner-one",
      urls,
      { pages: 1, discoveryFinished: true },
      true,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM compel_worker_jobs"))
        .rows[0].n,
      2,
    );
    assert.equal(
      await core.claim(pool, "legacy-1", "owner-two"),
      null,
      "assigned prospect jobs never consume another account",
    );
    const first = await core.claim(pool, "legacy-0", "owner-one");
    assert.equal(first.dailyCount, 0);
    const result = {
      url: first.job.linkedinUrl,
      profileIdentityConfirmed: true,followers:{count:2000,rawText:"2,000 followers"},
      firstName: "Evidence",
      lastName: "Coach",
      headline: "I help people navigate change",
      about:
        "I am a career coach. I help professionals change direction. Work with me through my coaching program.",
      emails: [],
      linkedinContact: {
        accountId: "legacy-0",
        connection: "CONNECTED",
        openProfile: "UNKNOWN",
        checkedAt: new Date().toISOString(),
        source: "WORKER",
        note: "Matching profile distance.",
      },
    };
    await core.checkpoint(pool, first.job.jobId, "owner-one", result);
    const saved = await store.finishProfile(
      pool,
      { ...first.job, owner: "owner-one" },
      result,
      { facts: {}, websiteStatus: "NONE" },
    );
    assert.equal(saved.assessment.status, "MATCH");
    let prospect = (
      await pool.query("SELECT * FROM case_study_prospects WHERE id=$1", [
        saved.prospectId,
      ])
    ).rows[0];
    assert.equal(prospect.data.stage, "QUALIFIED");
    assert.equal(prospect.data.email, "");
    assert.equal(prospect.data.prospecting.discoverySource, "CONNECTION");
    const revision = prospect.revision;
    await store.finishProfile(
      pool,
      { ...first.job, owner: "owner-one" },
      result,
      { facts: {} },
    );
    assert.equal(
      (
        await pool.query(
          "SELECT revision FROM case_study_prospects WHERE id=$1",
          [saved.prospectId],
        )
      ).rows[0].revision,
      revision,
      "a repeated completion is idempotent",
    );
    await core.complete(pool, first.job.jobId, "owner-one", {
      ...result,
      status: "PROSPECTED",
    });
    const cachedRun = await store.createRun(pool, {
      accountId: "legacy-1",
      source: "RECHECK",
      limit: 1,
      urls: [first.job.linkedinUrl],
    });
    const cached = await core.claim(pool, "legacy-1", "owner-two");
    assert.equal(cached.job.resumeResult,undefined,'Explicit rechecks refresh followers instead of reusing unchecked capture');
    assert.equal(
      cached.dailyCount,
      0,
      "claiming a fresh recheck does not charge until its actual profile navigation",
    );
    const manual = {
      ...saved.assessment,
      status: "OUTSIDE",
      score: 0,
      reason: "Operator review: a newer decision made during the run.",
      assessedAt: new Date(Date.now() + 1000).toISOString(),
    };
    // Legacy records have only a run ID; rechecking must recover the original source.
    await pool.query(
      "UPDATE case_study_prospects SET data=data#-'{prospecting,discoverySource}' WHERE id=$1",
      [saved.prospectId],
    );
    await pool.query(
      "UPDATE case_study_prospects SET data=jsonb_set(data,'{prospecting,assessment}',$2::jsonb) WHERE id=$1",
      [saved.prospectId, JSON.stringify(manual)],
    );
    const kept = await store.finishProfile(
      pool,
      { ...cached.job, owner: "owner-two" },
      result,
      { facts: {} },
    );
    assert.equal(
      kept.assessment.status,
      "OUTSIDE",
      "a late worker cannot overwrite a newer manual fit review",
    );
    assert.equal(
      (
        await pool.query("SELECT data FROM case_study_prospects WHERE id=$1", [
          saved.prospectId,
        ])
      ).rows[0].data.prospecting.discoverySource,
      "CONNECTION",
    );
    await core.complete(pool, cached.job.jobId, "owner-two", {
      status: "PROSPECTED",
    });
    await store.refreshRuns(pool);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM compel_prospect_runs WHERE id=$1",
          [cachedRun],
        )
      ).rows[0].status,
      "COMPLETE",
    );
    const second = await core.claim(pool, "legacy-0", "owner-one");
    await store.pauseAccount(pool, "legacy-0", "Fixture LinkedIn rate limit");
    await core.defer(
      pool,
      second.job.jobId,
      "owner-one",
      { status: "ERROR", failure: { stage: "linkedin" } },
      new Date().toISOString(),
    );
    assert.equal(
      await core.claim(pool, "legacy-0", "owner-one"),
      null,
      "paused prospecting jobs do not auto-retry",
    );
    await store.changeRun(pool, runId, "RESUME");
    const resumed = await core.claim(pool, "legacy-0", "owner-one");
    assert.equal(resumed.job.jobId, second.job.jobId);
    assert.equal(
      resumed.dailyCount,
      0,
      "claiming a checkpoint does not spend a profile slot",
    );
    await store.changeRun(pool, runId, "STOP");
    assert.equal(await store.runIsActive(pool, runId), false);
    assert.equal(
      (
        await store.finishProfile(
          pool,
          { ...resumed.job, owner: "owner-one" },
          result,
          { facts: {} },
        )
      ).status,
      "CANCELLED",
    );
    await core.complete(pool, resumed.job.jobId, "owner-one", {
      status: "CANCELLED",
    });
    await pool.query(
      "UPDATE case_study_prospects SET data=jsonb_set(data,'{stage}','\"DO_NOT_CONTACT\"') WHERE id=$1",
      [saved.prospectId],
    );
    const check = await store.createRun(pool, {
      accountId: "legacy-0",
      source: "RECHECK",
      limit: 1,
      urls: [first.job.linkedinUrl],
    });
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM compel_prospect_runs WHERE id=$1",
          [check],
        )
      ).rows[0].status,
      "COMPLETE",
      "excluded people are not queued again",
    );
    // A source run at the exact shared budget must not open LinkedIn at all.
    await pool.query(
      "INSERT INTO compel_worker_account_profiles(account_id,day,profile_key,job_id) SELECT 'legacy-0',compel_worker_day(),'https://www.linkedin.com/in/cap-'||n||'/','fixture' FROM generate_series(1,4) n",
    );
    await store.createRun(pool, {
      accountId: "legacy-0",
      source: "FOLLOWER",
      limit: 2,
    });
    assert.equal(await store.claimSource(pool, "legacy-0", "owner-one"), null);
  } finally {
    await raw.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await raw.end();
  }
});
