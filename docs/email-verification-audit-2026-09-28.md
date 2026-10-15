# Leads CRM and email verification audit

Date: 28 September 2026, Casablanca time.

The CRM now reserves every matching Hunter lead. Email verification had software defects, stale or unsupported labels, and a confirmed SMTP host reputation problem. The software defects are corrected. The current host still cannot reliably verify Microsoft-hosted recipients.

## CRM changes applied

85 Leads CRM records match Hunter by LinkedIn profile identity or the explicit CRM lead ID. 50 needed their contacted flag updated. Matching ignores URL scheme, subdomain, capitalization, tracking parameters and trailing profile paths. Synchronization runs when Hunter records are added and when CRM records are read.

Hunter membership has its own `HUNTER` source. It reserves the lead without inventing a DM timestamp or send date. Existing Gmail, platform and manual contact evidence is preserved. Marking an actual LinkedIn DM replaces membership-only provenance with recorded contact evidence. Undoing that DM retains the Hunter reservation.

The CRM has an In Hunter filter and row labels. Reserved leads remain checked, cannot be unchecked from Leads CRM, and are excluded from fresh outreach lists. Manual contact toggles now save correctly and show errors without a page reload. CRM tabs were inspected at 1542, 1100 and 760 pixels, with all 85 reservation checkboxes checked and no browser page errors.

## Live SMTP diagnosis

The production transport was tested against Compel's own domain and one previously blocked CRM recipient. These were SMTP envelope probes: no DATA command or email message was sent. Results are saved in `output/email-verification-audit-2026-09-28.json` and `output/smtp-diagnosis-2026-09-28.json`.

| Check | Observed result | Meaning |
|---|---|---|
| Outbound port 25 | Connected to Google and Microsoft | Port connectivity is working on this machine. |
| STARTTLS | Completed against both hosts | Encryption works; the Microsoft rejection happens after TLS. |
| Microsoft RCPT | 550 with an explicit Spamhaus client-host block | The server rejects this probing host. The recipient remains unconfirmed. |
| Google RCPT | Both the real and randomized recipient were accepted | This conversation cannot establish individual mailbox existence. It does not prove that every accepted address will receive mail. |
| EHLO identity | `verify.getcompel.co` had no A/AAAA answer in the final diagnostic | The configured identity needs forward DNS on the eventual probe host. |
| Reverse DNS | No PTR answer for the current public IP | Forward and reverse identity are not established. |
| Sender SPF | `v=spf1 include:_spf.google.com ~all` | The published sender policy authorizes Google. A desktop probe using that MAIL FROM needs separate authorization; this is an infrastructure concern, not the explicit reason given in the observed Microsoft refusal. |

The database contains 30 stored reasons mentioning Spamhaus. This is separate from the live confirmation and does not establish which particular Spamhaus list the current IP is on. Spamhaus describes why many end-user address ranges are unsuitable for direct SMTP in its [Policy Blocklist documentation](https://www.spamhaus.org/blocklists/policy-blocklist/). SPF checks sender authorization against the connecting host, as specified in [RFC 7208](https://www.rfc-editor.org/rfc/rfc7208.html).

## Software defects corrected

| Defect | Correction |
|---|---|
| DNS timeouts could become “no MX” and INVALID for six hours | Temporary DNS errors stay UNKNOWN and are not cached as domain absence. Shared DNS resolution also retains possible addresses during discovery. |
| Missing MX and null MX handling differed between discovery and verification | Both paths use one resolver, support A/AAAA implicit MX, and respect explicit null MX. These rules follow [RFC 5321 §5.1](https://www.rfc-editor.org/rfc/rfc5321.html#section-5.1) and [RFC 7505](https://www.rfc-editor.org/rfc/rfc7505.html). |
| Bare 550/551 or generic refusal text could falsely condemn a mailbox | Only explicit mailbox-level evidence produces a negative SMTP verdict. All 4xx responses stay temporary. Mailbox-full and disabled replies are kept separate from sender reputation blocks, consistent with [RFC 3463](https://www.rfc-editor.org/rfc/rfc3463.html). |
| Batch verification lost banner/EHLO/MAIL refusal details | Single and batch verification now share one transport and retain the failing phase, reply and transport error. |
| One answered recipient stopped retries for the whole batch | Each recipient retains its strongest evidence; unresolved addresses continue to alternate advertised MX hosts. |
| Extended retries bypassed the recipient cap | Normal and extended attempts use at most ten real recipients plus one randomized control per envelope. Duplicate input addresses are probed once per pass, with output positions preserved. |
| Packet parsing and inactivity timers could mishandle replies or hang | A bounded parser handles fragmented, multiline and coalesced replies. An absolute conversation deadline prevents indefinite tarpits. |
| No STARTTLS or EHLO fallback | Advertised STARTTLS is used with certificate validation. Unsupported EHLO falls back to HELO. TLS failures remain inconclusive. |
| A stalled control check could lose an earned recipient acceptance | Acceptance survives timeout or disconnect; the inconclusive control keeps the result RISKY. |
| Host block caching could be poisoned by mailbox refusal wording | Explicit mailbox refusals do not cache a host-level block. Reputation keywords match whole terms. Waiting connections recheck the host cache before opening a socket. |
| Recovery could retain old refusal flags | Applying a recovered result clears stale refusal evidence. |
| Verification could attach to a newly edited email | Persistence checks the address that was actually verified. Changing an email atomically clears the previous address's verification fields. |
| Different exports used different freshness rules | CRM, qualified-lead API and Google Sheets outreach use the same proof gate. Missing, expired, future-dated, oversized or insufficient evidence cannot enter the proven send list. |

Persisted verdicts are checked independently of the verifier's label. Unsupported positive and negative claims are downgraded instead of trusted. Configuration readiness no longer claims that SMTP connectivity and reputation were tested. The SMTP diagnostic now uses the production transport and does not infer a host problem merely because a supposed known-good recipient was rejected.

## Stored evidence corrected

605 legacy VALID labels had no recorded direct SMTP proof. They were backed up and reset to UNVERIFIED. Another eight legacy labels—three INVALID and five RISKY—had neither verification method nor reason and were also backed up and reset. Suppressed leads and recorded bounced outcomes are protected from that legacy cleanup.

65 records retain historical SMTP-backed VALID results, but all their proof has expired. The latest recorded check was 2 September 2026. The CRM now displays EXPIRED and requires rechecking before proven email export. This explains the current Ready count of zero; it is not a claim that these mailboxes stopped existing.

| Current stored status | Records |
|---|---:|
| UNVERIFIED | 11,606 |
| Historical VALID, expired | 65 |
| RISKY with SMTP evidence | 58 |
| UNKNOWN | 53 |
| INVALID with SMTP evidence | 3 |

Previous fields are preserved in `output/email-unproven-labels-before-2026-09-28.json` and `output/email-unsupported-legacy-status-before-2026-09-28.json`. No backlog-wide SMTP re-verification was run.

## What remains necessary

Move direct probes to a suitable host with a stable IP, outbound port 25, forward DNS and matching provider-managed PTR. Use a verifier-specific sender identity whose SPF authorizes that host. Verify the setup with a real/random recipient pair at each important recipient provider before rechecking the backlog. The local UI can remain on this machine; the probing transport would need to run on that host.

Alternatively, use a verification service as an additional evidence source while preserving its catch-all and unknown classifications. An authenticated sending relay is not automatically a recipient verifier: accepting relay submissions does not demonstrate that the destination mailbox exists.

No SMTP verifier can promise “never misses.” Receiving servers can conceal recipient validity, defer their decision until message delivery, or refuse the probe host. Robust behavior means retaining those leads with an honest UNKNOWN or RISKY result and a useful reason, rather than manufacturing VALID or INVALID. The observed Google behavior demonstrates that limit directly.

## Validation

TypeScript passes. The email verifier suite covers 18 scenarios using local SMTP fixtures, including a 100-address batch, DNS errors, partial MX recovery, early refusals, parser fragmentation, stalled controls, protocol fallback, host-cache isolation and persistence gates. Hunter engine/database checks and 22 source/discovery regression tests pass. Live TLS probes and the responsive CRM review provide additional integration evidence.

Run the deterministic verifier suite with `node scripts/verify-email-verifier.cjs`. Run the read-only stored-data audit with `node --env-file=.env.local scripts/email-verification-audit.cjs`; `--probe` adds controlled live envelope probes. `--reconcile-labels` explicitly enables backed-up legacy-label reconciliation.
