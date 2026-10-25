# Headless processing and account pacing

On 2026-10-25 the user explicitly replaced the original daily-only policy with
300 unique profiles per account per local day and a minimum 60 seconds between
profile starts. The existing daily limit remains editable in account settings.
The default for new accounts is 300, subject to an explicit
`DEFAULT_DAILY_SCRAPE_LIMIT` environment override. Real environment files are
unchanged. Existing non-archived accounts are set to 300 without resetting usage,
clearing holds, deleting jobs or requeueing leads.

Processing uses Puppeteer's pinned full Chrome for Testing in headless mode.
Connect/Open session and manual sign-out use a visible launch of that same binary
and persistent profile. The runtime closes the previous owned browser before
switching modes, suppresses stale callbacks from the closed page, and re-verifies
the saved member before capture. It never opens both modes against one profile.
Cookies, the profile directory and the manual sign-in requirement remain intact.
If the pinned browser is missing, startup reports CHROME_FOR_TESTING_MISSING with
the command to install it; it does not silently fall back to system Chrome.

There is no browser window or visible automation banner during headless work.
Visible Chrome for Testing can still display automation/testing infobars. Browser
automation flags, user-agent/WebDriver signals and security warnings are not
suppressed or spoofed. Changing window visibility is not evidence that account
restrictions have been prevented.

PostgreSQL `next_profile_at` records the next permitted profile start per account.
The same account-row lock protects both daily reservations and profile-start
reservations. Concurrent starts and agent restarts cannot bypass the interval.
Same-day retries are free against the unique-profile cap but obey the interval.
Full cached captures and website research can continue during the gap.

The dashboard shows Waiting for next profile and its resume time. The agent uses
an interruptible scheduling deadline; Pause and manual-review commands remain
responsive. It does not hold the next lead's claim or sleep inside an active
profile during the gap. A pending interval keeps Chrome alive past its shorter
idle-close threshold, avoiding an identity check and browser relaunch every
minute. Resource recycling and reactive stops remain enabled. A held headless
browser closes after its current task drains; Open session requests visible
manual review, and only matching manual confirmation can clear a hold.

At one start per minute, the nominal ceiling is 60 fresh profile starts/hour;
300 starts require roughly five hours, with extra time for slow pages/recovery.
The earlier unpaced 30-lead benchmark is historical, not a current throughput or
account-safety claim. No live LinkedIn benchmark is run against a restricted
account to validate this change. Validation uses local rendered fixtures, an
isolated PostgreSQL schema, cookie persistence across actual browser launches,
and the existing frozen 50-lead qualification replay.

Validation: 301 engine/prospect/coach tests pass with zero skips. After removing the now-unused preclaim path, all 18 affected runtime/scheduler tests pass again. TypeScript and lint of changed files pass. The 50-record stored-evidence replay matches the preceding v2 decisions exactly (zero new changes, zero errors). Local account API smoke confirms the agent online, all three non-archived limits at 300, all three review holds retained, and processing paused. No live LinkedIn profile was opened for validation.
