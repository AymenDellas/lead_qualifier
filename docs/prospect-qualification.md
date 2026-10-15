# Finding and qualifying coaches

The workflow is **Finder → Engine → Leads CRM → Ready export → Automailer**. There is no separate Prospects tab or manual investigation step.

## Everyday use

1. Use Finder to discover individual executive, leadership, career and business coaches. Searches rotate across titles and locations; stronger search matches are queued first.
2. Use Engine to process the profiles. The separate LinkedIn worker must be running (`npm run worker` or your desktop BAT). Jobs survive restarts and respect the daily profile budget.
3. Open Leads CRM. Qualifying coaches appear in **NA qualified** or **UK qualified**, as before. Qualification does not require a verified email, so a qualified coach remains visible while their email needs verification.
4. Verify emails locally. **Ready** and the regular verified-email download provide the list for Automailer. Existing suppression, contact history, duplicate and mailbox-proof checks still apply.

## Qualification and ranking

Qualification requires a matching profile, a relevant coaching segment, evidence of an independent coaching practice and an identifiable commercial coaching offer, and an established US, UK or Canadian location/target market. The matching LinkedIn profile can establish these facts when a website is absent or inaccessible. A corporate-only internal coach, unrelated coaching discipline, or an unconfirmed person does not qualify.

Client testimonials, recent marketing activity and a possible funnel improvement help rank a prospect. Missing testimonials or an unproven funnel problem do not block an otherwise relevant coach from qualifying. Economics and delivery capacity need a later business conversation; public credentials and follower counts do not prove buying intent. Explicit contrary evidence remains a reason to exclude a lead.

Research reads at most five public HTML pages, checks website ownership and retains source excerpts. Findings from an unrelated website cannot establish this person's practice. Third-party, vendor and placeholder emails are excluded; guessed addresses do not become attributable merely because SMTP accepts them. Research older than 90 days needs refreshing before a new send export. Legacy qualified CRM records retain their existing export path without an extra research requirement.

The interpreter defaults to `openai/gpt-oss-120b`; `PROSPECT_RESEARCH_MODEL` overrides it. Source passages and output are bounded, citations are checked against retrieved text, and provider failures are visible in the logs. Strong saved rule evidence can qualify a coach even if interpretation is unavailable; an incomplete assessment is reported as an error rather than a reliable rejection. Opening lines and sales-outcome learning are excluded.

## Worker resource use

The lead worker uses one headless browser with one clean LinkedIn tab. A PID guard rejects duplicate worker starts. Saved tabs are closed through the browser-level connection before Puppeteer or its plugins initialize their pages; listing all restored pages first can overload Chrome and time out. Bounded shutdown/recycling cleans up only that worker's own Chrome process tree.

Normal startup does not automatically open visible Chrome on a failed LinkedIn login. Pending work is retained and the worker tells you to run **`npm run worker -- --login`** when a visible sign-in is necessary. A navigation or browser-control timeout retries once with a clean headless browser and then reports an undetermined login status; it cannot establish an expired login. The worker returns to headless operation after successful sign-in. The desktop BAT uses normal headless startup. `node worker.cjs --check-login` verifies startup and closes the browser before claiming any queued profile.

The Engine reads qualified totals from saved CRM results, so heartbeats and worker restarts cannot erase today's count. The profile budget counts started attempts, which can exceed distinct completed CRM profiles after retries.

## Recover saved results

`node scripts/reclassify-engine-results.cjs` previews classifications under the current rules using saved evidence only. `--apply` saves a full backup under `backups/engine-recovery/` and updates only assessment and pipeline status in a transaction. Email addresses, mailbox proof, research dates, suppression, contact history and manual reviews are retained. No browser, AI request, SMTP probe or outreach is started. Unresearched legacy records are left alone.

## Validation

`node --test tests/prospects/qualification.test.cjs tests/prospects/research.test.cjs tests/prospects/worker.test.cjs tests/prospects/worker-lifecycle.test.cjs tests/prospects/worker-status.test.cjs tests/prospects/engine-recovery.test.cjs` checks qualification, source grounding, profile-only evidence, contact ownership, actual worker persistence, duplicate/browser cleanup, persistent counters and recovery. Browser lifecycle checks use mocks and do not launch Chrome.

`tests/prospects/store.cjs` uses an isolated PGlite database via `DISCOVERY_TEST_RUNTIME_DIR` to verify CRM persistence, verified exports, manual-review preservation, suppression and failed-save recovery. It does not access the application database or send email.
