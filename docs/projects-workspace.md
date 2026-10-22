# Projects and client delivery

Projects continues the existing onboarding record. It reuses the agreed scope,
client identity, access checklist, portal token and seeded deliverables. Existing
projects do not need to be recreated. Legacy deliverables stay private until an
admin explicitly shares them.

## Admin workflow

1. Open Projects and choose a client. Search by client or project, or filter by phase.
2. Add the actual deliverable content, a preview/document link, or files. Save
   new items before adding files. Check **Share this deliverable with the client**
   and choose **Ready for your review** when approval is needed.
3. In Client requests, describe what the client should supply and select answer,
   link, file, or any format. Add a deadline if needed. Submitted responses appear
   in the review count. Mark them complete or send clarification with **Please
   update your response**.
4. In Remaining setup, assign tasks to Compel or the client. Client reports move
   tasks to **Waiting for verification**; the admin verifies and completes them.
   Existing access requests remain managed through onboarding.
5. Save changes and copy the Client workspace link. No email is sent automatically.

Scope & notes shows agreed inclusions/exclusions and outstanding preparation.
Private notes remain admin-only. Saved items cannot be removed accidentally:
close requests or unshare deliverables instead.

## Client workflow

The existing private portal links to `/portal/[token]/project`. The client can
see next actions, shared deliverables, requests, setup ownership, and scope.
They can submit responses/files and approve or request changes to the exact
deliverable version shown. Changes require a comment. A content, link, visibility,
or file change creates a new version and invalidates previous approval. Review
history remains in the admin workspace.

Portal actions derive project ownership from the token, never a client-supplied
project ID. Revoking/rotating the existing portal token also revokes project and
file access. Internal notes, private deliverables, fees, and internal project data
are excluded from client props. No contract is signed by approving a deliverable.

## Files and persistence

An additive `business_project_files` table stores bytes separately from project
JSON; metadata only goes to the UI. Files are limited to 3 MB and 100 active files
per project. Larger files should be shared through a link. Downloads require
admin authentication or the owning portal token and use attachment/no-store/
nosniff headers. Removing a deliverable file archives it. Client submissions are
retained with their request. Files are not virus scanned.

Project writes lock the row and increment its revision. Stale admin writes,
stale client responses, and stale approvals are rejected. Client input remains
in the form on errors and across project tabs; refreshed data is loaded after a
successful submission. The workspace does not currently send notifications or
poll for updates: admins use Refresh updates, and clients reload their portal.

## Verification

- `npm run test:projects`: domain transitions, legacy/privacy behavior, exact
  review versions, response preservation, setup verification, real file bytes,
  ownership, admin authentication, stale writes and upload limits.
- `npm run test:onboarding`, `npm run test:sign`, `npm run test:auth`:
  existing onboarding/authentication regressions.
- `npm run test:copy-studio`: existing copy generation regressions.
- `npx tsc --noEmit`, `npm run build`: full application checks.

Browser verification uses a clearly labelled disposable project; real client
answers, approvals and agreements must not be changed as test data.
