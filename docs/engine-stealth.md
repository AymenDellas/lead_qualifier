# Account session controls and diagnostic evidence

## Evidence before implementation — 27 October 2026

The requested browser/session changes follow an explicit user instruction. They do not establish the cause of LinkedIn restrictions. The active AliasMode adapter uses plain `puppeteer.connect`, not a newly injected Puppeteer-extra/stealth layer. A failed read after two profiles does not isolate volume, account history, session state, endpoint compatibility or network causes.

AliasMode currently numbers LinkedinB / John Dilah as profile #1. Its existing account review hold and paused intent were preserved. Opening that persistent profile could restore LinkedIn tabs before CDP attaches, so diagnostics used a newly created blank AliasMode Chromium profile instead. This tests the engine and exact supported headless CLI/CDP path, not the held account's saved identity. No LinkedIn navigation, login, cookie export or credential transfer was used.

Observed headless values: `navigator.webdriver=false`, a Chrome/155 Windows UA without HeadlessChrome, `window.chrome` present, and five plugins. BrowserScan displayed 100% fingerprint authenticity. Incolumitas reported OK for its displayed Puppeteer, webdriver, plugin and worker-consistency tests. Its behavioural result was not complete at capture. CreepJS displayed 0% headless and 19% like-headless. DeviceAndBrowserInfo and Fingerprint's supplied root URLs were landing pages, not completed detector verdicts. The final Antoine Vastel URL returned HTTP 502. CDP and TLS/JA3/JA4 verdicts remain unknown. No all-green result or LinkedIn restriction-prevention claim follows from these observations.

The temporary diagnostic profile was closed and deleted through the supported CLI. The Cloud-backed installation does not expose the legacy V1 delete route. Full page evidence and the fresh 50-record decided-lead snapshot are private under ignored `data/engine-v2/session-hardening/`. Replay uses the frozen snapshot clock and never visits LinkedIn.

## Ordered implementation

1. Network and policy state: `src/lib/account-session-policy.cjs`, `src/lib/account-session-store.cjs`, account controls and PostgreSQL additive fields. Credentials remain in AliasMode; no purchase or paid usage. Missing/unverified proxy binding blocks unattended work.
2. Engine/mode and identity: `aliasmode-client.cjs`, `aliasmode-cli.cjs`, `aliasmode-browser.cjs`, `account-runtime.cjs`. Visible processing is the requested default; actual mode must match. Profile identity changes invalidate diagnostic evidence and require human review.
3. Diagnostic gate: `stealth-self-test.cjs`, runnable diagnostics script and bounded PostgreSQL reports. Unavailable/incomplete tests are UNKNOWN, never PASS. Detector verdicts are observations, not evidence of LinkedIn acceptance.
4. Warmup/ramp/recovery: account policy, PostgreSQL daily reservations and agent/runtime. Rendered warmup visits consume the existing unique-profile cap and spacing; they never decide/dequeue a CRM lead. Explicit pauses and review holds win over timers. Recovery never automatically enables processing.
5. Session interactions: `session-humanizer.cjs`, runtime and Voyager reader. All actions stay cancellable and bounded. Identity/followers/location gates retain their dependency order; activity/contact reads cannot be shuffled ahead of those gates. No message, connection, follow, reaction or form submission is authorized.
6. Dashboard, documentation and validation: existing AliasMode account controls, focused fixtures, full engine/CRM checks, types, lint, build and private-tracing check. Replay all 50 records after each phase and report every delta.

## Current verification

Phase 0 preserves 50 decided CRM records, reasons, stored evidence and replay assessments. All actual accounts remain paused and both existing account holds remain in place. A detector-site pass is not a licence to clear a LinkedIn hold. Proxy configuration is authorized; purchase and paid usage are not.

Phase 1 adds additive account fields and unique proxy-reference/verified-egress indexes. Account configuration rejects credential payloads, requires closed/paused sessions and uses revision compare-and-swap. Evidence writes require the current unexpired owner lease and configuration revision. Policy changes preserve recovery deadlines and exact account holds while invalidating prior diagnostics. Eight new policy/database tests and two existing AliasMode store tests pass; all 50 frozen records replay with zero decision/evidence changes and zero errors. Runtime admission and dashboard controls follow in the next phase; merely saving policy is not permission to process.
