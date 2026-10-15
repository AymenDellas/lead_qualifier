# Funnel Analyzer tab

The **Funnel Analyzer** lives under **Tools** in the Compel dashboard. It scans a public landing page and returns a conversion audit for the hero, copy, offer, page flow, CTA, proof, objections, and distractions. The scan API is part of this Next.js app at `/api/funnel-scan`; no second server is needed.

## Configuration

The Agent Router key is read only by the server. The browser never receives it.

- Local Next.js: set `AGENTROUTER_API_KEY` in the ignored `.env.local`.
- Docker Compose: set it in the ignored `.env.docker.local` overlay. Compose loads that file for the dashboard service only. This file is excluded from the Docker build context.
- Set `AGENTROUTER_MODEL=deepseek-v4-flash`. Leave `AGENTROUTER_FALLBACK_MODELS=` empty to use that model exclusively.

The tracked `.env.example` and `.env.docker.example` show the expected names without credentials. Do not put the live key in the tracked `.env.docker`.

Run `npm run check-env` after changing configuration. Existing unrelated drift may still be reported.

## Scope

The scan reads up to five public pages and their conversion destinations without submitting a form, making a purchase, or booking a call. Results are based on visible page content and public links; styling that requires a rendered browser and private funnel steps may need manual review.
