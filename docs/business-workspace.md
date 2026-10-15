# Compel business workspace

The dashboard now includes Today, Sales, Clients, Performance, and Business & Offer. Existing discovery, scraper qualification, email verification, CRM send gates, and infrastructure are unchanged.

## Data and setup

The new screens use the existing `DATABASE_URL` and Postgres pool. On first access, `ensureBusinessSchema()` transactionally creates four additive tables (`business_offer_versions`, `business_opportunities`, `business_projects`, `business_activities`) and seeds one offer version from the supplied Compel knowledge base. The database user needs permission to create these tables and indexes. Initialization is idempotent and retried after a failure. No existing lead rows are altered.

Business edits are saved server-side. An offer save creates a new version; opportunities and projects retain their original version. Opportunity and project revision checks reject stale saves. Creating a project twice returns the same project. Activities retain the conversation and update history (the UI loads the most recent 50 events per opportunity).

## Daily workflow

1. Review Business & Offer. Measurement and case-study terms are intentionally blank because they were not specified in the source.
2. In Sales, add an opportunity manually or search for an existing CRM lead. Import CRM replies reads leads already recorded as `REPLIED`, excludes suppressed leads, creates up to 100 new opportunities per import, and advances existing NEW/EMAILED opportunities when a reply is recorded. Repeating the import does not duplicate opportunities.
3. The workflow is **initial email → initial reply → same-day Loom → follow-up after 48 hours if unbooked → breakup → booking/proposal → won/lost**. There is no qualifying question. Save the reply before recording a Loom as sent. Subsequent follow-up dates are editable; the unspecified breakup interval is not invented.
4. Fill in the opportunity brief, observed evidence, unknowns, suggested funnel, and agreed engagement terms. “Suggest funnel from evidence” uses recorded audience stage, primary CTA, offer tier, and video readiness. It leaves the recommendation unresolved if evidence is missing. Copy the relevant message draft, review placeholders, and send through the existing sending platform. Stage changes only record actions; they do not send messages.
5. Mark the opportunity won and start client delivery. The checklist uses the selected funnel from that opportunity's original offer version. Work can contain page copy, nurture email sequences, booking integration notes, file URLs, deadlines, and approval feedback.
6. Record baseline and comparison bookings in Performance. Agree counting rules, attribution, a positive minimum increase, fee, and exact terms. Eligibility requires complete equal-length non-overlapping periods, a completed comparison window, target achieved, evidence URL, and explicit review. A zero baseline has no percentage. Case studies do not receive automatic performance-fee eligibility. Invoice states record external activity and do not charge or invoice anyone.

Today combines due Looms/follow-ups, upcoming Compel discovery calls, blocked work, approvals, and due client deliverables. Client-generated booking results remain separate from Compel's own sales calls.

## Integrations and scope

CRM reply import uses the existing campaign report reconciliation. Live Instantly and Calendly webhooks are not connected in this release; booking dates, actual sent stages, performance counts, and invoice status can be entered manually. No external messages, bookings, or payment requests are issued by these screens. Source evidence and message drafts are editable/manual; no additional AI service is required.

## Verification

`node scripts/test-business.cjs` checks workflow timing, validation, independent delivery templates, and payment eligibility edge cases. Optional SQL integration tests run against an isolated in-memory Postgres using PGlite installed outside the project: set `BUSINESS_TEST_RUNTIME_DIR` to that temporary npm directory and run `node scripts/test-business.cjs --database`. Application credentials are never loaded by this test script.

Typecheck with `node node_modules/typescript/bin/tsc --noEmit --incremental false`. Build with the existing `npm run build`. The pre-existing lint command was deliberately not changed.

## Onboarding template refinements

New scopes explicitly exclude lead generation, advertising, third-party subscriptions/platform costs, and ongoing optimization outside the agreed scope unless separately agreed in writing. Free case-study projects have no project-payment prerequisite; paid projects retain their agreed initial payment requirement. Untouched legacy start requirements are updated by engagement type. Empty exclusions are upgraded only for unsigned, unconfirmed scopes; custom terms, confirmed scopes and signed agreement contents are preserved.

The client sees included work, exclusions and start requirements above the agreement PDF link and again when confirming the scope. Confirmation persists the normalized scope shown to the client. Generated agreement drafts include exclusions and start requirements before signature lines; uploaded signed PDFs are served unchanged. Portal statuses and outstanding items use client-facing actions, with baseline capture clearly assigned to Compel.

Both the client and operator forms include optional questions about approach differentiation and unsuitable clients. Answers persist through save/resume and appear in Copy Studio as the approach/mechanism and audience-fit/booking-qualification context. An older cached form cannot erase these newly added answers.

Onboarding regression checks: `node --import tsx --test tests/onboarding/template.test.ts` and `node --test tests/onboarding/actions.test.cjs`. Copy Studio handoff coverage remains in `tests/copy-studio/onboarding.test.ts`. The older `scripts/test-business.cjs` currently references a pre-existing missing `transitionOpportunity` export and cannot run as a complete business-suite check.
