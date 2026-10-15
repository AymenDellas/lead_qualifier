import dns from 'node:dns/promises';
import type { MxRecord } from 'node:dns';

export type MailDomainResult = {
    status: 'OK' | 'NO_MAIL' | 'TEMP_ERROR';
    records: MxRecord[];
    reason: string;
};
type Lookup = Pick<dns.Resolver, 'resolveMx' | 'resolve4' | 'resolve6'>;
const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });
const cache = new Map<string, { result: MailDomainResult; expires: number }>();
const pending = new Map<string, Promise<MailDomainResult>>();
const definitiveAbsence = (error: unknown) => ['ENOTFOUND', 'ENODATA'].includes((error as NodeJS.ErrnoException)?.code || '');

/** DNS outages are retryable, never evidence that an address is invalid. */
export async function lookupMailDomain(domain: string, lookup: Lookup = resolver): Promise<MailDomainResult> {
    try {
        const records = await lookup.resolveMx(domain);
        // Some DNS libraries represent the root exchange as an empty string.
        if (records.some(record => record.priority === 0 && (!record.exchange || record.exchange === '.'))) {
            return { status: 'NO_MAIL', records: [], reason: 'Domain publishes a null MX: it explicitly does not accept email' };
        }
        const usable = records.filter(record => record.exchange && record.exchange !== '.')
            .sort((a, b) => a.priority - b.priority);
        if (usable.length) return { status: 'OK', records: usable, reason: 'MX records found' };
    } catch (error) {
        if (!definitiveAbsence(error)) return { status: 'TEMP_ERROR', records: [], reason: `MX lookup failed temporarily (${(error as NodeJS.ErrnoException).code || 'DNS error'}); retry later` };
    }
    // RFC 5321 implicit MX applies only when MX is absent, not on DNS failures.
    const addresses = await Promise.allSettled([lookup.resolve4(domain), lookup.resolve6(domain)]);
    if (addresses.some(answer => answer.status === 'fulfilled' && answer.value.length > 0)) {
        return { status: 'OK', records: [{ exchange: domain, priority: 0 }], reason: 'Implicit MX via A/AAAA' };
    }
    if (addresses.some(answer => answer.status === 'rejected' && !definitiveAbsence(answer.reason))) {
        return { status: 'TEMP_ERROR', records: [], reason: 'Address lookup failed temporarily; retry later' };
    }
    return { status: 'NO_MAIL', records: [], reason: 'Domain has no MX or A/AAAA mail destination' };
}

export async function resolveMailDomain(domain: string): Promise<MailDomainResult> {
    const key = domain.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.result;
    if (pending.has(key)) return pending.get(key)!;
    const request = lookupMailDomain(key).then(result => {
        if (result.status !== 'TEMP_ERROR') {
            if (cache.size >= 5000) cache.delete(cache.keys().next().value!);
            cache.set(key, { result, expires: Date.now() + (result.status === 'OK' ? 6 * 3600000 : 5 * 60000) });
        }
        return result;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
}
