# Worker target attachment — 28 October 2026

The installed and lockfile-pinned Puppeteer / Puppeteer Core version is **24.38.0**. Its `ConnectOptions` declaration and CDP connector support `targetFilter`; no dependency upgrade is required. The option is also documented by [Puppeteer's official ConnectOptions reference](https://pptr.dev/api/puppeteer.connectoptions). Both AliasMode connection paths now reject the CDP target kinds `worker`, `service_worker` and `shared_worker` while retaining page, browser, tab and unrelated target kinds.

In this pinned release, a dedicated CDP `worker` is exposed by the public `target.type()` as `other`. The predicate therefore reads the pinned target's `_getTargetInfo().type`, with the public type as a fallback. Checking only the public type would miss dedicated workers. The fixture covers this mapping, both connection paths, and ordinary non-worker targets.

**Keep `Runtime.enable` for pages.** Puppeteer requires it to track execution contexts. The adapter does not suppress, replace or intercept that command, change browser globals, or inject stealth code. A real local Chrome fixture confirms that a dedicated worker still executes and returns its result while Puppeteer does not track it, and that page evaluation works across navigations. The fixture disconnects its launcher connection before the adapter attaches so a second, unfiltered Puppeteer connection cannot affect the worker observation.

## Anonymous before/after measurement

The explicitly requested measurement used one newly created blank AliasMode Chromium profile, visible mode, the production browser adapter and isolated PostgreSQL diagnostic leases. The control removes only `targetFilter` from the adapter's connect options. The second run uses the adapter's normal filtered options. Both execute the unchanged `DIRECT_SIGNALS_V2` detector battery and its existing verdict logic. No mapped LinkedIn browser is opened, and LinkedIn/LICDN requests from detector pages are blocked.

| DeviceAndBrowserInfo observation | Unfiltered | Worker filter |
| --- | --- | --- |
| `isAutomatedWithCDPInWebWorker` | `true` | **`false`** |
| `isAutomatedWithCDP` | `true` | `true` |
| `isBot` | `true` | `true` |
| All 22 other reported boolean flags | Identical | Identical |
| All seven direct browser checks | Identical | Identical |
| Overall unchanged detector gate | FAIL | FAIL |

The requested worker flag changed from true to false with every other flag on that same detector unchanged. [DeviceAndBrowserInfo's detector page](https://deviceandbrowserinfo.com/are_you_a_bot) documents its separate main-context and worker CDP signals. This does not make the browser undetectable or change the detector's FAIL verdict.

Across the full external battery, the control recorded 5 PASS / 1 FAIL / 1 UNKNOWN endpoints; the filtered run recorded 6 PASS / 1 FAIL / 0 UNKNOWN. Sannysoft timed out during control navigation and completed in the filtered run. JA3 hashes and the original-order JA4 variants also differed between TLS requests; canonical JA4 and sorted `ja4_r` were identical. These observations are retained rather than described as completely identical external runs. The script's strict full-battery `acceptance` remains false and it exits with status 1 to disclose those differences. There was no retry to obtain a preferred result.

The disposable blank profile was confirmed closed, then deleted through the official CLI after verifying that it was newly created and unmapped. The original profile roster was restored. Before/after hashes confirm that actual account intent, holds, pending controls and session evidence are unchanged. John's consumed experiment and restriction hold remain unchanged.

Reproduction command: `node scripts/engine-worker-target-comparison.cjs --run`. This is a separate anonymous diagnostic, not permission to open a mapped account or resume processing. It verifies pinned option support before creating a profile and records missing or positive signals without converting them into passes.

Private full evidence is in ignored `data/engine-v2/worker-target-filter/comparison-44035fdc-579e-4262-9c45-25294285d584.json` and `comparison-latest.json`. PostgreSQL benchmark `worker-target-filter-5cd333e9-1701-4272-a6f8-ced7b6ccb944` has state `DIAGNOSTIC_COMPLETE`, kind `worker-target-comparison`, two measured runs and zero lead jobs; that state describes a completed measurement, not a passing detector verdict.

Focused verification: 23/23 adapter/support/worker/comparison fixture tests passed. Scoped ESLint passed. Full repository verification and frozen-evidence replay are recorded with the surrounding session changes.
