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
# Phase 4: persistent agent and recovery

The measured 5,573 MiB service peak justified replacing the supervisor/account/public-worker process tree with one persistent agent and one shared pool. LinkedIn browser capacity defaults to one; public rendering remains separate and on demand. Chrome automatically recycles after 10 captured jobs or a sampled 1,536 MiB browser-tree threshold, and closes after 30 seconds idle. These are resource controls, never LinkedIn interaction limits or timed gaps between leads. A 384 MiB Node heap default leaves room for Chrome on an 8 GB PC.

Queue polling backs off from 2 to 30 seconds with PostgreSQL NOTIFY wakeups. Processing intent survives a restart. Every capture action still checks pause, ownership, command version and reactive security holds. Browser crashes resume checkpoints within two retries; exhausted attempts become REVIEW. Startup errors publish an exact stage and action. PID/profile lock recovery requires verified dead ownership plus heartbeat expiry. Expired leases alone cannot steal a running job.

Removed after repository-wide reader checks: `account-supervisor.cjs` (child spawning), `scripts/public-research-worker.cjs` (separate public process), `worker-legacy-import.cjs` (automatic disk queue import), and `linkedin-activity-policy.cjs` (unused hourly/rolling/schedule gates). The former supervisor entry point is a five-line agent compatibility launcher. Qualification no longer writes folder queue/results. The existing finder-progress consumer still uses `queue-results`, so its directory and all user data remain intact. The unused progress writer and file-based Resume last path were removed after reference checks; Resume saved work now authorizes PostgreSQL checkpoints. Read-only legacy archive/history views remain because they still have UI consumers. The obsolete child-supervisor tests were replaced with persistent-agent tests; obsolete throttle tests were removed.

Validation: 21 agent/coordinator/process/launcher/resource tests and 21 manual-sign-in/race/pipeline tests passed; TypeScript passed. Regression phase 4 replayed all 50 frozen records: each changes to REVIEW solely because stored followers are missing; the full per-lead delta is in ignored `data/engine-v2/phase-4-regression.json`. The diagnostic replay with the follower gate satisfied has zero other changes. Existing stored qualified leads are grandfathered until explicitly selected for recheck.

# Phase 5: daily profiles and follower rechecks

The existing account field is named `daily_limit`; it remains the single daily profile limit. A new additive ledger keys account + configured local date + canonical profile URL. An account-row transaction makes reservations atomic. Claims, cached captures, session verification and same-account same-day retries do not increment it. Another account reading that person consumes its own slot. Midnight is computed in PostgreSQL using the worker machine's IANA time zone by default; `DAILY_LIMIT_TIMEZONE` overrides it. The existing 1–400 database field constraint is retained. Interaction counters are statistics only.

At the cap, account intent remains enabled and the dashboard shows DAILY_LIMIT_REACHED with the next local midnight. The website lane continues. First navigation charges immediately before opening the profile; source lists are no longer charged as profiles. Selected CRM rows can explicitly request a fresh follower recheck, retaining active-profile duplicate protection. Existing QUALIFIED rows receive the additive `followers_check_status='UNCHECKED'` default without requeue or decision changes. Followers and connections retain separate raw/parsed evidence in the CRM and prospect evidence views.

Validation: 11 daily/parser/qualification/single-limit tests passed, plus an expanded daily database test covering explicit rechecks, duplicate suppression and preserving the old CRM decision while queued. TypeScript passed. Phase 5 frozen replay: 50 intended follower-missing REVIEW changes, zero changes outside the follower rule, zero replay errors. Full per-lead changes: ignored `data/engine-v2/phase-5-regression.json`.

# Phase 6: final verification

The PostgreSQL manifests confirm exactly the same 30 ordered profile URLs and 30 distinct jobs in `baseline-unthrottled` and `after-v3`. Both completed. Every after job explicitly bypassed captured-profile reuse and loaded LinkedIn; this was not a stored-evidence simulation. Both used the manually connected first enabled account. The other two accounts' security/review holds were retained. The original throttled attempt picked up 0/30 and has no comparable latency; the usable before batch required removing its prohibited identity/check gates first.

| Measurement | Before, 30 profiles | After, same 30 |
| --- | ---: | ---: |
| Median pickup → terminal save | 19.004 s | 5.576 s |
| p90 pickup → terminal save | 40.332 s | 18.801 s |
| Terminal outcomes/hour | 161.7 | 400.2 |
| Batch elapsed, first pickup → last save | 668.0 s | 269.8 s |
| QUALIFIED / REJECTED / REVIEW / ERROR | 1 / 2 / 0 / 27 | 0 / 13 / 17 / 0 |
| ERROR rate | 90% | 0% |
| ERROR + REVIEW rate | 90% | 56.7% |
| Retries / rework | 0 / 0 | 0 / 0 |
| Observed peak worker + Chrome RSS | 5,573 MiB | 2,811 MiB |
| Sampled mean process-tree CPU, 100% = one core | 113.0% | 77.1% |
| Sampled CPU seconds per terminal outcome | 25.64 | 6.87 |
| Parent-tree sampled peak CPU | 172.3% | 204.5% |
| Idle queries/minute | 385, original blocked account + public worker | 100, authorized empty queue; 45 paused |
| Final-run startup failures | original gated attempt could not start capture | 0; all startup stages recorded |

The median fell 70.7%, p90 fell 53.4%, and terminal throughput rose 2.48×. “Terminal” includes REVIEW and ERROR; these are not all automatic qualification decisions. The final batch made 13 automatic rejections and handed 17 leads to review. The intended follower rule accounts for 11 low-follower rejections and 10 missing-count reviews. Five reviews lacked reliably dated activity, one site remained unreadable after its bounded render, and one profile layout could not be read. No rule was relaxed to obtain an email/activity qualification. The gain includes the intentional follower-first exits and the live site's current rendering; it does not isolate the architecture's causal contribution.

RAM uses the larger valid whole-agent observation: the independent benchmark sampler saw 2,595 MiB, while the agent's offset sampler caught 2,811 MiB. Both PIDs identify the same agent. The final table uses 2,811, a 49.6% reduction, rather than the lower missed-peak sample. Fifteen-second RSS sampling can miss brief peaks and sums shared pages conservatively. CPU compares the same surviving-PID sampling method in both batches. It misses new/short-lived process work, especially around recycling, so CPU seconds are sampled lower bounds. Peak CPU did **not** improve. No browser tests, lint, typecheck or build ran during the final batch.

Idle was measured separately with zero pending/processing jobs, zero discovery runs and zero Chrome processes. Four 30-second authorized-empty windows settled at 100–101 queries/minute; Pause settled at 45. The before value is the original blocked/idle service (314 account + 71 public-worker queries/minute, excluding supervisor/dashboard), not a perfectly identical authorization/queue state. The final idle probes explicitly restored Pause. Resource queries count the agent's maintenance work, not dashboard SQL. The dashboard now exposes per-lead timings, stage/final-outcome funnels, separate ERROR/REVIEW/rejection reasons, and current/peak whole-tree resources. Heavy trace arrays are excluded from normal queue-history responses.

The first diagnostic v2 run exposed a 39.9% lane/retry/other wall share dominated by an unreadable website's two delayed repeats. That justified making still-unreadable static-plus-rendered pages terminal, applying the site deadline across checkpoint gaps, and removing the public retry sleep. It also exposed a pipeline bug: low followers were incorrectly converted to REVIEW because the deliberately unread activity was unknown. The final pipeline now honors FOLLOWERS_BELOW_MIN before the activity branch; an integration test covers the full public-lane/CRM outcome. The final run had one HTTP website fetch and one render, and no rework. A failed final DB acknowledgement now retains completed research and releases only that owned job, with bounded recovery; it cannot strand the job or release another public task's claim.

Startup verification caught one legacy handoff problem in the diagnostic run: an explicitly released session still carried a BROWSER_CLOSED snapshot, so the new registry reported FAILED at AGENT_ACK with the exact ownership reason and action. The lease/updated timestamp proves the old explicit release; recovery now recognizes it. Unknown/live ownership still cannot be reclaimed. The final cold agent/browser start and automatic recycles recorded AGENT_ACK, BROWSER_STARTING, SESSION_VERIFIED and PROCESSING; the saved command supplies REQUEST_RECEIVED. No final-run startup failure occurred.

Remaining floor: the median first profile load/read is **2.979 s**, including a median **1.542 s** of actual navigation. Eight leads needed an activity read (6.34 s average). LinkedIn profile/activity/contact/actions account for 70.5% of attributed final wall time; website research is 2.1%. This is now primarily a rendered LinkedIn-page floor. There is no measured reason to migrate away from Puppeteer.

Regression phase 6 replays all 50 frozen records without network access. All 50 lack stored follower evidence and intentionally become REVIEW under v2. The diagnostic replay with only the follower gate satisfied has **zero non-follower changes and zero errors**. One stored QUALIFIED decision already disagreed with the original evaluator before this work; it remains identified as pre-existing drift. Full snapshots, every per-lead phase delta, raw batch reports, resource samples, exact-profile verification and derived comparison are in ignored `data/engine-v2/`; manifests and raw batch reports also remain in PostgreSQL. Existing qualified CRM records were not automatically requeued or rewritten by the migration.

Final validation: all 296 engine/prospect/coach tests passed with no skips; all nine CRM tests passed, including the explicitly opted-in PostgreSQL temporary-table integration test. Dashboard fixture checks passed for desktop/mobile measurements, all 30 per-lead rows, pause/resume intent, editable daily profiles, cap/resume status, exact startup failure/retry action, and selected follower recheck. The live telemetry GET also returned the bounded per-lead/resource summaries. Browser mutations were intercepted and no fixture data reached PostgreSQL. The whole-project lint command has been repaired (`next lint` is unavailable in the installed Next version). It identifies five existing errors outside this engine work: the teleprompter's plain internal link and effect-state patterns in WorkspaceCommandMenu, OnboardingWorkspace, EvidenceRecoveryDialog and OnboardingDialog. Those unrelated files were left intact. No libraries were migrated, no user data or real environment files were modified, no destructive migration ran, and no speculative claim index or Windows scheduled task was installed.

TypeScript (`npx tsc --noEmit`) passes. An additional 180 existing Copy Studio, projects and email-verification tests pass with no skips. The first production build completed successfully. Its broad Finder/Create filesystem patterns unexpectedly traced 3,907 local browser-profile entries and 637 ignored data entries into a route manifest. Global deployment tracing exclusions now keep browser profiles, environment files, queues, evidence, archives and other private runtime directories out of the package; no runtime files were removed. `node scripts/engine-verify-build.cjs` checks generated route manifests without opening those files. The rebuilt production package passes. All 43 emitted route manifests contain zero private runtime entries. Both the complete working tree and the staged Dashboard/CRM source variants pass TypeScript; the latter check ensures unrelated UI work was not required by the staged engine controls. Whole-project lint still reports the five existing unrelated errors listed above (seven warnings); engine files have no lint errors.
