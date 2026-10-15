# Lead Finder targets

The target is the number of unique profiles kept in the run after the existing discovery scorer and minimum-score filter. A target of 3,000 can require scoring more than 3,000 candidates. Repeated accepted URLs and rejected results do not consume the target. The engine stops inside a result page as soon as the kept target is met.

The saved run `find-1791050608159` completed all 210 original country queries: 2,976 scored, 1,718 kept, 1,258 rejected, 749 search credits. Its shortfall came from exhausting the query bank, not a cap on scored candidates.

For US and Canada searches, the engine now searches the original country bank, alternate country wording, then a reserve across US states/DC and Canadian provinces/territories if needed. Each reserve query retains the requested title and a country constraint. Original location and first-touch discovery provenance remain attached to each lead. Other locations use their original search bank.

Pages per query and minimum score are preserved in every phase. Geographic expansion spends additional search credits only while the kept target is still unmet. The search plan is finite: when available queries are exhausted, the result explicitly reports a shortfall instead of claiming the target was reached. Provider failures report an error. Manual stop remains available.

Search keys use round-robin failover within each run. HTTP 400 with “Not enough credits”, or invalid/unauthorized keys, disable that key for the remainder of the run and immediately try another configured key. Temporary rate limits, network failures and service errors also try other keys before bounded retries. A genuine malformed request stops immediately. If every key is unavailable, the actual provider reason appears in a visible error above Start searching. Missing saved jobs also clear stale reconnect state so a fresh search can start.

Progress carries `target`, `remaining`, `searchPhase`, and `searchArea`. Final stats distinguish `target_reached`, `search_exhausted`, and `cancelled`, and retain the actual number of queries searched. `kept_leads_target` is the explicit API field; the older `max_urls_target` remains supported. Completed runs export every kept profile; live progress shows a rolling tail of 50.

On Windows, Finder progress and cancellation files live under `%LOCALAPPDATA%/Compel/lead-finder/<project-hash>`, outside the OneDrive workspace. Other platforms keep the existing `queue-results` path. Older workspace snapshots remain readable. Progress writes use unique temporary files, atomic replacement, and bounded asynchronous retries for `EPERM`, `EACCES`, and `EBUSY`. Updates are awaited in order. If persistence remains unavailable, the shared live cache continues serving progress and the next update retries saving; a progress checkpoint failure cannot abort discovery or bypass required CRM saves. This cache survives development module reloads, but not a server restart.

Run `node scripts/verify-lead-finder.cjs` for the real engine with simulated search responses, including the 3,000-kept scenario, exact stopping, duplicates, geographical scope, score floor, four-page limit, cancellation, provider failure, and injected temporary/persistent file locks. These checks use no search credits and write no CRM records.
