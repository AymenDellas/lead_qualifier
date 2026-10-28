# CLAUDE.md

Current qualification-engine policy is in AGENTS.md and docs/engine-stealth.md. Legacy filesystem-queue/local-Chrome/password descriptions below are historical and do not override those instructions.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Compel" — a Next.js dashboard + a separate persistent Puppeteer worker process for finding, qualifying, and emailing coaches found via LinkedIn. (The product was previously called "Revlane Signal Engine"; the name survives only in historical notes below where it was part of an actual config value.) Two runtimes share one codebase and one Postgres database:

1. **Next.js app** (`src/`) — dashboard UI, server actions, and API routes. Runs `next dev`/`next start`.
2. **`worker.cjs`** (repo root, plain CommonJS, not part of the Next.js build) — a long-running Puppeteer/puppeteer-extra process that logs into LinkedIn and processes jobs one at a time. It is started separately (`node worker.cjs`) and is the *only* process that drives the browser.

The two communicate via a filesystem job queue, not HTTP calls to each other.

## Commands

```bash
npm run dev      # next dev -p 3000
npm run build    # next build (standalone output)
npm run start    # next start -p 3000
npm run lint     # next lint
npm run worker             # node worker.cjs — start the LinkedIn worker; pending jobs resume
npm run worker -- --login   # explicitly allow a visible browser if LinkedIn requires manual sign-in
node worker.cjs --resume   # start the worker, resuming leftover queued jobs
npm run backup             # snapshot the leads table to backups/leads-<timestamp>.json (prunes >30d)
npm run check-env          # report drift between .env.local and .env.docker (key names only, never values)
curl -X POST http://localhost:3000/api/admin/smtp-doctor -H 'Content-Type: application/json' -d '{"domain":"yourdomain.com","knownGood":"contact"}'  # why verification is/isn't working: HELO/PTR identity + a live SMTP dialogue
curl -X POST http://localhost:3000/api/admin/migrate   # apply schema changes to the live DB (idempotent)
curl -X POST http://localhost:3000/api/admin/revoke-catchall-proof  # demote VALID rows that were only ever accepted by a catch-all domain
curl -X POST http://localhost:3000/api/admin/reverify -H 'Content-Type: application/json' -d '{"target":"unknown","limit":100}'  # retry leads the probe never got a verdict on (default target: unproven-valid)
curl 'http://localhost:3000/api/crm/leads/qualified?include=risky,unverifiable'  # send list widened; every row carries send_tier
curl -X POST http://localhost:3000/api/admin/gmail-sync # reconcile the contacted flag against Gmail Sent Mail
curl -X POST http://localhost:3000/api/admin/import-campaigns -H 'Content-Type: application/json' -d '{"dir":"C:/Users/you/Downloads"}'  # import automailer/Instantly campaign reports
node -r ts-node/register src/lib/migrate.ts   # one-off: migrate legacy data/leads_db.json into Postgres (see src/lib/migrate.ts)
```

There is no test suite/test runner configured in `package.json`. The many `test-*.cjs`, `debug-*.cjs`, `check*.js`, `patch_*.js`, `fix_*.js` files at the repo root are throwaway scripts from past debugging/data-recovery sessions, not a test suite or reusable tooling — don't treat them as project conventions, and don't add new ones to the root; put ad hoc scripts in a scratch location instead of the repo root if you need to create one during work.

## Local setup

- Copy `.env.example` → `.env.local` for the Next.js app. Copy `.env.docker.example` → `.env.docker` for Docker. Required vars differ per surface — see those files. Key ones: `DATABASE_URL` (Postgres), `LINKEDIN_ACCOUNTS` (JSON array of `{email,password}` used by `worker.cjs` for browser login), `LINKEDIN_LI_AT` (session cookie), `GROQ_API_KEY*` (hook generation), `SERPER_API_KEY_1..8` (Google dork search, round-robined), `GOOGLE_SHEETS_CREDENTIALS_BASE64`/`GOOGLE_SHEETS_SPREADSHEET_ID` (export), `EMAIL_VERIFY_HELO`/`EMAIL_VERIFY_MAIL_FROM` (self-hosted SMTP verification identity).
- `worker.cjs` reads `.env.local` itself via a hand-rolled parser (`loadEnv()`), independent of Next.js's env loading — it must exist even outside Docker.
- **The two env files drift, and the symptoms appear far from the cause.** `next dev`/`next start` read `.env.local`; Compose hands the containers only `.env.docker`. Nothing keeps them in sync, so a key added to one is simply absent in the other. This has bitten twice: `GMAIL_ACCOUNTS` set only in `.env.local` made Sync Gmail report "no accounts configured" from inside the container, and `EMAIL_VERIFY_HELO` set only locally left the container announcing `verify.revlane.io` — a domain the deployment doesn't own — so recipient servers refused every probe on policy grounds, which looks exactly like "the address is dead". Run `npm run check-env` after touching either file; add new keys to **both**.
- Database is Postgres (`src/lib/pg_setup.ts`, single `leads` table, schema created idempotently via `createSchema()`). SSL is forced with `rejectUnauthorized: false` for Supabase/Neon-style hosted Postgres.
- Docker (`Dockerfile`, `docker-compose.yml`) builds one image used by two services: `qualifier` (runs `node server.js`, the Next.js standalone server) and `qualifier-worker` (overrides the command to run `worker.cjs` inside an Xvfb + fluxbox + x11vnc virtual display, exposed on 5900 for VNC debugging of the headful browser). Both containers share the same named volumes for `queue/`, `queue-results/`, `progress/`, `.browser-profiles/`, and `data/` — this is how the filesystem queue crosses container boundaries.

## Architecture

### The filesystem job queue (Next.js ↔ worker.cjs)

The Next.js app never touches Puppeteer directly for LinkedIn profile scraping; it hands off work to `worker.cjs` through plain JSON files:

- `queue/*.json` — pending jobs, written atomically (`.tmp` then `fs.renameSync`) by `POST /api/queue-batch` (`{ jobId, linkedinUrl, nativePostProcess, targetRegion, createdAt }`). `worker.cjs` polls this directory every `POLL_INTERVAL_MS`, scrapes one profile at a time (one browser, one tab, never spawns new Chrome instances), and deletes the job file when done.

  `prospect-research.cjs` now extracts contacts only from the matching profile or an identified personal practice. Shared-platform and vendor addresses are excluded, guessed domains are not ownership proof, and SMTP acceptance cannot resolve an ownership question. `prioritizeEmails()` only sorts attributable candidates; persistence prefers published contacts over guesses.

  Each job runs in **two stages**. `scrapeProfile()` reads the matching LinkedIn profile and records activity without using inactivity as a rejection gate. `enrichAndFinalize()` performs bounded public business research through `prospect-research.cjs` and applies `prospect-qualification.cjs`; native persistence uses `/api/prospects/research-result`. No opening lines are generated in this path. Stage two needs no LinkedIn session, so up to `ENRICH_CONCURRENCY` jobs run while the loop claims the next profile. In-flight filenames are excluded from selection and stay queued until a durable result is written, so restart and deduplication work through enrichment. Pending enrichments must settle before browser recycling.
- `queue-results/*.json` — one file per completed job (`{jobId}.json`), read by `GET /api/process-lead?jobId=...` for polling. Also holds `worker-status.json`, a heartbeat the worker rewrites continuously so the API can report worker liveness/staleness (>120s since update = stale).
- `progress/` — crash-recovery snapshots written by `scraper-actions.ts` for the (separate, older) bulk Puppeteer scraping flow driven by `puppeteer-actions.ts` (`scrape-results/`, spawned as a detached child process with its own PID file, distinct from `worker.cjs`).

When touching either side of this contract, keep the JSON shape in sync — there's no schema validation between producer and consumer, just matching field names read on both ends.

### Lead pipeline / CRM

All leads live in one Postgres `leads` table (`src/lib/db.ts` + `src/lib/pg_setup.ts`). `pipeline_status` values are `INBOX` → `QUALIFIED`, or `NOT_QUALIFIED`.

**Business qualification and email status are independent axes.** The workflow is Finder → Engine → qualified Leads CRM tabs → verified export. There is no separate Prospects UI or manual investigation requirement. Research recalculates `QUALIFIED` or `NOT_QUALIFIED` through `prospect-store.ts`; profile identity, independent ownership, a coaching offer and target-market evidence establish fit. Client proof, marketing activity and funnel opportunities affect priority. Verification writes only the `email_*` columns; `updateLeadEmailVerification` must never move `pipeline_status`. Legacy QUALIFIED records retain the existing verified-email export path. Matching contact ownership is also required for new assessed records. See `docs/prospect-qualification.md`. Economics/capacity need human confirmation before delivery; opening lines and sales outcomes do not influence qualification.

`GET /api/crm/leads/qualified` requires current Contact now business evidence and attributable email ownership, plus the existing fresh scored direct SMTP proof and suppression/contact exclusions. It deduplicates by address and prefers stronger business evidence. CRM and Sheets send exports apply the same requirements; neither an old QUALIFIED label nor an optional email tier can bypass business qualification. Opening lines are not a requirement. Research exports remain labelled research data.

**Three export tiers, composing via `?include=` (comma-separated), and nothing is ever promoted between them.** Every returned row carries `send_tier`, so the level of proof survives into whatever consumes the export — an export that mixes proven and unproven addresses without saying which is which is how "verified" stopped meaning anything the first time.

- **`PROVEN`** (default) — direct SMTP accepted this address and refused a random one at the same domain.
- **`RISKY`** (`?include=risky`) — the server accepted mail but the address could not be shown to be unique: catch-all domains, free providers.
- **`UNVERIFIABLE`** (`?include=unverifiable`) — the probe learned *nothing*, overwhelmingly because the recipient server refused this sending host. On the current deployment that is 351 leads, and they were previously invisible everywhere. They are handed over labelled so a sending platform, which verifies from its own clean IPs, can filter them again — never merged into `PROVEN`, never included by default.

`isExportableUnverifiable` (`src/lib/send-tiers.ts`) is the predicate, and it lives in `lib` because the export exists twice: this route and the CRM's own client-side CSV button. It still excludes free providers (those validate recipients properly, so no answer means the probe was refused, not that a guessed address is plausible), junk addresses, and system addresses — each a judgement about the *address* rather than about whether the probe got through. Its parameter is described structurally rather than as `Pick<LeadRecord, …>`, because `LeadRecord` is declared twice — in `db.ts` and divergently inside `CrmDatabase.tsx` — and a `Pick` of the server type is rejected for the client copy over fields the function never reads.

Outcome columns (`contacted_at`, `replied_at`, `booked_at`, `outcome`, `hook_source`, `do_not_contact`) exist so reply/booking rates can be attributed to region, query, and hook style. `setLeadOutcome` also auto-suppresses on `NOT_INTERESTED`/`BOUNCED`. Schema changes are applied idempotently via `POST /api/admin/migrate`.

`src/app/api/crm/leads/[location]/route.ts` buckets leads into NA/UK/OTHER via large hardcoded keyword lists matching against the free-text `location` field (no structured geo data) — location resolution logic lives only there.

**OTHER is not an edge case — it is the bulk of the inbox.** For an unscraped lead, `location` holds the *search* location the dork used, not the person's, and a large legacy cohort has the literal string `'Unknown'` (7,760 of 8,037 INBOX rows when this was written) which resolves to OTHER. The dashboard offered only NA and UK buttons, so almost the entire backlog was unreachable from the UI. Three things must stay in sync or leads silently strand: the region button in `Dashboard.tsx`, the GET bucket in this route, and — critically — the **POST** branch, because the worker builds its push endpoint as `{targetRegion}_qualified` and the POST returns 400 for any type it doesn't recognise. A missing POST branch means the scrape succeeds, the lead qualifies, and the result is thrown away on push.

**`created_at` is typed `string` on `LeadRecord` but node-postgres hydrates it into a `Date`.** Any string method on it typechecks cleanly and throws at runtime — `.localeCompare` on it took out the whole region endpoint with a 500. The same applies to every `TIMESTAMP` column (`contacted_at`, `email_verified_at`, …). Compare them as epoch milliseconds via a helper that accepts `Date | string | null`; don't trust the declared type.

### `contacted` is a claim; `contacted_source` is the evidence

**Being flagged `contacted` does not mean a message was sent.** The flag is set when a lead is *pushed* to a sending platform, which is a different event: platforms routinely accept a contact and never send to it (daily caps, their own verification rejecting the address, a paused sequence, a step never reached). Conflating the two silently burns qualified leads — they sit in the CRM looking spent when nobody ever emailed them.

`contacted_source` records which evidence backs the flag:

- **`PLATFORM`** — a sending platform's own campaign report confirms the send. Authoritative, because the platform knows both who it sent to *and* who it merely held.
- **`GMAIL`** — the address was found in a connected mailbox's Sent folder. Direct proof of an actual send.
- **`MANUAL`** — a person ticked the box for this one lead. A deliberate claim, so it is trusted.
- **`NULL`** — set by a *bulk push*. Proves the lead was queued, nothing more.

**`isProvenContacted()` — not the raw `contacted` flag — is what excludes a lead from a send list, and what hides it from the pipeline tabs.** A lead flagged by a bulk push stays visible and stays sendable, because nothing shows a message was ever sent to it. This is deliberately non-destructive: the flag is preserved, and importing the matching campaign report upgrades or corrects it later. Blocking on the bare flag had buried 628 qualified, verified, deliverable leads.

`toggleContactedAction` stamps `MANUAL`; `bulkMarkContacted` (the push path) deliberately stamps nothing. Keep that asymmetry — it is the whole distinction.

Rules that keep this trustworthy:

- Provenance only ever strengthens. A `GMAIL` match must not overwrite `PLATFORM`, and un-marking a lead clears the source with it (a stale source on a cleared flag would be read as evidence by the next sync).
- Only the campaign import may clear a flag, and only where `contacted_source` is NULL. A platform's "not sent" is scoped to the campaigns in the reports you have — a lead skipped by one campaign may have been emailed by another, and a Gmail match proves it was.
- A partial mailbox scan must never produce a clear-list. Fewer messages read means fewer leads confirmed and *more* reported unconfirmed, so a transient IMAP error makes the destructive action look more attractive. `scanComplete` gates `safeIds` for exactly this reason.

### Junk addresses

`src/lib/junk-addresses.ts` (`classifyJunkAddress`) rejects addresses that can't be a lead's own mailbox: placeholders left in website markup (`johndoe@yourmail.com`), vendor and platform desks the crawler picked up off a lead's site (`support@jouwweb.nl`, `notifications@surecart.com`), registrar and privacy proxies, social-network domains, and fragments the crawler mangled together.

**Verification cannot catch these** — they're real, deliverable mailboxes, just not the lead's — so they pass SMTP and land on a send list looking perfect. It's deliberately conservative about role accounts: `hello@`/`info@`/`contact@` is usually the real monitored inbox for a solo operator and is *not* junk. Suppression, never deletion — the row keeps a LinkedIn URL worth re-scraping. Exposed as "Scan for Junk Addresses" in the CRM and `POST /api/admin/suppress-junk`.

### Campaign report import

`src/lib/campaign-report.ts` parses per-recipient campaign exports from automailer.io / Instantly; `src/app/actions/campaign-import-actions.ts` reconciles them against the CRM (also `POST /api/admin/import-campaigns` with `{dir}` or `{files}`).

The distinction the parser exists to preserve is **uploaded vs sent** — collapsing them is what inflated the contacted count in the first place. A lead is sent-to if any `Step N Sent` column says Yes or `Status` is `Contacted`. Reports overlap heavily (the same campaign re-exported as more of it ran), so `mergeCampaignReports` folds every signal with OR: once a platform says a message went out, a later export omitting the row can't take it back.

This import is the only place allowed to correct a flag downward, and it also writes real outcomes — `Bounced` → `BOUNCED` (which auto-suppresses), `Replied` → `REPLIED`. Bounces are applied before replies so a bounced-then-replied row ends up suppressed rather than queued for another send.

### Bounce reconcile

`src/lib/gmail-bounces.ts` reads delivery reports (NDRs) out of each mailbox's INBOX; `src/app/actions/bounce-actions.ts` applies them (`POST /api/admin/sync-bounces`, "Scan inbox for bounces"). This is the fallback when SMTP verification isn't available — the mail you actually sent is then the only reliable signal, and repeatedly mailing dead addresses is what wrecks a sending domain.

`classifyBounce()` carries the same distinction as the verifier's `classifyReject`, and it is the whole point of the feature: **a 5.x.x status does not mean the mailbox is dead.** The same permanent class covers "no such user" and "high probability of spam", and those demand opposite responses — only `MAILBOX_UNKNOWN` suppresses. A `POLICY_BLOCK` means the person is real and *your sending domain* has a problem; suppressing on it deletes a live lead and buries the signal. Diagnostic text is read **before** the status code, because many servers return 5.7.0 as a catch-all including for "no mailbox by that name", and rate limits ("exceeded their limit per hour") arrive under permanent codes while being entirely temporary.

The sync also **restores** leads previously marked `BOUNCED` whose report turns out to be a policy refusal — the inbox's own diagnostic outranks a platform's summary, and a lead written off in error is invisible forever unless something looks for it.

### Gmail reconcile

`src/lib/gmail-sent.ts` reads recipient addresses out of Gmail's Sent Mail over IMAP (`imapflow`), and `src/app/actions/gmail-actions.ts` matches them against leads to fix the `contacted` flag and backfill true `contacted_at` send dates. Accounts come from `GMAIL_ACCOUNTS` in `.env.local` (same JSON-array shape as `LINKEDIN_ACCOUNTS`).

The report groups sent mail into **campaigns** by normalised subject (`campaignKey()`), which is the only reliable way to separate real outreach from the warm-up traffic that dominates a mailbox connected to a service like Mailivery. Raw recipient counts are meaningless on their own — judge a campaign by its `leadsMatched` share. A campaign with thousands of messages and near-zero CRM matches was sent to a list built outside this tool.

A lead's absence from the mailboxes is never proof it wasn't contacted: it may have been reached from a mailbox that isn't configured here, or from a platform sending on its own infrastructure. That's why nothing is ever un-marked automatically.

IMAP + App Password is used deliberately over OAuth: no Google Cloud project, consent screen, or app verification, and no 7-day refresh-token expiry (which unverified OAuth apps in "Testing" mode suffer). The Sent folder is resolved by its IMAP `\Sent` special-use flag, not by name, because the folder is localised. Access is read-only — nothing writes to Gmail.

The sync **never un-marks a lead**. Absence from a scanned mailbox isn't proof a lead wasn't contacted (LinkedIn DMs, other accounts), so unconfirmed leads are only reported; clearing them is a separate explicit action.

### Lead discovery: dork engine

`src/lib/dorkEngine.ts` builds Google dork queries from job titles/locations, runs them through Serper API (key round-robin across `SERPER_API_KEY_1..8`), filters out a noise-domain blocklist and negative-keyword list, and streams found LinkedIn URLs into the DB live via a callback (`src/app/api/find-leads/route.ts` fires this as a background task within Next.js). `src/lib/finder-progress.ts` serves live progress from a global cache shared across development module reloads and writes atomic checkpoints with unique temp names and bounded retries for Windows file locks. Windows runtime files live outside OneDrive at `%LOCALAPPDATA%/Compel/lead-finder/<project-hash>`; other platforms retain `queue-results`. The status route also reads older workspace snapshots. Checkpoint failures must not abort discovery; CRM saves remain required. `DELETE /api/find-leads?jobId=` sets the live cancellation flag and writes a `.cancel` file for background tasks, including older runs. The status route reports `error` once `heartbeatAt` goes quiet for 120s, matching the worker's convention. Regression checks inject temporary and persistent locks in `scripts/verify-lead-finder.cjs`.

**The bottleneck is worker throughput, not lead count.** `DEFAULT_DAILY_SCRAPE_LIMIT` is 400/day against a five-figure inbox, so finding *more* leads has close to zero marginal value. All the value is in choosing which of the backlog to scrape next. That reframing is what the scoring is for, and it is why the score is a **prioritiser, not a gate**.

**`src/lib/discovery-score.ts` (`scoreDiscoveryResult`) cannot see the ICP, and must not pretend to.** A Serper result is a headline plus ~160 characters. None of the three ICP signals is in it: "actively posting" lives in the Voyager activity feed, "sells a paid offer" lives on the lead's website, and "solo" is a weak guess from a headline. So this scores 0-100 for *ranking* and hard-rejects only what is unambiguous (no niche match, a blocklisted term in the headline, a corporate function word alongside `at <Company>`). The real ICP gate belongs at the worker, where those signals exist.

Two rules keep it honest, and both come from real failures caught in testing:

- **Errors are asymmetric, so grade rather than reject.** A rejected result is never written and nothing records it was seen, so a false reject loses the profile permanently; a false accept only misranks a row the worker will judge properly later. Hence the employer shape (`Coach at <Company>`, no owner marker) is a −12 penalty (A12), not a rejection — it falls below the write floor anyway, but raising the floor or finding an owner marker recovers it. Only a corporate function word **in the headline itself** rejects outright; the snippet is never consulted for that, since page text carries "People also viewed" entries and testimonials naming other people's job titles.
- **A single-word niche that is also a role stem must not earn A1.** Searching the niche "Coach" made every role-word match score as an exact-phrase match at twice the weight, which silently disabled the employer-shape check (it only fires on a bare role word). A single-word niche that is *not* a role stem — "Nutritionist" — still earns A1, because there it is the only signal available.

  **This has a large operational consequence, so state it when advising on settings.** `extractNicheSignals` puts the typed niche into `phrases`, but the A1 guard skips a single-word phrase that is also a role word. So the niche `Coach` can never score above A2 (+12), while `Business Coach` earns A1 (+25) *and* sets `confidence: 'high'`, which in turn disables the A12 employer-shape penalty (−12). The same profile therefore scores up to **25 points higher** under a two-word niche — against an observed score ceiling of 55, that is the difference between a usable ranking and a flat one. Always advise multi-word niches (`Business Coach`, `Executive Coach`, `Health Coach`), one per run.

`fit_reasons` persists the matched weights as JSONB (`[{"id":"A1","w":25,"hit":"business coach"}]`) — a score you cannot explain is a score you cannot tune. The scorer is pure and dependency-free so it can be compiled standalone and exercised against saved SERP fixtures.

**The write floor (20) is not the selectivity mechanism.** It is cheap insurance against filling the table with junk. "Fewer, much better" actually happens at **queue ordering**: `GET /api/crm/leads/[location]?limit=` sorts by `fit_score DESC NULLS LAST` and returns a batch, so the worker's scarce daily budget goes to the best candidates first. Ranking rather than filtering is deliberate — nothing is discarded, the threshold stays re-tunable, and it applies retroactively to every row that has a score. The limit is applied *after* the region filter; applying it in SQL would starve every region but whichever happens to score highest overall. Unscored legacy rows sort last, and `insertDiscoveryProvenance` backfills a score whenever a re-find sees a row that has none, which is how the pre-existing backlog acquires scores at all.

**Provenance is first-touch and write-once.** `insertDiscoveryProvenance` (`db.ts`) writes `discovery_*` only on insert. If a later template re-finds a profile and overwrites, credit reassigns to whichever template ran last and every per-template number — qualified-per-credit above all — becomes meaningless. A re-find increments `discovery_seen_count` instead, which is itself the input to weight A8. Two deliberate exceptions, both strictly additive: a missing `fit_score` is backfilled, and a *higher* score from a later sighting wins (the score is a property of the profile, not of the query). The engine re-scores once at the 1→2 sighting transition, because scoring happens on first sighting when the count is always 1 — without that, A8 could never fire.

**The template bank is 35, not 107** (`buildQueryBank`, returning `{id, query}` with ids derived from category + driver word, never an array index). The deleted categories asked the same question repeatedly: appending `"Experience"`, `"About"`, `"Skills"`, `"Connections"` — words on *every* LinkedIn profile — is eleven near-identical queries against one slice of the index, and the ten generic business nouns (`company`, `services`, `solutions`…) were the same. What survives changes the semantic target. `queryBankSize()` derives the count by building a throwaway bank rather than hardcoding it, so pruning can never desynchronise the progress denominator.

`prequalifyViaGoogle` and `LOCATION_ALIASES` were deleted. The first spent a full Serper credit per candidate re-searching a profile to re-read the headline the original result already returned in its title tag, and failed open on every error path, so it rejected almost nothing while roughly doubling the cost of a run. The second built a large city/state expansion that was passed to the relevance check and never read — geo filtering is Google's job, because the location string is already in the dork.

**The discovery target counts unique kept profiles after scoring, not candidates scored.** `kept_leads_target` is the explicit input (`max_urls_target` remains a legacy alias). If the original country queries fall short, `buildDiscoverySearchPlan` adds alternate country wording and a conditional reserve of state/province queries for US/Canada, retaining the requested titles, country constraint, page limit and score floor. This expansion actually runs new queries; it is separate from the deleted unused relevance aliases above. Stop exactly at the kept target inside a page. Completed stats distinguish target reached, search exhausted with a shortfall, and manual cancellation. See `docs/lead-finder.md` and `scripts/verify-lead-finder.cjs`.

### Email verification

`src/app/actions/email-verifier-actions.ts` is a deliberately self-hosted verifier: DNS MX lookup + raw SMTP handshake (no third-party verification API). It maintains in-memory TTL caches for MX and catch-all results. Only a non-catch-all `SMTP_DIRECT` result can produce `VALID`/sendable status (`method` on `VerificationResult` records how a result was obtained: `SMTP_DIRECT` > `DNS_PREFILTER` > `LOCAL_PREFILTER`). `src/lib/email-domain-server.ts` is a lighter MX-only prefilter used elsewhere (`"server-only"` import guards it from client bundles). `src/lib/email-constants.ts` holds disposable/role/free-provider domain lists.

**Proof requires a score.** `isProvenValid` checks `email_status`, `email_verification_method === 'SMTP_DIRECT'`, an unexpired expiry **and a non-null `email_verification_score`**. The score is the part that can't be faked by a backfill: a data-recovery script once promoted 935 rows by writing VALID + SMTP_DIRECT + a year-long expiry directly, forging every other field the gate read, and those addresses went out on a campaign as "verified". Only a real run computes a score. `POST /api/admin/revoke-unearned-proof` clears method/expiry on any row carrying SMTP_DIRECT with a null score.

**A deferral is not a refusal, and this distinction hides in the wording.** Greylisters deliberately reject the first attempt from an unknown (sender, recipient, IP) triple and expect a retry minutes later — phrased as "not yet authorized to deliver mail", "temporarily deferred", "try again later". Those read as hostile, and classifying them as `POLICY_BLOCK` is wrong twice over: the address never gets its retry (a verifiable mailbox becomes UNKNOWN), and every deferral is counted as evidence the host is being refused, so `blockSignal` reports a reputation crisis that isn't happening. `TRANSIENT_PHRASES` is therefore tested **before** `POLICY_BLOCK_PHRASES`, and the greylist retry waits `EMAIL_VERIFY_GREYLIST_WAIT_MS` (90s default) — a five-second retry is refused by design, since filtering that out is precisely what greylisting is for.

**Diagnose with `/api/admin/smtp-doctor` before concluding verification is broken.** It reports the host's identity (does `EMAIL_VERIFY_HELO` resolve, does the public IP have a PTR) and then runs a real SMTP dialogue against one domain, probing a known-good address and a random control. Only the contrast is meaningful: real accepted + random refused = working; both accepted = catch-all; a known-good address refused = the server is refusing *this host*. A successful `telnet` to port 25 proves nothing — connectivity and identity fail independently, and the refusals happen at EHLO or RCPT, not at connect.

Expect roughly half of probes to return UNKNOWN regardless. Anti-harvesting appliances (SpamExperts, stackmail, spamprotect and similar) tarpit the connection — hanging it open past any timeout — specifically to defeat address probing. Those domains are not verifiable by anyone; use bounce reconcile (below) for them, and run verification twice so greylists that have since cleared resolve on the second pass.

**Most UNKNOWNs are a verdict about the sending host, not the lead — and re-running the verifier cannot change them.** Measured 2026-08-28 against 388 UNKNOWN leads: 215 (55%) sit on Microsoft-hosted domains that answer every probe from this deployment with `550 5.7.1 Service unavailable, Client host [<ip>] blocked using Spamhaus`, identically for the real address and for the random control — which is precisely why nothing can be concluded. Two independent identity defects cause it, and both are properties of *where the verifier runs*:

- The public IP is a residential/mobile address with **no PTR record**. Several hosts refuse on that alone: `450 Client host rejected: cannot find your reverse hostname`.
- `EMAIL_VERIFY_HELO` names a host with **no A record**, and some servers quote it back while refusing (`550 "JunkMail rejected - (verify.getcompel.co)"`).

Pointing HELO at a name that resolves was A/B-tested against six domains and changed nothing — the refusals are dominated by the IP, so **don't "fix" the HELO and report it as a fix**. The only real remedy is probing from a host with a static IP, a PTR, and a HELO that matches it. Until then, Google-hosted domains verify normally and Microsoft-hosted ones cannot be verified here at all.

A re-verify that recovers nothing is therefore the expected outcome, not a bug: a 100-lead run over this backlog moved 2 rows. `POST /api/admin/reverify` takes `{"target":"unknown"}` for this population (default `unproven-valid` keeps its old meaning), and reports `changed`/`transitions` rather than only a status spread — two runs that rescue 0 and 40 leads produce identical `outcomes` blocks otherwise, which is how "I re-ran it and they stay unknown" went unexplained for so long.

Three rules keep that population honest, all added after the above:

- **`smtpVerifySingle` banks an accept before probing for catch-all.** A 250 on the real address is recorded in `earned` the moment it arrives; the timeout/close/error handlers return it instead of a blank result. Hanging up on the *second* RCPT is exactly what an anti-harvest tarpit does, and the old code answered that by discarding the acceptance it had already been given — turning live addresses into UNKNOWN. `catchAll` stays null on that path, so a rescued accept reaches RISKY and can never manufacture a VALID.
- **A host-level refusal is cached for 30 minutes (`hostBlockCache`) and short-circuits every other address behind that MX.** The refusal is about our IP, so it is the same answer for all of them; without this, re-verifying the Microsoft cohort opens hundreds of connections that are each certain to fail. The TTL is deliberately far shorter than the MX/catch-all caches — a listing can lift and a dynamic IP can be reassigned. The extended-timeout retry also skips these: more patience cannot change a reputation verdict, and re-asking a server that just refused you is how the next listing is earned.
- **The refusal code and the server's own words are persisted into `email_verification_reason`.** "Server refused our probe" alone is untriageable — a Spamhaus block and a one-off rate limit read identically, yet the first affects every lead behind a provider and the second clears by itself. `summariseReply` strips the per-connection server ids so the reasons group.

Three invariants here are load-bearing — changing any of them silently corrupts the send list:

- **`classifyReject()` separates "this mailbox doesn't exist" from "this server refused *us*."** Both arrive as a 5xx. Only `MAILBOX_UNKNOWN` may set `smtpValid === false` (→ `INVALID`); a `POLICY_BLOCK` must stay `null` (→ `UNKNOWN`). Collapsing them means a blocklisted sending IP marks every good lead as dead, quietly. `blockSignal` warns when policy refusals dominate.
- **The catch-all probe is only conclusive when the random address is refused at mailbox level.** Anti-harvest setups routinely accept RCPT #1 and refuse RCPT #2 on policy grounds; treating that as "non-catch-all" would promote unproven addresses to `VALID`.
- **No provider is exempt from that, and a catch-all is never `VALID`.** `buildFinalResult` once waived the rule for Google Workspace, reasoning that a catch-all "accepts email without bouncing". It does not: accepting at RCPT is not a promise to deliver — routing rules, aliases, and suspended or over-quota mailboxes are evaluated *after* the transaction closes, and the NDR arrives hours later where no probe can see it. The waiver put 106 unproven addresses on the send list (104 of them live), including `<anything>@bit.ly`, which sits on Google's MX and accepts every recipient while scoring 95/100. Even a genuine catch-all only proves mail lands in a bin, not that it reaches a person — and a stream of mail to addresses that don't exist is exactly what costs a sending domain its reputation. Catch-all domains are not verifiable by SMTP; they belong in `RISKY`, exportable on purpose via `?include=risky`. Repair endpoint: `POST /api/admin/revoke-catchall-proof`.
- **`toPersistedVerification` (`src/lib/verification-persist.ts`) is the enforcement point, and it is deliberately not inside the verifier.** Both write paths — the CRM's manual/batch verify and the worker's on-arrival verify in `api/crm/leads/[location]` — go through it, and it re-derives the invariant from `checks` rather than trusting `status`. It exists as a shared module because those two paths had already drifted: one carried a comment claiming defence in depth over a straight passthrough, the other inlined the field mapping and checked nothing, so a bad verdict reached the send list with no second opinion. Anything arriving as `VALID` without a refused random recipient is written as `RISKY` with the downgrade appended to the reason.
- **`SYSTEM_ADDRESSES` (noreply@, postmaster@…) blocks `VALID`; `ROLE_ACCOUNTS` no longer does.** For a solo-operator ICP, `hello@`/`info@`/`contact@` is usually the real monitored inbox — excluding those cost far more real leads than it prevented bad sends. Role parts still take a score penalty.

All SMTP connections go through `withSmtpSlot()`, which serialises per MX host with a minimum gap (`EMAIL_VERIFY_HOST_INTERVAL_MS`) under a global cap (`EMAIL_VERIFY_CONCURRENCY`). Don't open sockets around it.

### Hook generation

`src/lib/groqClient.ts` calls Groq to generate a single cold-email opening line ("hook"), either from a lead's website copy or their recent LinkedIn post, under a strict prompt contract (must start with "Your", 10–20/25 words, no em dashes, empty string if the site looks broken/parked). Preserve these constraints if editing the prompts — they're enforced by instruction, not code.

### Frontend

**Visual system.** `src/app/globals.css` defines it and is the only place a colour is written: near-black ground, hairline rules rather than raised cards, and structure carried by type and spacing. Colour is a *signal* — acid green (`--signal`) for live/good, amber for attention, red for stop — so the one screen that matters stands out. **The palette is fixed; don't restyle it.** Components read tokens (`var(--signal)`, `var(--line)`, `var(--text-dim)`…) and never a literal or a Tailwind colour scale — `grep -E '(bg|text|border)-(zinc|slate|gray|red|blue|purple|green|amber|emerald)-[0-9]' src/components/` must stay empty. A previous session left a `globals.redesign.css` proposing a teal-on-paper palette; it was deleted, because the accent carries meaning that a re-theme silently breaks.

Use the component classes rather than ad-hoc utilities: `.panel` / `.panel-head` / `.panel-body` / `.panel-note`, `.figures` / `.fig`, `.btn` (+ `-primary` / `-outline` / `-ghost` / `-danger`), `.sidebar` / `.nav-item`, `.seg`, `.tab`, `.mark`, `.badge`, `.chip`, `.stat`, `.field` / `.field-label` / `.field-hint`, `.drop`, `.feed-row`, `.bar-track` / `.bar-fill`, `.tbl-wrap` / `.tbl-head` / `.tbl-row`, `.menu`, `.num`, `.label-micro`, `.dot-live`. A table where every cell is a coloured lozenge reads as confetti — status is a `.mark` (small square plus a word), not a filled pill. Every figure gets `.num` (mono, tabular) so columns align and counts don't reflow. At most one `.btn-primary` per screen.

**Fonts are wired in `layout.tsx`, and the stylesheet depends on it.** `globals.css` reads `--font-outfit` and `--font-fira-code`; for a long time nothing defined them, so every screen fell back to the browser default and the "mono, tabular" figures were neither. If those `next/font/google` calls are removed, the type system silently stops applying.

**Navigation is a left rail (`.sidebar`), not a toolbar.** The strip it replaced held a tab row plus nine buttons in one non-wrapping flex container and pushed *Sync Gmail* and everything after it off-screen with no indication. A rail cannot do that. Below `lg` the rail is hidden and a scrolling `.tabs` strip takes over. Inside a screen, keep the toolbar to a primary action plus a **Tools** menu.

**Say what a number means, in words the operator uses.** Statuses are rendered through `LEAD_STATUS` / `VerifyMark` in `Dashboard.tsx` rather than printed raw: `ACTIVITY_FAILED` reads "Not posting" because nothing failed, and an `UNKNOWN` whose reason matches `/refused our probe/` reads **"Host refused us"** in the idle colour — never the failure colour, because that verdict is about this machine's IP and says nothing about the mailbox (see *Email verification*). Three headline figures per screen at most; the row that preceded them showed five tiles describing the same handful of leads and was read as none.

`src/components/Dashboard.tsx` is the main, large, stateful dashboard shell; `CrmDatabase.tsx` and `CrmSync.tsx` render/sync the leads table; `FinderEngine.tsx` drives the dork-search flow; `UrlCleaner.tsx` is a standalone URL-cleanup utility. All server-side mutation goes through `"use server"` action files under `src/app/actions/`, not client-side fetches to arbitrary endpoints, except where the queue/polling contract above requires a real HTTP API route.
