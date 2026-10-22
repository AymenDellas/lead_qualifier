# LinkedIn account workers

Manage accounts in **Pipeline Engine → LinkedIn accounts → Manage accounts**.
Add an account name and LinkedIn email; no password is collected. **Available to start** and the account capacity are settings, not authorization to run.

1. **Sign in on worker computer** opens that account's persistent browser. The human enters credentials and resolves any LinkedIn security checks. There is no automated password submission, including in background workers.
2. After reaching the feed, the worker reads the rendered self-profile card or opens the Me menu to confirm the member. It does not call a private identity endpoint. It saves the session locally and closes. The account is **Connected · Idle**. A failed identity read is not polled repeatedly. Duplicate or changed members cannot be confirmed under another account.
3. **Start processing · 1 hour** explicitly authorizes a bounded session. The API also supports 15–120 minute sessions. Startup validates the saved identity before claiming work. A supervisor restart leaves processing paused; browser failures and cycle limits need another explicit start. Background LinkedIn failures are not automatically retried.
4. **Pause processing** stops new reads and retains pending work. This action remains available even when the settings form has unsaved changes. Account warnings create a durable hold that settings edits and restarts cannot clear. Complete manual sign-in after resolving the underlying LinkedIn issue to clear a hold; then explicitly start processing.

Each account shows **Signed in as**, with the name and profile link returned
by LinkedIn for that browser session. This is independent of the saved login
email. Matching profiles are flagged across accounts. Offline sessions show
the last confirmed identity; an unavailable identity is never guessed from
the configured email or account name.

Each account has a stable local browser profile, and sign-in and processing both use visible Chrome. The worker no longer loads the stealth plugin or overrides the browser's automation flag. This does not guarantee that LinkedIn will accept an automated session.

New UI accounts default to 25 distinct profiles per UTC day, 100 page interactions per rolling 24 hours and 15 seconds between interactions (minimum 10 seconds). Existing profile budgets are retained. A shared cap permits at most 30 interactions per rolling hour. **Activity budgets & working hours** in Manage accounts adds separate hourly/24-hour limits for profile pages, contact panels, activity pages, discovery and account confirmation. All qualification and Prospecting work shares the same account ledger. Budget windows use database time, so worker-computer clock differences cannot bypass reservations. The today counters remain UTC-day reports. These are application budgets, not LinkedIn-approved allowances or a promise against restrictions. PostgreSQL serializes reservations across worker processes; pauses, reconnects and restarts cannot reset them.

Working hours are optional and use an explicit IANA time zone, selected weekdays and a start/end time. Overnight periods and daylight-saving changes are supported. A schedule never authorizes or starts processing; it only bounds an explicitly started session. A worker rests when an activity-specific budget or schedule is closed, remains cancellable and stops when its authorized session ends. Exhausting an account-wide budget pauses the account without creating a security hold. Pause before using the same LinkedIn account in another browser or tool.

The account panel also shows **LinkedIn checks today** and **saved profiles reused**.
Interactions count the worker's explicit page loads and content-opening controls, including failed attempts. Discovery scrolls that may load more results are also paced and counted.
Browser assets, automatic background requests and manual browsing are not counted.
Historical reads remain in the rolling ledger; new events identify rendered-page execution. Usage persists across restarts. The distinct-profile budget remains separate; an interaction is not the same as a profile.

## Page execution and recovery

`linkedin-browser-page.cjs` reads visible, rendered profile content and follows observed Contact info and activity links through browser controls. It does not replay private LinkedIn requests, inspect cookies or hidden application state, inject controls, change browser fingerprints or load a stealth plugin. Search pagination uses browser clicks and scrolling uses browser input. The normal LinkedIn frontend continues making its own requests. Background public-website research remains separate from the account's single LinkedIn page.

Profiles with lazy sections receive at most three additional, paced browser scrolls before the available About and activity content is read. Every scroll attempt counts against the profile-reading and overall interaction budgets. Generic unavailable-page headings do not establish a person's identity.

Profile facts, contact details and completed activity checks have separate durable capture checkpoints. A pause or account warning retains captured facts. On explicit resume the worker revalidates the profile and skips already captured contact details for the same account when less than 24 hours old. Partial captures cannot become complete cache hits or proceed straight to final qualification. Changed pages, mismatched identities and ambiguous activity remain errors or Unknown, rather than guessed facts. Premium and a generic Message button do not establish Open Profile permission; absent explicit evidence remains Unknown and can be reviewed manually.

The account's existing page is reused for saved-profile activity recovery. No private-API fallback or automatic browser restart is used when an interface changes. An account warning interrupts processing and requires manual review. Page readers are validated with intercepted browser fixtures, not real LinkedIn accounts. This is ordinary browser automation, not Linked Helper's proprietary browser and not an assurance of undetectability.

Later runs reuse identity-confirmed captures less than 24 hours old, using the
capture timestamp rather than the time website research finished. Old, undated
or mismatched captures are fetched again. Public profile facts can be reused
across accounts, but connection/Open Profile permission must be checked for the
selected account. Explicit retries still request a fresh capture when required.
Both qualification and Prospecting stop the affected account on LinkedIn
authentication, security or rate-limit responses, retain its queued work and
require manual sign-in/review to resume. A supervisor restart does not clear this pause.

The existing environment accounts are imported once, with account 0 retaining
its existing cookie directory and today's scrape count. Dashboard edits then
become authoritative. Legacy encrypted passwords remain stored for compatibility, but workers do not decrypt or submit them. Changing login identity requires adding an account; cookies are never reassigned. Removing and restoring an account preserves its profile and daily usage but leaves processing paused.

Run `npm run worker` on the worker computer. It starts the supervisor and watches explicit account requests every 10 seconds. The Next.js app and workers share `DATABASE_URL`; browser cookies stay on the worker. An interactive desktop or VNC is required for visible account windows. Starting the supervisor alone does not launch processing browsers. Legacy single-worker execution requires an explicit `--start`; managed accounts are preferred.

Repeated clicks reuse a pending sign-in request or open sign-in window. After a consumed request, a five-minute interval is required before another sign-in can be requested. At most three sign-in windows can be requested per rolling hour. Queued requests expire after ten minutes, so a late supervisor restart cannot open an old request. This is an application guard against repeated authentication attempts, not a platform allowance. Manual windows remain available for ten minutes.

Startup keeps a temporary blank tab open until the clean worker tab is ready,
so closing restored tabs cannot close the sign-in window. If LinkedIn times out
or interrupts its initial navigation, the window stays open for manual refresh
and sign-in within the existing ten-minute window.

Vercel hosts the authenticated controls and queue endpoints. PostgreSQL stores
pending jobs, results and per-account status. Workers claim jobs with row locks
and leases, preventing two accounts from claiming a profile at the same time.
Expired claims recover after 15 minutes. A session lease also prevents two
computers from using the same account simultaneously. In-flight work survives
settings changes, dashboard closures and worker restarts. Clearing the queue
cancels waiting jobs only.

Business fit is retained, but **Qualified requires an attributable, non-empty
email**. Missing, unsafe and guessed contacts stay Not qualified for another
research pass. Email presence does not create a VALID verification result;
the existing verifier and send-proof requirements remain separate.

Validation: `npm run test:workers` uses an isolated PostgreSQL schema and covers
concurrent claims, lease recovery, per-account limits, password encryption and
CRM persistence. It never scrapes LinkedIn or submits real test leads.

## Signing out an account

**Sign out LinkedIn** in Manage accounts disables that account, stops its browser after in-flight results save, and clears only its worker profile's LinkedIn session. The worker confirms that opening the feed redirects to login before reporting **Signed out**. Daily usage and the local profile remain. Reconnect manually, enable the account, and explicitly start processing to resume.

## Account activity history and recovery

**Account activity history** records sign-in requests, confirmed connections, processing starts, pauses and account warnings. It never stores passwords, cookies, or API keys. Raw read events support the rolling-hour budget and are omitted from the client-facing history. A stale worker's exit cannot revoke a newer processing authorization. If database persistence fails, the worker still stops browser activity and releases its lease when possible.

The safeguards follow the operational ideas documented by [Dux-Soup](https://support.dux-soup.com/article/90-warning-from-linkedin) (stop on warnings, avoid overlapping account activity, throttle) and [Expandi](https://help.expandi.io/en/articles/5405001-account-warm-up) (activity requires an active campaign, controlled limits). Their sending limits are not copied as profile-read limits. [LinkedIn explicitly prohibits unauthorized automation](https://www.linkedin.com/help/linkedin/answer/a1341543); these controls cannot make it restriction-free.

Validation includes isolated PostgreSQL tests for manual authentication, independent processing authorization, duplicate identities, warning persistence, concurrent read reservations, budget exhaustion, session expiry, stale exits, and queue preservation. Browser UI checks intercept all account APIs with labelled fixtures; they do not contact LinkedIn or start actual account workers.
