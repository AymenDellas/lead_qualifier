"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const q = require("../../src/lib/coach-prospecting.cjs");
const url = "https://www.linkedin.com/in/example-coach/";
const profile = {
  url,
  profileIdentityConfirmed: true,
  headline: "Career strategist | Founder",
  about:
    "I am a career coach. I help professionals change direction. Work with me through my coaching program.",
};
const now = new Date().toISOString();
const fact = (quote) => ({
  state: "OBSERVED",
  evidence: [{ url: "https://coach.example/services", quote }],
});
test("an unusual headline qualifies from About and service evidence, with no email requirement", () => {
  const result = q.assessCoach(profile);
  assert.equal(result.status, "MATCH");
  assert.ok(result.evidence.some((e) => e.source === "About"));
  assert.ok(result.gaps.some((g) => /website/.test(g)));
});
test("a headline without coach wording can qualify through grounded independent-practice and offer evidence", () => {
  const result = q.assessCoach(
    { ...profile, about: "I guide founders through change." },
    {
      facts: {
        independentBusiness: fact("I run an independent coaching practice."),
        paidOffer: fact("Business coaching for founders, £300 per session."),
      },
    },
  );
  assert.equal(result.status, "MATCH");
  assert.ok(result.evidence.some((e) => e.source === "paidOffer"));
});
test("title alone, founder alone, a blank headline, missing email and ambiguous roles are retained for review", () => {
  for (const headline of [
    "Executive Coach",
    "Founder and advisor",
    "I help people thrive",
    "",
  ])
    assert.equal(
      q.assessCoach({ ...profile, headline, about: "" }).status,
      "POTENTIAL",
    );
});
test("suppliers, vacancies, former roles and sports/agile-only coaches are excluded with a reason", () => {
  for (const headline of [
    "I build websites for coaches",
    "I help executive coaches scale",
    "Coaching software platform founder",
    "Former career coach",
    "Football coach",
    "Agile coach",
  ]) {
    const r = q.assessCoach({ ...profile, headline, about: "" });
    assert.equal(r.status, "OUTSIDE", headline);
    assert.ok(r.reason);
  }
});
test("a separate active coaching practice is not rejected because the person also has another role", () => {
  for (const headline of [
    "Former football coach | Business coach",
    "I help coaches grow | Executive Coach",
  ])
    assert.equal(q.assessCoach({ ...profile, headline }).status, "MATCH");
});
test("business facts without source quotes cannot fabricate a match and identity failure remains reviewable", () => {
  const facts = {
    independentBusiness: { state: "OBSERVED" },
    paidOffer: { state: "OBSERVED" },
  };
  assert.equal(
    q.assessCoach({ ...profile, headline: "Founder", about: "" }, { facts })
      .status,
    "POTENTIAL",
  );
  assert.equal(
    q.assessCoach({ ...profile, profileIdentityConfirmed: false }).status,
    "POTENTIAL",
  );
});
test("explicit user exclusions are treated as literal phrases, never executable regexes", () => {
  assert.equal(
    q.assessCoach(profile, {}, { exclude: ["career coach"] }).status,
    "OUTSIDE",
  );
  assert.equal(
    q.assessCoach(profile, {}, { exclude: ["coach.*"] }).status,
    "MATCH",
  );
});
test("Premium badges and generic message availability never establish Open Profile eligibility", () => {
  const e = q.profileContactEvidence(
    { premium: true, messageButton: true },
    "account-one",
    now,
  );
  assert.equal(e.openProfile, "UNKNOWN");
  assert.equal(e.connection, "UNKNOWN");
  assert.equal(
    q.profileContactEvidence({ openLink: true }, "a", now).openProfile,
    "YES",
  );
  assert.equal(
    q.profileContactEvidence({ openLink: false }, "a", now).openProfile,
    "NO",
  );
});
test("contact routes are account-specific and stale or future checks need re-verification", () => {
  const data = {
    stage: "QUALIFIED",
    prospecting: {
      contact: {
        accountId: "a",
        connection: "CONNECTED",
        openProfile: "UNKNOWN",
        checkedAt: now,
      },
    },
  };
  assert.equal(q.contactRoute(data, "a").key, "DM");
  assert.equal(q.contactRoute(data, "b").key, "VERIFY");
  for (const checkedAt of [
    "invalid",
    new Date(Date.now() - 8 * 86400000).toISOString(),
    new Date(Date.now() + 3600000).toISOString(),
  ])
    assert.equal(
      q.contactRoute(
        {
          ...data,
          prospecting: { contact: { ...data.prospecting.contact, checkedAt } },
        },
        "a",
      ).key,
      "VERIFY",
    );
});
test("known Open Profiles are free-message routes, pending invitations are not duplicate connection tasks", () => {
  const data = {
    stage: "QUALIFIED",
    prospecting: {
      contact: {
        accountId: "a",
        connection: "NOT_CONNECTED",
        openProfile: "YES",
        checkedAt: now,
      },
    },
  };
  assert.equal(q.contactRoute(data, "a").key, "OPEN_PROFILE");
  data.prospecting.contact.openProfile = "NO";
  assert.equal(q.contactRoute(data, "a").key, "CONNECT");
  data.prospecting.contact.connection = "PENDING";
  assert.equal(q.contactRoute(data, "a").key, "PENDING");
});
test("suppression and previous contact take precedence over fit and a free message route", () => {
  const data = {
    stage: "DO_NOT_CONTACT",
    prospecting: {
      assessment: q.assessCoach(profile),
      contact: { accountId: "a", connection: "CONNECTED", checkedAt: now },
    },
  };
  assert.equal(q.shortlist(data, "a").list, "SUPPRESSED");
  data.stage = "QUALIFIED";
  data.lastContactedAt = now;
  assert.equal(q.shortlist(data, "a").list, "CONTACTED");
});
test("a ready shortlist requires current coaching evidence as well as a known free contact route", () => {
  const data = {
    stage: "QUALIFIED",
    prospecting: {
      assessment: q.assessCoach(profile),
      contact: { accountId: "a", connection: "CONNECTED", checkedAt: now },
    },
  };
  assert.equal(q.shortlist(data, "a").list, "READY");
  data.prospecting.assessment.assessedAt = new Date(
    Date.now() - 31 * 86400000,
  ).toISOString();
  assert.equal(q.shortlist(data, "a").list, "REVIEW");
});
test("CSV exports quote text and prevent spreadsheet formula execution", () => {
  assert.equal(q.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(q.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});
