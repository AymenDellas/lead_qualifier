# Create: AI-led content studio

The default workflow is **Generate today's post → preview → refine → approve/copy → publish manually**. No source notes or per-post brief are required. Existing saved posts remain available in Saved posts.

## What guides the AI

Your direction stores audience, offer, topics, beliefs, voice, CTA intent, and optional example posts. Defaults are provided for Compel; setup is optional. New AI ideas and generated drafts follow this direction.

## Idea bank and AI usage

Explore ideas opens the saved bank without a provider request. Eighteen prepared starter angles are available immediately, alongside all previously generated AI ideas. Search, three-card pagination, viewing already drafted ideas, and rejecting an idea or draft do not call the model. Starter ideas focus on coaching-funnel problems; they are editorial starting points, not measured conversion winners.

Generate more ideas is a separate, explicitly labelled AI action. It requests three ideas and persists them for future reuse; an exact repeated angle reuses its existing record instead of duplicating it. Rejected angles stay hidden. Used ideas remain available under All saved ideas or Already drafted.

Generate today's post selects an unused bank idea and goes directly to drafting, removing the separate idea-generation request. Write this drafts the selected saved idea, including one used before. If the bank is exhausted, the user can reuse an angle or explicitly generate more; there is no automatic paid refill. Provider retries for incomplete JSON still apply to a drafting request. Writing and rewriting drafts consume AI credits.

Approvals, rejected ideas/drafts, and successful revision requests are stored as editorial preferences. Those preferences and recent post history are supplied to subsequent model calls. They describe taste, not measured content performance. Undoing an AI revision removes that revision from preference memory.

## Research and evidence

Source fields are optional. A supplied URL is fetched once before drafting. With source material and no selected bank idea, the drafting call chooses the strongest supported angle itself; it does not make a separate idea-generation call. Real funnel breakdowns recheck a relevant saved funnel or search with the existing `SERPER_API_KEY_1` / `SERPER_API_KEY`, then fetch public page text. Search snippets alone are not treated as page evidence. If no public example can be verified, the default workflow makes an illustrative principle post and records that fallback in Sources & reasoning. User-supplied URLs that fail return an error instead of silently substituting another source.

The existing AgentRouter environment configuration powers both ideas and copy. No new required environment variables or packages were added. Prompts separate style references, editorial instructions, and source evidence; they prohibit fabricated client results, citations, and personal experiences.

## Draft storage and editing

Generated posts and manual fragments persist immediately. Copy edits autosave after a brief pause; UI operations flush pending edits before changing drafts. Optimistic timestamps prevent an older request or slow model revision from overwriting a newer edit. The last 12 AI versions are retained for undo. Failed generations leave the previous post intact. Editing or restoring a post revokes approval.

Text, carousel, and video script formats are supported. Copy uses the same hook/body/CTA composition as preview, including compatibility with older drafts. Carousel slides have a typographic preview and individual 1080 × 1350 PNG exports; exports fit all copy or ask the user to split an overlong slide rather than truncating it.

### Miro video recording plans

Short video scripts generate a 3–5 scene Miro walkthrough, targeting 60–90 seconds. The result includes recording setup, a cohesive visual style, exact text and placement for each visual element, drawn arrows, spoken words, approximate timing, and cursor/zoom/pan cues. Each scene is designed as a finished, flat image that the user generates, pastes into Miro and records. New plans do not depend on constructing editable board objects or moving individual elements.

The model writes the spoken words as one connected explanation before splitting them into scenes. Generation and revisions ask for conversational sentences, natural contractions and transitions that carry the same thought or example forward. **Make it flow naturally** applies that direction to an existing video draft through the normal revision/undo workflow. It preserves the core argument, supported facts and useful visuals; human voice is not a reason to invent personal stories or claims.

The frame view pairs “Say this” with “Put on the board” and “While you say it”. Copy script exports only spoken words, Copy recording plan exports the full setup and scene instructions, and each frame has a board-text copy action. Edit script & board changes the individual beats and their instructions. AI revisions and undo retain the plan alongside the script. Selecting a different hook updates the opening beat without changing the remaining scenes. Older script-only drafts offer Add Miro recording plan.

**Copy image prompt** provides one ready-to-paste image-generation prompt for all scenes. It asks for separate finished landscape PNG images with exact text, placements, drawn arrows, and consistent colours, typography and spacing. It explicitly requests image generation without Miro connectors, board creation, code or editable artifacts. If the receiving image generator supports only one output, the prompt requests a contact sheet of separated scene panels for cropping. View full image prompt lets you inspect it before copying. The prompt follows specific styling in the saved layout and updates automatically after edits or undo. Existing saved video plans receive it too, without another AI request; legacy object descriptions are treated as graphics inside the images, and rehearsal-only reveal covers are omitted. Copy recording plan also includes this prompt. The user generates the images externally and pastes them into Miro.

`video-plan.js` supplies the schema, prompt, nested validation and text export. The middle-frame scripts are the source for the saved body; hook and closing line stay synchronized with the first and final frame. Incomplete generated plans fail before replacing a saved post. Script-only body edits cannot silently diverge from a saved plan.

**Teleprompter** opens a reading popup with the complete spoken script, including the opening and closing, without board instructions. It has adjustable text size and approximate words-per-minute scrolling, start/pause, restart, horizontal mirroring, elapsed time and progress. Space toggles playback when the reading area has focus; R restarts. Manual scrolling pauses automatic scrolling, and closing the popup restores the workspace. It works with current edits and older script-only videos too; opening it flushes pending saves and does not call the AI.

**Separate window** opens the same reader in a resizable browser popup at `/teleprompter`, so it can sit beside Miro while recording. A short-lived browser-local handoff passes only the title and spoken script; the receiver removes that local-storage entry and keeps a session copy for reload. No script is placed in the URL or sent to an external service. A blocked popup leaves the in-page reader available with a recovery message. The separate window contains a snapshot of the script at the moment it was opened; reopen it after changing the draft.

“This works” approves the current draft and saves a preference. Copy does not publish. Planned dates are reminders in the library, not a publishing integration. “I published this” records a manual publication.

New mutations use `content-create-actions.ts`, backed by `studio.js`. The existing content-create API remains available for compatibility. Storage continues to use `CONTENT_CREATE_DB_PATH` or `data/content-studio.json` and adds a `feedback` collection plus a `creative-direction` settings record.

## Verification

Run `node --test scripts/verify-content-studio.mjs` for isolated tests covering generation, preferences, fragments, approval invalidation, revision/undo, provider failures, concurrent edits, verified research/fallback, source-led ideation, carousel completeness, publication, and legacy copy composition. These tests use temporary databases and a model stub; they do not spend credits or modify user content. Use the local UI separately for live provider and visual checks.
