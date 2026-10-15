/**
 * Tier-A discovery scoring — a prioritiser, not a gate.
 *
 * ## What this can and cannot know
 *
 * A Serper result is a headline and roughly 160 characters of snippet. None of the
 * three ICP signals is observable in it:
 *
 *   - "actively posting"  lives in the Voyager activity feed
 *   - "sells a paid offer" lives on their website
 *   - "solo operation"     is a weak guess at best from a headline
 *
 * So this score is explicitly *not* the ICP filter — that belongs at the worker,
 * where those signals actually exist. What it does is kill obvious junk cheaply
 * and rank the INBOX, so the worker's scarce daily budget (400 profiles/day
 * against a five-figure backlog) is spent on the best candidates first. That
 * ranking is re-tunable at any time and applies retroactively to every row that
 * has a score, which a hard filter at discovery time would not.
 *
 * ## Scoring shape
 *
 * Surviving the hard rejects is itself weak evidence — the URL is a real profile,
 * the headline parsed, it matched the niche, it carries no blocklisted term and
 * isn't employer-shaped — so it earns a small base. Everything else is additive.
 *
 * The practical ceiling is ~83, not 100. That is deliberate: the weights were
 * chosen for what each signal is worth relative to the others, and inflating them
 * to reach a round number would only make the scale look more precise than it is.
 * Only the ordering matters, and the Phase 5 calibration query buckets by decile.
 *
 * Pure and side-effect free, so it can be exercised against saved SERP fixtures.
 */
import { segmentsFromText } from './prospect-qualification.cjs';

export interface ScoreReason {
    /** Stable weight id (A1…A11) so `fit_reasons` stays readable after a re-weighting. */
    id: string;
    /** Points contributed. Negative for penalties. */
    w: number;
    /** What actually matched, for auditing a score by eye. */
    hit?: string;
}

export interface NicheMatcher {
    /** Exact niche phrases, lowercased (e.g. "business coach"). */
    phrases: string[];
    /** Role stems, lowercased (e.g. "coach", "coaching"). */
    roleWords: string[];
}

export interface ScoreInput {
    /** Headline parsed out of Google's title tag; null when it could not be parsed. */
    headline: string | null;
    title: string;
    snippet: string;
    /** How many distinct templates have surfaced this profile (A8). */
    seenCount?: number;
}

export type RejectCode =
    | 'no_headline_match'
    | 'negative_keyword'
    | 'employer_shaped';

export interface DiscoveryScore {
    score: number;
    reasons: ScoreReason[];
    /** Non-null means do not write the row at all. */
    reject: RejectCode | null;
    /** Preserved for callers that still branch on the old relevance signal. */
    confidence: 'high' | 'low' | 'none';
}

/** Surviving every hard reject is worth a little on its own. See the header. */
const BASE_SCORE = 10;

/**
 * The write floor. "Matched a role word and nothing else" scores BASE + A2 = 22,
 * so 20 admits that case and excludes anything weaker. Cheap insurance against
 * filling the table with junk; the real selectivity is the queue ordering.
 */
export const DEFAULT_MIN_FIT_SCORE = 20;

// ── Signal vocabularies ───────────────────────────────────────────────
// Kept as plain arrays rather than one fused regex so a match can name itself in
// `fit_reasons` — a score you cannot explain is a score you cannot tune.

/** A3 — first-person offer language. The strongest headline-level solo signal. */
const FIRST_PERSON_OFFER = [
    'i help', 'i work with', 'i support', 'i partner with', 'i guide',
    'i teach', 'i coach', 'i show', 'helping', 'i empower',
];

/** A4 — owner markers. */
const OWNER_MARKERS = [
    'founder', 'co-founder', 'cofounder', 'owner', 'self-employed', 'self employed',
    'independent', 'private practice', 'sole trader', 'solopreneur', 'proprietor',
];

/** A5 — the offer itself being named in the headline. */
const OFFER_MARKERS = [
    '1:1', '1-1', 'one-on-one', 'one to one', 'mastermind', 'program', 'programme',
    'book a call', 'work with me', 'clients', 'coaching packages', 'retreat',
    'discovery call', 'strategy session',
];

/** A6 — coaching credentials. Weak paid-offer evidence, but cheap and specific. */
const CREDENTIAL_PATTERN = /\b(icf|pcc|acc|mcc|cpc|cpcc|acsth|accredited|certified)\b/;

/** A11 — the headline is advertising a vacancy, not a service. */
const HIRING_MARKERS = [
    'hiring', "we're looking for", 'we are looking for', 'join our team',
    'now recruiting', 'we are recruiting', 'open role', 'job opening',
];

/**
 * Corporate function words used only by the employer-shape reject. Deliberately
 * narrow — most obvious cases (recruiter, software engineer, sales manager) are
 * already blocklisted upstream, so this only needs to catch the residue.
 */
const CORPORATE_FUNCTIONS = /\b(vp|vice president|head of|senior manager|general manager|account manager|operations manager|regional manager|analyst|associate director|department)\b/;

/** A7 — a domain token in the snippet, which usually means they linked their site. */
const DOMAIN_TOKEN = /\b([a-z0-9][a-z0-9-]{1,60}\.(?:com|co|io|net|org|me|coach|us|ca|au|nz|ie|uk|life|biz|academy|consulting))\b/;
const DOMAIN_TOKEN_IGNORE = /^(linkedin|lnkd|bit|google|goo|facebook|instagram|twitter|youtube|t)\./;

function includesAny(haystack: string, needles: string[]): string | null {
    for (const n of needles) if (haystack.includes(n)) return n;
    return null;
}

function wordMatch(haystack: string, word: string): boolean {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
}

/**
 * Scores one SERP result.
 *
 * `negativeKeywords` are matched against the parsed headline only — never injected
 * into the query string, where a `-"term"` would drop any profile whose indexed
 * page mentions the term anywhere and cost far more good leads than it saves.
 */
export function scoreDiscoveryResult(
    input: ScoreInput,
    niche: NicheMatcher,
    negativeKeywords: string[] = [],
): DiscoveryScore {
    const reasons: ScoreReason[] = [];
    const headline = (input.headline || '').toLowerCase().trim();
    const snippet = (input.snippet || '').toLowerCase();
    const rawTitle = input.title || '';

    const reject = (code: RejectCode): DiscoveryScore =>
        ({ score: 0, reasons, reject: code, confidence: 'none' });

    // ── Hard reject: blocklisted term in the headline ──
    if (headline) {
        const declaredTargetCoach = segmentsFromText(headline).length > 0;
        for (const neg of negativeKeywords) {
            if (wordMatch(headline, neg.toLowerCase())) {
                // "Former recruiter | Career Coach" can be an excellent prospect.
                // A declared target coaching role needs business review, not rejection on background.
                if (!declaredTargetCoach) return reject('negative_keyword');
                if (!reasons.some(r => r.id === 'A13')) reasons.push({ id: 'A13', w: -4, hit: 'mixed professional role; confirm independent practice' });
            }
        }
    }

    // ── Niche relevance (A1 / A2) ──
    // A1 and A2 are mutually exclusive: an exact phrase already implies the role
    // word, and paying for both would double-count one piece of evidence.
    let confidence: DiscoveryScore['confidence'] = 'none';

    if (headline) {
        // A single-word "phrase" that is itself a role word is not stronger evidence
        // than the role word — it is the same evidence counted at twice the weight.
        // Searching the niche "Coach" made every role-word match score A1/high, which
        // silently disabled the employer-shape reject (it only fires on a bare role
        // word). A single-word niche that is *not* a role stem — "Nutritionist" —
        // still earns A1, because there it is the only signal available.
        const roleWordSet = new Set(niche.roleWords);
        const phraseHit = niche.phrases.find(p =>
            p && headline.includes(p) && (p.includes(' ') || !roleWordSet.has(p)),
        );
        if (phraseHit) {
            reasons.push({ id: 'A1', w: 25, hit: phraseHit });
            confidence = 'high';
        } else {
            const roleHit = niche.roleWords.find(rw => rw && wordMatch(headline, rw));
            if (roleHit) {
                reasons.push({ id: 'A2', w: 12, hit: roleHit });
                confidence = 'low';
            } else {
                // A headline that parsed but matches nothing is a decisive no.
                return reject('no_headline_match');
            }
        }
    } else {
        // No headline parsed. Fall back to title+snippet, but never award A1 from
        // it — the snippet is page text, not a stated job, so an exact phrase there
        // is far weaker evidence than the same phrase in a headline.
        const fullText = `${rawTitle.toLowerCase()} ${snippet}`;
        const hit = niche.phrases.find(p => p && fullText.includes(p))
            || niche.roleWords.find(rw => rw && wordMatch(fullText, rw));
        if (!hit) return reject('no_headline_match');
        reasons.push({ id: 'A2', w: 12, hit });
        confidence = 'low';
    }

    // ── Employer shape: penalise by default, reject only when unambiguous ──
    //
    // "Coach at Vodafone Business" is an employee; "Executive Coach at Smith
    // Coaching" is the ICP, and both have the same `at <Capitalised>` shape. The
    // errors are not symmetric: a false reject loses the profile permanently,
    // because a rejected result is never written and nothing records that it was
    // seen, while a false accept only misranks a row that the worker's own gate
    // will judge properly later. So the shape is graded, not fatal.
    //
    // Two guards apply to both: an exact niche phrase is never touched (that is
    // someone stating the practice as their identity), and any owner or
    // first-person marker means they run the thing regardless of who is named.
    const employerShaped = confidence === 'low' && /\bat\s+[A-Z]/.test(rawTitle);
    if (employerShaped) {
        const ownsIt = includesAny(headline, OWNER_MARKERS) || includesAny(headline, FIRST_PERSON_OFFER);
        if (!ownsIt) {
            // Reject only with a corporate function word *in the headline itself* —
            // "Head of Learning at Acme" is not a practice by any reading. The
            // snippet is deliberately not consulted: it is page text, so a
            // "People also viewed" entry or a testimonial would reject the lead
            // on someone else's job title.
            if (CORPORATE_FUNCTIONS.test(headline)) return reject('employer_shaped');
            // Otherwise just push it down the queue.
            reasons.push({ id: 'A12', w: -12, hit: 'employed at a named company' });
        }
    }

    // ── A3 / A4 — solo signals, jointly capped ──
    // Both describe the same underlying fact (this is one person's practice), so
    // an uncapped 27 would let headline flourish outrank real niche relevance.
    const firstPerson = includesAny(headline, FIRST_PERSON_OFFER);
    const owner = includesAny(headline, OWNER_MARKERS);
    if (firstPerson && owner) {
        // 15 + 12 capped to 20, taken off the weaker of the two.
        reasons.push({ id: 'A3', w: 8, hit: firstPerson });
        reasons.push({ id: 'A4', w: 12, hit: owner });
    } else if (firstPerson) {
        reasons.push({ id: 'A3', w: 15, hit: firstPerson });
    } else if (owner) {
        reasons.push({ id: 'A4', w: 12, hit: owner });
    }

    // ── A5 — the offer named outright ──
    const offer = includesAny(headline, OFFER_MARKERS) || includesAny(snippet, OFFER_MARKERS);
    if (offer) reasons.push({ id: 'A5', w: 10, hit: offer });

    // ── A6 — credential ──
    const credential = headline.match(CREDENTIAL_PATTERN);
    if (credential) reasons.push({ id: 'A6', w: 5, hit: credential[1] });

    // ── A7 — they linked a site of their own ──
    const domain = snippet.match(DOMAIN_TOKEN);
    if (domain && !DOMAIN_TOKEN_IGNORE.test(domain[1])) {
        reasons.push({ id: 'A7', w: 8, hit: domain[1] });
    }

    // ── A8 — surfaced by more than one template ──
    // A profile several distinct dorks can reach is well indexed, which in practice
    // means a real, established practitioner rather than a stub.
    if ((input.seenCount ?? 1) > 1) reasons.push({ id: 'A8', w: 5 });

    // ── A9 — agency voice ──
    // "We help teams…" with no first-person anywhere is a firm, not a solo operator.
    const hasWe = /\b(we|our|us)\b/.test(headline);
    const hasI = /\b(i|my|me)\b/.test(headline);
    if (hasWe && !hasI) reasons.push({ id: 'A9', w: -10 });

    // ── A10 — small network ──
    // LinkedIn renders anything past 500 as "500+", so a parsed number below that is
    // a genuinely small network: early-career, or a dormant profile.
    //
    // The thousands separator has to be part of the pattern. Matching bare digits
    // reads "1,200 connections" as *200* and penalises exactly the established
    // profiles the weight exists to reward. The explicit `+` check is the same trap
    // from the other side: "500+" must never be read as the number 500.
    const connections = snippet.match(/\b(\d[\d,]*)(\+?)\s*connections?\b/);
    if (connections && !connections[2]) {
        const count = Number(connections[1].replace(/,/g, ''));
        if (Number.isFinite(count) && count < 500) {
            reasons.push({ id: 'A10', w: -5, hit: `${count} connections` });
        }
    }

    // ── A11 — advertising a vacancy ──
    const hiring = includesAny(headline, HIRING_MARKERS) || includesAny(snippet, HIRING_MARKERS);
    if (hiring) reasons.push({ id: 'A11', w: -15, hit: hiring });

    const raw = reasons.reduce((sum, r) => sum + r.w, BASE_SCORE);
    const score = Math.max(0, Math.min(100, raw));

    return { score, reasons, reject: null, confidence };
}
