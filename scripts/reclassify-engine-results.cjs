'use strict';
// Reuse saved evidence only: no browser, AI, SMTP or outbound requests.
const fs = require('node:fs');
const path = require('node:path');
const { assessProspect, pipelineForAssessment } = require('../src/lib/prospect-qualification.cjs');

function planLead(lead, hasFreshSmtpProof, now) {
    const saved = lead.prospect_assessment;
    if (!saved?.research) return null;
    const assessment = assessProspect(saved.baseResearch || saved.research, {
        review: lead.prospect_review, email: lead.email, emailProven: hasFreshSmtpProof(lead), now,
    });
    // Preserve stages managed outside engine qualification.
    const stage = ['INBOX', 'QUALIFIED', 'REVIEW', 'NURTURE', 'NOT_QUALIFIED'].includes(lead.pipeline_status)
        ? pipelineForAssessment(assessment) : lead.pipeline_status;
    return { id: lead.id, previousStage: lead.pipeline_status, stage, assessment };
}

function summary(plans, rows, now) {
    const day = now.slice(0, 10);
    const todayIds = new Set(rows.filter(row => new Date(row.prospect_researched_at).toISOString().slice(0, 10) === day).map(row => row.id));
    return {
        researched: plans.length,
        previouslyQualified: plans.filter(p => p.previousStage === 'QUALIFIED').length,
        qualified: plans.filter(p => p.stage === 'QUALIFIED').length,
        todayResearched: todayIds.size,
        todayQualified: plans.filter(p => todayIds.has(p.id) && p.stage === 'QUALIFIED').length,
        stagesChanged: plans.filter(p => p.stage !== p.previousStage).length,
    };
}

async function main() {
    require('@next/env').loadEnvConfig(process.cwd());
    require('tsx/cjs/api').register();
    const { pool } = require('../src/lib/pg_setup.ts');
    const { hasFreshSmtpProof } = require('../src/lib/email-verification-proof.ts');
    const apply = process.argv.includes('--apply');
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT * FROM leads WHERE prospect_assessment IS NOT NULL
            ORDER BY id ${apply ? 'FOR UPDATE' : ''}`);
        const plans = rows.map(row => planLead(row, hasFreshSmtpProof, now)).filter(Boolean);
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', ...summary(plans, rows, now) }));
        if (!apply) { await client.query('ROLLBACK'); return; }
        const backupDir = path.join(process.cwd(), 'backups', 'engine-recovery');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, `before-${now.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(backupPath, JSON.stringify({ savedAt: now, rows }, null, 2), { flag: 'wx' });
        for (const plan of plans) {
            await client.query('UPDATE leads SET prospect_assessment=$2::jsonb, pipeline_status=$3 WHERE id=$1',
                [plan.id, JSON.stringify(plan.assessment), plan.stage]);
        }
        // Every other CRM field must remain byte-for-byte equivalent as JSON.
        const after = await client.query('SELECT * FROM leads WHERE id = ANY($1::text[]) ORDER BY id', [rows.map(row => row.id)]);
        const protectedRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['pipeline_status', 'prospect_assessment'].includes(key)));
        if (after.rows.length !== rows.length || after.rows.some((row, i) => JSON.stringify(protectedRow(row)) !== JSON.stringify(protectedRow(rows[i])))) {
            throw new Error('Recovery changed an unrelated CRM field; rolling back.');
        }
        await client.query('COMMIT');
        console.log(`Recovered saved engine results. Backup: ${backupPath}`);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) main().catch(error => { console.error('Engine recovery failed:', error.message); process.exitCode = 1; });
module.exports = { planLead, summary };
