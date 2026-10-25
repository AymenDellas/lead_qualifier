"use server";
import { requireWorkerAdmin as requireAdmin } from "@/lib/worker-admin";
import { pool } from "@/lib/pg_setup";
import * as store from "@/lib/coach-prospecting-store.cjs";
import { settings } from "@/lib/linkedin-workers.cjs";
import {followersDecision,minFollowers} from '@/lib/follower-policy.cjs';
import {
  assessCoach,
  shortlist,
  contactRoute,
} from "@/lib/coach-prospecting.cjs";
import { mapCaseStudyProspect } from "@/lib/case-study-store";
import { validateCaseStudyProspect } from "@/lib/case-study-validation";
import { markHunterProspectLinkedinDmSentAction } from "./linkedin-outreach-actions";
import { z } from "zod/v4";
import type { CoachContact, CoachRun } from "@/lib/coach-prospecting";
import { COACH_SOURCES } from "@/lib/coach-prospecting";
import type { CaseStudyProspectData } from "@/lib/case-study";

const idSchema = z.string().uuid();
const requestSchema = z.object({
  accountId: z.string().min(1).max(100),
  source: z.enum([
    "CONNECTION",
    "FOLLOWER",
    "PROFILE_VIEWER",
    "SEARCH",
    "URLS",
    "RECHECK",
  ]),
  limit: z.number().int().min(1).max(100),
  sourceUrl: z.string().max(3000).optional(),
  urls: z.array(z.string().max(2000)).max(100).optional(),
  exclude: z.array(z.string().max(100)).max(20).optional(),
});
export async function loadCoachProspectingAction(
  options: {
    accountId?: string;
    query?: string;
    list?: string;
    source?: string;
    page?: number;
  } = {},
) {
  await requireAdmin();
  if (
    (options.query || "").length > 150 ||
    !Number.isInteger(options.page || 0) ||
    (options.page || 0) < 0 ||
    (options.source !== undefined &&
      !Object.hasOwn(COACH_SOURCES, options.source))
  )
    throw Error("Invalid prospect filters.");
  await store.refreshRuns(pool);
  const config = await settings(pool);
  const accounts = config.accounts.map(
    ({
      id,
      label,
      dailyCount,
      dailyLimit,
      status,
      reason,
      online,
      prospectingReady,
      signedIn,
      enabled,
    }) => ({
      id,
      label,
      dailyCount,
      dailyLimit,
      status,
      reason,
      online,
      prospectingReady,
      signedIn,
      enabled,
    }),
  );
  const accountId = accounts.some((a) => a.id === options.accountId)
    ? options.accountId!
    : accounts[0]?.id || "";
  const rows = await pool.query(
    `SELECT p.id,p.revision,p.created_at,p.updated_at,jsonb_build_object(
 'name',p.data->'name','linkedinUrl',p.linkedin_url,'headline',p.data->'headline','website',p.data->'website','location',p.data->'location','source',p.data->'source',
 'stage',p.data->'stage','lastContactedAt',p.data->'lastContactedAt','suggestedDm',p.data->'suggestedDm',
 'prospecting',(coalesce(p.data->'prospecting','{}'::jsonb)-'about'-'websiteSources')||jsonb_build_object('discoverySource',COALESCE(p.data->'prospecting'->>'discoverySource',NULLIF(r.source,'RECHECK'),p.data->>'source','MANUAL')),
 'headlineQualification',p.data->'headlineQualification','scanStatus',p.data->'scanStatus','coachFit',p.data->'coachFit') AS data,
 EXISTS(SELECT 1 FROM leads l WHERE lower(regexp_replace(l.linkedin_url,'/+$',''))=lower(regexp_replace(p.linkedin_url,'/+$','')) AND l.do_not_contact IS TRUE) AS suppressed,
 EXISTS(SELECT 1 FROM leads l WHERE lower(regexp_replace(l.linkedin_url,'/+$',''))=lower(regexp_replace(p.linkedin_url,'/+$','')) AND l.contacted IS TRUE) AS previously_contacted
 FROM case_study_prospects p LEFT JOIN compel_prospect_runs r ON r.id::text=p.data->'prospecting'->>'runId'
 WHERE concat_ws(' ',p.data->>'name',p.data->>'headline',p.data->>'website') ILIKE $1`,
    ["%" + (options.query || "").trim() + "%"],
  );
  const classified = rows.rows
    .map((row) => {
      row.data.prospecting = {
        ...row.data.prospecting,
        suppressed: row.suppressed,
      };
      if (row.previously_contacted && !row.data.lastContactedAt)
        row.data.lastContactedAt = row.updated_at;
      return { ...row, classification: shortlist(row.data, accountId) };
    })
    .sort(
      (a, b) =>
        b.classification.score - a.classification.score ||
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
        a.id.localeCompare(b.id),
    );
  const sourceCounts: Record<string, number> = { ALL: classified.length };
  for (const row of classified) {
    const source = row.data.prospecting.discoverySource;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }
  const sourced = classified.filter(
    (row) =>
      !options.source ||
      options.source === "ALL" ||
      row.data.prospecting.discoverySource === options.source,
  );
  const counts: Record<string, number> = { ALL: sourced.length };
  for (const row of sourced)
    counts[row.classification.list] =
      (counts[row.classification.list] || 0) + 1;
  const selected = sourced.filter(
    (row) =>
      !options.list ||
      options.list === "ALL" ||
      row.classification.list === options.list,
  );
  const page = options.page || 0;
  const runs = (
    await pool.query(
      `SELECT r.*,count(j.id) FILTER(WHERE j.status='done' AND j.result->>'status'='PROSPECTED')::int AS done,
 count(j.id) FILTER(WHERE j.status='done' AND j.result->>'status'='ERROR')::int AS failed,
 count(j.id) FILTER(WHERE j.status IN('pending','processing'))::int AS pending FROM compel_prospect_runs r
 LEFT JOIN compel_worker_jobs j ON j.payload->'prospecting'->>'runId'=r.id::text WHERE r.account_id=$1 GROUP BY r.id ORDER BY r.created_at DESC LIMIT 12`,
      [accountId],
    )
  ).rows as CoachRun[];
  return {
    accountId,
    accounts,
    counts,
    sourceCounts,
    rows: selected.slice(page * 40, (page + 1) * 40).map((row) => ({
      id: String(row.id),
      revision: Number(row.revision),
      data: row.data as CaseStudyProspectData,
      classification: row.classification,
    })),
    total: selected.length,
    page,
    hasMore: (page + 1) * 40 < selected.length,
    runs,
    activeCount: config.activeCount,
    supervisorOnline: config.supervisorOnline,
  };
}
export async function startCoachProspectingAction(input: unknown) {
  await requireAdmin();
  return store.createRun(pool, requestSchema.parse(input));
}
export async function changeCoachRunAction(
  id: string,
  operation: "STOP" | "RESUME",
) {
  await requireAdmin();
  return store.changeRun(pool, idSchema.parse(id), operation);
}
export async function retryCoachRunAction(id: string) {
  await requireAdmin();
  idSchema.parse(id);
  await store.ensure(pool);
  const run = (
    await pool.query("SELECT * FROM compel_prospect_runs WHERE id=$1", [id])
  ).rows[0];
  if (!run) throw Error("Run not found.");
  const jobs = (
    await pool.query(
      "SELECT profile_key FROM compel_worker_jobs WHERE payload->'prospecting'->>'runId'=$1 AND status='done' AND result->>'status'='ERROR' LIMIT 100",
      [id],
    )
  ).rows;
  if (!jobs.length) throw Error("No failed profiles remain to retry.");
  return store.createRun(pool, {
    accountId: run.account_id,
    source: "RECHECK",
    limit: jobs.length,
    urls: jobs.map((j) => j.profile_key),
    exclude: run.data.criteria?.exclude || [],
  });
}
export async function loadCoachProspectAction(id: string) {
  await requireAdmin();
  idSchema.parse(id);
  await store.ensure(pool);
  const row = (
    await pool.query("SELECT * FROM case_study_prospects WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw Error("Prospect no longer exists.");
  return mapCaseStudyProspect(row);
}
const editSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CONTACT"),
    accountId: z.string().min(1).max(100),
    connection: z.enum(["CONNECTED", "NOT_CONNECTED", "PENDING", "UNKNOWN"]),
    openProfile: z.enum(["YES", "NO", "UNKNOWN"]),
    note: z
      .string()
      .trim()
      .min(10, "Record what you verified on LinkedIn.")
      .max(2000),
  }),
  z.object({
    kind: z.literal("FIT"),
    status: z.enum(["MATCH", "POTENTIAL", "OUTSIDE"]),
    note: z.string().trim().min(15, "Explain your fit decision.").max(2000),
  }),
  z.object({
    kind: z.literal("DRAFT"),
    channel: z.enum(["MESSAGE", "INVITATION"]).default("MESSAGE"),
    text: z.string().max(8000),
  }),
  z.object({
    kind: z.literal("INVITATION_SENT"),
    accountId: z.string().min(1).max(100),
  }),
]);
export async function saveCoachReviewAction(
  id: string,
  revision: number,
  input: unknown,
) {
  await requireAdmin();
  idSchema.parse(id);
  if (!Number.isInteger(revision))
    throw Error("Reload this prospect before saving.");
  const edit = editSchema.parse(input);
  if (
    edit.kind === "DRAFT" &&
    edit.channel === "INVITATION" &&
    edit.text.length > 200
  )
    throw Error("Keep the connection note within 200 characters.");
  return store.transaction(pool, async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM case_study_prospects WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row || row.revision !== revision)
      throw Error("This prospect changed. Reload their details before saving.");
    const d = mapCaseStudyProspect(row).data;
    const previous = d.prospecting || {
      assessment: assessCoach({
        url: d.linkedinUrl,
        headline: d.headline,
        profileIdentityConfirmed: false,
      }),
      contact: null,
      accountId: "",
      about: "",
      researchStatus: "NOT_RESEARCHED",
    };
    let next = { ...d, prospecting: { ...previous } };
    if (edit.kind === "FIT") {
        if(edit.status==='MATCH'&&followersDecision(previous.followers,previous.followers?.threshold??minFollowers()).status!=='CONTINUE')throw Error('Recheck followers before marking this prospect a match. The count must exceed the configured minimum.');
      next.prospecting.assessment = {
        ...previous.assessment,
        status: edit.status,
        score:
          edit.status === "MATCH"
            ? Math.max(55, previous.assessment.score)
            : edit.status === "OUTSIDE"
              ? 0
              : Math.min(45, previous.assessment.score),
        reason: "Operator review: " + edit.note,
        assessedAt: new Date().toISOString(),
      };
      next.coachFit =
        edit.status === "MATCH"
          ? "YES"
          : edit.status === "OUTSIDE"
            ? "NO"
            : "MAYBE";
      if (["FOUND", "QUALIFIED"].includes(d.stage))
        next.stage = edit.status === "MATCH" ? "QUALIFIED" : "FOUND";
    } else if (edit.kind === "DRAFT") {
      if (edit.channel === "INVITATION")
        next.prospecting.invitationDraft = edit.text;
      else next.suggestedDm = edit.text;
    } else {
      if (
        !(
          await c.query(
            "SELECT id FROM compel_linkedin_accounts WHERE id=$1 AND NOT archived",
            [edit.accountId],
          )
        ).rowCount
      )
        throw Error("Choose a saved worker account.");
      if (edit.kind === "CONTACT")
        next.prospecting.contact = {
          ...edit,
          checkedAt: new Date().toISOString(),
          source: "MANUAL",
        } as CoachContact;
      else {
        const lead = (
          await c.query(
            "SELECT 1 FROM leads WHERE lower(regexp_replace(linkedin_url,'/+$',''))=lower(regexp_replace($1,'/+$','')) AND (do_not_contact IS TRUE OR contacted IS TRUE)",
            [d.linkedinUrl],
          )
        ).rowCount;
        const route = contactRoute(d, edit.accountId);
        if (lead || !["CONNECT", "VERIFY"].includes(route.key))
          throw Error(
            "This prospect is already contacted, excluded, connected or awaiting acceptance.",
          );
        next.prospecting.contact = {
          accountId: edit.accountId,
          connection: "PENDING",
          openProfile:
            previous.contact?.accountId === edit.accountId
              ? previous.contact.openProfile
              : "UNKNOWN",
          checkedAt: new Date().toISOString(),
          source: "MANUAL",
          note: "Operator recorded that the invitation was sent on LinkedIn. No invitation was sent by Compel.",
        };
        next.nextAction = "Check for acceptance before sending a message.";
      }
    }
    validateCaseStudyProspect(next);
    const updated = await c.query(
      "UPDATE case_study_prospects SET data=$2,revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING *",
      [id, JSON.stringify(next)],
    );
    await store.activity(
      c,
      id,
      edit.kind === "INVITATION_SENT"
        ? "INVITATION_RECORDED"
        : "PROSPECT_REVIEW",
      edit.kind === "FIT"
        ? edit.note
        : edit.kind === "CONTACT"
          ? edit.note
          : edit.kind === "DRAFT"
            ? "Outreach draft saved; nothing sent."
            : "Invitation recorded separately from a sent message.",
    );
    return mapCaseStudyProspect(updated.rows[0]);
  });
}
export async function recordCoachMessageSentAction(
  id: string,
  accountId: string,
) {
  await requireAdmin();
  idSchema.parse(id);
  await store.ensure(pool);
  const row = (
    await pool.query("SELECT * FROM case_study_prospects WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw Error("Prospect not found.");
  const blocked = (
    await pool.query(
      "SELECT 1 FROM leads WHERE lower(regexp_replace(linkedin_url,'/+$',''))=lower(regexp_replace($1,'/+$','')) AND (do_not_contact IS TRUE OR contacted IS TRUE)",
      [row.linkedin_url],
    )
  ).rowCount;
  if (
    blocked ||
    !["DM", "OPEN_PROFILE"].includes(contactRoute(row.data, accountId).key)
  )
    throw Error(
      "Verify this account’s free messaging route and contact status before recording a new message.",
    );
  return markHunterProspectLinkedinDmSentAction(id);
}
