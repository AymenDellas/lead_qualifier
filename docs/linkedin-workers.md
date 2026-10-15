# LinkedIn account workers

Manage accounts in **Pipeline Engine → LinkedIn accounts → Manage accounts**.
Add an account name, its LinkedIn email and password. Enable the accounts you
want available, then choose how many run at once. The first N enabled accounts
run, in list order; 0 pauses all accounts. Changes are picked up every 10 seconds.
An already claimed lead finishes saving before its browser stops.

Each account shows **Signed in as**, with the name and profile link returned
by LinkedIn for that browser session. This is independent of the saved login
email. Matching profiles are flagged across accounts. Offline sessions show
the last confirmed identity; an unavailable identity is never guessed from
the configured email or account name.

Each account has a stable browser profile and its own daily counter (1–400,
reset at midnight UTC). The configured limit is a budget, not a guarantee from
LinkedIn. Security challenges can still interrupt an account.

The existing environment accounts are imported once, with account 0 retaining
its existing cookie directory and today's scrape count. Dashboard edits then
become authoritative. Existing passwords are never returned to the frontend;
leaving an edit blank retains the saved encrypted password. Changing login
identity requires adding an account, so cookies are never reused by another
identity. Removing an account archives its settings without deleting leads or
its browser profile.

Run `npm run worker` on the worker computer or a persistent server. It starts
the supervisor, which runs one isolated worker process per selected account.
The Next.js application and workers use the same `DATABASE_URL`. AES-GCM
credential encryption derives its key from that secret connection string
(ignoring the port, so direct and transaction-pooled connections agree);
if the database credentials change, re-save the account passwords with the
new connection string on both hosts. An optional shared
`LINKEDIN_CREDENTIAL_KEY` can keep encryption independent of that rotation.

If an account needs a security check, click **Sign in on worker computer**.
This explicitly opens its own browser on the worker machine; complete the
check there. The browser closes after saving the session. Workers otherwise
run headlessly. A server needs an interactive display/VNC for those checks;
the existing Docker worker display supports this.

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

**Sign out LinkedIn** in Manage accounts disables that account, stops its browser after in-flight results save, and clears only its worker profile's LinkedIn session. The worker confirms that opening the feed redirects to login before reporting **Signed out**. Saved credentials and daily usage remain; the account cannot automatically sign back in until **Sign in on worker computer** is requested. Enable it and select the desired running account count to resume qualification.
