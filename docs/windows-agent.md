# Windows agent at sign-in

Run `npm run worker` from the project directory. One persistent Node process owns account runtimes, bounded database saves, two public research tasks and at most one LinkedIn Chrome by default. `npm run worker:stop` requests a graceful PostgreSQL stop. Saved processing intent resumes on the next start; Pause and account security holds persist.

Optional start at Windows sign-in: in Task Scheduler choose **Create Task**, run only when your Windows user is logged on (manual LinkedIn sign-in needs an interactive desktop), and add an **At log on** trigger for that user. Action: the full path returned by `where.exe node`; arguments: `--max-old-space-size=384 "C:\path\to\leads_qualiferV2\worker.cjs"`; **Start in**: the project directory. Select **Do not start a new instance** and disable the task's execution time limit. Do not use highest privileges. No scheduled task is installed automatically by this change.

The dashboard's Start workers button launches the same agent through the compatibility entry point `scripts/linkedin-worker-supervisor.cjs`. It never spawns an account process. The fixed local launch endpoint is unavailable on Vercel and when `WORKER_LAUNCH_DISABLED=1`.

Startup diagnostics appear per account as REQUEST_RECEIVED, AGENT_ACK, BROWSER_STARTING, SESSION_VERIFIED and PROCESSING. FAILED includes the stage, reason and recovery action. The service launch marker also records database/lock failures before PostgreSQL can be reached. These local files contain process diagnostics only; PostgreSQL remains the queue and state store.

Automatic recovery requires a confirmed-dead PID and an expired heartbeat, or an explicit graceful release. Unknown ownership never permits removal of Chrome Singleton locks. Saved profile cookies are retained. Do not manually remove a live profile lock.
