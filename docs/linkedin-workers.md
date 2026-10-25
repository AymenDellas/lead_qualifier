# Local agent and account sessions

The current architecture, configuration and recovery guide is [engine-v2.md](engine-v2.md). Historical behavior is recorded in [engine-audit.md](engine-audit.md); its old budgets and process tree are audit evidence, not current instructions.

Start the local agent with `npm run worker` or **Start workers** in the local dashboard. `worker.cjs` is the persistent host; `scripts/linkedin-worker-supervisor.cjs` is a compatibility launcher. There are no account-worker or public-research child Node processes. Vercel cannot launch or control the worker.

Connect/Open session permits manual sign-in in a saved headful Puppeteer profile. No credentials are submitted by code. A matching member must be confirmed before processing. Start/Resume saves intent until Pause, disable, sign-out, the daily cap or security review. An agent restart resumes saved intent and checkpoints; it does not clear explicit pauses or security holds. Idle Chrome closes automatically and later reopens the same profile.

Only unique profiles per account per configured local day consume a LinkedIn allowance. Interaction counts are dashboard statistics. The current authorized policy is 300 profiles/account/day and a minimum 60 seconds between profile starts, persisted in PostgreSQL. There are no other hourly/rolling/per-kind budgets, working hours, cooldowns or throttle sleeps. At the daily cap, DAILY_LIMIT_REACHED shows the next midnight while public research finishes. Manual session checks and cached captures are free; same-day retries of an already-read profile are not charged again.

The default browser capacity is one. Each account uses one sequential tab in pinned Chrome for Testing: headless during processing, visible for manual sign-in/review. Switching modes closes the owned browser first and preserves the same profile/cookies. Ordered checkpoints and results use a bounded save queue; results save asynchronously, and the next lead stays unlocked during the one-minute interval. Public research uses two tasks and three HTTP slots, with a separate on-demand headless renderer. Public pages cannot navigate to LinkedIn/LICDN or private network addresses.

LinkedIn/LICDN HTTP 401/403/429/999, login/authwall/checkpoint/challenge, security warnings and identity mismatches stop the affected account. Its exact reason stays visible until manual review. Unavailable/wrong/unknown profile layouts become terminal REVIEW with retained evidence and do not halt unrelated leads. Chrome crashes resume checkpoints within bounded retries. Website failures never schedule a LinkedIn revisit.

Startup shows REQUEST_RECEIVED → AGENT_ACK → BROWSER_STARTING → SESSION_VERIFIED → PROCESSING, or a failure with its stage, reason and action. Only verified-dead owners with expired heartbeats, or verified explicit releases, may be reclaimed. Unknown/live profile locks are never erased. Existing `.browser-profiles` and cookies keep their location; new profiles use local app-state storage. There is no folder-based qualification queue/result import. Finder progress still reads its existing directory.

See [Windows start at sign-in](windows-agent.md), [measurements](engine-measurements.md), and root AGENTS.md for test commands and invariants.
