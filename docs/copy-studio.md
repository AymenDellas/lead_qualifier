# Copy Studio

Copy Studio is a native dashboard tab under **Workspace**, beside Create. It includes Direct to Call, Lead Magnet, and Video Sales Letter templates; brief entry and source extraction; strategy and draft generation; claim checks; section editing and AI rewriting; undo; preview; ChatGPT landing-page design prompts; copy export; and project backup/import. Custom copy-generation prompts and AI Consultation are not included.

The dashboard owns its UI and API. The original `copy_generator` project and its server are not dependencies. The new stylesheet is scoped to `.copy-studio` and uses the dashboard's existing color and font tokens. The tab loads on first use and stays mounted when changing dashboard screens, so a running generation can finish without losing the draft.

## Client onboarding and offer focus

Choose **client onboarding** inside Copy Studio, search by client, project, or page URL, then review the answers to apply. Website matches are suggestions; multiple projects on the same website remain selectable. The studio reads only the client's offer, audience, problem, outcome, traffic/qualification context, and must-keep/avoid notes. Agency fees, agency deliverables, portal tokens, signatures, access data, and consent records are excluded from the response. No onboarding record is edited by Copy Studio.

Choose the onboarding/current offer, one specific offer, or a new offer. Each option keeps a separate brief within the copy project. Switching options starts a clean brief, and switching back restores previous edits. Creative direction and client notes are included in strategy, generation, and section rewrites. Changes to them mark an existing draft as outdated.

Page import is optional. It detects distinct offers and requires a choice when several offers are found. Extraction for a chosen offer uses only that offer's facts, backed by source quotes. Importing a different named offer starts a separate copy project with the reviewed fields and retains the original project. Unsupported or ambiguous offers are not silently substituted.

The selected onboarding's identity and revision are saved in browser storage and project backups. Opening the picker refreshes available answers; newer revisions are flagged for review. Existing version-2 backups remain supported.

## Direct to Call sections and headings

The Direct to Call outline now contains hero, problem, approach, call details, audience fit, **About me**, proof, objections, and the final CTA, in that order. Add the coach's approved name, relevant background, experience and qualifications in **Give the copy substance → Coach background & credentials**. Optional source extraction can populate that field for review using exact source quotes. Missing background leaves the public About me section empty and requests details in the writer's notes; the generator does not fabricate credentials or a personal story. Supplied background requires a populated introduction. The design prompt includes a distinct biography layout and an approved portrait when available.

Supporting headings now introduce their section clearly, for example “How I help,” “What the conversation covers,” “Who this is for,” and “About me.” They can be specific to the client, while the hero remains outcome-led and the final CTA action-led. These rules apply to generation and section rewrites. Existing eight-section drafts and backups remain readable/exportable; regenerate them to adopt the new outline and heading instructions.

## Original copy as a full reference

Generation combines the reviewed brief and onboarding answers, the full captured original copy, and the operator's creative direction. The original copy is supplied to strategy, drafting, claim repair, and section rewrites. It guides voice, vocabulary, rhythm, context, positioning and useful material. The approved brief controls factual claims, and requested changes guide the rewrite within those facts. Conflicting or outdated source details and other offers do not override the selected offer.

Choose **Start with an existing page → Use full copy as reference** to attach a URL or pasted copy while keeping every brief field unchanged. Reading and attaching the reference does not require an AI extraction request. **Extract offer facts** remains available when you want to review additional facts for the brief. Existing imported pages automatically become full references for subsequent generation.

The reference panel shows the captured text and lets you preserve the client's voice (default), rework the voice while retaining context, or turn the reference off. A specific voice instruction takes priority over the original voice; the generic default voice does not. URL import now recursively follows public same-origin links, including navigation and footer links, and discovers routes through sitemap indexes and robots-declared sitemaps. It starts with the supplied page and includes the homepage even when the supplied page has no link to it. About, testimonial, result and service routes become one reference with source-page URL markers. Other offers still require explicit selection; provider credentials and offer-specific proof remain subject to review.

Website coverage lists pages read, duplicates, unreadable/failed routes, pending routes and shortened text. Crawls are bounded at 100 page attempts, 2,000 discovered routes, 20 sitemap documents and two minutes, with three concurrent requests and per-request deadlines. Only public HTML is read; unlisted routes absent from links/sitemaps, JavaScript-only content, embedded content and login-protected pages cannot be guaranteed. External links, access/action routes and non-page assets are excluded. Every connection and redirect retains public-address validation and DNS pinning; discovered routes cannot redirect outside the final seed origin. The reference limit is now 240,000 characters, shared across pages so a long homepage cannot consume the entire budget, with a 24,000-character per-page ceiling. Limits and missing content are reported rather than presented as full coverage. The full retained reference passes through offer selection, strategy, generation and rewrites. For missing content, paste the visible copy. Existing saved references are not recrawled automatically; use Change to import the site again. The reference and coverage persist in project backups and browser storage. Changing the text or reference setting marks an existing draft as outdated.

## Landing page design prompt

After generating copy, open **Design prompt** beside Sections and Preview. It automatically combines the latest saved draft with its offer, audience, conversion goal, section-specific layout guidance, and design exclusions. **Copy design prompt** prepares it for ChatGPT; **Download prompt** saves a text file. There is no second AI request. Saved edits, section rewrites, undo, and project reloads all produce the matching prompt. When the brief changes, the prompt keeps the existing draft's generation snapshot until a new draft is generated.

When the generated draft includes an original-page reference, the design handoff also supplies its canonical public marketing-page URL for client asset research. Query strings and fragments are removed; credential-bearing URLs, private/literal hosts, nonstandard ports, common access paths and non-web URLs are excluded. The URL follows the draft's generation snapshot, so a new ungenerated reference cannot replace the saved draft's client. Raw source copy and private onboarding metadata remain excluded. The builder must verify the actual provider's identity before choosing a portrait and cannot import other offers or claims. The old page supplies identity and asset candidates, not the design quality target.

The prompt carries a shared quality standard in `shared/design-direction.ts`, with a distinct visual identity derived for each offer. Every handoff now requires a continuous dark canvas with readable light text. Offer-specific deep neutral or chromatic grounds, accents, typography, composition and atmosphere still vary; there is no shared palette or starter stylesheet. The approved reference establishes depth, hierarchy, type confidence and finish; its exact colors, font pair, centered hero, dots and spotlight geometry are not defaults. Linear, Vercel and Stripe identify a craft benchmark rather than a technology-brand skin to reuse. Reference assets and commercial claims cannot become client material.

Before coding, the builder interprets the audience, voice, message and conversion decision, considers three materially different directions, then selects and documents its strongest offer-specific identity internally. It defines its own actual palette, typography, hero geometry, background language, section rhythm and action treatment. A counterfactual check rejects choices that could be transferred unchanged to an unrelated offer. Where previous pages are available, the builder compares visual signatures and avoids unintended repetition. Different colors on an identical composition do not count as distinct designs.

The canvas remains coherent through the page, with transparent content sections and no alternating colored bands, tinted conversation panels or separate closing boxes. Light, dark and chromatic identities are valid. Purposeful light, material, texture, spatial lines, tonal falloff or authentic imagery can create depth; dots and overhead lighting are optional tools. There is no mandatory hero alignment, font family, colored-word treatment or closing layout. Supporting sections use one coherent content spine and readable measure, with prominent headings grouped directly above related text, lists and actions. Similar section roles reuse the same alignment and spacing grammar. There is no layout-variation quota: arbitrary zigzags, remote title/body columns, disconnected checklists and empty half-pages are excluded. Splits require a real content relationship, such as an approved portrait and biography or a working form and context. A meaningful second focal point can share the established reading axis. Navigation, mesh gradients, repeated cards, fabricated proof and competing actions remain excluded. Final copy, descriptive headings, paragraph breaks and section order remain exact; empty sections stay omitted and editorial notes stay private.

The builder must inspect actual desktop/mobile renders and check offer-specific identity, visible controlled depth, hierarchy, reading comfort, consistent section grouping and alignment, exact copy and functioning supplied interactions. Batch review compares first viewports and full-page silhouettes to catch template reuse. Named failures require revision and another capture. It must distinguish code checks from visual verification when rendering is unavailable. Missing assets and booking/form destinations must be supplied separately. The prompt guides the external builder; Copy Studio itself does not render or validate that external landing page or claim improved conversion rates.

## Configuration

The existing working Copy Studio provider settings were copied into the ignored `.env.local` and `.env.docker.local` files. Other AI features retain their original credentials. Compose already loads the Docker override for the dashboard service. No credentials are sent to the browser or included in project exports.

The optional variables are:

```dotenv
COPY_STUDIO_API_KEY=
COPY_STUDIO_BASE_URL=https://agentrouter.org/v1
COPY_STUDIO_MODEL=deepseek-v4-flash
COPY_STUDIO_TIMEOUT_MS=90000
```

Without a dedicated key, endpoint, or model, the corresponding `AGENTROUTER_*` setting is used. Use **Tools → Setup & storage → Test AI connection** to verify a real provider request. Restart the dashboard after environment changes.

AgentRouter uses the same pinned, genuine Qwen Code client as the working standalone tool. Tools, customizations, telemetry, and chat recording are disabled. The private temporary relay handles AgentRouter's null and billing stream frames while preserving real completion and error events. The CLI is resolved from the dashboard's own installation and included in Next.js standalone output; Docker also copies the full dependency tree.

## Saved projects

Projects use this browser's local storage at the dashboard address, under `compel:copy-studio:library:v2`. They are separate from lead and content databases. Saved project data from `localhost:3874` is not automatically accessible at `localhost:3000` because browser storage is scoped by origin. To bring an existing project over, export **Project backup** from the standalone tool, then choose **Tools → Import a project** in the dashboard. The file format is unchanged.

## Implementation

- `src/components/copy-studio/`: integrated workspace, review dialogs, persistence, and scoped styles.
- `src/lib/copy-studio/shared/`: schemas, templates, and deterministic copy checks; imports `zod/v4` without changing the dashboard's Zod 3 callers.
- `src/lib/copy-studio/server/`: generation, provider transport, safe URL extraction, and HTTP adapter.
- `src/app/api/copy-studio/[operation]/route.ts`: Node-runtime routes for onboarding selection, health, connection, generation, revision, import, and reading references.

The API enforces same-origin JSON requests, bounded request sizes, rate and concurrency limits, and a five-minute deadline. Response cancellation stops the active provider call. Extracted facts require source quotes and are applied only after review. A failed request preserves the previous completed draft. Automated claim checks are not exhaustive fact verification.

## Verification commands

```sh
npm run build
npm run test:copy-studio
npm run test:copy-studio:browser
```

Browser tests use Chrome and port 3000. Default tests use deterministic AI fixtures. Set `LIVE_AI=1` for the additional real connection/generation/export/reload test; it consumes provider credits. Browser screenshots are written to `tmp/copy-studio-screenshots/`. Existing dashboard files changed for this integration were copied to `backups/copy-studio-integration-2026-09-27/` before editing; no prior local changes were discarded.

## Verified integration

The final section-flow refinement on October 15, 2026 removed the layout-variation quota and per-section alignment changes. The prompt now keeps headings, introductions, lists and actions together on a stable supporting-content spine; real media/form relationships can justify a split. The three Codex demonstrations were updated and reviewed in full on desktop 1440×1000 and phone 375×844. All seven supporting sections on each page share their page's heading/body alignment, with 24px desktop and 22px phone heading/body gaps. Normal supporting copy is 20px desktop and 17–18px phone. No horizontal overflow, clipped or offscreen text was found. Exact copy and order, keyboard focus and all three demo booking destinations passed checks. The 55 shared/backend tests and production build including TypeScript validation passed; existing build warnings remain. Before-refinement HTML, prompt and full-page screenshots are retained alongside the new captures in the three-offer visualization folder. These remain Codex-built demonstrations; no external-provider rerun was performed for this refinement.

Later on October 15, 2026, the quality brief replaced the fixed atmospheric recipe after the user rejected its repetition across offers. It now requires an offer-specific identity, internal comparison of three directions, a counterfactual check and a batch distinctness review. No fixed palette, font pair, hero alignment, light/dot combination or starter stylesheet remains. All 55 shared/backend checks, TypeScript validation and the production build passed; existing finder-progress tracing and PostCSS module-type warnings remain.

Three illustrative Direct-to-Call offers were implemented in Codex from the revised prompt: Boardroom Voice (aubergine/lavender, architectural light planes and offset typography), Second Chapter (mineral green, daylight folds and centered editorial rhythm), and Endurance Reset (forest/acid yellow, trajectory lines and a wide athletic composition). These are Codex-authored demonstrations, not successful unmodified external-provider generations. Three parallel provider calls timed out, a minimal provider/client probe failed, and a serial retry was canceled; external-provider validation of this revision remains unconfirmed. Exact copy, paragraph breaks, heading order, three supplied demo destinations and empty-proof omission passed checks. Desktop 1440×1000 and mobile 375×844 were visually inspected and had no horizontal overflow, offscreen text or clipped text. Keyboard focus and the local booking action passed for all three. The comparison gallery, per-offer prompt/implementation snapshots, source metadata, viewport checks and screenshots are saved under `three-offer-design-test-2026-10-15` in the visualization workspace. The demo booking destination collects no data.

The following earlier atmospheric-recipe test is historical and was superseded by the offer-specific quality brief above. After visual approval on October 15, 2026, that atmospheric direction replaced the earlier light-canvas/artwork instructions. All 55 shared/backend checks, TypeScript validation and the production build passed. The build retains the existing finder-progress tracing and PostCSS module-type warnings.

A separate illustrative first-time-manager offer, **First 90 Days**, was sent through the actual final design prompt to the configured `deepseek-v4-flash` model. Supplied local Outfit/Inter font files and a local demo booking destination were the only implementation assets. One incomplete response and one timed-out attempt were rejected; the completed test used a compact-output instruction and captured the genuine client's complete assistant message. The final HTML is byte-for-byte the model's extracted document, with no manual copy, CSS or layout changes. Exact copy, paragraph breaks, heading order, three CTA destinations and omission of empty proof passed checks. Desktop 1440×1000 and mobile 375×844 screenshots covered the hero and full page: all eight content sections have transparent backgrounds, the atmospheric light and selective highlights transferred, the approach statement provides a second focal point, and there was no horizontal overflow, offscreen content or clipped text. The primary action stayed within the first viewport. Keyboard focus and the demo booking link were exercised. This is a configured-model test, not a ChatGPT run or a guarantee about every external builder. Raw output, final prompt, verification data and screenshots are in the visualization workspace under `approved-prompt-leadership-test-2026-10-15`; the approved original preview remains separate.

On October 15, 2026, the design prompt was revised against the reported flat, repetitive output. The final code passed 54 shared/backend checks, including source-URL privacy and snapshot isolation, plus TypeScript validation and the production build. Both focused design-prompt browser workflows also passed during the iteration. Existing lead-finder tracing and module-type warnings remain.

A live `deepseek-v4-flash` verification generated baseline and revised HTML using copy from the reported page, without an original portrait asset. The revised render was rejected for its dark flat hero, awkward wrapping and oversized support panel. The delivered reference includes local frontend refinement after actual browser inspection; an external refinement request returned an empty response. It is not a one-shot model result or proof that ChatGPT will reproduce it automatically. The refined sample preserved the supplied headings, paragraphs, bullets, CTA labels and section order, with no invented proof. Desktop 1440×1000 and mobile 375×844 had no horizontal overflow or clipped text; the primary action was visible in the first viewport at both sizes. Keyboard focus and a local demonstration booking destination were exercised. The sample uses original abstract SVG artwork and embedded project fonts. Preview, screenshots, verification notes and a design-only revision prompt are saved in the task's visualization workspace under `copy-studio-design-preview-2026-10-15`.

On October 14, 2026, the design-prompt art-direction update passed all 52 shared/backend checks, both focused design-prompt browser workflows, TypeScript validation and the production build. Clipboard copying, downloads, saved edits, undo, reload, mobile controls and stale-brief isolation were verified. The active development dashboard picked up the updated prompt. No external builder run or landing-page conversion test was performed; rendered review is an instruction for the builder. Existing lead-finder tracing and module-type warnings remain.

On October 14, 2026, the About me section, approved biography field, descriptive heading rules, legacy-draft compatibility and design handoff passed 52 shared/backend checks and all 22 browser workflows. One browser assertion was updated to the new descriptive fixture heading and its workflow rerun successfully; the optional live-provider browser test was skipped. A separate real-provider draft returned the nine-section outline with descriptive titles and a factual coach introduction, with zero automated issues. Desktop/mobile biography rendering, TypeScript validation and the production build passed. Existing lead-finder tracing and browser-profile packaging warnings remain.

On October 13, 2026, the automatic design-prompt handoff passed 45 shared/backend checks and 20 browser workflow tests. Clipboard copying, text download, saved copy edits, undo, reload, and stale-brief isolation were verified. Desktop/mobile visual inspection and the production build passed. The optional live-provider browser test was skipped because the new prompt does not make a provider request. Existing lead-finder tracing and locked browser-profile packaging warnings remain.

On October 12, 2026, the full original-copy reference pipeline passed 40 backend tests and 18 browser workflow tests (the optional live-provider browser test was skipped). A separate real-provider draft retained requested original wording and voice, used the reviewed audience, and omitted outdated pricing and the unrelated offer, with zero automated issues. Desktop/mobile controls were visually inspected. TypeScript validation and the production build passed. Existing lead-finder file-tracing and locked browser-profile packaging warnings remain.

On October 12, 2026, onboarding selection and offer focus were verified with 35 backend tests, 15 browser workflow tests, desktop/mobile visual inspection, and live-provider detection and targeted extraction of a two-offer sample. The production build passed. Existing file-tracing and locked browser-profile packaging warnings remain in the lead-finder routes.

On September 27, 2026:

- Production build, including TypeScript validation: passed.
- Backend regression tests: 28 passed.
- Browser workflow tests against the production dashboard: 11 passed, including project backup/import, mobile layout, retained drafts, cancellation, and generation across tab switches.
- Additional real-provider browser test: passed for connection, full page generation, export, and reload.
- AgentRouter connection from the packaged standalone server: passed. Its bundled client was present and executed successfully.

The local dashboard is running the production build on port 3000. Production credentials are supplied at runtime, not packaged into the build. The local standalone launch uses Node's `--env-file=../../.env.local` from `.next/standalone`, with the generated static assets and public directory copied alongside it. Docker already supplies these assets and environment settings through its existing configuration.

A development-server restart after changing the build root exhausted memory in its CSS workers. Those preview processes were stopped and the generated development cache was preserved as `.next/dev-before-copy-studio-root`. Final browser verification used the production server, which does not run the development compiler.
