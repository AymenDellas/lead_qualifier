# Guided client onboarding

## Prepare before sharing

In Onboarding → Form, use **Read the current website** to reuse Copy Studio’s website extraction, offer selection, and field review. Alternatively choose a saved Copy Studio brief from this browser. No extraction is run automatically when a client opens their portal.

Apply and review the prefill, then **Save onboarding** before sharing the client link, or choose **Open local portal** to save and inspect the real client route. Missing facts may remain as explicit client questions; the final five essentials are still required before the client can confirm the offer. An unprepared portal shows a simple preparation message. Existing agreement and project URLs remain available.

The original source capture is retained with the prepared onboarding. When using this onboarding in Copy Studio, an explicit checkbox can attach that capture as the original voice/context reference. Existing Copy Studio references are replaced only when selected. Coach background, full proof, and requested changes also flow back into Copy Studio.

## Client flow

The client portal uses a centered column on one continuous light background. There is no navbar, sidebar, percentage dashboard, separate task list, or repeated scope section.

The welcome screen introduces the prepared brief with one action. Four focused screens follow:

1. **Your offer:** review the five essentials, with an individual Edit action for each answer. Missing facts appear as questions.
2. **Story & proof:** review short source-based previews of the coach's background, differentiation, and up to three attributed testimonial excerpts. Full originals are available on demand. Audience details, assets, preferences, and additional changes use optional disclosures.
3. **Going live:** choose the website manager and publisher, share the booking link, and reveal relevant contact, introduction, tool, or access details. Contact details expand and fade into place, with reduced-motion support. If another person manages or publishes the website, the coach must send the introduction in their email app and check **I’ve sent the introduction email and copied Aymen** before continuing. The portal records this confirmation; opening the email app alone does not count as sending. An unchecked confirmation opens the introduction automatically. Client and server checks enforce the requirement while allowing unfinished drafts to save.
4. **Scope & agreement:** review the deliverables, exclusions, timing, agreement PDF, applicable payment, and case-study permission. Scope confirmation and brief submission save atomically. Scope confirmation does not sign the agreement or verify publishing access.

Client edits to the short supporting summaries are stored separately under `journey.reviewSummaries`; automatic previews never overwrite original proof or background. Reviewed background and differentiation flow into Copy Studio, while proof corrections are included as explicit context alongside the complete original testimony. No additional AI request runs when a client opens their portal.

Answers and the current step save automatically and through explicit Save buttons. Saves are queued and revision checked. Failed saves preserve the visible draft and provide retry/copy recovery. Back navigation remains available without requiring a successful network save. Partial drafts can contain unfinished contact details; completion requires a valid contact when a website person is involved.

Legacy reporting, technical and preference fields remain stored. They are no longer separate client questions. Metrics can still be recorded in the internal baseline section. Existing signed documents and agreement terms retain their prior handling.

## Publishing handoff

Onboarding → Access contains the per-project access choices and Compel’s verification control. Domain connection is the default; website editing, booking configuration, email follow-up and tracking can be enabled for the actual scope.

If someone else manages the website, the coach gets an editable introduction with **Copy message** and **Open in email**. The mail draft goes to the provided contact and copies Aymen. Opening it does not send it or mark it as sent. The coach can explicitly report that they sent the introduction.

Contact details, an introduction, and a submitted brief never independently complete publishing readiness. Compel must confirm responsibility and verify the access or developer arrangement. Changing the contact, publisher, manager or relevant platforms reopens verification. Unneeded generated access requests are retained as non-blocking history; manual requests remain under operator control.

## Open the actual client portal locally

**Open local portal** opens the real `/portal/[token]` route on localhost, even when the configured sharing domain points to production. It saves an edited onboarding draft first, including its prefilled source, story and proof. Copy client link continues to use the configured public domain for sharing. A failed save leaves the draft in the editor and does not open a stale portal.

Applying a page prefill or Copy Studio brief marks that imported summary ready for client review; an additional approval click is not required. The real client must still confirm the five essentials. A genuinely empty, unsaved onboarding continues to show the preparation message. Local browser-only Copy Studio projects do not appear in a portal until they have been applied and saved to that client's onboarding.

Use the actual client route to review the process. Existing PDF documents and payment links retain their real behavior. Access receipts use the same revision-checked save queue as the answers. Baseline capture remains an internal Compel task. `journey.flowVersion: 3` distinguishes the welcome and four focused screens. Saved progress from the former final-review and agreement screens maps to the new last screen; unfinished website introductions return to Going live. Stored answers remain intact.

## Redesign verification · 2026-10-22

- Onboarding model, source preview, Copy Studio bridge, and isolated action tests cover source retention, summary corrections, old/new progress, consent, scope confirmation, and access receipt permissions.
- Browser checks use isolated sample data for all editing and submission actions. They cover desktop/mobile layouts, all screens, reload/resume, individual edits, missing answers, invalid contact details, introduction content, save recovery, access receipts, paid-client and unprepared states.
- The actual local client route is inspected read-only. No real client records are changed by the UI checks.
- Screenshots: `output/client-onboarding-redesign/`. Test logs: `tmp/onboarding-redesign-*`.

## Implementation and verification

The workflow is stored as optional versioned JSON under `onboarding.journey`; no new database tables or bulk record migration are needed. New standalone onboardings get the guided setup. Existing answers and legacy fields survive partial client saves. Only client-owned fields are accepted by the public save action; prepared-source data, required-access selections and internal verification flags are excluded.

Verified locally on 2026-10-21:

- 14 onboarding model/template tests and 9 isolated server-action tests passed.
- All 150 Copy Studio regression tests passed.
- TypeScript and the final production build passed.
- Browser checks covered saved Copy Studio prefill, approval, the existing website-prefill review dialog, all five client steps, missing essential validation, complete proof retention, publishing branches and email draft contents, and desktop/mobile layout.
- The real local portal displayed the unprepared-summary guard correctly.
- The browser walkthrough used unsaved client preview data. No real client records were edited, no email was sent, and no deployment was performed.

Screenshots: `output/onboarding-guided-2026-10-21/`. Test/build logs: `tmp/onboarding-guided-*`, `tmp/onboarding-actions-final.log`, and `tmp/onboarding-copy-studio.log`.
