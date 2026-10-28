# AliasMode account browsers — 27 October 2026

The provider/CDP ownership architecture below remains active. The latest per-account visible-default mode, dedicated proxy controls, fingerprint checks, manually reviewable UNKNOWN reports and warmup/ramp/recovery policy are documented in [engine-stealth.md](engine-stealth.md), which supersedes the earlier headless-only and fixed-spacing descriptions here.

AliasMode replaces the abandoned AdsPower integration as the sole active account-browser provider. The former Chrome launcher and AdsPower adapter remain as inactive commented source, with no fallback. The installed Puppeteer version attaches through CDP; no browser library was migrated.

## Architecture

`worker.cjs` starts `compel-agent.cjs`. Each requested account acquires its existing PostgreSQL lease. `aliasmode-browser.cjs` fences its immutable profile ID and binding revision against that owner, checks the provider lifecycle, starts only an inactive profile, and calls `puppeteer.connect` with the returned loopback WebSocket. It reuses only a recorded worker tab, otherwise creates its own tab in the persistent default context. Other restored tabs remain intact. No local account Chrome, incognito context, cookie export or fingerprint/proxy overrides are used.

`aliasmode-client.cjs` uses status, profile list and V1 active/stop; supported helper CLI handles profile launch. The default address is `http://127.0.0.1:50400`, without API authentication. The abandoned AdsPower key is never read or forwarded. Control concurrency is two, capacity sixteen, with no pacing sleeps. Start/stop deadlines are 120/90 seconds; other calls use 10 seconds and JSON is capped at 1 MiB. Starting, stopping and uncertain lifecycle states fail visibly instead of spawning another browser. Single-flight metadata refresh runs independently of capture scheduling; revision fences discard stale refresh results.

The user subsequently authorized [supported CLI headless processing](engine-aliasmode-headless.md), replacing the initial configured-mode compromise. The packaged helper controls launch mode; Local API remains responsible for CDP discovery and stop. Processing must confirm headless mode, and manual sign-in/review must confirm visible mode. No headless flags are passed through Local API launch_args, and wrong/unknown mode blocks work.

The rendered LinkedIn feed confirms the expected member. Verification leaves processing paused. An existing hold clears only through the explicitly requested manual review path after a matching feed identity is confirmed; opening the browser, changing settings or restarting does not clear it. Start separately authorizes a verified eligible account. Targeted Voyager GETs and CSRF handling remain inside the signed-in browser tab; no Node LinkedIn requests were added. Qualification rules remain unchanged.

Eligible started accounts retain simultaneous lanes, with sequential captures within each. PostgreSQL retains unique-profile reservations, the editable 300/day default, and the 60-second interval. Shared research tasks (2), HTTP slots (3), saves (6), browser ceiling (10, optionally lower) and account-local recycling remain bounded. Public rendering uses separate short-lived plain Puppeteer Chrome.

## State and controls

Additive `aliasmode_profile_id` and `aliasmode_profile_name` columns bind core accounts. `compel_aliasmode_config` and `compel_aliasmode_sessions` store sanitized metadata, revisions, ownership, worker targets and browser PIDs. Existing identities, history, daily usage, review holds, checkpoints and AdsPower tables remain. Bindings are unique; changes require paused accounts and no live lease/open provider session. Address changes also require closed sessions. Owner fences protect provider stops and session writes.

The dashboard offers connection address, Refresh profiles, Link profile, expected member, daily limit, Verify session, Start batch, Pause and Close profile. It has no API-key or password field. Historical unbound accounts remain collapsed with their holds and cannot launch local Chrome. Vercel restrictions, local-admin checks and same-origin mutation checks remain.

CDP disconnect preserves manually opened browsers. Managed recycling and explicit Close use AliasMode stop and require confirmed inactive state. Start timeouts reconcile state before another attempt. Provider/CDP outages release the current job with its checkpoint, retain processing intent and show operational failure without consuming a lead retry or generating REVIEW. LinkedIn security signals still stop the account for human review. Agent shutdown detaches; Close profile explicitly stops a browser. AliasMode owns disk persistence and browser lifecycle; CompelOS never deletes its locks or profiles.

Memory accounting includes confirmed attached browser trees, the agent/public renderer and AliasMode application processes, deduplicated by PID. Missing browser roots are reported. Sampled RAM/CPU can miss short peaks; Node RSS is never substituted for browser memory.

## Setup

1. Open AliasMode with Local API on loopback. Profiles must use Chromium with a CDP endpoint; Firefox cannot attach.
2. Start the local agent. Refresh profiles under Engine → LinkedIn profiles → Manage.
3. Link the immutable profile ID and expected member. Verify session and complete manual sign-in. Processing remains paused.
4. Resolve any review hold explicitly, allow processing if globally paused, then Start batch on each intended account. Both eligible started accounts can run together.
5. Pause stops further captures; Close profile also stops its browser while retaining sign-in. Restart resumes authorized work from PostgreSQL checkpoints. [Windows startup](windows-agent.md) still applies; AliasMode must also be running.

User-confirmed mapping: LinkedinA (`k1iew9id`) → Moustafa Eiraq; LinkedinB (`k1ierfk4`) → John Dilah. These are different members from historical saved accounts and require new paused records, not replacement identities.

## Verification

Phase 1 preserved 50 decided CRM records under ignored `data/engine-v2/aliasmode-migration/`. Fixed-clock replay produced zero decision, qualification-flag or blocker changes. Provider tests cover V1 routes, no keys/launch flags, loopback guards, lifecycle ambiguity, ownership, cleanup, explicit close and operational failures. Real local CDP fixtures cover persistent sessions, account isolation, browser PID and browser-context Voyager reads. These fixtures do not establish live LinkedIn compatibility or protection from restrictions. Final integration results are recorded below after verification.

Primary references: [Local API](https://aliasmode.com/docs/local-api/), [launcher source](https://github.com/aliasmode/aliasmode/blob/main/launcher.ts), [route implementation](https://github.com/aliasmode/aliasmode/blob/main/server.ts). Contracts were checked against official source and local status/list responses, rather than assumed from AdsPower compatibility.

### Completed integration checks

- 385 engine/prospect/coach tests passed. After final lifecycle hardening, 30 affected lifecycle/CDP tests passed, including close-task retirement, simultaneous restriction/disconnect handling and nonblocking provider refresh.
- All 14 CRM tests passed with `CRM_TEST_POSTGRES=1` against temporary PostgreSQL fixtures; none skipped. TypeScript and lint for affected dashboard/routes passed.
- Full lint retains five errors and seven warnings in unrelated UI files: WorkspaceCommandMenu, OnboardingWorkspace, EvidenceRecoveryDialog, OnboardingDialog, CrmDatabase, Dashboard, FinderEngine and CoachProspectingWorkspace. They were not changed by this migration.
- Production build passed, with the existing broad dynamic-path tracing warnings. All 45 emitted route manifests contain zero private runtime entries.
- Both real imported profiles accepted the installed Puppeteer's CDP connection on Chrome 155.0.8059.85, with distinct browser PIDs. This used only new `about:blank` worker tabs, then closed those tabs and detached. Existing windows/tabs remained open. No cookies, LinkedIn feed or member APIs were read during this check.
- New bindings are saved as separate paused, unverified accounts. Desktop and 390-pixel dashboard views were inspected; the mobile document width is 390 pixels with no horizontal overflow. No API-key input remains.
- Fixed-clock phase 1 and phase 2 replays of the 50-record snapshot show zero changed decisions, flags, blockers or replay errors. No qualification rule changed. Final replay and control-state comparison are kept in the ignored migration directory.

Live AliasMode start/stop was not exercised against externally opened human profiles. Start/stop, recycle, outage and isolation behavior was exercised with real local CDP fixture browsers and provider contracts. The agent remains offline and all accounts remain paused. The next manual steps are Start agent, Verify session for each mapped member, then Start batch when intended. A live 30-lead qualification/performance batch was not run; no throughput, RAM improvement or restriction-prevention claim follows from these checks.
