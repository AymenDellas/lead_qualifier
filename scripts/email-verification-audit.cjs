// Read-only by default. --reconcile-labels backs up and resets unsupported VALID labels.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/lib/pg_setup.ts');
const { revokeUnprovenEmailLabels } = require('../src/lib/db.ts');
const { syncHunterContacted } = require('../src/lib/hunter-contact-sync.ts');
const output = path.join(__dirname, '..', 'output');
fs.mkdirSync(output, { recursive: true });
(async () => {
    const before = await pool.query(`SELECT id,email_status,email_verification_method,email_verification_reason,
        email_verification_score,email_verified_at,email_verification_expires_at FROM leads
        WHERE email_status='VALID' AND (email_verification_method IS DISTINCT FROM 'SMTP_DIRECT'
            OR email_verified_at IS NULL OR email_verification_expires_at IS NULL)`);
    let reset = 0;
    const previousPath = path.join(output, 'email-verification-audit-2026-09-28.json');
    const previous = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : {};
    if (process.argv.includes('--reconcile-labels')) {
        const backup = path.join(output, 'email-unproven-labels-before-2026-09-28.json');
        if (before.rows.length && !fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(before.rows, null, 2));
        const legacy = await pool.query(`SELECT id,email_status,email_verification_method,email_verification_reason,
            email_verification_score,email_verified_at,email_verification_expires_at FROM leads
            WHERE email_status IN ('INVALID','RISKY') AND email_verification_method IS NULL
                AND NULLIF(TRIM(email_verification_reason),'') IS NULL
                AND COALESCE(outcome,'')<>'BOUNCED' AND do_not_contact IS NOT TRUE`);
        const legacyBackup = path.join(output, 'email-unsupported-legacy-status-before-2026-09-28.json');
        if (legacy.rows.length && !fs.existsSync(legacyBackup)) fs.writeFileSync(legacyBackup, JSON.stringify(legacy.rows, null, 2));
        reset = await revokeUnprovenEmailLabels();
    }
    const counts = await pool.query(`SELECT email_status,COALESCE(email_verification_method,'none') AS method,COUNT(*)::int AS count
        FROM leads GROUP BY email_status,email_verification_method ORDER BY count DESC`);
    const refusals = await pool.query(`SELECT COUNT(*)::int AS count FROM leads
        WHERE email_verification_reason ILIKE '%spamhaus%'`);
    const hunter = process.argv.includes('--reconcile-labels') ? await syncHunterContacted() : null;
    const report = { ...previous, timestamp: new Date().toISOString(), unsupportedValidInitially: previous.unsupportedValidInitially ?? previous.unsupportedValidBefore ?? before.rows.length,
        unsupportedValidRemaining: before.rows.length - Math.min(before.rows.length, reset),
        labelsReset: (previous.labelsReset || 0) + reset, lastResetCount: reset, hunterMatches: hunter?.memberIds.size, hunterUpdated: hunter?.updated,
        storedSpamhausRefusals: refusals.rows[0].count, statusCounts: counts.rows };
    if (process.argv.includes('--probe')) {
        const { getSmtpDiagnostic } = require('../src/app/actions/email-verifier-actions.ts');
        report.ownDomainProbe = await getSmtpDiagnostic(process.env.EMAIL_VERIFY_MAIL_FROM);
        const blocked = await pool.query(`SELECT email FROM leads
            WHERE email_verification_reason ILIKE '%spamhaus%' AND email<>'' ORDER BY email_verified_at DESC LIMIT 1`);
        if (blocked.rows[0]) report.previouslyBlockedProbe = await getSmtpDiagnostic(blocked.rows[0].email);
    }
    fs.writeFileSync(previousPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, ownDomainProbe: report.ownDomainProbe && {
        verdict: report.ownDomainProbe.verdict, stages: report.ownDomainProbe.dialogue.map(step => [step.command.split(' ')[0],step.code]),
    }, previouslyBlockedProbe: report.previouslyBlockedProbe && {
        verdict: report.previouslyBlockedProbe.verdict, result: report.previouslyBlockedProbe.result,
        stages: report.previouslyBlockedProbe.dialogue.map(step => [step.command.split(' ')[0],step.code]),
    } }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
