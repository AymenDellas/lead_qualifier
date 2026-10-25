# CompelOS qualification engine audit

Captured 2026-10-25, before behavioral changes. This is a trace of the working
tree, including the existing uncommitted session/research rebuild, not just HEAD.
No `AGENTS.md` or `README.md` exists in this checkout or its ancestor directories.
`docs/local-worker-start.md` and `docs/linkedin-workers.md` supply the deployment
context: browser workers are local only; Vercel uses PostgreSQL and cannot launch
the worker or Chrome. The task's daily-profile-only limit supersedes old comments.

## Evidence preserved before changes

`data/engine-v2/regression-before.json` contains 50 decided CRM leads, the stored
decision, review, email, reasons, full stored research, and the original evaluator's
replay at a fixed snapshot time. It is local, ignored lead data and is not committed.
There are 22 QUALIFIED and 28 NOT_QUALIFIED records. One stored QUALIFIED record
(`nnec6symoiaoz09wp4keub`) already replays NOT_QUALIFIED before any changes.
Compare subsequent phases with the frozen original replay as well as stored state;
do not count pre-existing drift as a new regression. No LinkedIn pages were loaded.
The last 300 job records have **no stage timings**. Creation-to-completion includes
queue time and retry backoff and cannot establish pickup-to-decision latency.

Initial account state: all processing disabled, all session leases expired. The
first enabled account has a disconnected-browser reason; the other two accounts
have persisted restriction/security-review reasons (one is disabled). Those holds
must be preserved. A live baseline requires a verified usable session.

## Pipeline, costs and ownership

Counts below describe application calls, not all subresources Chrome/LinkedIn
loads. LinkedIn's normal browser traffic is not enumerated by the current engine.
Phase 1 must measure actual page actions and browser request events separately.

| Stage | Execution / page loads | Timeouts, retries, waits | Concurrency / database calls |
| --- | --- | --- | --- |
| Discovery search | `src/lib/dorkEngine.ts:createSerperSearcher/runDorkEngine` actually uses `google.serper.dev/search`, not SerpAPI in this checkout. No account browser. | 20s HTTP timeout; up to three rounds across configured keys; network/5xx wait 5s, rate limit exponential 10s; 500ms between search pages. These are search-provider controls, not LinkedIn controls. | Sequential query/page search; discovery progress and lead persistence use PostgreSQL. Finding is outside the requested optimization target. |
| CRM to queue | Engine actions use `linkedin-workers.cjs:queueCandidates/enqueue`. Canonical HTTPS `/in/slug/` key. | Same-day completed-profile exclusion; active-profile unique index; no page requests. | Candidates query suppresses duplicate assessed/contacted CRM people. Enqueue: completed-key lookup plus one JSON recordset INSERT. Max 5,000 submitted URLs. |
| Service reconciliation | `scripts/linkedin-worker-supervisor.cjs` -> `account-supervisor.cjs:tick`. | **2s**, not 10s, current polling. Child stop grace 20s. A crashed child requires a changed explicit command token. | Each tick: service heartbeat UPDATE, expired-login UPDATE/events, accounts SELECT. One child Node per requested account, plus public research child. |
| Account startup | `worker.cjs:main`, process lock -> ensure -> account read -> acquireSession -> runtime. Chrome starts later on Connect/Start. | Pool connect 10s/query 15s; session lease 120s; heartbeat 10s. Main loop sleeps 1.5s even after a completed job. | Pool max 3 **per process**. Heartbeat does session UPDATE and job lease UPDATE. Each loop also heartbeats after tick. |
| Manual connect | `account-runtime.cjs:connect/observeManual`; persistent, visible Chrome; one reused tab. | Browser launch/protocol 30s. New browser navigates feed once (30s). Manual observation window 10min. DOM identity can open account menu once; no credentials entered. | Account read, consume request, identity/permit checks, transactional matching-member confirmation. No profile budget should be consumed by a session check. |
| Processing preparation | `prepareProcessing`; existing confirmed open browser avoids feed navigation. Otherwise opens saved profile, feed, rendered identity. | 30s feed navigation; current permit can delay identity; failed identity pauses. Handled Start token prevents automatic repeat. | `processingAllowed` rechecks lease, pause, identity, hold and exact command version. `startProcessing` permits 15–120min (default 60) and currently enforces extra budgets. |
| Source discovery (optional) | `coach-prospecting-worker.cjs:discover`; rendered network/search list. | 45s navigation; main 12s; Next-page DOM change 20s. Up to 50 search pages or 12 list passes; stagnant after three. Fixed **1.4s** after scrolling. | Sequential on the account tab. Per action permit and run-active checks. `claimSource` transaction reads usage and incorrectly charges a `source/run-id` as a daily profile. Progress transaction saves seen keys and enqueues unique profiles. |
| Capture claim | `linkedin-workers.cjs:claim`. | Job lease 15min; expired processing claims recover. Ready `retry_at` predicate. No browser loads. | Transaction: account selection, session row lock, usage INSERT/lock, duplicate cancellation, `FOR UPDATE SKIP LOCKED` job SELECT, optional completed-profile cache lookup, unique usage reservation, job UPDATE. Typically 9–13 SQL calls including BEGIN/COMMIT, more for retries. |
| Profile navigation / identity | `linkedin-browser-page.cjs:openProfile/parseProfile`. 1 profile navigation. DOMContentLoaded then supported h1/h2 identity and matching contact/self routes. | 45s navigation plus 12s hydration loop, **250ms fixed polling sleep**. No navigation retry. Redirect and 404/410 are record failures. | One account job at a time. `beforeCheck('profile_page')` precedes load; inspect/security checks repeat during hydration. Snapshot bounds visible HTML to 2MiB. |
| Profile hydration / expansion | `captureProfile`. | Up to three scrolls; each waits for About+activity DOM for 2s (250ms polling). Optional About expand. | Each scroll/expand obtains a permit. Parse duplicates the early identity parse. Saves profile checkpoint (one guarded UPDATE). No followers extraction/check yet. |
| Contact | Matching profile's contact-info overlay, then close. Usually SPA transitions, potentially page requests. | Visible dialog wait 8s, disappeared dialog wait 8s; event predicate polling 250ms. Detached control handle retried twice; no navigation retries. | Permit before open and close. Resume of same-account contact checkpoint <24h skips panel. Saves contact checkpoint. Published emails/links only. |
| Activity | `readActivity` follows an actually rendered `/recent-activity/all/` or `/posts/` link. Usually 1 extra page transition; can reopen profile if URL changed. | Route wait 12s; cards/empty-state wait 10s, 250ms polling. Unknown stays Unknown; no private endpoint fallback. | Permit for activity page. Author-matched dated card only. Does not currently reuse profile Activity cards. Complete capture checkpoint saved. |
| Durable lane transfer | `worker-research-queue.cjs:handoff`. | Immediate owner/lease-checked UPDATE. No website wait. | First call ensures lane/runtime schema and migrates eligible complete captures. Then same job becomes research/pending and releases account owner. Capture awaits this DB write; next claim occurs on next runtime tick, not prefetched. |
| Research claim | Separate `scripts/public-research-worker.cjs` -> `worker-research-runner.cjs`. | Empty queue sleep 2s; heartbeat 10s; 15min job lease. | One research job at a time. Pool max 3. Each claim currently also migrates eligible captures, then CTE SKIP LOCKED UPDATE. Fully captured evidence required. |
| Cheap research shortcut | `prospect-research.cjs:researchProspect`, `qualificationFirst`. | With recent dated activity and an attributable published profile email, returns without crawling. | Saves qualification immediately but marks website pending, which can create a **post-qualification continuation**. Inactive and unknown activity do not currently short-circuit crawling. |
| Website static fetch | `website-crawler.cjs:crawlWebsiteRoutes`; HTTP+Cheerio, not account Chrome. | Default **200 pages/pass, 90s/pass, 600 total routes**, up to 8 roots. Each request 10s (hard max 12s), 4 redirects, 4MiB response, DNS pinned to a validated public address. Shared abort signal spans redirects. www DNS failure can try apex. | Batches of up to **3** fetches. Contact then About then services prioritized. Explores all remaining discovered public routes. Complete parsed page/source text retained during a pass. No domain cache. |
| Website render fallback | `public-page-browser.cjs:createPageRenderer`; lazy independent **headless** Puppeteer browser with fresh contexts. | Up to 3 rendered pages/job, serialized. Navigation total 10s, network-idle 250ms with 2.5s timeout (again after popup). Max 60 requests and 12MiB per render. Browser remains open until research process stops. | Separate from account Chrome already. Fallback can run on fetch failure and again for sparse/no-contact root/contact HTML. No LinkedIn requests, validated redirects/public DNS. |
| Crawl resume | Previous crawl routes, attempts, candidates and matching-host evidence retained. | Per-route attempts up to 3. Job research retries up to 3 at +60s; qualified continuation at +30s, up to 3. 404/410/non-HTML skip; 400/401/403/DNS/cert/private/size/redirect failures terminal. Pending pass budget can cause repeated passes. | Website failure never returns a complete capture to LinkedIn automatically. Existing recovery migration repairs older captures. Legacy attribution migration can reread roots/contact/About once. |
| Qualification | `prospect-qualification.cjs:assessProspect/pipelineForAssessment`. Rules run locally. Worker passes `ai:false`. | Activity <=30 days and attributable email; business-fit tiers advisory. Freshness uses current time; regression replay must freeze the clock. | No network/DB. `pipelineForAssessment` currently uses attributable email + profile/dated activity helper rather than `qualification.qualified` directly. Preserve this behavior until regression evidence justifies a deliberate change. |
| CRM write | `worker-research-store.cjs:saveWorkerResearch`; native path. | Failed CRM save retries saved research. Current module-level schema promise is shared across pools. | Transaction: owned job lock, canonical-profile advisory lock, lead SELECT FOR UPDATE, optional INSERT, assessment + contact/email provenance UPDATE, COMMIT. Holds contact/suppression state; selected email changes reset verification metadata. Completion follows in a separate guarded UPDATE. |
| Prospecting write | `coach-prospecting-worker.cjs:finish` -> `coach-prospecting-store.cjs:finishProfile`. | Active campaign / lease checks. No second native CRM write. | Transaction with job lock, canonical advisory lock, dedupe, qualification/review and run progress writes. Separate prospect-pool semantics; must not silently change qualified CRM eligibility. |
| Failure / final result | `account-runtime.cjs:recoverJob`, `worker-research-runner.cjs`, `worker-failure.cjs`. | Control/auth holds defer captured evidence; unavailable URL completes ERROR and moves on. Other capture failures complete ERROR and pause. Unknown activity becomes terminal ERROR despite nonretryable evidence. Research/CRM retry <=3, then terminal ERROR. | Result completion checks owner AND live lease; unique pending key prevents duplicates. Checkpoints retained. Normalized history can recompute qualification at display time. |
| Dashboard | `queue-status` -> `linkedin-workers.cjs:queueStatus/settings`, `Dashboard.tsx`, `LinkedInAccounts.tsx`. | Client polling varies; compact history less often. No real per-stage latency data. | Settings loads events over last 24h to compute rolling limits; history fetch limits 100 latest people but still normalizes research. Queue totals, daily totals, outcomes, service heartbeat, account leases use additional queries. Current memory field has no process-tree measurement in the new runtime. |

## Every main/startup exit and no-work return

`worker.cjs:main` has no silent top-level `return` in the present working tree.
It throws on missing/invalid `--account`, process lock already owned, failed schema
or database setup, missing account, and session lease not acquired. Top-level catch
prints only to console and sets exitCode=1: failures before a runtime heartbeat are
not consistently visible in the dashboard. The loop stops on SIGINT/SIGTERM or IPC
stop, lease heartbeat error, missing/disabled account (`runtime.close`); it then
closes owned Chrome, releases jobs/session, closes pool and removes its own lock.

Runtime no-work/early-return paths:

- stopped runtime; account missing; disabled account; completed/duplicate logout;
  duplicate/consumed login request; already handled Start; existing confirmed browser;
  a newer command/token or page/signal generation supersedes an old callback;
- manual sign-in still on login/checkpoint/non-feed; identity absent; browser closed;
  10min manual deadline; mismatching identity; account notice; manual inspection failure;
- persisted attention reason; processing not authorized/expired/paused;
  `processingAllowed=false` or lost lease/command fencing;
- source campaign stopped/paused; no eligible source; source discovery finishes/stalls;
- capture claim disabled by account capacity; daily profile limit; queue empty;
  cached complete capture bypasses browser; unavailable/redirected profile completes;
- control/auth/rate failure defers without bypassing account hold; other capture failure
  completes and pauses; research-only retry does not reactivate account processing.

Supervisor startup exits: owned PID lock, verified old single worker still running,
DB/schema/import error, service stop file, signal/IPC stop. `stopChild` sends stop then
kills **that child only** after 20s. `account-supervisor.tick` returns when busy/stopped,
does not launch disabled/unrequested/held accounts, and suppresses a same-command
relaunch after exit. It pauses a crashed child's account rather than recovering.

Public-research startup exits: own PID lock live/starting, cannot acquire after two
attempts, DB/schema failure. Loop exits on signal/IPC/heartbeat failure, releases
owned research claims and closes owned browser. Errors are console-only here too.

`account-browser.cjs` rejects invalid profile key, another in-process profile owner,
closing/disconnected owner, 30s launch timeout, restored-tab close failure and Chrome
Singleton/profile-in-use error. It does not remove Singleton locks. Close grace is
2s, then owned child kill and another 2s exit check. Unknown ownership never allows
killing arbitrary Chrome. Existing OneDrive profile takes precedence over new local
profile root. Windows backgrounding moves the visible Chrome window off-screen.

## LinkedIn gating and delay inventory (to remove except daily profiles/holds)

| File / function | Existing value or condition | Role |
| --- | --- | --- |
| `linkedin-workers.cjs:validateSettings` | daily check budget 100 default (10–2,000), minimum gap 15s default (10–300s) | Saved non-profile limits |
| `linkedin-workers.cjs:startProcessing` | working hours; daily check/rolling 24h; 30 checks/hour | Rejects Start |
| `linkedin-workers.cjs:requestLogin` | 5min reopen cooldown; 3 windows/hour | Rejects manual session checks |
| `linkedin-workers.cjs:reserveLinkedInCheck` | working-hours wait 60s; `next_check_at`; daily/rolling request budget; 30/hour; per-kind rolling waits | Transactional permits before all actions |
| `linkedin-activity-policy.cjs:DEFAULT_LIMITS/actionWait` | profile 15/hour,25/day; contact 20/50; activity 15/25; discovery 15/40; identity 5/10 | Rolling 1h/24h per-kind budgets |
| `account-runtime.cjs:permit` | sleep min(waitMs,1,000ms) in a loop; manual check throws instead | Holds account lane between actions |
| `coach-prospecting-worker.cjs:discover` | pause(1,400ms) after each list scroll | Fixed rendering/pacing sleep |
| `linkedin-browser-page.cjs:openProfile` | fixed 250ms delay in 12s readiness loop | Replace with event-based readiness |
| `worker.cjs:main` | 1,500ms after every tick, including completed capture | Artificial inter-job gap |
| `linkedin-workers.cjs:claim` | daily_limit 1–400; unique **global day/profile** currently in UTC | Keep daily profiles, repair account scope/timezone |
| `coach-prospecting-store.cjs:claimSource` | counts `source/run-id` against daily profiles | Wrong unit; discovery is not a profile |
| `account-runtime.cjs:tick` | daily limit -> pauseProcessing / PROFILE_BUDGET | Needs idle-until-midnight state, not manual restart |
| `linkedin-workers.cjs:processingAllowed/claim` | explicit pause, account enabled, session/job lease, member identity, command fencing, capacity, review hold | Keep intent, ownership and reactive stops; resource capacity is not a per-action throttle |
| `linkedin-session-policy.cjs:pageSignal` | 401/403/429/999, checkpoint/challenge/login/authwall, visible restriction notice | KEEP reactive stop until manual review |

Browser navigation/DOM deadlines, bounded crash retries and idle polling are not
LinkedIn usage budgets. Keep deadlines; replace fixed rendering sleeps with events.
AI-provider budget functions (`reserveResearch/coolResearch`) are not LinkedIn
limits; current qualification worker disables AI and does not use them.

## Current process tree and memory

```text
npm/node (local dashboard launch or terminal)
  node scripts/linkedin-worker-supervisor.cjs [pool max 3]
    node worker.cjs --account A [pool max 3]
      headful Chrome persistent profile A
        renderers / GPU / network / utility processes
    node worker.cjs --account B [pool max 3, if explicitly requested]
      headful Chrome persistent profile B + children
    node scripts/public-research-worker.cjs [pool max 3]
      headless Chrome on demand + children
```

No current 50-job manual stop or `getMemoryMB` remains in the thin worker.
The account browsers are already reused and website rendering is already separate.
No idle close or automatic Chrome recycling exists. The public headless browser
stays alive after first use. Multiple account browser trees plus four Node pools
can exceed the 8GiB machine budget. Node RSS alone cannot measure this.

## Hypotheses after trace

| Hypothesis | Finding |
| --- | --- |
| Expensive before cheap rejection | Supported for inactive/unknown activity before website crawl; followers currently absent. Profile-email shortcut already avoids crawl for some qualified leads. |
| Exhaustive/slow website crawl and retries | Supported by code budgets and continuation behavior; actual share requires measured baseline. |
| Extra activity page / unresolved activity errors | Supported. One extra route normally; nonretryable Unknown ends ERROR. |
| Errors redo all LinkedIn work | Contradicted for complete captures: current research lane resumes evidence. Partial captures can reopen the profile; keep checkpoint guarantees. |
| LinkedIn waits on website | Contradicted in this working tree. It awaits checkpoint/handoff DB writes and has 1.5s loop overhead. |
| Self-imposed throttling | Supported by inventory above; measure elapsed waits, do not estimate them as observed time. |
| Supervisor 10s / website in account Chrome / 50-job stop | Contradicted in this working tree. Supervisor is 2s, separate research browser, no job-count stop. |
| High memory / opaque start failures | Plausible process topology and console-only pre-heartbeat failures; quantify process trees/start outcomes in Phase 1. |

## Measurement gate

No timing ranking is claimed from code limits or historical queue timestamps.
Phase 1 adds persisted spans, funnel/rework/error counts, OS process-tree samples,
idle query counts and a bounded 30-lead run manifest. Behavioral phases must be
justified by the resulting ranking. If manual sign-in or a reactive account hold
prevents that run, report an incomplete baseline and its exact stop reason.
