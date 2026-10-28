# AliasMode headless processing — 27 October 2026

Current session policy: see [engine-stealth.md](engine-stealth.md). The latest user request changes the default to visible processing and adds per-account prerequisites, rendered warmup, ramp and recovery. Headless-only/fixed-interval descriptions below are historical.

The user authorized supported headless processing after the initial Local API/CDP migration. AliasMode's packaged CLI supplies the missing launch-mode control; the Local API still supplies CDP discovery and confirmed stop. Puppeteer, browser-context Voyager reads, PostgreSQL guarantees and qualification policy remain.

## Supported helper

`src/lib/aliasmode-cli.cjs` invokes the installed `aliasmode-mcp.exe` with argument arrays and `shell:false`, using a hidden helper-process window. Default Windows path: `%LOCALAPPDATA%\AliasMode\aliasmode-mcp.exe`. An optional `ALIASMODE_HELPER_PATH` must name an absolute helper executable. Nothing is installed or updated automatically. Only necessary operating-system environment variables are passed; database/auth configuration is not forwarded.

Processing uses `browser open --profile <id> --headless --json`. The official helper detaches its launch ownership before exiting, leaving the profile running for Puppeteer. Manual launch omits `--headless`, then requires an actual `headless:false` result; omission uses AliasMode's runtime default and cannot force a globally headless runtime visible. An unexpected mode fails visibly, without processing fallback. No `launch_args` flags are sent to the Local API.

Helper execution is bounded to one short-lived process, with ten admitted operations, no pacing sleep, a 120-second launch deadline, 20-second status/version deadline and 256 KiB output cap. Version success is cached for the agent lifetime. The helper runs for browser lifecycle operations, never per lead. Vendor output/endpoints are not logged or returned to the dashboard. Missing executable, timeout, mode conflict and unverified launch are separate provider errors.

`aliasmode-client.cjs` correlates CLI mode/port with an unchanged Local API WebSocket before attachment. A successful new-launch receipt carries only its numeric port for fenced cleanup; a timeout does not imply ownership. Existing raw active/stop calls remain available for lifecycle reconciliation.

The investigation confirmed installed helper beta.69 could open a disposable Chromium 155 profile headlessly, leave it alive after CLI exit, and accept the installed Puppeteer's CDP connection for a local page. Only that owned disposable profile was closed/deleted; real LinkedIn profiles were untouched. This does not establish LinkedIn compatibility or restriction prevention.

Phase 1 replay: 50 preserved decided CRM records, zero decision/qualification/blocker changes and zero replay errors. Private snapshots/reports remain under ignored `data/engine-v2/aliasmode-headless/`.

## Worker and dashboard flow

`aliasmode-browser.cjs` requires a confirmed mode before attaching or reading LinkedIn. Start defaults to headless; Verify session requests visible mode. Runtime drains ordered saves before changing modes, then closes its owned worker tab and asks AliasMode to stop the profile. A confirmed inactive state must precede reopening the same profile. The same persistent default context is used throughout; there is no cookie transfer or password entry.

An externally opened wrong-mode browser is left intact and shows MODE_CONFLICT with an instruction to Close profile explicitly. After an agent restart, a saved managed flag alone is insufficient for automatic mode switching: the live PID and recorded worker target must match. Missing mode evidence blocks work. Wrong-mode newly launched profiles are cleaned up only against the confirmed launch port; ambiguous timeouts are reconciled without assuming ownership. Existing security holds, owner-fenced leases and checkpoints remain authoritative.

The dashboard shows actual Headless / Visible session / Mode unconfirmed while attached. Provider status includes the helper version and actionable helper failures. No new mode toggle is exposed: headless is required for processing and visible is required for manual connection. Accounts retain separate concurrent sequential lanes, daily allowances and one-minute intervals. Website research, saves and browser process-tree measurement keep their existing bounds; helper processes descend from the agent and are included when present at sampling time.

Phase 2: 31 affected browser/runtime fixture tests passed, plus 20 mode/provider checks. Fixed-clock replay again shows zero changes across all 50 preserved records. Real fixture browsers verify headless → visible → headless transitions with a synthetic cookie in the same profile, and account isolation during recycling. Full verification and installed-AliasMode checks follow separately; no live LinkedIn requests are part of these tests.

## Completed verification

- All 400 engine/prospect/coach tests passed. All 14 CRM tests passed with PostgreSQL enabled, without skips. TypeScript, affected component lint and production build passed. Full lint retains the same five unrelated UI errors and seven warnings documented in the AliasMode migration report.
- The production adapter was exercised against installed AliasMode beta.69 / Chromium 155.0.8059.85, using a newly created disposable profile and an isolated PostgreSQL schema. Headless → visible → headless all reported the requested mode, used distinct browser PIDs and preserved a synthetic cookie in that same profile. Only local test pages were read. The disposable browser/profile and isolated test schema were cleaned up; no real LinkedIn profile, session cookie or feed was read.
- The three observed open/switch operations took 10.9, 20.4 and 23.7 seconds in this integration check. They include provider stop/relaunch and mode checks, were run while other checks were active, and are not throughput measurements or per-lead timings.
- Local API/provider metadata confirms the supported helper is available. Every phase replays the fresh 50-record snapshot with zero decision, qualification-flag or blocker changes and zero replay errors. All four saved accounts retain their prior identity, enabled state, limit, processing intent and review reason. Processing remains paused on all accounts; the existing hold remains intact.
- Deployment tracing reports 45 route manifests and zero private runtime entries; a separate manifest-only scan found zero installed AliasMode application/profile paths. Windows helper discovery does not package the executable or its session files for Vercel.

The agent remains offline. In Engine, Start agent, Verify session for each intended member, then Start batch. Verify session is visible and does not authorize processing. Start requests headless mode and resumes from PostgreSQL checkpoints. If a manually opened wrong-mode browser has no verified CompelOS ownership, Close profile explicitly before switching; never delete browser locks. No live 30-lead batch was run and no LinkedIn restriction-prevention or performance-gain claim is made.

Primary sources: [official helper commands](https://github.com/aliasmode/aliasmode#agent-browser-automation), [helper implementation](https://github.com/aliasmode/aliasmode/blob/main/agent/aliasmode-mcp.ts), [MCP lifecycle](https://github.com/aliasmode/aliasmode/blob/main/agent/mcp-host.mjs).
