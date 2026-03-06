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
