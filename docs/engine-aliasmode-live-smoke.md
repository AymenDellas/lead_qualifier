# AliasMode live test — 27 October 2026

The user authorized a small live lead test after headless integration. Four uncontacted, unsuppressed profiles were selected from the existing 30-profile `baseline-unthrottled` manifest, excluding same-day completed work. This was a partial smoke test, not a replacement 30-lead benchmark. No engine code or qualification policy changed for the test.

Both new mapped accounts verified their saved LinkedIn members through the normal visible manual-connection workflow. Both then used the production headless agent and PostgreSQL queue concurrently. Each account reserved two unique profiles; the 60-second interval remained in force. No old unbound account was enabled and the original security hold remained intact.

| Result | Count |
| --- | ---: |
| Rejected: confirmed Singapore residence | 1 |
| REVIEW: follower count could not be established | 2 |
| Capture interrupted by LinkedIn HTTP 403 | 1 |
| Qualified | 0 |

The 403 occurred on John Dilah's second queued profile, after a profile fallback request was attempted. The account's reactive stop persisted the exact access-restriction reason. HTTP 403 is confirmed; this test did not inspect an account-restriction notice or infer the account's wider status. The remaining capture and its checkpoint were retained in PostgreSQL. Both tested accounts were paused immediately after the stop; no additional LinkedIn reads were made to diagnose it or to retry the held account.

The three completed decisions were persisted to CRM. For one selected profile, the canonical save selected an older pre-existing duplicate row; the original duplicate remained unchanged. No CRM rows were deleted or merged. Private before-state and actual saved-row IDs are retained in the report.

Median pickup-to-decision across the three completed profiles was **47.6 seconds**, p90 **48.2 seconds**. The first two included cold browser/session startup (48.4 and 47.6 seconds); the third took **2.9 seconds**. None reached activity/contact/website research because the location/follower gates decided them first. These results cannot establish steady-state throughput or full successful-lead latency.

Sampled peak agent/AliasMode/browser process-tree RSS was **4,336 MiB**. Sampling covered seven stored samples; a Windows process enumeration failed during the run, so short peaks may be missed. The completed decisions had no retries/rework; the held job remains pending with its interruption evidence and one deferred attempt.

Two follower checks failed despite previously stored follower evidence for one profile. The live check establishes that current follower acquisition needs investigation before a broader run. Stored evidence does not establish whether the count was absent from the response or unsupported by the parser. No additional profile requests or policy relaxation were used to hide the missing evidence.

The manifest and report are stored in `compel_engine_batches` with state `BLOCKED`. Full evidence, source lead snapshots, telemetry and per-lead results are under ignored `data/engine-v2/aliasmode-live-smoke/`. This is not a clean end-to-end pass: headless account/session/queue/CRM operation was exercised, while follower capture and a 403 stopped the test from completing.
