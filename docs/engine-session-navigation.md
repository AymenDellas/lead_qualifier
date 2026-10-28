# Rendered session navigation — 28 October 2026

The user requested feed entry/exit, native profile navigation, bounded dwell and observed navigation evidence. This implementation does not re-arm either consumed John experiment or clear his restriction hold. No authenticated LinkedIn validation was performed. The anonymous worker-target measurement is documented in [engine-worker-targets.md](engine-worker-targets.md).

## Behavior

`session-humanizer.cjs` opens `/feed/` with `waitUntil: 'load'`. The experimental runner retains its rendered member confirmation and fingerprint/owner checks before scrolling the feed and dwelling for a sampled 20–60 seconds. The existing humanizer supplies one or two feed scrolls.

Profile navigation in both the rendered reader and humanizer uses `linkedin-browser-page.cjs:navigateProfile`. It clicks an available visible, enabled, same-tab link to exactly the requested canonical member using ordinary pointer input. Otherwise it calls `page.evaluate(url => location.assign(url))`. Profile navigation never calls `page.goto`; headers are never injected. Navigation registers a `load` wait before input and verifies `document.readyState === 'complete'`. Existing profile identity and page-health checks still follow navigation. The Voyager paths are unchanged.

The experimental runner then observes native LinkedIn tracking request completion and document readiness until a 750 ms quiet window or an eight-second deadline. This uses request events and cancellable polling, not a fixed settling sleep. It records pending requests, observed request count, readiness, elapsed time and deadline/quiet outcome. Network quiet cannot prove server-side receipt or completion of future telemetry: `telemetryFlushConfirmed` remains false. Dwell is sampled at 30–90 seconds with two to four scrolls spread through that period. Ownership, pause and reactive security checks remain active throughout. Measured elapsed dwell is retained honestly, including scheduling/command overhead; it is never clamped to the sampled target.

Only this experimental runner passes a new interval into the existing PostgreSQL atomic reservation: a censored log-normal distribution with a 90-second median and sigma 0.65, a 60-second floor and a 400-second ceiling. The daily/unique-profile reservation, same-day accounting and duplicate lock are unchanged. Ordinary account policy settings and qualification scheduling keep their existing intervals. No additional hourly budgets, permits or cooldowns were introduced.

A persisted session plan samples a 20–40-minute target. Healthy completion returns to `/feed/` and records actual duration and whether it met that range. The existing 20-start ceiling and all account controls take priority, so reaching that ceiling early can truthfully record `targetMet: false`. The runner stops selecting profiles as the target approaches; waiting deadlines do not extend past it. A hold, pause, navigation failure or interrupted checkpoint stops without a final navigation. Final-feed security responses also stop with their exact hold. Historical segment reports remain unchanged.

## Evidence

Completed visits store navigation method, whether a new HTTP document navigation occurred, observed Referer and Sec-Fetch-Site, header source, sampled/actual dwell, scroll count, settle outcome and reserved interval. Navigation, settle and dwell evidence is also checkpointed before subsequent inspection so later failures retain completed observations.

Document headers come from Chromium's `Network.requestWillBeSentExtraInfo`, with the Puppeteer request headers as an explicitly labelled fallback. Only the two requested header values are retained. Referer query strings, credentials and fragments are omitted. No cookies, authorization headers or response bodies are saved. If a rendered link uses native SPA routing, there is no new HTTP navigation or load event; its header values are explicitly null. Interception-only fixtures may also lack Fetch Metadata, which stays null rather than being fabricated.

## Verification

`session-navigation-browser.test.cjs` uses a fresh, in-memory TLS certificate and a loopback HTTPS server. Chromium resolves the canonical fixture origin directly to that server; other hostnames are blocked. No URL or header rewriting is used. Both the server and production CDP observer independently verify present Referer and `Sec-Fetch-Site: same-origin` for rendered-link and `location.assign` document navigations. A separate SPA fixture verifies that no headers are invented. The fixture also checks feed-first/feed-last ordering, load completion, native tracking completion, dwell bounds and actual scroll commands.

Deterministic tests verify the distribution's median, logarithmic quantiles and long tail, lower/upper dwell bounds, cancellation, pending telemetry deadlines and quiet-window resets. PostgreSQL/runtime fixtures cover atomic slots, the target duration, preserved checkpoints, fresh 403/401 stops, wrong-member/error pages, final-feed security stops and the consumed manifest's re-arm rejection.

Before behavior edits, 50 decided CRM records were frozen with reasons, evidence and their fixed-clock replay under ignored `data/engine-v2/session-navigation-20261028/`. PostgreSQL stores the benchmark manifest `session-navigation-20261028-929fcb37-de84-4bdd-8199-0b2b72247f86`. Per-phase/final replay and account/CRM preservation results are stored with that manifest. No runtime state or evidence is committed from the private folder.
