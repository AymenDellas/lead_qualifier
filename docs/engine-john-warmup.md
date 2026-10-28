# John: authorized rendered warmup experiment — 28 October 2026

The user confirmed John is not currently restricted and explicitly authorized a one-time test of 20 rendered profiles. Authorization is restricted to AliasMode profile `k1ierfk4` / John Dilah. Proxy, detector and recovery admission and the normal ten-profile warmup ceiling are waived only inside this bounded experiment. The normal policy/configuration, existing detector reports and normal processing intent are preserved. No account/profile is deleted.

The existing persistent agent owns the account browser and its sequential tab. PostgreSQL holds the experiment manifest, per-visit checkpoints and canonical-profile lock jobs. Existing unique daily reservations and 60–150-second spacing remain atomic. The feed must confirm the saved member before the old review hold can be reconciled; any newly observed account signal stops work, including an HTTP code identical to the saved hold. Passwords/cookies are not entered/exported. Pointer movement and scrolling are permitted; social actions are not.

There are no CompelOS qualification Voyager calls, follower/activity/contact reads, public crawls or CRM decisions. Normal LinkedIn rendered pages may make their own background Voyager requests; those are counted separately, without headers/cookies or response bodies. This experiment cannot rule out all LinkedIn internal API traffic or isolate account history, CDP and proxy causes by itself.

The run ends at 20 attempted profile starts, a security signal, identity/fingerprint mismatch, operator pause/close, account daily ceiling, ownership/configuration change, browser error or a 90-minute deadline. Normal qualification remains paused afterward. Only test lock jobs are cancelled/released; their results never count as completed qualification or block a later normal qualification. Private observations and frozen regression evidence stay under ignored `data/engine-v2/john-warmup/`; PostgreSQL remains the runtime state store.

## Running and stopping this single-use authorization

`node scripts/engine-john-warmup.cjs prepare` selects exactly 20 eligible, distinct Inbox profiles and preserves their CRM row digests. `start` writes the bounded authorization to PostgreSQL and wakes the existing persistent agent; it cannot re-arm a completed/stopped manifest. `watch` uses one LISTEN connection plus one reporting connection and saves private progress. `report` verifies the selected CRM rows against their pre-test digests. `cancel`, dashboard **Stop test**, and **Close profile** all withdraw authority for further actions. No public API offers a general exception switch.

`worker-warmup-experiment.cjs` owns this manifest, its attempt checkpoints and temporary canonical-profile lock jobs. `account-runtime.cjs` dispatches only the exact experiment command; `engine-daily-policy.cjs` validates that same manifest inside the normal atomic reservation transaction. Ordinary claims explicitly exclude experiment jobs, including orphan locks recovered after a dead agent. An agent/browser restart ends this experiment rather than retrying a navigation. All other accounts retain their normal policy and paused intent.

## Verification before live work

The PostgreSQL and intercepted-browser fixtures verify the 20-visit ceiling, unique daily reservations and randomized spacing, disabled qualification intent, old-hold reconciliation, fresh identical 403 stops, identity/configuration/ownership/expiry checks, manual pause, browser disconnect and orphan-job exclusion. TypeScript, lint on changed files and all 14 PostgreSQL-enabled CRM tests pass. Both the original session-hardening and freshly frozen 50-record evidence sets replay with zero decision changes, evidence changes or errors.

The complete engine/worker/prospect/coach suite passes **433/433**, with zero failures or skips. Browser fixture requests were intercepted locally; none of these tests visited live LinkedIn.

Full workspace lint still reports the existing five errors and seven warnings outside these changes. The production build compiled successfully, but was intentionally stopped during its subsequent TypeScript stage when free system RAM fell to about 365 MB; stopping that build alone restored about 2.1 GB free. The separate TypeScript check passed. This is an incomplete build verification, not a successful production-build claim. No live account work overlaps tests/builds.
