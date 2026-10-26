# Finder geography and REVIEW audit — 26 October 2026

The Finder copied the query's country into `leads.location`. A person mentioning US clients, studying in Canada or working for a UK employer could therefore be labelled as living there. Search operators and location scoring did not establish the person's residence.

Discovery now requires an explicit person-location field or constrained geographic metadata, matching the requested UK/US/Canada country. Missing, conflicting, foreign and unsupported evidence is excluded before import and does not consume the kept target. The database validates the proof independently. Actual country, requested query location and raw location evidence have separate fields. Re-finding an existing lead preserves its current location, stage and first-touch provenance. See [lead-finder.md](lead-finder.md).

Search evidence can be stale. New main CRM captures verify the current rendered profile country on the page already loaded. Identity-confirmed foreign residence rejects before downstream activity/contact/website work. Unknown country requires REVIEW after the follower check. No city-only guesses are used. Country names appearing inside New Jersey, New Mexico, Rhode Island and Prince Edward Island do not create false country conflicts. Ambiguous homonyms still fail closed. Nested recommended members cannot supply location or follower evidence.

## All 98 existing REVIEW leads

A repeatable-read audit preserved all 98 CRM rows and 425 related job records before changes. Primary causes were:

| Primary reason | Leads | Finding and action |
| --- | ---: | --- |
| FOLLOWERS_NOT_SHOWN | 47 | Support direct divs, split/accessible widgets, localized Activity headers and bounded same-page hydration. Keep attribution to the requested member. |
| ACTIVITY_UNCONFIRMED | 43 | Explicit foreign-author cards no longer inflate unresolved own activity; localized dates and mixed rendered layouts are supported. Undated own/missing-author cards still require REVIEW. |
| PAGE_CHANGED | 4 | Retain evidence and identity safeguards; expanded rendered layouts can be checked in one controlled refresh. |
| CRAWL_INCOMPLETE | 2 | Genuine incomplete website evidence; retain budgets/checkpoints and terminal review. Do not invent an attributable email. |
| FOLLOWERS_UNPARSEABLE | 2 | Existing Arabic bidi raw text reparses to 1,119 and 23,838. Repair counts without changing observation time or inventing downstream facts. |

Among the 43 activity cases, 32 have an old selected own-author date plus unresolved cards. The old evidence does not identify those unresolved cards sufficiently to reject them as inactive in bulk. Six historical recent-activity candidates still lack attributable email evidence. There are zero safe automatic promotions to QUALIFIED in this audit.

Of the original 98, 65 have explicit target-country evidence, 12 explicit foreign countries, 13 city/metro-only evidence and eight missing locations. The 12 proven foreign cases can become NOT_QUALIFIED using stored identity-matched evidence. The remaining 86 need evidence, not a looser qualification rule.

## Policy and repairs

Followers must now be strictly greater than 500: 500 rejects, 501 continues. `MIN_FOLLOWERS` remains configurable; its default and `.env.example` are 500. Qualification version is 3. Connections never substitute for followers. Arabic bidi source text is retained exactly while its normalized count is parsed.

There are also 27 old follower rejections with counts 501–1,000. They deserve fresh downstream checks under the new threshold; lowering the threshold cannot supply the activity/contact work skipped by the old early exit. Their migration to REVIEW is a deliberate policy refresh, separate from reducing the original 98-review cohort. Legacy qualified records are never automatically requeued for followers.

The broader qualified-record audit identifies 53 identity-matched records with explicit foreign residence. These can be removed from the qualified stage from their stored evidence, without a LinkedIn visit. Unknown legacy locations are not guessed or mass-relabelled.

`scripts/engine-review-repair.cjs` creates a dry-run plan and immutable private input snapshot. `--apply --queue` applies fenced changes and stages eligible refreshes. PostgreSQL's `compel_qualification_repairs` retains full before/after assessments and the reason/job ID. A transaction and compare-and-swap checks protect concurrent manual/email edits; repeats cannot enqueue another policy refresh. Contacted/suppressed/Hunter-protected profiles and protected duplicates are excluded from refresh admission. No email, verification proof, contact history, suppression, original capture time or security hold is cleared. Processing must be paused, remains paused, and is never enabled by this tool. The normal PostgreSQL queue owns refreshes with active-profile duplicate protection, 300/day and 60-second profile-start reservations. Fresh policy checks bypass old completed-result caching; website/CRM recovery keeps its checkpoints.

Final applied counts and validation are recorded below after the migration. Private evidence lives in ignored `data/engine-v2/`; those JSON files are audit artifacts, never a runtime queue.

## Stored-evidence regression

Before behavior changes, 50 already-decided leads were frozen: 17 REVIEW, 17 NOT_QUALIFIED and 16 QUALIFIED, with reasons/evidence and a fixed replay clock. Finder-only changes have zero decision changes. No regression replay visits LinkedIn.

With existing evidence flags/thresholds preserved, version 3 changes one old pure-mapper outcome from NOT_QUALIFIED to REVIEW because activity is unknown. That row was already persisted as REVIEW: the correction makes the pure mapper agree with the worker; it is not a measured review reduction.

With the requested current country/500 policy applied to the same evidence, 17 replay decisions change: 13 country exclusions, three old-threshold rejections becoming REVIEW, and the same uncertainty-routing correction. The country exclusions include six formerly qualified foreign profiles. There are zero unexpected decision changes and zero replay errors. Evidence fields also record the new policy/threshold. Every changed ID, before/after decision, reason and stored-evidence comparison is in `data/engine-v2/location-review-v3/policy-phase-regression.json`; the final replay is `final-regression.json`. These are policy changes, not performance gains.

## Verification

Five focused agent contributions covered Finder provenance, all REVIEW records, rendered follower/activity evidence, adversarial policy tests and integration invariants. The integration review found a compact-CRM projection losing the country gate; both SQL and JavaScript projections now retain it. Independent tests cover full/compact send eligibility, unknown identity, version 2 compatibility, evidence version 2 round-trips, country conflicts and source attribution. PostgreSQL fixtures verify atomic/idempotent repairs and retained holds/contact history in isolated temporary tables.

Rendering tests use local intercepted fixtures; Finder checks use simulated search responses. No paid search credits, live LinkedIn batch or outreach are used for validation. A lower live REVIEW rate cannot be claimed until the staged profiles are actually processed. The earlier engine throughput figures predate the currently authorized pacing and do not measure this change.
