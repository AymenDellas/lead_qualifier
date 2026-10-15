import "server-only";
import { resolveMailDomain } from './email-dns';

/** Server-only MX prefilter used while generating possible addresses. */
export async function verifyEmailDomain(email: string): Promise<boolean> {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;

    // A temporary DNS failure must not erase a possible address during discovery.
    return (await resolveMailDomain(domain)).status !== 'NO_MAIL';
}
