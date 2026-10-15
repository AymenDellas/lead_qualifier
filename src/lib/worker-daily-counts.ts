import { pool } from './pg_setup';

let cache: { day: string; at: number; counts: { dailyQualified: number; dailyRejected: number; dailyReview: number; dailyNurture: number } } | undefined;

/** Saved CRM outcomes survive worker heartbeats, shutdowns and restarts. */
export async function savedDailyWorkerCounts() {
    const day = new Date().toISOString().slice(0, 10);
    if (cache?.day === day && Date.now() - cache.at < 15000) return cache.counts;
    const result = await pool.query(`SELECT
        count(*) FILTER (WHERE pipeline_status IN ('QUALIFIED','OUTREACH'))::integer AS qualified,
        count(*) FILTER (WHERE pipeline_status IN ('NOT_QUALIFIED','REVIEW','NURTURE'))::integer AS rejected
        FROM leads WHERE prospect_researched_at >= $1::timestamptz AND prospect_researched_at < $1::timestamptz + interval '1 day'`, [`${day}T00:00:00.000Z`]);
    const counts = { dailyQualified: result.rows[0]?.qualified || 0, dailyRejected: result.rows[0]?.rejected || 0, dailyReview: 0, dailyNurture: 0 };
    cache = { day, at: Date.now(), counts };
    return counts;
}
