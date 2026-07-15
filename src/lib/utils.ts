import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function cleanUrl(url: string): string {
    if (!url) return '';
    // Remove double extensions or redundant query params that look like .com.com
    let cleaned = url.replace(/\.com\.com/g, '.com');
    cleaned = cleaned.replace(/\.net\.net/g, '.net');
    cleaned = cleaned.replace(/\.io\.io/g, '.io');
    return cleaned;
}

export function extractEmails(text: string): string[] {
    // A more permissive regex that catches more valid emails. 
    // We rely heavily on `validateEmail` below to filter out the false positives.
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63})/g;
    const matches = text.match(emailRegex) || [];
    return [...new Set(matches.map(e => e.toLowerCase()))];
}

export function validateEmail(email: string): boolean {
    const e = email.toLowerCase().trim();

    // Basic format check
    if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,6}$/.test(e)) return false;

    const [local, domain] = e.split('@');
    if (!local || !domain) return false;

    // Local part checks
    if (local.length < 2) return false;
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

    // Domain checks
    const parts = domain.split('.');
    if (parts.length < 2) return false;
    const tld = parts[parts.length - 1];
    if (tld.length < 2 || tld.length > 6) return false;
    // Domain name (without TLD) should be at least 2 chars
    if (parts[0].length < 2) return false;

    // Reject file extensions that look like emails
    const badTlds = ['js', 'ts', 'css', 'png', 'jpg', 'gif', 'svg', 'woff', 'woff2', 'ttf', 'map', 'json', 'xml', 'html', 'htm', 'jsx', 'tsx', 'mjs', 'cjs'];
    if (badTlds.includes(tld)) return false;

    // Reject internal/tracking domains
    const badDomains = ['linkedin.com', 'licdn.com', 'microsoft.com', 'google.com', 'googleapis.com', 'gstatic.com', 'sentry.io', 'example.com', 'test.com', 'localhost'];
    if (badDomains.some(d => domain.includes(d))) return false;

    // Reject placeholder/generic patterns
    const badLocalParts = ['noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster', 'webmaster', 'hostmaster', 'abuse'];
    if (badLocalParts.includes(local)) return false;

    return true;
}

/**
 * Verify an email domain has valid MX records (DNS check).
 * Returns true if the domain can receive email.
 * Safe to call from server actions only (uses Node dns module).
 */
export async function verifyEmailDomain(email: string): Promise<boolean> {
    try {
        const dns = await import('dns');
        const domain = email.split('@')[1];
        if (!domain) return false;
        return new Promise((resolve) => {
            dns.resolveMx(domain, (err, addresses) => {
                if (err || !addresses || addresses.length === 0) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    } catch {
        return false;
    }
}

/**
 * Generate common email guesses from a first name, last name hint, and domain.
 * Returns a list of plausible email addresses to verify.
 */
export function guessEmails(firstName: string, domain: string, lastName?: string): string[] {
    if (!firstName || !domain) return [];
    const f = firstName.toLowerCase().trim();
    const d = domain.toLowerCase().replace(/^www\./, '').trim();

    // Don't guess for generic platforms
    const skipDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
        'icloud.com', 'aol.com', 'protonmail.com', 'mail.com',
        'squarespace.com', 'wix.com', 'wordpress.com', 'godaddy.com',
        'shopify.com', 'webflow.io', 'carrd.co', 'notion.so'];
    if (skipDomains.some(s => d === s || d.endsWith('.' + s))) return [];

    const guesses = [
        `${f}@${d}`,
        `hello@${d}`,
        `info@${d}`,
        `contact@${d}`,
    ];

    if (lastName) {
        const l = lastName.toLowerCase().trim();
        guesses.push(
            `${f}.${l}@${d}`,
            `${f}${l}@${d}`,
            `${f[0]}${l}@${d}`,
        );
    }

    return [...new Set(guesses)];
}

/** Common contact page paths to guess when crawling a website */
export const CONTACT_PAGE_PATHS = [
    '/contact', '/contact-us', '/about', '/about-us', '/about-me',
    '/get-in-touch', '/connect', '/reach-out', '/work-with-me',
    '/hire-me', '/coaching', '/consulting', '/services',
    '/lets-talk', '/book', '/book-a-call', '/schedule',
    '/work-together', '/say-hello', '/enquiry', '/inquiry',
    '/support', '/help', '/faq', '/team', '/people', '/staff',
    '/privacy', '/legal', '/imprint', '/impressum', '/footer',
];

/** Priority keywords for sorting internal links (contact-likely pages first) */
export const LINK_PRIORITY_KEYWORDS = [
    'contact', 'about', 'team', 'people', 'staff', 'connect', 'reach',
    'get-in-touch', 'enquir', 'work-with', 'hire', 'coaching', 'consult',
    'lets-talk', 'book', 'schedule', 'services', 'work-together',
    'say-hello', 'privacy', 'legal', 'faq', 'support', 'help',
    'info', 'footer', 'imprint',
];

export function extractLinkedInName(url: string): string {
    if (!url) return '';
    try {
        const trimmed = url.trim();
        // Extract the core name part from various formats
        const match = trimmed.match(/linkedin\.com\/in\/([^\/\s?#]+)/i);
        if (match && match[1]) {
            return `https://www.linkedin.com/in/${match[1]}`;
        }

        // Handle cases where only the name might be provided
        if (!trimmed.includes('.') && !trimmed.includes('/')) {
            return `https://www.linkedin.com/in/${trimmed}`;
        }

        return trimmed;
    } catch (e) {
        return url;
    }
}

export function normaliseLinkedinUrl(url: string): string | null {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        if (!urlObj.hostname.includes('linkedin.com')) return null;
        
        // Return exactly https://linkedin.com/in/slug (or similar)
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2 && pathParts[0] === 'in') {
            return `https://www.linkedin.com/in/${pathParts[1]}`;
        }
        return null;
    } catch {
        return null;
    }
}
