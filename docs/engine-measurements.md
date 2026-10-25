# Engine measurements

## Phase 1: original limits, 2026-10-25

The regression snapshot predates all changes. Phases 0 and 1 replay 50/50 records
with **zero changed decisions, qualification flags or blocker reasons**. One stored
decision already disagreed with the original evaluator; see the audit.

The `baseline` manifest in `compel_engine_batches` contains 30 eligible CRM Inbox
profiles and their actual queue IDs. No profile was picked up: before opening Chrome,
the identity permit entered `sleeping`, with reason **The identity activity budget
is resting. Pending work is retained.** At 10:39 UTC the recorded eligibility was
17:14:31 UTC; the processing session expired at 11:07:17 UTC. The measurement was
stopped explicitly after establishing it could not start within that session.
All 30 jobs remain pending and intact. Other accounts' review holds remain intact.

| Metric | Original run |
| --- | --- |
| Requested / queued / picked up / decided | 30 / 30 / 0 / 0 |
| Median / p90 pickup-to-decision | unavailable: no pickups |
| Decided throughput | 0 during the observed start attempt; no completed batch rate |
| Ranked lead-stage wall shares | unavailable: no lead reached a stage |
| Startup blocker | per-kind identity daily/rolling budget before browser opening |
| Whole service process-tree peak RSS while blocked | 174 MiB (Chrome never opened) |
| Peak sampled service-tree CPU while blocked | 1.36% of one core |
| Observed idle account / public-worker SQL rate | 314 / 71 queries per minute, excluding supervisor and dashboard |
| Rework / ERROR rate | unavailable: no decided leads |

This is a **blocked baseline**, not a completed 30-lead performance comparison.
The unmodified legacy limits prevent the requested batch. Removing those prohibited
limits is a prerequisite to measuring page/crawl costs. A subsequent 30-lead run
must be labelled as a baseline **after limit removal**, not silently substituted
for the original. No crawl optimization is justified by a fabricated stage ranking.

The resource samples cover the service Node process and descendants, including
Chrome when present. Samples are 15s apart and exclude the PowerShell sampler;
brief processes can be missed. The full existing worker suite ran during this
blocked attempt, outside the measured process tree. Do not use these startup/idle
resource values as representative active-capture memory or CPU.

## Instrumentation

- `engine-telemetry.cjs` carries bounded per-lead spans through PostgreSQL checkpoints
  and lane handoff. It measures profile navigation, every wrapped page action,
  contact, activity, actual pacing sleeps, individual website HTTP/render pages,
  crawl, qualification, CRM save, result save and SQL. Actual outgoing request
  events are counts, not private response inspection. It records queue wait,
  attempts, retries and repeated stage work.
- Wall attribution splits overlapping spans into disjoint intervals. Three parallel
  requests are not reported as three times their elapsed wall-clock share. Gaps
  between capture and research, including retries, remain in the decision latency.
- `engine-process-metrics.cjs` samples the OS process tree and cumulative CPU on
  Windows/Linux, plus actual SQL counts outside lead work. Telemetry overhead is
  reported as `sampleMs`. First CPU sample is unavailable, not zero.
- Engine's **Qualification performance** panel shows measured median/p90, batch
  elapsed throughput, stage shares/funnel, retries/rework, error reasons, RAM/CPU,
  and idle worker queries. No samples show an explicit empty state.
- `node scripts/engine-benchmark.cjs prepare baseline` preserves the 30-profile
  manifest in PostgreSQL. `run` uses the actual workers, locks, account controls and
  CRM writes, refuses unrelated pending work, and stops after a 20min measurement
  bound or account stop. `report` reads the saved report. Local JSON reports under
  `data/engine-v2/` are ignored evidence exports, not the authoritative queue.
- `node scripts/engine-regression.cjs phase-1` replays stored evidence at the
  snapshot clock without loading LinkedIn or a website. It lists every changed
  pipeline decision, qualification flag and blocker reason, and exits nonzero.

Focused telemetry, process-tree, browser-fixture and research-runner tests: 37
passed. Typecheck passed. The existing `npm run lint` command fails before linting:
the installed Next.js treats `lint` as a directory. No lint pass is claimed.

The pre-existing session/research refactor was recorded separately in commit
`5697456` as the audited working-tree base. The trace is `de2060e`. Unrelated UI,
configuration and secret-file changes present before this task were not included.

The full worker run found two telemetry compatibility failures with injected pages
that omit a mouse. The wrapper now tolerates those pages; all 17 affected race and
telemetry tests pass. The other 126 tests passed and one opt-in DB test was skipped.

## Prerequisite: remove prohibited limits

The blocked startup justifies removing the legacy check gate before further cost
measurement. `recordLinkedInAction` checks ownership/explicit pause and records
statistics, without consulting counts, hours or next-check timestamps. Identity,
contact, activity, profile and discovery share this behavior. Manual Connect has
no frequency cap. Old DB columns are retained as inert compatibility data; no data
or constraints were deleted. The dashboard no longer offers action budgets/gaps.
The 50-lead regression remains unchanged. The daily-profile accounting/timezone
repair, event-based rendering waits and idle polling changes are still pending.

`baseline-unthrottled` will use the same 30 still-unvisited queue records. It is
explicitly a baseline after removal of the prohibited action limits. It must not
be compared to the blocked run as a measured active-work speedup.

## Completed 30-lead baseline after limit removal

`baseline-unthrottled` completed all 30 original queued records. No crawl,
qualification, followers, activity reuse or infrastructure optimization was loaded
in those worker processes. The new follower parser was tested separately and was
not imported by the live worker. Pickup-to-final-save median **19.004s**, p90
**40.332s**; 30 outcomes over **667.999s**, **161.68 outcomes/hour**. Outcomes:
1 QUALIFIED, 2 REJECTED, 27 ERROR (26 ACTIVITY_UNCONFIRMED, 1 PROFILE_REDIRECT).
There were zero automatic retries and zero repeated profile/crawl passes in this
sample. The ERROR rate is 90%; that is outcomes, not successfully qualified leads.

| Rank | Stage | Attributed wall time | Share | Change justified |
| --- | --- | --- | --- | --- |
| 1 | Other LinkedIn actions, including hydration | 186.003s | 27.65% | Followers immediately after identity; avoid scrolling/expansion for decided leads; event-based readiness |
| 2 | LinkedIn activity | 181.914s | 27.04% | Reuse reliably dated author-matched profile preview; terminal unknown evidence goes to REVIEW |
| 3 | Lane queue / uninstrumented gaps | 104.501s | 15.53% | Overlap durable handoff/save with next capture under bounded backpressure; eliminate inter-job idle sleep |
| 4 | LinkedIn profile navigation/identity | 77.511s | 11.52% | One reused tab; bounded browser recycling; no repeated profile read on public failures |
| 5 | LinkedIn contact | 66.001s | 9.81% | Skip after follower/activity decision; retain contact checkpoints |
| 6 | Website research | 32.355s | 4.81% | Bound tail cost and stop when attributable email is established; do not claim this is the dominant bottleneck |
| 7 | Other SQL | 18.522s | 2.75% | Fewer idle queries; retain atomic ownership; no speculative index |
| 8 | CRM and final save | 5.890s | 0.88% | Bounded asynchronous save; batch only independent safe writes |
| 9 | Qualification | 0.063s | <0.01% | Preserve existing logic; no interpreter/library migration |

Overlapping spans are attributed once. Inclusive totals for diagnostics are
different: DOM waits 257.968s / 166 actions, page evaluation 121.240s / 418 calls,
29 activity reads, 30 profile navigations, 29 contact stages. Only 2 leads caused
website HTTP/render work (20 HTTP page attempts, 5 render calls); 29 crawl function
entries include no-site fast returns. No full-site retry domination was observed.

Service-tree peak RSS **5,573 MiB**; peak sampled CPU **172.31% of one core**.
Account-only sampler separately observed 5,319 MiB peak. Public browser remained
resident after use. Late-run account/public idle SQL rates were 109/67 per minute;
these exclude supervisor and dashboard queries. Startup identity verification
succeeded after the prohibited limits were removed. No auth/restriction hold was
cleared by this run. Median pre-pickup queue wait 768.309s includes the deliberately
blocked original attempt and is not included in the 19.004s primary latency.

The claim EXPLAIN is saved locally as `data/engine-v2/claim-explain.json`. PostgreSQL
uses `compel_worker_research_queue` bitmap index scans plus SKIP LOCKED, estimated
total cost 13.2. No additional index is supported by this result. Reports/manifests
are in PostgreSQL and ignored local exports; no live lead evidence is committed.

## Phase 2: cut work per lead

Followers are checked immediately after rendered identity, before hydration,
activity navigation, contact or websites. This brings the Phase 5 parser/version
work forward because Phase 2 explicitly depends on that first disqualifier. Counts
and raw text for followers and connections are separate. A count <=1,000 rejects;
missing/unparseable evidence reviews. A matching-author recent profile preview
avoids activity navigation entirely. Otherwise activity is read before contact and
website work; unknown/inactive activity ends the lead. For the remaining active
leads, returning to the profile for contact can add one profile navigation; this
trades that small minority's extra load against skipping contact/hydration for the
26/30 baseline activity-unknown leads. Existing contact/activity checkpoints resume.

Profile/card/menu readiness uses DOM mutation predicates. Repeated account-notice
checks no longer clone and parse the entire page. Full visible evidence snapshots
remain at actual reading boundaries. This targets the measured 27.65% hydration
and page-action share (121.24s inclusive page evaluation), without changing the
identity check or using private endpoints.

Websites default to 8 distinct pages, 20 seconds accumulated across automatic
resumes, 5s per request and 12 total page attempts. Home/contact/About are prioritized.
The existing attribution rules decide whether an email is sufficient to stop.
Remaining routes and failures stay in saved evidence. Terminal failures and exhausted
budgets go to REVIEW; no automatic public failure returns to LinkedIn. Readable
HTML without an email no longer launches Chrome. Anonymous HTML cache entries are
bounded to 8 slots/domain, 256KiB/slot in PostgreSQL, re-evaluating attribution for
each person. A final qualification no longer creates a background crawl continuation.
The measured website share was only 4.81%; these are tail/resource bounds, not a
claim that website optimization is the principal gain.

The offline regression report `data/engine-v2/phase-2-regression.json` enumerates
every changed record. All 50 lack stored follower evidence and therefore replay
REVIEW under v2 (`FOLLOWERS_NOT_SHOWN`). A diagnostic pass holding only the new
follower gate satisfied reproduces **all 50 original pipeline decisions, email/
activity flags and blocker reasons**. No non-follower regression was found. The
diagnostic count is never stored as lead evidence. Existing pre-v2 CRM outcomes
are displayed as follower-unchecked and are not automatically requeued or rewritten.

42 parser, qualification, real-browser fixture, research/recovery and website-budget
tests pass; typecheck passes. Browser fixtures now include explicit passing follower
evidence, and separate tests prove low/absent counts end after one page and that
an inline recent post avoids activity navigation. Daily timezone/account-scope
repair, selected recheck UI, browser recycling and the single agent are next.

## Phase 3: pipeline flow

A sequential save queue accepts at most six pending/active operations. It clones
checkpoints at admission, preserves write order and owner/lease fences, surfaces
failures, and applies backpressure before memory can grow. Profile capture can
move ahead while the prior durable handoff commits; public research is awakened
after that commit. Shutdown drains admitted saves before releasing ownership.
Per-kind statistics batch safely into one counter update; they cannot gate work.
Account intent/session ownership reads and the authoritative daily reservation
still need PostgreSQL responses to preserve their guarantees.

The next job is claimed near the final capture checkpoint, not at the beginning
of a long browser visit. Prefetched lock time is included in the primary latency;
claiming too early would inflate pickup-to-decision while improving throughput.
Pause/review releases the unused prefetched claim without incrementing retry counts.

Website requests share three HTTP slots, including rendering subrequests. Public
rendering remains a separate headless Puppeteer process, opens only for insufficient
static HTML and closes after 15s idle. Launch time counts toward the render deadline;
fresh contexts close on deadline. Public CRM schema readiness is scoped per pool.
The optional discovery reader now waits for rendered readiness instead of sleeping
1.4s, and ends at its requested profile target or the actual end/stall of the list,
without the old 50-page/12-pass interaction budgets.

The existing claim index remains unchanged based on EXPLAIN and the 2.75% SQL share.
No library or queue migration was made. Bounded saves/HTTP slots, overlapping claims,
public idle close, and recovery tests pass (16 focused tests; 21 including telemetry).
Typecheck passes. Phase 3 regression: 50 intentional missing-follower REVIEW results,
zero changes to the original evaluator with only that new gate isolated.
