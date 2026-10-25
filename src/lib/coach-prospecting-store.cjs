"use strict";
const { randomUUID } = require("node:crypto");
const core = require("./linkedin-workers.cjs");
const { assessCoach } = require("./coach-prospecting.cjs");
const ready = new WeakMap();
const SCHEMA = `CREATE TABLE IF NOT EXISTS compel_prospect_runs (
 id UUID PRIMARY KEY,account_id TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',
 data JSONB NOT NULL,owner TEXT,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS compel_prospect_run_queue ON compel_prospect_runs(account_id,status);
 CREATE TABLE IF NOT EXISTS case_study_prospects(id UUID PRIMARY KEY,linkedin_url TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL DEFAULT 0,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS case_study_activities(id UUID PRIMARY KEY,prospect_id UUID NOT NULL REFERENCES case_study_prospects(id) ON DELETE CASCADE,kind TEXT NOT NULL,note TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`;
async function ensure(pool) {
  await core.ensure(pool);
  if (!ready.has(pool))
    ready.set(
      pool,
      (async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtext('compel/prospect-runs/v1'))",
          );
          await c.query(SCHEMA);
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      })().catch((e) => {
        ready.delete(pool);
        throw e;
      }),
    );
  return ready.get(pool);
}
async function transaction(pool, fn) {
  await ensure(pool);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
function sourceUrl(source, value = "") {
  if (source === "CONNECTION")
    return "https://www.linkedin.com/mynetwork/invite-connect/connections/";
  if (source === "FOLLOWER")
    return "https://www.linkedin.com/mynetwork/network-manager/people-follow/followers/";
  if (source === "PROFILE_VIEWER")
    return "https://www.linkedin.com/me/profile-views/";
  if (source === "SEARCH") {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "www.linkedin.com" ||
      u.pathname !== "/search/results/people/" ||
      u.username ||
      u.password
    )
      throw Error(
        "Use a LinkedIn people-search URL starting with https://www.linkedin.com/search/results/people/.",
      );
    u.hash = "";
    return u.href;
  }
  return "";
}
async function account(c, id) {
  const a = (
    await c.query(
      "SELECT id FROM compel_linkedin_accounts WHERE id=$1 AND archived IS FALSE AND signed_out_at IS NULL",
      [id],
    )
  ).rows[0];
  if (!a) throw Error("Choose a saved, signed-in worker account.");
}
async function activity(c, id, kind, note) {
  await c.query(
    "INSERT INTO case_study_activities(id,prospect_id,kind,note) VALUES($1,$2,$3,$4)",
    [randomUUID(), id, kind, note],
  );
}
async function queueProfiles(c, run, urls) {
  let queued = 0,
    skipped = 0;
  const seen = new Set(run.data.seen || []);
  for (const raw of urls) {
    const url = core.profileUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if ((run.data.queued || 0) + queued >= run.data.limit) break;
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [url]);
    const existing = (
      await c.query(
        "SELECT id,data FROM case_study_prospects WHERE lower(regexp_replace(linkedin_url,'/+$',''))=lower(regexp_replace($1,'/+$','')) FOR UPDATE",
        [url],
      )
    ).rows[0];
    const suppressed = await c.query(
      "SELECT 1 FROM leads WHERE lower(regexp_replace(linkedin_url,'/+$',''))=lower(regexp_replace($1,'/+$','')) AND (do_not_contact IS TRUE OR contacted IS TRUE) LIMIT 1",
      [url],
    );
    if (
      suppressed.rowCount ||
      (existing &&
        (existing.data.stage === "DO_NOT_CONTACT" ||
          existing.data.lastContactedAt ||
          existing.data.crmLeadId))
    ) {
      skipped++;
      continue;
    }
    // New discovery never overwrites a worked prospect. Explicit rechecks reuse its existing row.
    if (existing && run.source !== "RECHECK") {
      skipped++;
      continue;
    }
    const id = "job_" + randomUUID();
    const checkpoint = await core.cachedLinkedInProfile(c, url, run.account_id);
    const payload = {
      jobId: id,
      linkedinUrl: url,
      nativePostProcess: false,
      prospecting: {
        runId: run.id,
        accountId: run.account_id,
        source: run.source,
        criteria: run.data.criteria || {},
      },
    };
    const inserted = await c.query(
      "INSERT INTO compel_worker_jobs(id,profile_key,payload,checkpoint) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
      [id, url, core.json(payload), checkpoint ? core.json(checkpoint) : null],
    );
    if (inserted.rowCount) queued++;
    else skipped++;
  }
  return {
    ...run.data,
    seen: [...seen].slice(0, 2000),
    queued: (run.data.queued || 0) + queued,
    skipped: (run.data.skipped || 0) + skipped,
  };
}
async function createRun(pool, input) {
  const sources = [
    "CONNECTION",
    "FOLLOWER",
    "PROFILE_VIEWER",
    "SEARCH",
    "URLS",
    "RECHECK",
  ];
  if (!sources.includes(input.source))
    throw Error("Choose a discovery source.");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw Error("Choose between 1 and 100 new profiles per run.");
  if (typeof input.accountId !== "string" || input.accountId.length > 100)
    throw Error("Choose a worker account.");
  const exclude = (input.exclude || [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (exclude.length > 20 || exclude.some((v) => v.length > 100))
    throw Error("Use up to 20 exclusions of 100 characters each.");
  const urls = input.urls || [];
  if (
    !Array.isArray(urls) ||
    urls.length > 100 ||
    urls.some((u) => !core.profileUrl(u))
  )
    throw Error("Use up to 100 valid /in/ profile URLs.");
  if (["URLS", "RECHECK"].includes(input.source) && !urls.length)
    throw Error("Add profiles to research or recheck.");
  const target = sourceUrl(input.source, input.sourceUrl);
  return transaction(pool, async (c) => {
    await account(c, input.accountId);
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('compel/prospect/run/'||$1))",
      [input.accountId],
    );
    if (
      (
        await c.query(
          "SELECT id FROM compel_prospect_runs WHERE account_id=$1 AND status IN ('PENDING','RUNNING','PAUSED','QUEUED') FOR UPDATE",
          [input.accountId],
        )
      ).rowCount
    )
      throw Error(
        "Finish, resume or stop this account’s current prospecting run first.",
      );
    const run = {
      id: randomUUID(),
      account_id: input.accountId,
      source: input.source,
      status: target ? "PENDING" : "QUEUED",
      data: {
        limit: input.limit,
        sourceUrl: target,
        criteria: { exclude },
        queued: 0,
        skipped: 0,
        seen: [],
        pages: 0,
        discoveryFinished: !target,
        message: target
          ? "Waiting for the selected account worker."
          : "Profiles queued for evidence review.",
      },
    };
    await c.query(
      "INSERT INTO compel_prospect_runs(id,account_id,source,status,data) VALUES($1,$2,$3,$4,$5)",
      [run.id, run.account_id, run.source, run.status, core.json(run.data)],
    );
    if (!target) {
      run.data = await queueProfiles(c, run, urls);
      if (!run.data.queued) run.status = "COMPLETE";
      await c.query(
        "UPDATE compel_prospect_runs SET data=$2,status=$3 WHERE id=$1",
        [run.id, core.json(run.data), run.status],
      );
    }
    return run.id;
  });
}
async function activeAccount(c, id, owner) {
  return (
    await c.query(
      `SELECT a.*,(SELECT count(*) FROM compel_worker_account_profiles p WHERE p.account_id=a.id AND p.day=compel_worker_day()) AS profile_count FROM compel_linkedin_accounts a JOIN compel_worker_sessions s ON s.account_id=a.id
 WHERE a.id=$1 AND a.enabled AND NOT a.archived AND a.signed_out_at IS NULL AND a.logout_requested_at IS NULL AND s.owner=$2 AND s.lease_until>NOW()
 AND a.processing_enabled IS TRUE AND a.connected_at IS NOT NULL AND a.attention_reason=''
 AND (SELECT active_count FROM compel_worker_config WHERE id=1)>0 FOR SHARE OF a`,
      [id, owner],
    )
  ).rows[0];
}
async function claimSource(pool, accountId, owner) {
  return transaction(pool, async (c) => {
    const a = await activeAccount(c, accountId, owner);
    if (!a||Number(a.profile_count)>=a.daily_limit) return null;
    if (
      (
        await c.query(
          "SELECT 1 FROM compel_prospect_runs WHERE account_id=$1 AND status='PAUSED'",
          [accountId],
        )
      ).rowCount
    )
      return null;
    const run = (
      await c.query(
        "SELECT * FROM compel_prospect_runs WHERE account_id=$1 AND (status='PENDING') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [accountId],
      )
    ).rows[0];
    if (!run) return null;
    await c.query(
      "UPDATE compel_prospect_runs SET status='RUNNING',owner=$2,lease_until=NOW()+interval '5 minutes',updated_at=NOW() WHERE id=$1",
      [run.id, owner],
    );
    return { ...run, status: "RUNNING", owner };
  });
}
async function sourceProgress(
  pool,
  runId,
  owner,
  urls,
  info = {},
  finished = false,
) {
  return transaction(pool, async (c) => {
    const run = (
      await c.query(
        "SELECT * FROM compel_prospect_runs WHERE id=$1 AND owner=$2 AND status='RUNNING' AND lease_until>NOW() FOR UPDATE",
        [runId, owner],
      )
    ).rows[0];
    if (!run) return null;
    const data = { ...(await queueProfiles(c, run, urls)), ...info };
    const status =
      finished || data.queued >= data.limit
        ? data.queued
          ? "QUEUED"
          : "COMPLETE"
        : "RUNNING";
    if (status !== "RUNNING") {
      data.discoveryFinished = true;
      if (data.queued >= data.limit)
        data.message = `Collected the requested ${data.queued} profiles for evidence review.`;
    }
    await c.query(
      "UPDATE compel_prospect_runs SET data=$2,status=$3,lease_until=NOW()+interval '5 minutes',updated_at=NOW() WHERE id=$1",
      [run.id, core.json(data), status],
    );
    return { ...run, data, status };
  });
}
async function changeRun(pool, id, operation) {
  if (!validId(id) || !["STOP", "RESUME"].includes(operation))
    throw Error("Choose a valid run action.");
  return transaction(pool, async (c) => {
    const run = (
      await c.query(
        "SELECT * FROM compel_prospect_runs WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!run) throw Error("Run not found.");
    if (operation === "STOP") {
      await c.query(
        "UPDATE compel_prospect_runs SET status='CANCELLED',owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1",
        [id],
      );
      await c.query(
        "UPDATE compel_worker_jobs SET status='cancelled',completed_at=NOW() WHERE payload->'prospecting'->>'runId'=$1 AND status='pending'",
        [id],
      );
    } else {
      if (run.status !== "PAUSED")
        throw Error("Only a paused run can be resumed.");
      await account(c, run.account_id);
      if (
        (
          await c.query(
            "SELECT 1 FROM compel_worker_sessions WHERE account_id=$1 AND status->>'status'='paused'",
            [run.account_id],
          )
        ).rowCount
      )
        throw Error(
          "Resolve the LinkedIn account check in Pipeline Engine and sign in on the worker before resuming.",
        );
      const status = run.data.discoveryFinished ? "QUEUED" : "PENDING";
      await c.query(
        "UPDATE compel_prospect_runs SET status=$2,owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1",
        [id, status],
      );
      await c.query(
        "UPDATE compel_worker_jobs SET retry_at=NULL WHERE payload->'prospecting'->>'runId'=$1 AND status='pending'",
        [id],
      );
    }
  });
}
async function pauseAccount(pool, accountId, message) {
  return transaction(pool, async (c) => {
    await c.query(
      "UPDATE compel_prospect_runs SET status='PAUSED',data=jsonb_set(data,'{message}',to_jsonb($2::text)),owner=NULL,lease_until=NULL,updated_at=NOW() WHERE account_id=$1 AND status IN ('PENDING','RUNNING','QUEUED')",
      [accountId, message],
    );
  });
}
async function releaseSource(pool,runId,owner) {
  // A global account pause suspends discovery without individually stopping
  // that campaign. A user-cancelled/held run cannot be reactivated here.
  return pool.query("UPDATE compel_prospect_runs SET status='PENDING',owner=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1 AND owner=$2 AND status='RUNNING'",[runId,owner]);
}
async function runIsActive(pool, id) {
  const r = await pool.query(
    "SELECT status FROM compel_prospect_runs WHERE id=$1",
    [id],
  );
  return r.rows[0] && !["CANCELLED", "ERROR"].includes(r.rows[0].status);
}
async function finishProfile(pool, job, result, research) {
  return transaction(pool, async (c) => {
    const meta = job.prospecting;
    const run = (
      await c.query(
        "SELECT * FROM compel_prospect_runs WHERE id=$1 FOR UPDATE",
        [meta.runId],
      )
    ).rows[0];
    if (!run || ["CANCELLED", "ERROR"].includes(run.status))
      return { status: "CANCELLED" };
    const lease = (
      await c.query(
        "SELECT id FROM compel_worker_jobs WHERE id=$1 AND owner=$2 AND status='processing' AND lease_until>NOW() FOR UPDATE",
        [job.jobId, job.owner],
      )
    ).rowCount;
    if (!lease) throw Error("Prospect job lease lost.");
    const url = core.profileUrl(job.linkedinUrl);
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [url]);
    const old = (
      await c.query(
        "SELECT * FROM case_study_prospects WHERE lower(regexp_replace(linkedin_url,'/+$',''))=lower(regexp_replace($1,'/+$','')) FOR UPDATE",
        [url],
      )
    ).rows[0];
    if (old?.data.prospecting?.lastJobId === job.jobId)
      return { status: "PROSPECTED" };
    if (
      old &&
      (old.data.stage === "DO_NOT_CONTACT" ||
        old.data.lastContactedAt ||
        old.data.crmLeadId)
    )
      return { status: "SKIPPED" };
    const automatedAssessment = assessCoach(result, research, meta.criteria);
    const manual = old?.data.prospecting?.assessment;
    // A recheck refreshes evidence; only another operator review replaces a
    // recorded human decision. This also avoids relying on cross-host clocks.
    const follower=require("./follower-policy.cjs").followersDecision(research.followers||result.followers,require("./follower-policy.cjs").minFollowers());
    const assessment = follower.status==='CONTINUE'&&manual?.reason?.startsWith("Operator review:")
      ? manual
      : automatedAssessment;
    const base = old?.data || {
      name: "",
      linkedinUrl: url,
      headline: "",
      location: "",
      website: "",
      email: "",
      source: ["CONNECTION", "FOLLOWER", "PROFILE_VIEWER"].includes(meta.source)
        ? meta.source
        : "MANUAL",
      warmthEvidence: "",
      mode: "CLIENT",
      stage: "FOUND",
      scanStatus: "COMPLETE",
      coachFit: "MAYBE",
      headlineQualification: { qualified: false, matches: [], reason: "" },
      websiteScan: {
        method: "NOT_RUN",
        pages: [],
        challenge: "",
        completedAt: "",
      },
      scores: {
        icpFit: 0,
        warmth: 0,
        funnelWeakness: 0,
        commercialPotential: 0,
        total: 0,
      },
      whyContact: "",
      mainWeakness: "",
      outreachAngle: "",
      suggestedDm: "",
      recommendedNextAction: "",
      observations: [],
      nextAction: "",
      nextActionDueAt: "",
      lastContactedAt: "",
      notes: "",
      delivery: {
        strongestLeaks: ["", "", ""],
        auditUrl: "",
        discoveryCallAt: "",
        beforeScreenshots: [],
        afterScreenshots: [],
        oldCopy: "",
        newCopy: "",
        rationale: "",
        metrics: "",
        testimonial: "",
        caseStudyUrl: "",
      },
    };
    let discoverySource = base.prospecting?.discoverySource;
    if (
      !discoverySource &&
      meta.source === "RECHECK" &&
      base.prospecting?.runId
    ) {
      discoverySource = (
        await c.query(
          "SELECT source FROM compel_prospect_runs WHERE id::text=$1",
          [base.prospecting.runId],
        )
      ).rows[0]?.source;
      if (discoverySource === "RECHECK") discoverySource = null;
    }
    discoverySource ||= meta.source !== "RECHECK" ? meta.source : base.source;
    const incomingContact = result.linkedinContact || null;
    const previousContact = base.prospecting?.contact;
    const contact =
      previousContact?.source === "MANUAL" &&
      (!incomingContact ||
        Date.parse(previousContact.checkedAt) >
          Date.parse(incomingContact.checkedAt))
        ? previousContact
        : incomingContact || previousContact || null;
    const next = {
      ...base,
      name:
        [result.firstName, result.lastName].filter(Boolean).join(" ") ||
        base.name,
      headline: result.headline || base.headline,
      location: result.profileLocation || base.location,
      website: research.website || result.website || base.website,
      scanStatus: "COMPLETE",
      coachFit:
        assessment.status === "MATCH"
          ? "YES"
          : assessment.status === "OUTSIDE"
            ? "NO"
            : "MAYBE",
      headlineQualification: {
        ...base.headlineQualification,
        qualified: assessment.status === "MATCH",
        reason: assessment.reason,
      },
      stage:
        base.stage === "FOUND" && assessment.status === "MATCH"
          ? "QUALIFIED"
          : base.stage,
      scores: {
        ...base.scores,
        icpFit: assessment.score,
        total: assessment.score,
      },
      whyContact: assessment.reason,
      prospecting: {
        ...base.prospecting,
        assessment,
        automatedAssessment,
        contact,
        about: String(result.about || "").slice(0, 10000),
        followers:research.followers||result.followers,connections:research.connections||result.connections,
        runId: meta.runId,
        lastJobId: job.jobId,
        accountId: meta.accountId,
        discoverySource,
        researchStatus:
          research.crawl?.complete === false ? "PARTIAL" : "COMPLETE",
        websiteSources: (research.pages || [])
          .map((s) => ({ url: s.url, title: s.title }))
          .slice(0, 20),
      },
      nextAction:
        assessment.status === "MATCH"
          ? "Verify the contact route and review an outreach draft."
          : "Review the saved evidence before deciding whether this coach fits.",
    };
    next.recommendedNextAction = next.nextAction;
    const id = old?.id || randomUUID();
    if (old)
      await c.query(
        "UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1",
        [id, core.json(next)],
      );
    else
      await c.query(
        "INSERT INTO case_study_prospects(id,linkedin_url,data) VALUES($1,$2,$3)",
        [id, url, core.json(next)],
      );
    await activity(c, id, "COACH_EVIDENCE", assessment.reason);
    return { status: follower.status==='CONTINUE'?'PROSPECTED':follower.status, assessment, prospectId: id };
  });
}
async function refreshRuns(pool) {
  await ensure(pool);
  await pool.query(`UPDATE compel_prospect_runs r SET status='COMPLETE',updated_at=NOW() WHERE status='QUEUED'
 AND NOT EXISTS(SELECT 1 FROM compel_worker_jobs j WHERE j.payload->'prospecting'->>'runId'=r.id::text AND j.status IN('pending','processing'))`);
}
module.exports = {
  SCHEMA,
  ensure,
  transaction,
  sourceUrl,
  createRun,
  claimSource,
  sourceProgress,
  changeRun,
  pauseAccount,
  releaseSource,
  runIsActive,
  finishProfile,
  refreshRuns,
  activity,
};
