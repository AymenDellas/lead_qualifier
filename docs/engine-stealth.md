# Account session controls and diagnostic evidence

## Detector correction audit — 28 October 2026

The previous runner required an invented common JSON result element that these sites do not share. It also visited the DeviceAndBrowserInfo and Fingerprint homepages. This was a runner limitation, not evidence that their tests failed. Before changing behaviour, 50 already-decided CRM records were frozen again with their stored decisions/reasons/evidence and deterministic replay assessments under ignored `data/engine-v2/detector-v3/`; the existing frozen set also replays unchanged.

Verified primary endpoints are [BrowserScan bot detection](https://www.browserscan.net/bot-detection), [DeviceAndBrowserInfo's bot test](https://deviceandbrowserinfo.com/are_you_a_bot), [Fingerprint Playground](https://demo.fingerprint.com/playground), and [Sannysoft](https://bot.sannysoft.com/) as the replacement for the failed Antoine Vastel URL. Incolumitas and CreepJS already use their actual test pages. [BrowserLeaks JSON](https://tls.browserleaks.com/json) exposes browser-routed JA3/JA4 evidence; its [TLS documentation](https://browserleaks.com/tls) describes fingerprints, not a universal automation verdict. The [published CDP serialization heuristic](https://deviceandbrowserinfo.com/learning_zone/articles/detecting-headless-chrome-puppeteer-2024) is an observable-side-effect test; it can flag open DevTools and a negative result does not mean no CDP connection exists. CompelOS's control connection remains CDP in all modes.

### Corrected runner: DIRECT_SIGNALS_V2

Each actual HTML test page gets seven direct in-page checks: webdriver, headless/bot UA markers, Chromium's chrome object, nonzero plugin count, readable WebGL vendor and renderer, and the Error.stack console-serialization CDP heuristic. Missing/throwing values are UNKNOWN; positive automation flags are FAIL. BrowserScan/CreepJS serve as direct-probe contexts. DeviceAndBrowserInfo's `#jsonResult`, Fingerprint's `[data-test-property-name="bot"]`, Sannysoft's completed result cells and Incolumitas's `#new-tests` provide separate site verdicts where available. No site is expected to provide another site's checks or the invented shared JSON element. Marketing/example text cannot establish a pass. Result waits observe DOM changes with a deadline, rather than sleeping.

The seven-entry battery ends with a navigation to BrowserLeaks JSON in the same browser/session/network. Reports store JA3 hash/text, JA3n, JA4 variants and the server-observed HTTP UA; unknown fields are not copied. TLS checks validate JA3 hash integrity, JA4 shape and equality of HTTP/browser UA. Their PASS means coherent evidence was captured, **not** a match to a reference Chrome JA3/JA4: no such trusted reference was supplied. JA3 extension ordering can vary. Raw hashes must not be treated as an automation classifier.

Overall FAIL wins if any direct check, TLS coherence check or completed site verdict fails. Overall PASS requires every direct check at every successfully reached actual test endpoint and the TLS checks to pass. A missing optional vendor UI report does not erase directly measured signals, and remains explicitly marked UNKNOWN inside `external`. A missing required signal, failed navigation, unexpected redirect or unreadable TLS response produces overall UNKNOWN unless another failure already determines FAIL. Reports state this scope and the known CDP control transport; PASS never means all vendor sites declared the browser human. Existing manual approval remains limited to exact current UNKNOWN reports and rejects confirmed nested signal/site failures. The identity-freeze origin/hash fields are unchanged, and the dashboard summary includes all seven entries, including TLS.

Focused pure/PostgreSQL/browser fixtures pass 17/17 before external measurements. The browser fixtures intercept every request and exercise visible/headless mode, real JS reads, real result selectors, synthetic TLS JSON, a positive CDP serializer control and cancellation. Both the original and freshly frozen 50-record sets replay with zero decision/evidence changes and zero errors. No qualification rule, browser library, proxy, account hold or processing intent was changed.

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

Phase 2 implements lane admission, configured visible/headless launch, fixed-origin fingerprint comparison, diagnostic commands/manual UNKNOWN approval, rendered warmup, ramp/spacing/stagger and recovery. The complete engine suite passes 420/420; an additional five-test PostgreSQL run verifies that explicit Start can follow completed diagnostics without another manual sign-in, while the next processing session still rechecks the member. The 50 frozen records replay with zero decision changes, zero evidence changes and zero errors. The PostgreSQL-enabled CRM suite passes 14/14. Failed diagnostic launches clear their pending command, retain an actionable error and require another explicit request instead of reopening repeatedly. Close and holds cancel pending diagnostics.

## Implemented controls

`account-session-policy.cjs` evaluates PROVISION → WARMUP → RAMP → PROCESSING, with HOLD and RECOVERY taking precedence over automated work. PostgreSQL owns each account's configuration, deadlines and observations. `account-session-guard.cjs` runs inside the existing account lane; it does not create another worker/browser. `account-runtime.cjs` releases a blocked claim without deciding or retrying the lead. Cached complete captures and the existing public research lane retain their separate path.

Processing defaults to **headful**, matching visible manual sign-in. A per-account headless option remains explicit; actual CLI mode and Local API CDP port must still agree. No browser library was migrated, stealth injection added, user agent overwritten, or cookie exported. The old Chrome/AdsPower implementations remain inactive commented references. AliasMode owns its profile, proxy credentials, cookies and cache; CompelOS never clears them.

New profiles can be provisioned with `node scripts/engine-provision-profile.cjs "Expected member name" aliasmode-chromium` (or `cloakbrowser`). The native create request explicitly sets `engine=chromium`, `chromium_runtime=aliasmode|cloakbrowser`, and a 1920×1080 screen. A safe creation receipt is printed before the PostgreSQL account import; failed imports never automatically create a replacement or delete the partial profile. Existing profile engine/proxy changes are made in AliasMode and then reflected in CompelOS's declared configuration. The V1 profile roster does not expose complete engine/proxy provenance; declaring an engine in CompelOS is not automatic proof of that vendor configuration.

Network preflight compares three browser-routed observations against the configured fixed exit IP, country and timezone, then checks the browser's own timezone. It rejects observed rotation or an explicit datacenter result. It uses keyless ipapi.is (currently 30 lookups per IP/UTC day), has no automatic retries or paid fallback, and reports an exhausted/unavailable lookup as an error. Anonymous responses do not independently prove a connection is a purchased residential proxy: confirm that product with your provider. Credentials must be configured in AliasMode, never pasted into CompelOS or this repository. PostgreSQL prevents duplicate proxy references and duplicate verified exit IPs.

After manual member verification, the first successful configured network preflight records the observed browser baseline. Every baseline and comparison uses the same secure BrowserScan origin: about:blank can omit secure-context fields, and different origins can expose different profile fingerprints. An unavailable consistent context stops the check rather than creating a false drift report. Explicit Capture/Approve identity also exists for reviewed changes. A later observed hash change creates a persistent hold. The hash covers observed UA, platform, screen, timezone, locale, cores, memory, WebGL vendor/renderer, and the declared profile/configuration identity. It does not prove that all possible browser signals are unchanged or that two profiles are unlinkable.

The detector runner reads only the configured six public sites with bounded requests and result waits. Landing pages, HTTP errors and unsupported/missing results remain **UNKNOWN**, never a synthetic pass. Current sites do not share a stable machine-readable verdict, so reports can contain UNKNOWN even when individual visible JS checks look normal. On the user's subsequent explicit instruction, an administrator may inspect the saved report and approve its unclear checks. This is recorded as **HUMAN_APPROVED**, preserving the original UNKNOWN result, report ID and approval time. A failed check, saved LinkedIn hold, identity drift, changed configuration, stale report or pending diagnostic prevents approval. Approval never starts processing or clears a hold. The dashboard offers a separate, explicit Start action after prerequisites are satisfied.

Rendered warmup visits reserve the same daily/spacing allowance as profile-data reads and release the CRM job unchanged. Visits are recorded by the PostgreSQL local day; no Voyager qualification or public research is performed during a warmup visit. Four distinct observed warmup days and elapsed days are required by default. The visit list stays bounded and prevents repeatedly visiting the same first queued lead that day. An empty queue cannot manufacture warmup progress.

After warmup the effective daily allowance ramps 15 → 30 → 60 → 100 at seven-day steps, never exceeding the account's editable ceiling. Profile starts reserve randomized 60–150-second spacing atomically in PostgreSQL; cached reads are free. Initial lane staggering is persisted with the explicit Start request, so wake notifications cannot erase it. Per-kind counters remain statistics. Session interactions are bounded pointer movement and scroll; they never click a social control, submit a form, message, connect, react or follow. Every tenth captured profile additionally receives a rendered visit after its profile slot is reserved. Identity/follower/location gates retain their required ordering; activity/contact reads are not shuffled ahead of them.

LinkedIn 401/403/429/999 and recognized account notices retain their stop behaviour. The profile-data-volume wording and plain “we restricted your account” wording are covered; notices are kept with the reason. Human verification leaves processing paused, invalidates the prior gate and starts a minimum seven-day recovery deadline. The ramp restarts at 15 after recovery; neither deadline expiry nor a configuration save starts the account. A configuration edit cannot shorten an existing recovery deadline.

## Configuration

**New environment variables: none.** Existing `ALIASMODE_HELPER_PATH`, `MAX_ACTIVE_BROWSERS`, process-tree memory/recycle settings and `DAILY_LIMIT_TIMEZONE` retain their purposes. No real environment file was read as a document, edited, staged or committed. New controls are per-account PostgreSQL values:

| Setting | Default |
| --- | --- |
| `engine` | `aliasmode-chromium` (declared vendor profile engine) |
| `launch_mode` | `headful` |
| Proxy binding / expected exit IP | Unconfigured; unattended work blocked |
| `warmupDays` | 4 |
| `warmupProfilesPerDay` | 10 |
| `rampStepDays` | 7 |
| `recoveryDays` | 7; cannot configure below 7 |
| `minIntervalSeconds` / `maxIntervalSeconds` | 60 / 150 |
| `staggerSeconds` | 120 maximum |
| `renderEvery` | 10 |
| Editable `daily_limit` ceiling | Existing value; new accounts default to 300 |

## Runbook

1. Keep AliasMode open. Use existing imported profiles, or explicitly provision a new blank profile with the script above. No account/profile is automatically replaced.
2. In AliasMode configure the intended Chromium engine and dedicated static residential proxy. Obtain its fixed exit IP, country and timezone from the provider. Buying proxies is outside CompelOS and has not been performed.
3. Pause and Close profile in CompelOS. In Engine → LinkedIn profiles → Session setup, save the corresponding reference, host/port, country, timezone, exit IP, engine and mode. Credentials stay in AliasMode. Settings do not enable processing or clear review holds.
4. Verify the expected LinkedIn member manually when you choose to reconnect. Run Check network, capture/review the browser baseline and Run detector checks. Read Saved session evidence. If results are unclear, explicitly review and approve that exact report; confirmed failures cannot be overridden.
5. Start warmup explicitly. Rendered visits leave qualification jobs queued. After sufficient observed days, the same authorized lane enters the bounded ramp. Pause remains effective at every stage.
6. On HOLD, review the exact reason and complete the appropriate human verification. Diagnose a fingerprint change before explicitly approving a replacement baseline. Rerun invalidated checks. After the recovery deadline, explicitly Start if you want to resume at the low allowance.
7. `node scripts/engine-stealth-check.cjs <account-id> preflight|approve-identity|diagnostics` submits the same PostgreSQL commands for the single agent; it never spawns a competing account browser. A held account rejects diagnostic requests.

## Verification limits

Offline browser fixtures intercept every request. They cover visible CDP operation, persistence of the requested mode, observed identity drift, safe pointer/scroll actions, warmup without Voyager/qualification, blocked admission, atomic ramp/spacing reservations, stale/expired owners, duplicate proxy bindings and explicit review of only a current unclear report. Frozen qualification evidence remains independent of these session controls. Live authenticated LinkedIn qualification and proxy-route validation remain unverified; no restriction-prevention or throughput improvement is claimed.

## Final validation and rollout

Phase 3 adds `src/components/AccountSessionControls.tsx`, integrates it into `src/components/AliasModeAccounts.tsx`, and exposes the report/approval operations through the existing local-admin/same-origin `src/app/api/aliasmode/route.ts`. The approval checkbox resets when the report ID or configuration revision changes. Desktop (1280 px) and mobile (390 px) layouts were inspected without saving account settings, requesting browser checks or enabling processing. Current setup/hold states keep Start disabled. The temporary viewport override was reset.

| Check | Result |
| --- | --- |
| Full engine/worker/prospect/coach suite | 420 passed; 0 failed/skipped |
| Additional PostgreSQL session/admission checks | 5 passed |
| CRM with `CRM_TEST_POSTGRES=1` (temporary fixture tables) | 14 passed; 0 failed/skipped |
| `npx tsc --noEmit` | Passed; production build's typecheck also passed |
| ESLint on changed production files | Passed |
| `npm run lint` across the workspace | 5 errors and 7 warnings in existing unrelated components |
| Production build | Passed on retry with the same Next 16.1.6 Turbopack builder |
| `node scripts/engine-verify-build.cjs` | 45 route manifests; 0 private runtime entries |
| Frozen evidence, phases 0/1/2/3 and final | 50 records; 0 decision changes, 0 evidence changes, 0 errors |
| Agent restart | AGENT_ACK, ALIASMODE_CDP, 0 open account browsers, 0 pending saves |
| Actual account state after restart | All 4 paused; both existing holds unchanged; no account evidence/settings changed |

The first production build failed resolving Fira Code's Google-font URLs (`next/font/google queries have exactly one entry`). A retry compiled successfully; no font source, package, bundler configuration or mock font response was changed. Existing broad dynamic-filesystem warnings remain in Finder/Create. Full lint's five errors are in `src/app/teleprompter/page.jsx`, `WorkspaceCommandMenu.tsx`, `business/OnboardingWorkspace.tsx`, `copy-studio/EvidenceRecoveryDialog.tsx` and `copy-studio/OnboardingDialog.tsx`; their unrelated work was left intact. Private logs, screenshots, diagnostic evidence and the restart comparison remain in ignored `data/engine-v2/session-hardening/`.

The old idle agent was stopped gracefully after confirming no enabled processing or pending manual/diagnostic commands, then restarted hidden using the current source. PostgreSQL and the official AliasMode roster confirm that the two original profiles remain closed. Proxy purchase/configuration and authenticated LinkedIn trials were not performed. No account was automatically approved, warmed up, qualified or resumed. No new environment variable or runtime library was introduced.

## Engine/mode comparison

New blank profiles were tested through the production CLI/CDP adapter and isolated PostgreSQL leases. No LinkedIn profile was signed in or visited. Both engines exposed webdriver=false, a normal Chrome user agent, window.chrome and five plugins in both modes. All four batteries remained UNKNOWN: root landing pages/missing machine-readable verdicts and Antoine Vastel HTTP 502 prevented a complete CDP/TLS result. This does not justify selecting CloakBrowser or identify a restriction cause. AliasMode Chromium remains the default; no existing profile engine was changed.

| Engine | Mode | Launch/attach seconds | Six-site battery seconds | Observed browser requests | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| AliasMode Chromium 155 | Visible | 14.61 | 14.60 | 166 | UNKNOWN |
| AliasMode Chromium 155 | Headless | 9.86 | 14.67 | 176 | UNKNOWN |
| CloakBrowser 146 | Visible | 66.36 | 14.56 | 155 | UNKNOWN |
| CloakBrowser 146 | Headless | 9.94 | 14.45 | 171 | UNKNOWN |

Each cell is one diagnostic run, not a throughput benchmark; first-launch startup and cache state were not controlled. Request counts include the sites' subresources. The temporary profiles are absent from the final official CLI roster, which contains only the two original imported profiles, both closed. Full evidence stays private under ignored data/engine-v2/session-hardening/browser-comparison.json.
