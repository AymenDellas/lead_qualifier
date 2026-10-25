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
