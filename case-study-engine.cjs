/**
 * Pure Case Study Hunter scoring and message generation.
 * Kept outside the browser worker so it can be tested without LinkedIn or a DB.
 */

const SOURCE_POINTS = {
    REPLIED: 25,
    PROFILE_VIEWER: 21,
    ENGAGER: 18,
    FOLLOWER: 14,
    CONNECTION: 11,
    MANUAL: 4,
};

const decode = (text) => String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function stripHtml(html) {
    return decode(String(html || ''))
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstTagText(html, tag) {
    const match = String(html || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? stripHtml(match[1]).slice(0, 240) : '';
}

function absoluteUrl(href, baseUrl) {
    try { return new URL(href, baseUrl).href; } catch { return baseUrl || ''; }
}

function rawHomepageLinks(source, pageUrl) {
    return [...String(source || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .map((match) => ({ href: absoluteUrl(match[1], pageUrl), text: stripHtml(match[2]), top: -1 }));
}

function analyzeFunnelHtml(html, pageUrl, relatedPages = [], homepageMetadata = {}) {
    const source = String(html || '');
    const pages = [
        { ...homepageMetadata, url: pageUrl, html: source },
        ...relatedPages.map((page) => ({ ...page, url: page.url || pageUrl, html: String(page.html || '') })),
    ];
    const homepage = pages[0];
    const combinedSource = pages.map((page) => page.html).join('\n');
    const text = stripHtml(combinedSource).slice(0, 180000);
    const lower = text.toLowerCase();
    const semanticH1 = firstTagText(source, 'h1');
    const title = firstTagText(source, 'title');
    const renderedHero = String(homepage.heroText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const heroContext = String(homepage.heroContext || renderedHero).replace(/\s+/g, ' ').trim().slice(0, 1600);
    const evidenceSource = String(homepage.evidenceSource || '');
    const heroVerified = Boolean(renderedHero || (!evidenceSource && semanticH1));
    const hero = renderedHero || semanticH1 || title || text.slice(0, 180);
    const observations = [];
    const add = (id, label, evidence, severity, url = pageUrl) => {
        observations.push({ id, label, evidence, severity, url: url || '' });
    };

    const outcomeWords = /(increase|grow|book|revenue|clients?|career|leadership|confidence|performance|results?|transform|achieve|scale|promotion|clarity|offers?|roles?|authority|presence|attract|secure|land|hire|hired)/i;
    const audienceWords = /(coach|leaders?|executives?|founders?|business owners?|professionals?|women|men|teams?|entrepreneurs?|managers?|job seekers?|candidates?|recruiters?|job search|interviews?|resume|linkedin)/i;
    const vagueWords = /^(welcome|home|unlock your potential|transform your life|be your best|thrive|live your best|empower|discover)/i;
    const clarityText = `${hero} ${heroContext}`;
    const hasConcreteOutcome = outcomeWords.test(clarityText);
    const hasConcreteAudience = audienceWords.test(clarityText);
    const genericHero = vagueWords.test(hero);
    if (heroVerified && ((!hasConcreteOutcome && !hasConcreteAudience) || (genericHero && !(hasConcreteOutcome && hasConcreteAudience)))) {
        add('VAGUE_HERO', 'Vague positioning in the hero', `The visible homepage hero says “${hero}”, but it does not identify a concrete audience or outcome.`, 8);
    }

    const homepageLinks = Array.isArray(homepage.visibleLinks) && homepage.visibleLinks.length
        ? homepage.visibleLinks.map((link) => ({
            href: absoluteUrl(link.href, pageUrl),
            text: String(link.text || '').replace(/\s+/g, ' ').trim(),
            top: Number(link.top ?? -1),
        }))
        : rawHomepageLinks(source, pageUrl);
    const bookingLink = homepageLinks.find(({ href }) =>
        /(calendly\.com|acuityscheduling\.com|calendar\.app\.google|hubspot\.com\/meetings|scheduleonce\.com|savvycal\.com|cal\.com)/i.test(href));
    if (bookingLink) {
        const bookingUrl = absoluteUrl(bookingLink.href, pageUrl);
        let bookingHost = 'the external calendar';
        try { bookingHost = new URL(bookingUrl).hostname; } catch { /* use the safe label */ }
        const ctaLabel = bookingLink.text.slice(0, 160);
        add(
            'DIRECT_CALENDAR',
            'Homepage CTA goes directly to a calendar',
            ctaLabel
                ? `The visible homepage CTA “${ctaLabel}” links directly to ${bookingHost}.`
                : `The homepage links directly to ${bookingHost}.`,
            7,
            bookingUrl,
        );
    }

    const hasOptIn = /(free [^.!?]{0,80}(guide|training|resource|workshop|checklist|assessment)|newsletter|lead magnet|email course|subscribe|join my list|masterclass)/i.test(lower);
    if (!hasOptIn) {
        add('NO_NURTURE', 'No visible nurture entry point', `No public opt-in, free resource, newsletter, or email nurture entry point was found across the ${pages.length} scanned funnel page(s).`, 5);
    }

    const proofMatches = lower.match(/(testimonials?|recommendations?|case stud(?:y|ies)|client results?|success stor(?:y|ies)|helped\s+\d+|\d+%|before and after)/g) || [];
    if (proofMatches.length < 2) {
        add('WEAK_PROOF', 'Weak visible proof', `The ${pages.length} scanned funnel page(s) showed ${proofMatches.length ? 'only one clear proof signal' : 'no clear case-study, result, or testimonial language'}.`, 5);
    }

    const hasOffer = /(coaching|programme|program|work with me|book a call|discovery call|strategy call|consultation|1[: -]?1|one[- ]to[- ]one|private coaching|executive coaching|leadership coaching|business coaching)/i.test(lower);
    if (!hasOffer) {
        add('UNCLEAR_OFFER', 'Offer is hard to identify', `The ${pages.length} scanned funnel page(s) do not clearly name a coaching offer, engagement, or next step.`, 6);
    }

    const ctaLinks = homepageLinks.filter(({ text: linkText }) =>
        /(book|schedule|apply|start|get|download|subscribe|join|contact|work with|learn more)/i.test(linkText));
    const distinctCtas = new Set(ctaLinks.map((link) => link.href.replace(/[?#].*$/, '') || link.text.toLowerCase()));
    if (distinctCtas.size > 3) {
        add('CTA_COMPETITION', 'Competing calls to action', `The visible homepage presents ${distinctCtas.size} different action destinations, which can blur the primary path.`, 4);
    }

    observations.sort((a, b) => b.severity - a.severity);
    return {
        pageUrl,
        title,
        hero,
        text,
        observations,
        signals: {
            hasOffer,
            hasOptIn,
            hasBookingLink: Boolean(bookingLink),
            heroVerified,
            evidenceSource,
            proofCount: proofMatches.length,
            premiumLanguage: /(executive|leadership|ceo|founder|business owner|high performance|private coaching|1[: -]?1|one[- ]to[- ]one|mastermind)/i.test(lower),
            priceLanguage: /(?:\$|usd\s*)[3-9](?:,?\d{3}|k)\b|(?:3|4|5)k\s+(?:program|programme|coaching|investment)/i.test(lower),
        },
    };
}

function analyzeFunnelPages(pages) {
    const usable = Array.isArray(pages) ? pages.filter((page) => page && (page.html || page.text)) : [];
    if (!usable.length) return analyzeFunnelHtml('', '');
    const normalized = usable.map((page) => ({
        ...page,
        html: String(page.html || `<body>${page.text || ''}</body>`),
    }));
    return analyzeFunnelHtml(normalized[0].html, normalized[0].url || '', normalized.slice(1), normalized[0]);
}

function marketFit(location, text) {
    const combined = `${location || ''} ${text || ''}`;
    if (/(united states|\busa\b|\bu\.s\.\b|canada|united kingdom|\buk\b|england|scotland|wales|northern ireland|new york|california|texas|florida|toronto|vancouver|london|manchester)/i.test(combined)) return 6;
    return location ? 2 : 0;
}

function scoreProspect(input) {
    const headline = String(input.headline || '');
    const siteText = String(input.analysis?.text || '');
    const combined = `${headline} ${siteText}`;
    const explicitCoach = /\b(coach|coaching)\b/i.test(combined);
    const excludedShape = /\b(recruiter|therapist|agency|software|saas|real estate agent)\b/i.test(headline) && !explicitCoach;
    const coachFit = excludedShape ? 'NO' : explicitCoach ? 'YES' : /mentor|advisor/i.test(combined) ? 'MAYBE' : 'NO';

    let icpFit = 0;
    if (coachFit === 'YES') icpFit += 15;
    else if (coachFit === 'MAYBE') icpFit += 6;
    if (/(executive|business|leadership|career|high performance)\s+coach/i.test(combined)) icpFit += 7;
    else if (/\b(life|health|wellness)\s+coach/i.test(combined)) icpFit += 3;
    icpFit += marketFit(input.location, siteText);
    if (input.website && input.analysis?.signals?.hasOffer) icpFit += 7;

    const rawWarmth = SOURCE_POINTS[input.source] ?? SOURCE_POINTS.MANUAL;
    const warmth = input.mode === 'CLIENT' ? Math.round(rawWarmth * 0.6) : rawWarmth;
    const rawWeakness = Math.min(25, (input.analysis?.observations || []).reduce((sum, item) => sum + Number(item.severity || 0), 0));
    const funnelWeakness = input.mode === 'CLIENT' ? Math.round(rawWeakness * 0.8) : rawWeakness;

    let rawCommercial = 0;
    if (input.analysis?.signals?.priceLanguage) rawCommercial += 5;
    if (input.analysis?.signals?.premiumLanguage || /(executive|business|leadership)\s+coach/i.test(headline)) rawCommercial += 5;
    if (input.analysis?.signals?.hasOffer) rawCommercial += 3;
    if (input.analysis?.signals?.hasBookingLink) rawCommercial += 2;
    const commercialPotential = input.mode === 'CLIENT' ? Math.min(30, rawCommercial * 2) : Math.min(15, rawCommercial);
    const total = Math.min(100, icpFit + warmth + funnelWeakness + commercialPotential);

    return {
        coachFit,
        scores: { icpFit, warmth, funnelWeakness, commercialPotential, total },
    };
}

function buildOutreach(input, score) {
    const name = String(input.firstName || input.name || '').trim() || 'there';
    const observation = input.analysis?.observations?.[0];
    const websiteHost = (() => { try { return new URL(input.website).hostname.replace(/^www\./, ''); } catch { return 'your site'; } })();
    const evidence = observation?.evidence || '';
    const mainWeakness = observation?.label || 'No verified funnel weakness';
    const outreachAngle = observation ? evidence.replace(/\.$/, '') : '';
    const caseStudyDm = observation
        ? `Hey ${name} — I had a look at ${websiteHost} and noticed ${outreachAngle.charAt(0).toLowerCase()}${outreachAngle.slice(1)}. I’m choosing one coach for a case-study rebuild. If useful, reply and I’ll send a short Loom with the three changes I’d make.`
        : '';
    const clientDm = observation
        ? `Hey ${name} — I had a look at ${websiteHost} and noticed ${outreachAngle.charAt(0).toLowerCase()}${outreachAngle.slice(1)}. I recently worked on a similar funnel path. If useful, reply and I’ll send a short Loom showing what I’d change here.`
        : '';
    const total = score.scores.total;
    const recommendedNextAction = score.coachFit === 'NO'
        ? 'Do not prioritize until coach fit is confirmed'
        : !input.website
            ? 'Find and verify the website before outreach'
            : !observation
                ? 'Review the funnel manually before outreach'
            : total >= 80
                ? 'DM now'
                : total >= 65
                    ? 'Add to today’s message list'
                    : total >= 50
                        ? 'Engage first, then review manually'
                        : 'Keep out of the active queue';
    const commercialReason = input.analysis?.signals?.priceLanguage
        ? 'The public page shows pricing in the $3k–$5k+ range.'
        : input.analysis?.signals?.premiumLanguage && input.analysis?.signals?.hasOffer
            ? 'The premium positioning and visible offer make a $3k–$5k service plausible, pending manual confirmation.'
            : 'The $3k–$5k commercial fit still needs manual confirmation.';
    return {
        whyContact: score.coachFit === 'YES'
            ? `${name} appears to sell coaching and has a ${input.source.toLowerCase().replaceAll('_', ' ')} relationship. The scan found ${input.analysis?.observations?.length || 0} specific funnel opportunity signal(s). ${commercialReason}`
            : `${name} has some useful signals, but coach fit needs a manual check before contact.`,
        mainWeakness,
        outreachAngle,
        suggestedDm: input.mode === 'CLIENT' ? clientDm : caseStudyDm,
        recommendedNextAction,
    };
}

module.exports = { analyzeFunnelHtml, analyzeFunnelPages, buildOutreach, scoreProspect, stripHtml };
