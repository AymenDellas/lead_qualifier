"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module"),
  ts = require("typescript");
const root = path.resolve(__dirname, "../.."),
  resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  return resolve.call(
    this,
    request.startsWith("@/")
      ? path.join(root, "src", request.slice(2))
      : request,
    parent,
    ...args,
  );
};
require.extensions[".ts"] = (m, file) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
const stub = (file, exports) => {
  require.cache[require.resolve(file)] = {
    id: file,
    filename: file,
    loaded: true,
    exports,
  };
};
let allowed = true,
  queries = 0,
  row,
  blocked = false,
  recorded = 0,
  listingRows = [];
stub(path.join(root, "src/lib/worker-admin.ts"), {
  async requireWorkerAdmin() {
    if (!allowed) throw Error("Sign in first");
  },
});
const client = {
  async query(sql, values = []) {
    queries++;
    if (sql.includes("FROM case_study_prospects p"))
      return { rows: structuredClone(listingRows) };
    if (sql.includes("SELECT r.*")) return { rows: [] };
    if (sql.startsWith("SELECT * FROM case_study_prospects"))
      return { rows: values[0] === row.id ? [row] : [] };
    if (sql.startsWith("SELECT id FROM compel_linkedin_accounts"))
      return { rowCount: values[0] === "account-a" ? 1 : 0, rows: [] };
    if (sql.startsWith("SELECT 1 FROM leads"))
      return { rowCount: blocked ? 1 : 0, rows: [] };
    if (sql.startsWith("UPDATE case_study_prospects")) {
      row.data = JSON.parse(values[1]);
      row.revision++;
      return { rows: [row] };
    }
    throw Error("Unexpected action fixture query: " + sql);
  },
};
stub(path.join(root, "src/lib/pg_setup.ts"), { pool: client });
stub(path.join(root, "src/lib/coach-prospecting-store.cjs"), {
  transaction: async (_, fn) => fn(client),
  ensure: async () => {},
  activity: async () => {},
  refreshRuns: async () => {},
});
require("../../src/lib/linkedin-workers.cjs").settings = async () => ({
  accounts: [{ id: "account-a", label: "Fixture account", enabled: true }],
  activeCount: 1,
  supervisorOnline: true,
});
stub(path.join(root, "src/app/actions/linkedin-outreach-actions.ts"), {
  async markHunterProspectLinkedinDmSentAction() {
    recorded++;
    return { alreadyRecorded: false };
  },
});
const b = require("../../src/lib/case-study.ts"),
  q = require("../../src/lib/coach-prospecting.cjs"),
  a = require("../../src/app/actions/coach-prospecting-actions.ts");
function reset() {
  allowed = true;
  queries = 0;
  blocked = false;
  recorded = 0;
  listingRows = [];
  const data = b.blankCaseStudyProspect(
    "https://www.linkedin.com/in/test-coach/",
    "MANUAL",
    "CLIENT",
  );
  data.name = "Fixture coach";
  data.scanStatus = "COMPLETE";data.prospecting={followers:{rawText:"2,000 followers",count:2000},assessment:{policy:q.POLICY,status:"POTENTIAL",score:10,reason:"Fixture",evidence:[],gaps:[],assessedAt:new Date().toISOString()},contact:null,accountId:"account-a",about:"",researchStatus:"COMPLETE"};
  row = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    linkedin_url: data.linkedinUrl,
    data,
    created_at: new Date(),
    updated_at: new Date(),
  };
}
test("all prospecting actions authenticate before queries or input handling", async () => {
  reset();
  allowed = false;
  for (const work of [
    () => a.loadCoachProspectingAction(),
    () => a.startCoachProspectingAction({}),
    () => a.changeCoachRunAction("x", "STOP"),
    () => a.retryCoachRunAction("x"),
    () => a.loadCoachProspectAction("x"),
    () => a.saveCoachReviewAction("x", 0, {}),
    () => a.recordCoachMessageSentAction("x", "a"),
  ])
    await assert.rejects(work, /Sign in first/);
  assert.equal(queries, 0);
});

test("source and status filters combine before pagination, counts and exports", async () => {
  reset();
  for (let i = 0; i < 85; i++) {
    const data = structuredClone(row.data);
    data.name = "Fixture " + i;
    data.prospecting = {
      assessment: q.assessCoach({
        url: data.linkedinUrl,
        headline: "Career coach",
        about:
          "I am a career coach. I help professionals. Work with me through my coaching program.",
        profileIdentityConfirmed: true,followers:{rawText:"2,000 followers",count:2000},
      }),
      contact: {
        accountId: "account-a",
        connection: "NOT_CONNECTED",
        openProfile: "YES",
        checkedAt: new Date().toISOString(),
      },
      discoverySource: i % 2 ? "CONNECTION" : "SEARCH",
    };
    listingRows.push({
      ...row,
      id: "fixture-" + i,
      created_at: new Date(i * 1000),
      data,
      suppressed: false,
      previously_contacted: false,
    });
  }
  const first = await a.loadCoachProspectingAction({
    accountId: "account-a",
    source: "SEARCH",
    list: "READY",
    page: 0,
  });
  assert.equal(first.total, 43);
  assert.equal(first.rows.length, 40);
  assert.equal(first.hasMore, true);
  assert.equal(first.counts.READY, 43);
  assert.equal(first.sourceCounts.CONNECTION, 42);
  assert.ok(
    first.rows.every((r) => r.data.prospecting.discoverySource === "SEARCH"),
  );
  const next = await a.loadCoachProspectingAction({
    accountId: "account-a",
    source: "SEARCH",
    list: "READY",
    page: 1,
  });
  assert.equal(next.rows.length, 3);
  assert.equal(next.hasMore, false);
  assert.equal(
    new Set([...first.rows, ...next.rows].map((r) => r.id)).size,
    43,
  );
  const before = queries;
  await assert.rejects(
    a.loadCoachProspectingAction({ source: "NOT_A_SOURCE" }),
    /Invalid prospect filters/,
  );
  assert.equal(queries, before);
});
test("manual route verification is account-specific, requires a note and rejects stale saves", async () => {
  reset();
  const edit = {
    kind: "CONTACT",
    accountId: "account-a",
    connection: "CONNECTED",
    openProfile: "UNKNOWN",
    note: "I verified this first-degree connection in LinkedIn.",
  };
  await a.saveCoachReviewAction(row.id, 1, edit);
  assert.equal(row.data.prospecting.contact.source, "MANUAL");
  assert.equal(q.contactRoute(row.data, "account-a").key, "DM");
  assert.equal(q.contactRoute(row.data, "account-b").key, "VERIFY");
  await assert.rejects(a.saveCoachReviewAction(row.id, 1, edit), /changed/);
  await assert.rejects(
    a.saveCoachReviewAction(row.id, 2, { ...edit, note: "" }),
  );
  assert.equal(row.revision, 2);
});
test("a recorded invitation is pending, does not fabricate a sent message, and cannot be repeated", async () => {
  reset();
  await a.saveCoachReviewAction(row.id, 1, {
    kind: "INVITATION_SENT",
    accountId: "account-a",
  });
  assert.equal(row.data.prospecting.contact.connection, "PENDING");
  assert.equal(row.data.lastContactedAt, "");
  assert.equal(recorded, 0);
  await assert.rejects(
    a.saveCoachReviewAction(row.id, 2, {
      kind: "INVITATION_SENT",
      accountId: "account-a",
    }),
    /already contacted/,
  );
});
test("fit review and drafts cannot overwrite privileged workflow fields supplied in the request", async () => {
  reset();
  await a.saveCoachReviewAction(row.id, 1, {
    kind: "FIT",
    status: "MATCH",
    note: "I verified their independent coaching offer on the website.",
    lastContactedAt: new Date().toISOString(),
    crmLeadId: "forged",
  });
  assert.equal(row.data.stage, "QUALIFIED");
  assert.equal(row.data.lastContactedAt, "");
  assert.equal(row.data.crmLeadId, undefined);
  await a.saveCoachReviewAction(row.id, 2, {
    kind: "DRAFT",
    text: "A reviewed message draft.",
  });
  assert.equal(row.data.suggestedDm, "A reviewed message draft.");
  assert.equal(recorded, 0);
  await assert.rejects(
    a.saveCoachReviewAction(row.id, 3, {
      kind: "DRAFT",
      text: "x".repeat(8001),
    }),
  );
  await a.saveCoachReviewAction(row.id, 3, {
    kind: "DRAFT",
    channel: "INVITATION",
    text: "A separate connection note.",
  });
  assert.equal(
    row.data.prospecting.invitationDraft,
    "A separate connection note.",
  );
  assert.equal(row.data.suggestedDm, "A reviewed message draft.");
  await assert.rejects(
    a.saveCoachReviewAction(row.id, 4, {
      kind: "DRAFT",
      channel: "INVITATION",
      text: "x".repeat(201),
    }),
  );
});
test("message recording cannot bypass missing eligibility, another account or CRM suppression", async () => {
  reset();
  await assert.rejects(
    a.recordCoachMessageSentAction(row.id, "account-a"),
    /Verify/,
  );
  await a.saveCoachReviewAction(row.id, 1, {
    kind: "CONTACT",
    accountId: "account-a",
    connection: "NOT_CONNECTED",
    openProfile: "YES",
    note: "The composer explicitly says this is a free message.",
  });
  await assert.rejects(
    a.recordCoachMessageSentAction(row.id, "account-b"),
    /Verify/,
  );
  blocked = true;
  await assert.rejects(
    a.recordCoachMessageSentAction(row.id, "account-a"),
    /Verify/,
  );
  assert.equal(recorded, 0);
  blocked = false;
  await a.recordCoachMessageSentAction(row.id, "account-a");
  assert.equal(recorded, 1);
});
