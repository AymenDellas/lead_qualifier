# Concurrent account processing

The user requested simultaneous account processing on 26 October 2026. Every eligible started account now runs its own capture lane with one headless Chrome for Testing browser, one reused tab and its original persistent profile. The default browser ceiling is 10, matching the application's account limit. Only actual account work/manual requests open browsers; a three-account installation does not open ten browsers. `MAX_ACTIVE_BROWSERS` remains an optional explicit lower ceiling. The account editor shows simultaneous processing, or the reported lower ceiling when configured.

The existing single Node agent schedules each account's task independently. A slow profile, account review or manual sign-in does not serialize the other accounts. Manual requests with spare capacity no longer recycle unrelated account browsers. Each account retains its own PostgreSQL lease, owner fence, unique-profile daily count and `next_profile_at`. All accounts can start together; the one-minute interval applies independently to each account. Shared canonical-profile job locks prevent two accounts from processing the same queued job.

Legacy `active_count` is treated consistently as a global allow/pause switch: zero pauses globally; a positive saved value enables all available accounts. Settings return/save the full enabled count while allowed, so a legacy value of 1 no longer hides other accounts in dashboard totals. Availability remains separate from authorization: settings saves, manual sign-in and an agent restart do not start paused accounts. Resume starts eligible accounts; a security hold, sign-out or explicit account pause still wins.

## Resource and recovery bounds

One agent and its five-connection pool remain. Across all account lanes, checkpoint/result saves share one serial queue with six admitted items. Account scopes keep their own errors, drains and recovery: an error in one scope is not cleared by another account, and closing one scope does not close the others. Each account can have one capture awaiting admission, so backpressure remains bounded by the account limit. Ordered saves and owner fences are retained.

The website lane still has two shared tasks, three shared HTTP requests, bounded cached HTML and one on-demand separate public browser. Those resources do not multiply per account. LinkedIn browser recycling remains per account: ten captured jobs, sampled whole-browser-tree RSS above 1,536 MiB, or idle closure. Cookies/profiles remain intact. A profile-interval wait keeps that account's browser alive. Account heartbeats renew concurrently before statistics-save admission, so one slow statistics flush does not postpone sibling leases.

Multiple real LinkedIn browsers will use more RAM than the previous one-browser default. No live LinkedIn RAM/throughput gain is claimed. The existing process-tree panel sums all account browsers and the public renderer; Node RSS alone is not used for browser recycling. Qualification, the 500-follower threshold, country gates, activity/email evidence and per-account 300/day defaults are unchanged. There are no new usage throttles, libraries, services, private endpoints or automatic sign-in actions.

## Verification

A fresh 50-record decided-lead snapshot was taken before changing behavior. Stored-evidence replay changes zero decisions and zero qualification evidence fields, with zero errors. Private snapshots/reports are under ignored `data/engine-v2/parallel-accounts/`.

Tests cover three account tasks entering capture before any finishes; paused/held account exclusion; independent interval reservations; three concurrent distinct PostgreSQL claims; active duplicate locks; legacy settings counts; spare-capacity manual requests; separate lease heartbeats; and shared save-queue bounds/error isolation. Actual PostgreSQL checks use isolated disposable schemas, without changing CRM data.

A real pinned-Chrome fixture launches three headless account browsers simultaneously, with one tab each and three separate persistent cookie jars. Recycling one leaves the other two open, and reopening preserves the first browser's cookie. All page requests are intercepted local fixtures, without visiting LinkedIn. An initial post-load sample was 1,130 MiB for the test process and its three Chrome trees; this is a small-fixture sample, not a LinkedIn peak-memory measurement. The full test run may record a different fixture sample.

All 347 engine/prospect/coach tests and all 14 CRM tests pass. TypeScript, lint, build, packaging and final runtime deployment results are recorded after their final checks. Existing manually paused processing intent is preserved during deployment.
