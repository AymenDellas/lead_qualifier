# Restored Voyager reader — 2026-10-26

The user explicitly requested the earlier Puppeteer-extra/stealth and Voyager approach after comparing it with rendered member-page reading. This authorizes those two mechanisms despite the original brief's contrary restrictions. It does not establish that either mechanism caused or prevents account restrictions. LinkedIn's reported restriction concerned unusually high profile-data access over time; one profile in a new run does not isolate its cause.

The screenshot's `77d8807` belongs to the client portal, not this engine. The actual pre-September-30 engine reference is `54be3c22c58ad90bc715a9ecf08c6a723b069011` (August 17); `844fc0f` (October 15) also used the earlier reader. This restoration changes the browser wrapper, targeted member-data reads and default job-count recycling. It keeps the current qualification rules and PostgreSQL architecture. The old password automation, folder queue, loose evidence parsing and qualification criteria are not restored.

## Browser and session

`account-browser-driver.cjs` creates an isolated Puppeteer-extra/stealth instance for each account owner. It uses the already-installed dependencies and the existing pinned Puppeteer/Chrome for Testing revision. The adapter preserves the original AbortSignal across the plugin wrapper's launch-option cloning, so closing a starting browser still cancels startup. The public website renderer continues to use plain Puppeteer.

Processing is headless. Connect/Open session opens the same saved profile visibly after the owned browser closes. Sign-in stays manual; no password is entered or stored by the worker. The account's rendered feed confirms the signed-in member. One feed tab is reused for that account's member-data reads; profiles, activity pages and contact panels are not navigated per lead. Existing saved profiles are retained in place.

Each eligible started account still has its own simultaneous, sequential browser lane. `MAX_ACTIVE_BROWSERS` defaults to 10, the app's account ceiling, and does not prelaunch unused browsers. Shared public research stays at two tasks/three HTTP slots; checkpoint/result saves stay bounded to six items. Automatic job-count recycling defaults to **50**, then continues with the saved session. The existing 1536 MiB per-browser process-tree guard, idle closure and 384 MiB Node heap remain. Fifty jobs is not a manual queue stop and memory pressure may recycle sooner.

## Targeted reads and decisions

`linkedin-voyager-reader.cjs` uses browser-side GET requests with the owner's existing session. The browser reads its CSRF token locally; that token is never returned to Node, copied to reports or exported. No credentials are logged. Redirects are not followed automatically. Each request has a 15-second deadline and a 2 MiB streamed response bound.

| Stage | Requested collection | Bound and behavior |
| --- | --- | --- |
| Profile | `identity/profiles/{slug}/profileView` | Confirm the requested public identifier, then read only its linked profile/follower/location objects |
| Profile alternate | `identity/dash/profiles`, `FullProfileWithEntities-101` | At most once when identity/followers are absent or the classic endpoint is unsupported; checkpoint before the alternate |
| Activity | `identity/profileUpdatesV2`, requested profile URN | Ten records, with matching author identity and reliable dates; no arbitrary metadata dates or unrelated actors |
| Contact | `identity/profiles/{slug}/profileContactInfo` | Read only this targeted contact response or its explicit referenced contact object; reject conflicting identities |
| Contact alternate | `identity/dash/profiles`, `ProfileContactInfo-14` | At most once for an unsupported classic contact endpoint |
| Featured | `identity/profiles/{slug}/featuredContent` | At most once, only if no email/website exists; accept declared link/article URLs, not arbitrary included objects |

A normal eligible fixture needs three reads: profile, activity, contact. Early follower/country decisions need one. Those are fixture counts, not a live request-volume benchmark. Source-list discovery and session identity controls still use their existing rendered helpers; this change concerns member qualification.

Main CRM decisions retain current rules: identity-matched UK/US/Canada residence, followers **strictly greater than 500**, recent matching-author activity within 30 days, and attributable email. Confirmed foreign residence rejects without downstream reads; missing location/followers/activity requires REVIEW. Connections stay separate. The response's raw follower value, parsed count and applied threshold are saved. Existing manual review, suppression/contact history, coach prospecting criteria and duplicate guarantees remain.

## Limits, checkpoints and failures

Existing per-account database limits remain editable; new-account default is 300 unique profiles per local day and the per-account profile-start interval remains 60 seconds. The atomic reservation precedes the first member-profile request, including a fallback-only retry. The same profile on the same day uses no additional daily slot. Cached captures, session checks and resuming only unfinished activity/contact data do not reread or recount a profile. There are no new hourly, rolling, per-kind or sleep-based limits.

Checkpoints identify `VOYAGER_V1`, requested canonical URL, account and original observation time. A partial capture is reusable for 24 hours only for that account/member/reader. Profile, activity and contact progress saves in order. A failed activity/contact request resumes its unfinished stage; it does not refresh the profile's timestamp. A completed capture passes to the existing public research lane without rereading LinkedIn. Existing rendered checkpoints are not mistaken for partial Voyager checkpoints; complete research captures remain reusable under the existing queue policy.

Network/5xx failures get the existing two bounded retries while retaining the browser and checkpoint. Exhaustion, malformed/oversized responses or unsupported identity/evidence become terminal REVIEW, retaining evidence. Unsupported classic endpoints allow only the declared alternate above. There is no automatic switch back to rendered member-page crawling.

HTTP 401/403/429/999, redirects to account checks, login/authwall/checkpoint/challenge, security/restriction messages and account identity mismatch stop the account. No endpoint fallback or automatic retry can bypass the review hold. Settings saves and agent restarts cannot clear it. Manual sign-in confirms identity and leaves processing paused until Start/Resume.

## Verification and operation

Private verification reports and the fresh 50-record decided-lead snapshot live under ignored `data/engine-v2/voyager-restore/`. Stored evidence is replayed at its original snapshot clock, without LinkedIn. Fixture browser tests intercept all page requests and exercise real Chrome for Testing, three account profiles, manual/headless switching, one-tab API capture, transport limits and checkpoint recovery. These tests do not verify current live endpoint availability or account safety.

Use `npm run worker` or the local dashboard's Start workers to run the agent. Start/Resume separately authorizes eligible account processing; existing holds remain. Vercel still cannot launch/control the worker. No schema/data deletion, credential change, account-limit reset or automatic legacy-lead requeue is part of this restoration.
