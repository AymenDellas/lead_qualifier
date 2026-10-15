# Case Study Hunter

The Case Study Hunter is an isolated path from a warm LinkedIn signal to a documented Compel case study.

## Runtime isolation

The original `worker.cjs` is unchanged. `case-study-worker.cjs` has its own:

- browser profile: `.browser-profiles-case-study/`
- input queue: `case-study-queue/`
- result directory: `case-study-results/`
- daily counter: `data/case-study-worker-limits.json`
- CRM write path: `/api/case-study/worker-result`

Run the dashboard and worker locally:

```bash
npm run dev
npm run case-study-worker
```

The second process may open a browser the first time so the LinkedIn session can be established. Avoid running both LinkedIn workers against the same account at full volume at the same time. The Case Study worker defaults to 150 profile scans per day, waits 12–25 seconds between profiles, and can be tuned with `CASE_STUDY_DAILY_SCRAPE_LIMIT`, `CASE_STUDY_PROFILE_DELAY_MIN_MS`, and `CASE_STUDY_PROFILE_DELAY_MAX_MS`.

For Docker, the worker is an optional profile:

```bash
docker compose stop qualifier-worker
docker compose --profile case-study up -d case-study-worker
```

## Source scanner

The screen accepts profile URLs directly or can collect up to 150 new profiles from:

- the LinkedIn connections list
- the followers list
- profile viewers
- a supplied LinkedIn post for visible engagers

Each discovered profile becomes a separate queue job. The source relationship, evidence, and configured target titles travel with that job and become part of the record.

As profiles are collected, every canonical LinkedIn profile URL is compared with every row in the Case Study prospect pipeline. Duplicate-check requests contain at most 100 URLs. Existing URLs are counted separately and do not consume the requested target: a target of 120 means 120 new profiles, even if the scanner must read 140 connections to skip 20 duplicates. Collection continues until the target is met, the source stops returning additional profiles, or the operator stops the run. Logs show new profiles, pipeline duplicates, and total profiles checked. If the source is exhausted, the worker queues the smaller available set and reports the shortfall. If any duplicate check fails, no profiles from that source scan are queued. Manually pasted profile URLs use the same duplicate gate.

An individual prospect has a **Retry scan** control for deliberate recovery from a failed, blocked, or outdated website scan. Retries preserve the title selection saved with the record. **Recheck missed coaches** in Scanner queues existing, uncontacted headline rejections that match the current titles. It reuses their records, skips CRM imports and suppressed/contacted prospects, and checks eligibility under a row lock to prevent duplicate recovery jobs. These explicit recovery controls bypass the new-profile duplicate gate.

The worker reads the LinkedIn headline first. One shared rule set supplies the scanner, server and worker with 18 default titles. Matching recognizes Coach/Coaching/Coaches wording, compound roles such as Executive & Business Coach, intervening specialty words such as Career Ownership Coach, and declared coach roles paired with relevant headline context. Communication, sales, professional, founder/entrepreneur, team, confidence, personal development and transformational coaching extend the original titles. Generic professional coaches proceed for website review without asserting that their niche, offer or commercial value is confirmed.

Configured titles still control the gate: Executive Coach alone does not admit every career or generic coach. Founder, CEO, Consultant and credential abbreviations alone do not establish a coaching role under the defaults. Sports and technical/agile coaching remain outside the defaults unless an applicable primary coaching role is also declared. People advertising services to coaches, vacancies and aspiring coaches are not treated as established coaches. Rejected profiles are recorded and do not trigger website requests. Coaches with no coaching role or credential evidence in their headline still require manual review; the gate does not invent that evidence from a generic job title.

For a matching headline, the worker extracts a website from LinkedIn contact information, About content, or Featured content. Its existing personal-domain fallback verifies that a candidate resolves and serves HTML. The worker saves the profile and website for manual review. It no longer crawls funnel pages, scores conversion weaknesses, or generates outreach angles or DMs.

The dashboard displays the worker phase, current task, queue size, daily count, and recent activity. The original lead qualifier and standalone Funnel Analyzer remain separate tools.

## Profile review

The Hunter pipeline shows the prospect, clickable Website and LinkedIn URL columns, an inline Status dropdown, and headline qualification. Status changes save in place and record activity without reloading the pipeline. Detailed records retain the warmth source, editable profile information, manual outreach tracking, next actions, notes, and the delivery archive. CRM imports remain separate in CRM outreach, which also has direct website and LinkedIn links.

Case Study and Client modes organize their respective pipelines. The Today view prioritizes qualified profiles by warmth source and age, with separate follow-up and engagement lists. It does not depend on funnel analysis or legacy scores. Legacy analysis fields are retained for storage compatibility but are not shown or used for ranking, and a fresh profile scan clears the derived analysis fields.

## CRM and follow-up

The stages are:

`Found → Qualified → Messaged → Replied → Interested → Audit sent → Call booked → Case study agreed → Rebuild → Completed → Testimonial / results`

Recording `Replied` creates an immediate action to send the specific Loom or audit. There is no qualifying-question step. Recording `Messaged` or `Audit sent` schedules a 48-hour follow-up. These changes record work only; the application does not send a LinkedIn message.

The daily screen selects up to five qualified people to review and message, three due follow-ups, and five remaining warm people to engage with.

## Delivery archive

At `Case study agreed`, the prospect record switches to delivery mode and stores:

- the three strongest leaks
- Loom/audit URL and discovery-call time
- before and after screenshot URLs
- old and new copy
- the rationale for each change
- metrics/results
- testimonial
- final case-study page URL

The tables are additive: `case_study_prospects` and `case_study_activities`. Existing leads and business opportunity tables are not changed.
