"use strict";
// The same evidence rules run in the worker, dashboard and regression suite.
const POLICY = "COACH_EVIDENCE_V2";
const {followersDecision,minFollowers}=require('./follower-policy.cjs');
const clean = (v) =>
  String(v || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
const positive = (f) =>
  ["OBSERVED", "INDICATED"].includes(f?.state) &&
  Array.isArray(f.evidence) &&
  f.evidence.some((e) => clean(e.quote) && /^https?:\/\//.test(e.url || ""));
const ownRole =
  /\b(?:executive|business|leadership|career|life|mindset|wellness|health|performance|confidence|relationship|divorce|transition|communication|sales|team|transformational|professional|personal development)\s+(?:and\s+\w+\s+)?coach(?:ing)?\b|\b(?:i (?:am|work as)|i'm|independent|certified|accredited|professional) (?:an? )?(?:[\w-]+ ){0,3}coach\b|\b(?:i|we) coach (?:leaders|executives|founders|clients|professionals|people|women|men)\b/i;
const vendor =
  /\b(?:i|we) (?:help|serve|build|design|create|sell|market|provide|support)(?:\s+[\w-]+){0,8}\s+(?:for )?coaches\b|\b(?:coaching software|coaching platform|coaching directory|recruit(?:er|ment)|hiring coaches)\b/i;
const inactive =
  /\b(?:former|retired|aspiring|trainee|student|ex[- ])\s+(?:[\w-]+\s+){0,2}coach\b|\bnot (?:an? )?(?:[\w-]+\s+){0,2}coach\b/i;
const outside =
  /\b(?:football|soccer|basketball|baseball|tennis|cricket|athletic|sports?|agile|scrum|devops|coding)\s+coach(?:ing)?\b/i;
const practice =
  /\b(?:my (?:coaching|clients|practice|program|programme)|work with me|independent|private practice|self[- ]employed|coaching (?:practice|business|sessions?|services?|program|programme|package)|book (?:a |your )?(?:coaching|consultation|discovery)|one[- ](?:on[- ]one|to[- ]one) coaching|1[:\-]1 coaching)\b/i;
const audience =
  /\b(?:i|we) (?:help|coach|support|guide|work with)\b|\bcoaching for\b/i;
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function assessCoach(input = {}, research = {}, criteria = {}) {
  const follower=followersDecision(research.followers||input.followers,minFollowers());
  if(input.profileIdentityConfirmed&&follower.status!=='CONTINUE')return {policy:POLICY,status:follower.status==='REJECTED'?'OUTSIDE':'POTENTIAL',score:0,reason:follower.reason,
    reasonCode:follower.reason,evidence:[{source:'LinkedIn followers',url:input.url||'',quote:(research.followers||input.followers)?.rawText||'Follower count not shown'}],gaps:follower.status==='REVIEW'?['Confirm the LinkedIn follower count.']:[],assessedAt:new Date().toISOString()};
  const fields = [
    ["Headline", input.headline],
    ["About", input.about],
  ]
    .map(([source, text]) => ({ source, text: clean(text) }))
    .filter((x) => x.text);
  // Evaluate independent statements, so a vendor reference cannot mask a separate coaching practice.
  const statements = fields
    .flatMap((f) =>
      f.text
        .split(/[|•;\n]|(?<=[.!?])\s+/)
        .map((text) => ({ source: f.source, text })),
    )
    .filter((x) => x.text);
  const role = statements.find(
    (x) =>
      ownRole.test(x.text) &&
      (!vendor.test(x.text) ||
        x.text.search(ownRole) < x.text.search(vendor)) &&
      !inactive.test(x.text),
  );
  const all = fields.map((f) => f.text).join(" "),
    facts = research.facts || {};
  const established =
    positive(facts.independentBusiness) && positive(facts.paidOffer);
  const practiceStatement = statements.find(
    (x) =>
      practice.test(x.text) && !vendor.test(x.text) && !inactive.test(x.text),
  );
  const audienceStatement = statements.find(
    (x) => audience.test(x.text) && !vendor.test(x.text),
  );
  const evidence = [];
  for (const x of [role, practiceStatement, audienceStatement])
    if (x && !evidence.some((e) => e.quote === x.text.slice(0, 500)))
      evidence.push({
        source: x.source,
        url: input.url || "",
        quote: x.text.slice(0, 500),
      });
  for (const key of [
    "independentBusiness",
    "paidOffer",
    "clientProof",
    "funnelOpportunity",
  ])
    if (positive(facts[key]))
      for (const e of (facts[key].evidence || []).slice(0, 2))
        evidence.push({
          source: key,
          url: e.url || "",
          quote: clean(e.quote).slice(0, 500),
        });
  const exclusions = (criteria.exclude || [])
    .filter((v) => clean(v).length >= 3)
    .slice(0, 20);
  const excluded = exclusions.find((term) =>
    new RegExp("\\b" + escape(clean(term)) + "\\b", "i").test(all),
  );
  let status, reason;
  if (!input.profileIdentityConfirmed) {
    status = "POTENTIAL";
    reason = "The requested LinkedIn identity could not be confirmed.";
  } else if (excluded) {
    status = "OUTSIDE";
    reason = `Matches your exclusion: ${excluded}.`;
  } else if (
    !established &&
    !role &&
    (outside.test(all) || vendor.test(all) || inactive.test(all))
  ) {
    status = "OUTSIDE";
    reason =
      "The available evidence describes an excluded role, a supplier to coaches, or a former/aspiring role—not an established coaching practice.";
  } else if (established || (role && practiceStatement && audienceStatement)) {
    status = "MATCH";
    reason = established
      ? "Evidence supports an independent coaching practice and an identifiable offer."
      : "The profile describes their own coaching work, client audience and a service or practice.";
  } else {
    status = "POTENTIAL";
    reason = role
      ? "A coaching role is evident; their offer or independent practice still needs confirmation."
      : "The headline is inconclusive. Keep this profile for About, website or manual review.";
  }
  const gaps = [];
  if (!role && !established)
    gaps.push(
      "Confirm that this person provides coaching, rather than buying or selling services to coaches.",
    );
  if (!established && !practiceStatement)
    gaps.push("Confirm their independent practice and coaching offer.");
  if (!research.website || research.websiteStatus !== "OWNED")
    gaps.push("An owned business website has not been confirmed.");
  if (!positive(facts.clientProof))
    gaps.push("Client results or testimonials need review.");
  let score =
    status === "OUTSIDE" ? 0 : status === "MATCH" ? 55 : role ? 30 : 10;
  if (status !== "OUTSIDE") {
    if (positive(facts.clientProof)) score += 12;
    if (positive(facts.funnelOpportunity)) score += 15;
    if (positive(facts.demandSignals)) score += 8;
    if (research.websiteStatus === "OWNED") score += 5;
    if (
      input.lastActivityAt &&
      Date.now() >= Date.parse(input.lastActivityAt) &&
      Date.now() - Date.parse(input.lastActivityAt) < 30 * 86400000
    )
      score += 5;
  }
  return {
    policy: POLICY,
    status,
    score: Math.min(100, score),
    reason,
    evidence: evidence.slice(0, 12),
    gaps,
    assessedAt: new Date().toISOString(),
  };
}
function profileContactEvidence(
  profile = {},
  accountId = "",
  now = new Date().toISOString(),
) {
  const distance =
    typeof profile.distance === "string"
      ? profile.distance
      : profile.distance?.value;
  const connection =
    distance === "DISTANCE_1"
      ? "CONNECTED"
      : profile.pendingInvitation === true
        ? "PENDING"
        : ["DISTANCE_2", "DISTANCE_3", "OUT_OF_NETWORK"].includes(distance)
          ? "NOT_CONNECTED"
          : "UNKNOWN";
  // Premium membership is deliberately ignored. Only an explicit Open Profile flag counts.
  const openProfile =
    profile.openLink === true
      ? "YES"
      : profile.openLink === false
        ? "NO"
        : "UNKNOWN";
  return {
    accountId,
    connection,
    openProfile,
    checkedAt: now,
    source: "WORKER",
    note: [
      connection !== "UNKNOWN"
        ? `Matching LinkedIn profile distance: ${distance || "pending invitation"}.`
        : "Connection status was not exposed.",
      openProfile !== "UNKNOWN"
        ? `Matching LinkedIn profile openLink=${profile.openLink}.`
        : "Free messaging was not confirmed.",
    ].join(" "),
  };
}
function contactRoute(data = {}, accountId = "", now = Date.now()) {
  if (data.stage === "DO_NOT_CONTACT" || data.prospecting?.suppressed)
    return {
      key: "SUPPRESSED",
      label: "Do not contact",
      reason: "This person is excluded from outreach.",
    };
  if (
    data.lastContactedAt ||
    [
      "MESSAGED",
      "REPLIED",
      "INTERESTED",
      "AUDIT_SENT",
      "CALL_BOOKED",
      "CASE_STUDY_AGREED",
      "REBUILD",
      "COMPLETED",
      "TESTIMONIAL_RESULTS",
    ].includes(data.stage)
  )
    return {
      key: "CONTACTED",
      label: "Already contacted",
      reason: "Continue the existing conversation.",
    };
  const e = data.prospecting?.contact;
  if (
    !e ||
    !accountId ||
    e.accountId !== accountId ||
    !Number.isFinite(Date.parse(e.checkedAt)) ||
    now - Date.parse(e.checkedAt) > 7 * 86400000 ||
    Date.parse(e.checkedAt) > now + 60000
  )
    return {
      key: "VERIFY",
      label: "Verify contact route",
      reason:
        "Check messaging eligibility from this account. Evidence is missing, stale or belongs to another account.",
    };
  if (e.connection === "CONNECTED")
    return {
      key: "DM",
      label: "Connection · free message",
      reason: "First-degree connection confirmed for this account.",
    };
  if (e.openProfile === "YES")
    return {
      key: "OPEN_PROFILE",
      label: "Open Profile · free message",
      reason:
        "Open Profile was explicitly confirmed. LinkedIn may still apply messaging limits.",
    };
  if (e.connection === "PENDING")
    return {
      key: "PENDING",
      label: "Invitation pending",
      reason: "Wait for acceptance; do not send another invitation.",
    };
  if (e.connection === "NOT_CONNECTED" && e.openProfile === "NO")
    return {
      key: "CONNECT",
      label: "Connection request",
      reason: "Free direct messaging was not available when checked.",
    };
  return {
    key: "VERIFY",
    label: "Verify free messaging",
    reason:
      "A Premium badge or generic Message button does not prove free messaging.",
  };
}
function shortlist(data, accountId, now) {
  const route = contactRoute(data, accountId, now),
    fit = data.prospecting?.assessment;
  const list = ["SUPPRESSED", "CONTACTED", "PENDING"].includes(route.key)
    ? route.key
    : fit?.status === "OUTSIDE"
      ? "OUTSIDE"
      : fit?.status !== "MATCH" ||
          fit.policy !== POLICY ||
          !Number.isFinite(Date.parse(fit.assessedAt)) ||
          (now || Date.now()) - Date.parse(fit.assessedAt) > 30 * 86400000
        ? "REVIEW"
        : ["DM", "OPEN_PROFILE"].includes(route.key)
          ? "READY"
          : route.key === "CONNECT"
            ? "CONNECT"
            : "VERIFY";
  return { list, route, score: fit?.score || 0 };
}
function csvCell(value) {
  const text = String(value ?? "");
  return (
    '"' +
    (/^\s*[=+@\-]|^[\t\r]/.test(text) ? "'" + text : text).replace(/"/g, '""') +
    '"'
  );
}
module.exports = {
  POLICY,
  assessCoach,
  profileContactEvidence,
  contactRoute,
  shortlist,
  csvCell,
};
