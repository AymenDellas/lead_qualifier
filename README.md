# CompelOS

Next.js dashboard with a PostgreSQL CRM and local Puppeteer qualification agent.

- Dashboard: `npm run dev`.
- Local qualification agent: `npm run worker`; graceful stop: `npm run worker:stop`.
- Manual sign-in and account controls: local dashboard → LinkedIn accounts.
- Architecture, daily cap, followers, configuration and recovery: [docs/engine-v2.md](docs/engine-v2.md).
- Audit and measurements: [docs/engine-audit.md](docs/engine-audit.md), [docs/engine-measurements.md](docs/engine-measurements.md).
- Optional Windows start at sign-in: [docs/windows-agent.md](docs/windows-agent.md).

PostgreSQL remains the only queue/state store. Persistent Chrome profiles stay on the worker computer. Worker features, browser launch and account controls are unavailable on Vercel; deploy only the dashboard there. Configure required credentials locally without committing `.env` files or secrets.
