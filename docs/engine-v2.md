# Qualification engine v2

Finder continues to discover leads through SerpAPI. PostgreSQL remains the CRM, queue, checkpoint store and measurement store. The local Next.js dashboard requests work through PostgreSQL; it does not own the browsers. The audit and measured changes are in [engine-audit.md](engine-audit.md) and [engine-measurements.md](engine-measurements.md).

## Architecture

`npm run worker` starts one persistent Node agent (`worker.cjs` → `src/lib/compel-agent.cjs`) with a shared five-connection pool. The existing worker entry point keeps desktop commands and deployment guards compatible while lifecycle logic lives in the agent module. No supervisor/account/public-research child Node processes remain. The old supervisor command is a compatibility launcher for the same agent.

The capture lane owns one sequential Puppeteer tab in a persistent account profile, with one LinkedIn browser by default. It claims a PostgreSQL job and verifies the saved account identity only when a browser is needed. It reads the requested profile, verifies its identity and checks followers first. Low followers reject immediately; missing/unparseable followers require REVIEW. A recent matching-author profile activity preview avoids an activity-page visit. Otherwise the worker follows the observed activity link. Inactive/unknown activity stops before contact and website work when the main CRM policy requires recent activity. Coach prospecting retains its original business criteria and does not inherit that email/activity gate. Active candidates continue to the rendered contact panel and remaining public evidence.

Checkpoint/result saves enter a bounded serial queue (capacity six). Near the last capture step the runtime preclaims the next job; it never waits for public website research. Database admission applies backpressure when the save queue is full. Daily reservations and ownership checks remain synchronous because their atomic guarantees must precede browser actions. Ordered saves prevent an earlier checkpoint from overwriting a later handoff. Complete captures transfer to the public lane under the same job ID and release the account claim.

Two public tasks share three HTTP slots, use fetch + Cheerio and a PostgreSQL cache with eight bounded slots per domain, 256 KiB per slot and a 24-hour TTL. Qualification rechecks email attribution per person even when HTML is cached. Home/contact/about routes receive priority; only observed links are followed. Defaults: eight distinct routes, twelve total attempts, twenty seconds across the site's wall-clock lifetime, five seconds per request. Stop when the existing qualification questions have enough evidence. Nonretryable HTTP failures do not trigger rendering. A successful but unreadable HTML shell gets one bounded rendering attempt in a separate on-demand headless Chrome; still-unreadable evidence becomes REVIEW. Transient website/CRM failures resume stored evidence within bounded attempts, without a LinkedIn visit or an added retry sleep.

The existing capture/research queue indexes were sufficient in the measured EXPLAIN plan. No speculative queue index was added. Account statistics are batched by action kind. Saves preserve do-not-contact flags, contacted history and email verification; replacing an email invalidates its prior verification.

## Daily cap and followers

The existing database column is `compel_linkedin_accounts.daily_limit` (the daily profile limit; no duplicate limit field was introduced). Its existing 1–400 constraint remains. Account settings show used/limit and let the operator edit it. New-account defaults use `DEFAULT_DAILY_SCRAPE_LIMIT` (400).

`compel_worker_account_profiles` has an account/date/canonical-URL primary key. An account-row lock serializes the count and insertion immediately before opening a person profile. Same-day retries and return visits to that person are free for that account. Another account has its own count. Claims, cached captures, source lists and session checks consume no profile slot. The configured PostgreSQL day uses `DAILY_LIMIT_TIMEZONE`, defaulting to the worker machine's IANA time zone at startup. The next midnight is computed by PostgreSQL, including DST. At the cap, intent stays enabled and status becomes DAILY_LIMIT_REACHED with the resume time; already-captured public work finishes. Notifications or the idle poll notice a limit edit/new day.

Followers must be strictly greater than `MIN_FOLLOWERS` (1000). The rendered profile provides raw text and an integer, supporting grouping, K/M suffixes and tested localized labels. Connections have separate evidence and never substitute for followers. At/below threshold → REJECTED with FOLLOWERS_BELOW_MIN; absent/unparseable → REVIEW. Evidence includes the applied threshold so a dashboard with different environment defaults cannot reinterpret the saved check. A new explicit check uses the current threshold.

`QUALIFICATION_VERSION` is 2; research schema version 1 remains compatible. Existing QUALIFIED records get the additive follower status default UNCHECKED and keep their stored decision. Select CRM rows and use **Recheck followers** to request fresh full qualification. This bypasses completed-today deduplication only for the selected request, keeps active-profile duplicate protection and consumes the account's daily slot only if it has not already read that profile that day. Followers/connection evidence is expandable in the CRM and prospect evidence view. No legacy lead is automatically requeued.

## Start, pause and recovery

Use Start workers in the local dashboard or `npm run worker`. Connect/Open session opens the saved profile for manual sign-in. Start/Resume authorizes processing until explicit Pause, disable, sign-out, the daily cap or account review. Restarting the agent resumes saved intent and unfinished PostgreSQL checkpoints. A manually paused or held account stays paused/held. `npm run worker:stop` requests a graceful PostgreSQL stop without clearing intent or evidence. See [Windows sign-in startup](windows-agent.md) for the optional Task Scheduler setup.

Account startup displays REQUEST_RECEIVED → AGENT_ACK → BROWSER_STARTING → SESSION_VERIFIED → PROCESSING. Failures include the stage, exact reason and recovery action. Startup history retains intermediate stages even if browser startup finishes between dashboard polls. The local launch marker exposes errors before the database is reachable. A live/unverified PID prevents a second agent; a confirmed-dead owner waits for heartbeat expiry. A legacy explicit release is recognized by its lease/updated timestamp fence, even when its final browser snapshot says BROWSER_CLOSED.

The agent registry records host/PID/script ownership. Only confirmed-dead, expired owners have processing claims reset to pending; checkpoints and security holds remain. Lease expiry alone never steals work from an unknown/live process. Chrome Singleton files are removed only with verifiable dead ownership/expired heartbeat or a verified close. A live or unverified Chrome profile remains blocked with an action to review its owner. Profiles/cookies and user data are never cleared or moved automatically.

Browser crashes resume the current checkpoint within two retries; exhausted attempts become REVIEW. Initial browser startup retries within three attempts and then shows FAILED. Resource recycling closes Chrome after ten captured jobs, above a sampled 1536 MiB browser-tree threshold, or after 30 seconds idle, and later reopens the same saved profile. There is no 50-job stop. Recycling yields the browser to waiting accounts, with manual-review requests first. Public Chrome closes after 15 seconds idle. Idle polling backs off from 2 to 30 seconds; PostgreSQL NOTIFY wakes new commands/jobs. These are idle/resource/recovery waits, never LinkedIn throttles. Rendering waits use DOM/navigation events.

Reactive stops cover LinkedIn/LICDN HTTP 401/403/429/999, authwall/login/checkpoint/challenge, security warnings and mismatched identities. They immediately block further account actions, persist the reason and show the window for manual review. Settings changes/restarts cannot clear them. No passwords, private endpoints or browser-library migration were introduced. Worker features are unavailable on Vercel.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIN_FOLLOWERS` | 1000 | Require a strictly greater follower count |
| `DEFAULT_DAILY_SCRAPE_LIMIT` | 400 | Default for new accounts; existing database values win |
| `DAILY_LIMIT_TIMEZONE` | worker local IANA zone | Day boundary stored in PostgreSQL |
| `MAX_ACTIVE_BROWSERS` | 1 | Maximum LinkedIn browsers |
| `CHROME_RECYCLE_JOBS` | 10 | Automatic Chrome recycling, never a manual job stop |
| `CHROME_RECYCLE_RSS_MB` | 1536 | Sampled whole-browser-tree recycling threshold |
| `LINKEDIN_BROWSER_IDLE_MS` | 30000 | Close idle LinkedIn Chrome, retaining profile |
| `PUBLIC_BROWSER_IDLE_MS` | 15000 | Close idle public headless Chrome |
| `WEBSITE_MAX_PAGES` | 8 | Distinct site route budget |
| `WEBSITE_MAX_ATTEMPTS` | 12 | Total site attempts across resumes |
| `WEBSITE_MAX_MS` | 20000 | Site wall-clock deadline across resumes |
| `WEBSITE_REQUEST_TIMEOUT_MS` | 5000 | Individual HTTP deadline |
| `WORKER_PROFILE_ROOT` | local app-state directory | New profiles only; existing `.browser-profiles` wins |
| `WORKER_LAUNCH_DISABLED` | unset | Disable the dashboard's process launcher |

The npm worker command limits the Node heap to 384 MiB. The resource panel measures the agent plus its whole Chrome process tree, not just Node RSS. RSS sums shared pages conservatively; CPU uses 100% per core. Fifteen-second sampling can miss short-lived peaks. The quiet-queue query rate is the comparable idle figure; during active work, outside-trace maintenance queries are also counted. Private raw evidence and reports stay in ignored `data/engine-v2/`; benchmark manifests/reports also live in PostgreSQL.

## Removed paths and checks

Removed: per-account child supervisor, separate public-research process, automatic folder queue/result import and unused file-based progress writer/resume path, unused hourly/rolling/schedule policy module, expiring one-hour processing authorization, fixed rendering sleeps, per-kind permits and check budgets, and post-decision automatic website continuations. Existing database columns/legacy data remain for compatibility; no destructive migration ran. Finder progress still reads `queue-results`, so that consumer/directory and all user files remain.

Run engine/CRM tests, TypeScript and lint as listed in root AGENTS.md. Regression snapshots replay stored evidence without LinkedIn. The exact before/after measurements, deliberate follower changes, startup failure and remaining LinkedIn page-load floor are recorded in [engine-measurements.md](engine-measurements.md).

Production builds exclude local profiles, environment files, queues, private evidence and other runtime directories from file tracing. The Finder/Create dynamic-path warnings can still appear; run `npm run build` and then `node scripts/engine-verify-build.cjs` to verify the emitted route manifests contain zero private runtime entries. These packaging exclusions do not delete runtime files. Worker process launch/control remains disabled on Vercel.
