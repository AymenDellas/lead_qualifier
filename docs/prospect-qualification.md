# Qualification and evidence

Finder → PostgreSQL queue/CRM → local LinkedIn capture → bounded public research → PostgreSQL result. See [engine-v2.md](engine-v2.md) for operation and configuration.

The main CRM qualification logic already used confirmed profile identity, an attributable email and reliably dated LinkedIn activity within 30 days. Business segment, geography and commercial facts rank/filter prospects; they are not additional email/activity qualification gates. The audit/regression snapshot preserves that existing behavior. The sole new qualification criterion is followers strictly greater than `MIN_FOLLOWERS` (default 1000).

Read follower evidence on the loaded profile immediately after identity. Store raw text, integer, applied threshold and timestamp. Keep connections separate. At/below threshold → REJECTED/FOLLOWERS_BELOW_MIN; absent/unparseable → REVIEW. Followers do not prove buying intent; this threshold is the requested screening rule. Qualification version is 2. Legacy qualified leads remain follower-unchecked without automatic requeue; explicitly selected follower rechecks refresh the profile and apply the current rule.

Case Study Hunter coach prospecting retains its existing independent-practice/offer criteria and optional email requirement. It also applies the follower rule. It does not inherit the main CRM's recent-activity or email gates. A missing/unusual headline can still be supported by About/website evidence after the follower check. Manual fit decisions cannot bypass an unknown/below-minimum follower count.

The worker skips remaining work after a decision. It checks activity before contact/website research when recent activity is required. Public research prioritizes home/contact/about links and stops once it has enough attributed evidence. Defaults: eight routes, twelve attempts, twenty wall-clock seconds, five seconds per request. Unreadable static HTML gets one bounded separate-browser attempt. Terminal site failures retain their evidence for REVIEW instead of a repeated crawl. Website/CRM retries reuse captured LinkedIn evidence.

Qualification remains separate from permission to send. SMTP verification, suppression, contact history, duplicate handling and account-specific messaging evidence retain their existing checks. No outreach starts as part of qualification. Replacing an email invalidates its old verification.

Private regression snapshots/replays are under ignored `data/engine-v2/`. The frozen 50-lead set has zero non-follower decision drift; full per-lead deltas and measurement limits are explained in [engine-measurements.md](engine-measurements.md). Root AGENTS.md lists the engine, CRM, type and lint checks.
