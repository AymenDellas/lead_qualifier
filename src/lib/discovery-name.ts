export type DiscoveryName = { firstName: string; lastName: string };

const CREDENTIALS = new Set([
    'acc', 'actc', 'ba', 'bare', 'bcc', 'ccp', 'ccsp', 'cec', 'cflc', 'ch', 'ches',
    'cpc', 'cphr', 'cpcc', 'cpqc', 'crha', 'cscmp', 'ed', 'edd', 'elimp', 'emccitca', 'gpcc',
    'icf', 'iom', 'jd', 'lsw', 'ma', 'mba', 'mcc', 'med', 'mpa', 'mpt', 'ms',
    'msc', 'msw', 'mdiv', 'nlp', 'pcc', 'phd', 'phr', 'pmp', 'shrmcp', 'shrmscp',
]);

/** Use the displayed profile name, never a guess from its URL or email address. */
export function extractDiscoveryName(title: string): DiscoveryName {
    const empty = { firstName: '', lastName: '' };
    let name = String(title || '')
        .replace(/&(?:amp|quot|apos|nbsp);/gi, entity => ({
            '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
        }[entity.toLowerCase()] || entity))
        .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
            const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
            return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
        })
        .replace(/\p{Cf}/gu, '')
        .replace(/\s+/g, ' ')
        .split(/[-–—]\s|[|•·♦]/u)[0]
        .replace(/\([^)]*\)/g, ' ')
        .split(',')[0]
        .replace(/^(?:(?:dr|mr|mrs|ms|prof)\.?\s+|["“']?coach["”']?\s+)+/i, '')
        .replace(/\s+["“][^"”]+["”]\s+/g, ' ')
        .replace(/^["“]+|["”]+$/g, '')
        .replace(/[\p{S}\uFE0F]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const words = name.split(' ');
    // Short credentials such as "MA" can also be a surname. Only strip them
    // after two name words; comma-separated credentials were already removed.
    const suffix = words.findIndex((word, index) => index >= 2 &&
        CREDENTIALS.has(word.toLowerCase().replace(/[.\-]/g, '')));
    if (suffix !== -1) name = words.slice(0, suffix).join(' ');
    // Some profile titles put the role directly after the name with no dash.
    // Require two name words before trimming it, so a business label such as
    // "Coacial Career Coaching" does not become a made-up person's name.
    const role = name.search(/\s+(?:(?:executive|career|business|life|leadership|professional|certified|food)\s+)*(?:coach|coaching)\b/i);
    if (role !== -1 && name.slice(0, role).split(' ').length >= 2) name = name.slice(0, role);
    name = name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV)$/i, '').trim();
    name = name.replace(/\b(\p{L}{2,})\.(?=\s|$)/gu, '$1');

    if (!name || name.length > 150 || /\d|\.\.\.|…/.test(name)
        || /\b(?:unknown|linkedin|profile|profiles|your|our|professional|business|career|executive|leadership|coach|coaching|consulting|branding|company|academy|founder|certified|services)\b/i.test(name)
        || !/^[\p{L}\p{M} .’'\-]+$/u.test(name)) return empty;

    const parts = name.split(' ');
    if (parts.length > 8 || !/\p{L}/u.test(parts[0])) return empty;
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
