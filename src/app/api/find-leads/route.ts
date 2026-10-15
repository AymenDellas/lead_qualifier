import { NextResponse } from 'next/server';
import { runDorkEngine, buildDiscoverySearchPlan, keptLeadTarget, SearchConfig, type DiscoveredLead, type DorkProgress } from '@/lib/dorkEngine';
import { DEFAULT_MIN_FIT_SCORE } from '@/lib/discovery-score';
import { insertDiscoveryProvenance } from '@/lib/db';
import { createFinderProgressStore } from '@/lib/finder-progress';

export const dynamic = 'force-dynamic';

const progressStore = createFinderProgressStore({
    onPersistenceError: (jobId, code) => console.warn(`[find-leads] ${jobId}: progress checkpoint ${code}; continuing with live progress.`),
});

/** Last N accepted leads kept in the progress file, newest first. */
const RESULTS_TAIL = 50;

const writeProgress = (jobId: string, payload: Record<string, unknown>) => progressStore.write(jobId, payload);

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const {
            job_titles, locations, kept_leads_target, max_urls_target, max_pages_per_dork,
            negative_keywords, min_fit_score,
        } = body;

        const validList = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 30
            && value.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 100);
        if (!validList(job_titles) || !validList(locations))
            return NextResponse.json({ error: 'Enter at least one job title and location (up to 30 each).' }, { status: 400 });
        const config: SearchConfig = {
            job_titles: [...new Set<string>(job_titles.map((value: string) => value.trim()))],
            locations: [...new Set<string>(locations.map((value: string) => value.trim()))],
            kept_leads_target: kept_leads_target ?? max_urls_target ?? 500,
            // Google's index for a single dork is effectively exhausted by page 3-5;
            // deeper pages mostly re-serve profiles already seen, which is why the
            // engine's 3-dry-pages abort trips so often. Paging to 20 bought almost
            // nothing and cost a Serper credit per page per template.
            max_pages_per_dork: max_pages_per_dork ?? 4,
            negative_keywords: negative_keywords ?? [],
            min_fit_score: min_fit_score ?? DEFAULT_MIN_FIT_SCORE,
        };
        let target: number;
        try {
            target = keptLeadTarget(config);
            if (!Number.isSafeInteger(config.max_pages_per_dork) || config.max_pages_per_dork! < 1 || config.max_pages_per_dork! > 10)
                throw new Error('Pages per search must be a whole number from 1 to 10.');
            if (!Number.isFinite(config.min_fit_score) || config.min_fit_score! < 0 || config.min_fit_score! > 100)
                throw new Error('Minimum score must be from 0 to 100.');
            if (!Array.isArray(config.negative_keywords) || !config.negative_keywords.every(value => typeof value === 'string' && value.length <= 100))
                throw new Error('Negative keywords must be a list of text values.');
        } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid search settings.' }, { status: 400 });
        }

        const apiKey = [
            process.env.SERPER_API_KEY_1, process.env.SERPER_API_KEY_2,
            process.env.SERPER_API_KEY_3, process.env.SERPER_API_KEY_4,
            process.env.SERPER_API_KEY_5, process.env.SERPER_API_KEY_6,
            process.env.SERPER_API_KEY_7, process.env.SERPER_API_KEY_8,
        ].filter(Boolean) as string[];

        if (apiKey.length === 0) {
            return NextResponse.json({ error: 'Missing SERPER_API_KEY environment variables' }, { status: 500 });
        }

        const jobId = `find-${Date.now()}`;
        config.run_id = jobId;
        const totalQueries = buildDiscoverySearchPlan(config).length;
        await progressStore.clearCancel(jobId);
        await writeProgress(jobId, {
            status: 'running', target, remaining: target,
            found: 0, scored: 0, rejected: 0, creditsSpent: 0,
            totalQueries, queryIndex: 0, currentQuery: '', searchPhase: 'country',
            config, results: [],
        });

        // Fire-and-forget background task. It owns the progress file from here on;
        // `heartbeatAt` on every write is what lets a poller tell "still working" from
        // "the process died and left this at running forever".
        Promise.resolve().then(async () => {
            const tail: DiscoveredLead[] = [];
            let latest: Partial<DorkProgress> = { target, remaining: target, found: 0, scored: 0, rejected: 0, creditsSpent: 0, queryIndex: 0, query: '' };

            try {
                const { leads, stats } = await runDorkEngine(
                    config,
                    apiKey,
                    async (p) => {
                        latest = p;
                        await writeProgress(jobId, {
                            status: 'running',
                            ...latest,
                            currentQuery: p.query,
                            templateId: p.templateId,
                            totalQueries,
                            config,
                            // A rolling tail rather than nothing. Writing the whole set on
                            // every tick was the reason this was left empty for the entire
                            // run, which made the live results list permanently blank.
                            results: tail,
                        });
                    },
                    async (lead) => {
                        // Write-through so a run that dies halfway still leaves its leads
                        // in the CRM. Provenance is first-touch — see insertDiscoveryProvenance.
                        try {
                            await insertDiscoveryProvenance({
                                linkedin_url: lead.url,
                                location: lead.location,
                                query: lead.query,
                                templateId: lead.templateId,
                                niche: lead.niche,
                                discoveryLocation: lead.location,
                                page: lead.page,
                                rank: lead.rank,
                                title: lead.title,
                                snippet: lead.snippet,
                                runId: lead.runId,
                                fitScore: lead.fitScore,
                                fitReasons: lead.fitReasons,
                            });
                        } catch (e: any) {
                            console.error('[find-leads] provenance insert failed:', e?.message);
                            throw new Error('A kept lead could not be saved to the CRM. Discovery stopped; previously saved leads are retained.');
                        }
                        tail.unshift(lead);
                        if (tail.length > RESULTS_TAIL) tail.pop();
                    },
                    () => progressStore.cancelled(jobId),
                );

                await writeProgress(jobId, {
                    status: stats.cancelled ? 'cancelled' : 'done',
                    target, remaining: Math.max(0, target - stats.kept),
                    targetReached: stats.targetReached, stopReason: stats.stopReason,
                    found: stats.kept,
                    scored: stats.scored,
                    rejected: stats.rejected + stats.belowFloor,
                    creditsSpent: stats.creditsSpent,
                    totalQueries,
                    queryIndex: stats.queriesCompleted,
                    searchPhase: latest.searchPhase, searchArea: latest.searchArea,
                    config,
                    stats,
                    // Live progress stays small; the finished export contains every kept profile.
                    results: leads,
                });
            } catch (err: any) {
                await writeProgress(jobId, {
                    status: 'error',
                    error: err?.message || String(err),
                    ...latest,
                    totalQueries,
                    config,
                    results: tail,
                });
            } finally {
                await progressStore.clearCancel(jobId);
            }
        });

        return NextResponse.json({ success: true, jobId, totalQueries, target });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/**
 * Cancels a running discovery job.
 *
 * The shared live cache receives the stop request immediately. A flag file also
 * reaches background tasks across development module reloads and older runs.
 */
export async function DELETE(req: Request) {
    try {
        const jobId = new URL(req.url).searchParams.get('jobId');
        if (!jobId || !/^find-\d+$/.test(jobId)) {
            return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });
        }
        await progressStore.cancel(jobId);
        return NextResponse.json({ success: true, cancelling: jobId });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
