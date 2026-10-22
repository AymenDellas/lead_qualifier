# LinkedIn prospecting

Open **Case Study Hunter → Prospecting**. This replaces the old Scanner as the
default discovery entry point. The existing Today, Pipeline and CRM outreach
records remain available.

## Workflow

1. Choose an existing account from Pipeline Engine. The screen shows the actual
   worker identity, pause/readiness state and configured daily research budget.
2. Use Discovery setup: connections, followers, profile viewers, a people-search
   URL configured on LinkedIn, or pasted profile URLs. Select up to 100 new
   profiles for one run. Optional exclusion phrases are literal, not regexes.
   People Search follows LinkedIn's rendered Next control instead of repeatedly
   scrolling the first ten results. It stops at the requested number of new
   profiles, the end of results, an account check, or the search-page budget.
3. The same account worker discovers visible candidates, then reviews each
   profile and linked business website. A missing or unconventional headline
   does not stop About or website research. Email is not a qualification gate.
4. Review Ready to message, Connection requests, Verify messaging and Needs fit
   review. Each decision has source quotes, gaps, score and timestamp. Missing
   evidence is unknown, not negative evidence. Existing records can be selected
   for rechecking instead of duplicated.
   Combine the prospect-list filter with **Discovery source**: My connections,
   My followers, Profile viewers, LinkedIn People Search, or pasted/manual
   profiles. Existing search results recover their source from their saved run;
   rechecks retain that original source. CSV exports respect both filters.
   Click a prospect's name to open their LinkedIn profile in a separate tab.
5. Verify the route from the selected LinkedIn account. Save a message draft or
   a separate connection note (200 characters). Open LinkedIn, send manually,
   then record the appropriate event. Recording an invitation does not mark a
   message sent. Pending invitations are separated from new connection tasks.

There is no automatic invitation or message sending, no InMail spending, and
no account rotation to get around a limit. A browser session does not make
automation undetectable or remove LinkedIn's restrictions. Plan-specific source
access and messaging limits still apply.

## Evidence and account scope

The shared `coach-prospecting.cjs` rules inspect headline and About statements
plus attributable practice, offer, proof and funnel evidence from existing
website research. Exact job-title lists are no longer the admission gate.
Professional coaching is supported broadly; sports/agile-only roles, suppliers
to coaches and former/aspiring-only roles are not treated as established
practices. Ambiguous profiles stay reviewable. Operators can correct fit with
a reason; an in-flight worker cannot overwrite a newer operator decision.

Free contact routes require explicit evidence: a matching profile's first-degree
distance or Open Profile flag, or a dated manual verification note. Premium
membership and a generic Message button are insufficient. Missing, stale
(seven-day), future or other-account contact evidence goes to Verify. Fit
evidence older than 30 days goes back to review. Contacted and excluded people
remain out of new outreach lists, including suppression in the linked Lead CRM.

## Worker and persistence

The existing `worker.cjs` and account supervisor handle discovery and research;
there is no second browser profile, credential copy or local file queue.
`compel_prospect_runs` stores progress, ownership and leases. Profile jobs reuse
`compel_worker_jobs`, daily budgets and unique daily profile reservations.
Assigned jobs cannot be claimed by a different account. Recent captured
profiles are reused without a new LinkedIn scrape. Drafts, notes and outreach
history remain attached to the existing Case Study record.
Rechecks refresh the automated assessment without replacing an operator's
recorded fit decision; only another manual review changes that decision.

One discovery batch reserves one local budget unit and is bounded to 50 rendered
People Search pages, or 12 scroll passes for network lists. The search filters
are preserved by following the page's own Next control. A saved search cursor
lets an interrupted source pass resume without starting at page one. Uncached
profile jobs reserve the existing profile budget. This
budget does not represent LinkedIn's published or internal request limits.
Visible-list stalls, partial research and page-budget coverage are reported
explicitly; the UI never claims to have read every possible profile or route.

LinkedIn limits and account checks pause the affected account/run without an
automatic retry. Restarting the supervisor preserves that pause. Resolve the
check through **Engine → LinkedIn accounts → Sign in on worker computer**, then
resume the run. Stopping a run cancels only its pending work, retaining saved
profiles and leaving the original email research queue alone. Failed profiles
have an explicit retry control. Captured work can finish without new LinkedIn
access while a run is paused.

## Validation

`npm run test:prospecting` covers evidence recall, false positives, identity,
Open Profile semantics, account-specific routing, stale/manual edits,
invitation/message separation, auth, source URLs, CSV formula escaping and
restriction stops. Its database test uses an isolated schema, never real
accounts or prospects. Run the worker/account regressions and `test:auth`, then
TypeScript and the production build. Browser QA uses labelled disposable
records and never clicks a real LinkedIn send/connect action.

The final installed worker must report `prospectingVersion=COACH_EVIDENCE_V1`.
Both the worker sources and hosted dashboard need this update; an old worker
is reported as needing an update rather than appearing ready for discovery.
