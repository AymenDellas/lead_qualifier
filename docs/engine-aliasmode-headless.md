# AliasMode headless processing — 27 October 2026

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

Primary sources: [official helper commands](https://github.com/aliasmode/aliasmode#agent-browser-automation), [helper implementation](https://github.com/aliasmode/aliasmode/blob/main/agent/aliasmode-mcp.ts), [MCP lifecycle](https://github.com/aliasmode/aliasmode/blob/main/agent/mcp-host.mjs).
