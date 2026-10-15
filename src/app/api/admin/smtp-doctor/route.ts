import { NextResponse } from 'next/server';
import { getSmtpDiagnostic } from '@/app/actions/email-verifier-actions';
import dns from 'dns/promises';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const identityResolver = new dns.Resolver({ timeout: 5000, tries: 2 });

/** Diagnostic envelope only, using the production verifier's SMTP transport. */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const domain: string = body.domain || process.env.EMAIL_VERIFY_MAIL_FROM?.split('@')[1] || 'getcompel.co';
        const knownGoodLocal: string = body.knownGood || 'contact';

        // Both overridable so a candidate identity can be tested against a real
        // server before it is committed to DNS or the env files.
        const helo: string = body.helo || process.env.EMAIL_VERIFY_HELO || 'verify.revlane.io';
        const mailFrom: string = body.mailFrom || process.env.EMAIL_VERIFY_MAIL_FROM || 'verify@revlane.io';

        if (![domain, helo].every(value => typeof value === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value))
            || typeof knownGoodLocal !== 'string' || /[\r\n<>@]/.test(knownGoodLocal)
            || typeof mailFrom !== 'string' || /[\r\n<>]/.test(mailFrom)) {
            return NextResponse.json({ success: false, error: 'Use a valid domain, recipient and SMTP identity.' }, { status: 400 });
        }


        // --- identity checks: what this host looks like to a receiving server ----
        const identity: Record<string, unknown> = { helo, mailFrom };

        try {
            const addresses = await Promise.allSettled([identityResolver.resolve4(helo), identityResolver.resolve6(helo)]);
            const resolved = addresses.flatMap(answer => answer.status === 'fulfilled' ? answer.value : []);
            if (!resolved.length) throw new Error('No A/AAAA answer');
            identity.heloResolvesTo = resolved.join(', ');
        } catch {
            identity.heloResolvesTo = null;
            identity.heloProblem = `${helo} has no A/AAAA answer — many servers refuse a HELO hostname that does not resolve.`;
        }

        let publicIp: string | undefined;
        try {
            const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) });
            publicIp = (await res.text()).trim();
            identity.publicIp = publicIp;
        } catch { identity.publicIp = 'could not determine'; }

        if (publicIp) {
            try {
                identity.reverseDns = (await identityResolver.reverse(publicIp)).join(', ');
            } catch {
                identity.reverseDns = null;
                identity.ptrProblem = `${publicIp} has no PTR record. Receiving servers treat an IP with no reverse DNS as untrusted, and most consumer/mobile ranges cannot be given one.`;
            }
        }

        identity.heloMatchesPtr = Boolean(
            identity.reverseDns && identity.heloResolvesTo &&
            String(identity.reverseDns).split(', ').some(name => name.toLowerCase().replace(/\.$/, '') === helo.toLowerCase()) &&
            String(identity.heloResolvesTo).split(', ').includes(publicIp || ''));

        const probe = await getSmtpDiagnostic(`${knownGoodLocal}@${domain}`, helo, mailFrom);
        return NextResponse.json({ success: true, identity, verdict: probe.verdict, probe });
    } catch (error: any) {
        console.error('SMTP doctor failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
