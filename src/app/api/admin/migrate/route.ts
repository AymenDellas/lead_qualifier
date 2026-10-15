import { NextResponse } from 'next/server';
import { createSchema, verifySchema } from '@/lib/pg_setup';

export const dynamic = 'force-dynamic';

/**
 * Applies the current schema to the live database: adds any missing columns and
 * indexes, and carries retired pipeline stages forward. Everything in
 * `createSchema()` is idempotent, so running this twice is a no-op.
 *
 *   curl -X POST http://localhost:3000/api/admin/migrate
 *
 * The response reports what is actually in the database afterwards, not merely
 * that the DDL ran without throwing. Those are different claims, and the gap
 * between them is silent: a server still running a build from before a schema
 * change executes the *old* `createSchema()`, applies nothing, and reports
 * success entirely truthfully. The failure then surfaces much later, as an
 * inserter blowing up on a column that was supposedly migrated. If this returns
 * `missingColumns`, restart the server so it picks up the new schema and re-run.
 */
export async function POST() {
    try {
        await createSchema();
        const verification = await verifySchema();

        return NextResponse.json({
            success: verification.ok,
            message: verification.ok
                ? `Schema is up to date (${verification.columnCount} columns).`
                : 'Migration ran but the schema is incomplete — is the server running an older build? Restart it and re-run.',
            ...verification,
        }, { status: verification.ok ? 200 : 500 });
    } catch (error: any) {
        console.error('Migration failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
