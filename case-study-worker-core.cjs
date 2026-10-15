const { DEFAULT_TARGET_TITLES, normalizeTitles, qualifyHeadline } = require('./src/lib/case-study-qualification.cjs');

function detectHumanCheck(title, text, url = '') {
    const haystack = `${title || ''} ${text || ''} ${url || ''}`.toLowerCase();
    const checks = [
        ['Cloudflare challenge', /checking your browser|just a moment|cf-chl|cloudflare ray id/],
        ['Human verification', /verify you are human|human verification|are you a human|security verification/],
        ['CAPTCHA', /captcha|hcaptcha|recaptcha/],
        ['Access challenge', /enable javascript and cookies|attention required|access denied|unusual traffic/],
    ];
    return checks.find(([, pattern]) => pattern.test(haystack))?.[0] || '';
}

function pagePriority(url) {
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return String(url).toLowerCase(); } })();
    const ordered = [
        /work[-_/]?with[-_/]?me|coaching|services?/, /program|programme|offer/, /results?|case[-_/]?stud|testimonial/,
        /about/, /book|apply|contact|schedule/,
    ];
    const index = ordered.findIndex((pattern) => pattern.test(path));
    return index < 0 ? 99 : index;
}

const NON_WEBSITE_HOSTS = [
    'linkedin.com', 'licdn.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be',
    'twitter.com', 'x.com', 'tiktok.com', 'calendly.com', 'cal.com', 'credly.com',
];

function cleanEncodedUrl(value) {
    return String(value || '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/[\\"',;]+$/, '');
}

function decodeLinkedinRedirect(value) {
    let raw = cleanEncodedUrl(value);
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        if (host === 'linkedin.com' && /\/redir\/redirect/i.test(parsed.pathname)) {
            const target = parsed.searchParams.get('url');
            if (!target) return '';
            raw = target;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const decoded = decodeURIComponent(raw);
                    if (decoded === raw) break;
                    raw = decoded;
                } catch { break; }
            }
        }
    } catch { /* the normalizer below will reject malformed values */ }
    return raw;
}

function normalizeWebsiteCandidate(value) {
    let raw = decodeLinkedinRedirect(value);
    if (!raw || /^\/?scale_\d+_\d+\//i.test(raw)) return '';
    if (raw.startsWith('//')) raw = `https:${raw}`;
    if (!/^https?:\/\//i.test(raw)) {
        if (!/^(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) return '';
        raw = `https://${raw}`;
    }
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        if (!host.includes('.') || host.includes('_') || !/[a-z]/i.test(host)) return '';
        if (NON_WEBSITE_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return '';
        if (/\.(?:avif|gif|ico|jpe?g|png|svg|webp|mp4|mov|pdf|zip)(?:$|[?#])/i.test(parsed.pathname)) return '';
        parsed.hash = '';
        return parsed.href;
    } catch { return ''; }
}

function uniqueWebsites(values) {
    return [...new Set(values.map(normalizeWebsiteCandidate).filter(Boolean))];
}

function extractContactWebsites(payload) {
    const data = payload?.data || payload || {};
    const included = Array.isArray(payload?.included) ? payload.included : [];
    let websites = Array.isArray(data.websites) ? data.websites : [];
    for (const item of included) {
        if (!websites.length && Array.isArray(item?.websites)) websites = item.websites;
    }
    // LinkedIn has used both `url` and `label` for the actual website value.
    // The original worker accepts both; normalization rejects non-URL labels
    // such as "Personal" or "Company website".
    return uniqueWebsites(websites.map((website) => typeof website === 'string' ? website : website?.url || website?.label || ''));
}

function extractSummaryWebsites(profilePayload) {
    const included = Array.isArray(profilePayload?.included) ? profilePayload.included : [];
    const urls = [];
    for (const item of included) {
        const summary = typeof item?.summary === 'string' ? item.summary : '';
        if (!summary) continue;
        urls.push(...(summary.match(/https?:\/\/[^\s"'<>)\]]+/gi) || []).map((value) => value.replace(/[.,;:!?)]+$/, '')));
    }
    return uniqueWebsites(urls);
}

function extractFeaturedWebsites(payload) {
    const serialized = JSON.stringify(payload || {});
    const absoluteUrls = serialized.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
    return uniqueWebsites(absoluteUrls);
}

module.exports = {
    DEFAULT_TARGET_TITLES,
    detectHumanCheck,
    extractContactWebsites,
    extractFeaturedWebsites,
    extractSummaryWebsites,
    normalizeTitles,
    normalizeWebsiteCandidate,
    pagePriority,
    qualifyHeadline,
};
