const LINKEDIN_HOST = /(^|\.)linkedin\.com$/i;
const SHORT_LINK_HOST = 'lnkd.in';
const MAX_REDIRECTS = 3;

function parseAllowedUrl(value: string) {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Use a valid LinkedIn post URL or lnkd.in post link.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        (!LINKEDIN_HOST.test(url.hostname) && url.hostname !== SHORT_LINK_HOST)) {
        throw new Error('Use a valid LinkedIn post URL or lnkd.in post link.');
    }
    return url;
}

function isLinkedInPost(url: URL) {
    return LINKEDIN_HOST.test(url.hostname) &&
        (/^\/posts\/[^/]+\/?$/i.test(url.pathname) || /^\/feed\/update\/[^/]+\/?$/i.test(url.pathname));
}

export async function resolveCaseStudyPostUrl(
    value: string,
    request: typeof fetch = fetch,
): Promise<string> {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 2048) throw new Error('Use a valid LinkedIn post URL or lnkd.in post link.');
    let current = parseAllowedUrl(raw);
    if (isLinkedInPost(current)) return current.href;
    if (current.hostname !== SHORT_LINK_HOST) {
        throw new Error('This URL does not point to a LinkedIn post.');
    }

    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        let response: Response;
        try {
            response = await request(current.href, {
                method: 'GET',
                redirect: 'manual',
                cache: 'no-store',
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            throw new Error('Could not resolve the lnkd.in link. Try again or paste the full LinkedIn post URL.');
        }
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (response.status < 300 || response.status >= 400 || !location) {
            throw new Error('Could not resolve the lnkd.in link. Try again or paste the full LinkedIn post URL.');
        }
        current = parseAllowedUrl(new URL(location, current).href);
        if (isLinkedInPost(current)) return current.href;
        if (current.hostname !== SHORT_LINK_HOST) {
            throw new Error('This lnkd.in link does not open a LinkedIn post.');
        }
    }
    throw new Error('The lnkd.in link redirected too many times. Paste the full LinkedIn post URL.');
}
