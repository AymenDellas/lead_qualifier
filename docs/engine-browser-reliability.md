# Browser reliability maintenance — 28 October 2026

## Scope and evidence

The user manually confirmed that John became restricted after the rendered-only warmup. The new 401 account hold and both consumed experiment segments remain in place. The earlier detector comparison found CDP-related flags in blank AliasMode Chromium profiles, but neither those flags nor a Puppeteer timeout establishes the cause of this account restriction.

This maintenance addresses page availability, hanging commands and diagnostic accuracy. It does not conceal CDP, modify browser fingerprints, inject stealth, bypass detector/restriction controls, change proxies or create replacement accounts. The installed Puppeteer and plain `puppeteer.connect` remain, including the existing 30-second protocol timeout. No authenticated LinkedIn validation or new warmup is authorized by this implementation request.

Before behavior changes, 50 already-decided CRM rows, their stored assessments/reasons/evidence and a frozen-clock replay were preserved in ignored `data/engine-v2/browser-reliability-20261028/regression-before.json`. Account controls/evidence were preserved separately. PostgreSQL remains the only runtime queue and state store.

## Confirmed code issues

1. `session-humanizer.cjs:interact` awaited `requestAnimationFrame` after a synchronous scroll. A callback that is never scheduled leaves its CDP evaluation pending. The local suspended-frame fixture reproduces this failure mode; it does not prove which evaluation caused the original live timeout.
2. `linkedin-browser-page.cjs:inspected` handled account security signals but did not explicitly classify generic LinkedIn 5xx/fallback pages. A path such as `/error_pages/500.html` can be an error page even if its actual response status is 200.
3. Warmup navigation discarded its `HTTPResponse` and did not require its final canonical URL to match the selected member. Availability failures/redirects could therefore be mistaken for completed visit actions.
4. The experiment observer retained security codes but omitted main-document redirect history and 5xx responses. Its terminal report also lost the specific account hold behind a generic control-change message. Runtime retirement could replace a useful outcome with generic offline text.

The live continuation's repeated browser launches corresponded to the existing memory guard; the sampler had observed a browser process tree above the 1,536 MiB threshold. The interval path already avoids idle recycling. The 8 GB RAM constraint does not justify disabling this guard, increasing its threshold or removing confirmed ownership checks. No browser-recycling or launch/session strategy is changed here.

## Implementation

- Scrolling completes synchronously; subsequent inspection reads the resulting DOM. No timer, retry, new delay or incidental interaction is added.
- `linkedin-page-health.cjs` treats explicit 5xx and LinkedIn 5xx fallback URLs as page-availability failures, separately from account security. Existing 401/403/429/999, checkpoint/challenge/authwall and security-warning classification takes precedence. Failed pages retain evidence for manual retry.
- The navigation response is preserved through `visit` and the runtime inspector. Both ordinary and experimental warmup verify the selected canonical destination before recording success, and inspect again after the existing pointer/scroll action.
- Experiment reports retain the last action, final page route, main-navigation status and a bounded redirect chain. Arrays retain at most 20 navigation responses, 20 server errors, 20 security responses and 10 failed-request records; each redirect chain retains at most eight routes. Paths are bounded, query strings/fragments and URL credentials are omitted, and no cookies, headers or response bodies are collected. Connection capability URLs are redacted from error messages.
- A newly persisted security hold remains the experiment's reason instead of being relabelled as an operator pause. The final offline snapshot retains the experiment outcome. Owner/configuration/lease fences, checkpoints, duplicate locks, daily reservations, spacing and processing intent are unchanged.

These diagnostic changes apply to future explicitly authorized work. Historical reports are preserved without fabricated response/redirect evidence. The consumed John manifests are not re-armed.

## Verification

Local unit fixtures cover suspended animation frames, preserved navigation responses, fallback pages, security precedence, warmup destination checks and preservation of the exact hold/outcome. Intercepted browser fixtures cover real 500 responses, redirects to 200-status error pages and wrong-member redirects; no such page counts as a completed visit. They also verify that query credentials are absent from reports and that qualification/research never runs during warmup.

The first added browser-fixture attempt used a headless browser with a headful declared account and was correctly rejected before navigation. The fixture declaration was corrected to match its actual mode; production mode/ownership checks were retained.

| Check | Result |
| --- | --- |
| Full engine/worker/prospect/coach suite | 445 passed; 0 failed/skipped |
| PostgreSQL-enabled CRM suite | 14 passed; 0 failed/skipped |
| TypeScript | Passed |
| Lint on changed files | Passed |
| Full workspace lint | Existing 5 errors / 7 warnings elsewhere |
| Original session, John experiment and fresh maintenance replay sets | 50 records each; 0 decision changes, 0 evidence changes, 0 errors |

The focused 15-test pure/runtime set was also rerun after adding the explicit rule that security notices take precedence on a 5xx page. The final browser cases ran against that rule. Neither tests nor replay opened authenticated LinkedIn sessions. No new production build was run for this worker maintenance; its changes introduce no dependency, asset or browser-launch configuration.

## Applied local runtime

The previous agent was stopped through its existing PostgreSQL stop command. Its OFFLINE release, dead PID and absence of pending account-start/login/diagnostic requests were verified before restarting. The new agent acknowledged startup at 16:42:40 UTC with **zero open account browsers and zero pending saves**. All four accounts remain paused; both existing holds and every saved account control/evidence field match the pre-maintenance snapshot. No account browser was opened or warmup re-armed. An already open review browser was not forcibly closed.

Final replay after restart remains unchanged in all three 50-record sets. PostgreSQL stores the verification receipt as `browser-reliability-20261028`, state `OFFLINE_VERIFIED`, kind `browser-reliability-maintenance`, with zero requested profiles/jobs. The private `verification-summary.json` contains the compact results and account comparison. No performance/restriction-prevention claim follows from these offline tests; browser CDP visibility and the prior detector flags remain unchanged.
