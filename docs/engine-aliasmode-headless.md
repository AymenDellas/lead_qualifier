# AliasMode headless processing — 27 October 2026

The user authorized supported headless processing after the initial Local API/CDP migration. AliasMode's packaged CLI supplies the missing launch-mode control; the Local API still supplies CDP discovery and confirmed stop. Puppeteer, browser-context Voyager reads, PostgreSQL guarantees and qualification policy remain.

## Supported helper

`src/lib/aliasmode-cli.cjs` invokes the installed `aliasmode-mcp.exe` with argument arrays and `shell:false`, using a hidden helper-process window. Default Windows path: `%LOCALAPPDATA%\AliasMode\aliasmode-mcp.exe`. An optional `ALIASMODE_HELPER_PATH` must name an absolute helper executable. Nothing is installed or updated automatically. Only necessary operating-system environment variables are passed; database/auth configuration is not forwarded.

Processing uses `browser open --profile <id> --headless --json`. The official helper detaches its launch ownership before exiting, leaving the profile running for Puppeteer. Manual launch omits `--headless`, then requires an actual `headless:false` result; omission uses AliasMode's runtime default and cannot force a globally headless runtime visible. An unexpected mode fails visibly, without processing fallback. No `launch_args` flags are sent to the Local API.

Helper execution is bounded to one short-lived process, with ten admitted operations, no pacing sleep, a 120-second launch deadline, 20-second status/version deadline and 256 KiB output cap. Version success is cached for the agent lifetime. The helper runs for browser lifecycle operations, never per lead. Vendor output/endpoints are not logged or returned to the dashboard. Missing executable, timeout, mode conflict and unverified launch are separate provider errors.

`aliasmode-client.cjs` correlates CLI mode/port with an unchanged Local API WebSocket before attachment. A successful new-launch receipt carries only its numeric port for fenced cleanup; a timeout does not imply ownership. Existing raw active/stop calls remain available for lifecycle reconciliation.

The investigation confirmed installed helper beta.69 could open a disposable Chromium 155 profile headlessly, leave it alive after CLI exit, and accept the installed Puppeteer's CDP connection for a local page. Only that owned disposable profile was closed/deleted; real LinkedIn profiles were untouched. This does not establish LinkedIn compatibility or restriction prevention.

Phase 1 replay: 50 preserved decided CRM records, zero decision/qualification/blocker changes and zero replay errors. Private snapshots/reports remain under ignored `data/engine-v2/aliasmode-headless/`.

Primary sources: [official helper commands](https://github.com/aliasmode/aliasmode#agent-browser-automation), [helper implementation](https://github.com/aliasmode/aliasmode/blob/main/agent/aliasmode-mcp.ts), [MCP lifecycle](https://github.com/aliasmode/aliasmode/blob/main/agent/mcp-host.mjs).
