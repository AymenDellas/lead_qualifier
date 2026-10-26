'use strict';

// Shared by the LinkedIn worker, server and browser. No network calls or CRM outcomes.
const VERSION = 1;
const QUALIFICATION_VERSION = 3;
const {followersDecision,minFollowers}=require('./follower-policy.cjs');
const RESEARCH_MAX_AGE_DAYS = 90;
const ACTIVITY_MAX_AGE_DAYS = 30;
const SEGMENTS = ['EXECUTIVE', 'CAREER', 'BUSINESS'];
const SEGMENT_LABELS = { EXECUTIVE: 'Executive coaching', CAREER: 'Career coaching', BUSINESS: 'Business coaching', UNKNOWN: 'Segment needs review' };
const DEFAULT_TITLES = ['Executive Coach', 'Leadership Coach', 'Career Coach', 'Business Coach'];
const FACT_KEYS = ['independentBusiness', 'paidOffer', 'clientProof', 'demandSignals', 'funnelOpportunity', 'marketingControl', 'economics', 'capacity', 'targetMarket'];
const FACT_LABELS = {
    independentBusiness: 'Independent coaching business', paidOffer: 'Established coaching offer',
    clientProof: 'Client evidence', demandSignals: 'Demand and marketing signals',
    funnelOpportunity: 'Relevant conversion opportunity', marketingControl: 'Control over marketing',
    economics: 'Offer economics', capacity: 'Capacity for new clients', targetMarket: 'Market fit',
};
const STATES = ['OBSERVED', 'INDICATED', 'UNKNOWN', 'NEGATIVE'];
const STATE_LABELS = { OBSERVED: 'Observed', INDICATED: 'Indicated', UNKNOWN: 'Unknown', NEGATIVE: 'Contrary evidence' };
const TIER_LABELS = { A: 'Contact now', B: 'Investigate', C: 'Nurture', OUTSIDE_ICP: 'Outside ICP', UNREVIEWED: 'Not researched' };
const PLATFORM_DOMAINS = new Set([
    'linkedin.com', 'instagram.com', 'facebook.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com',
    'slideshare.net', 'topmate.io', 'linktr.ee', 'linktree.com', 'calendly.com', 'cal.com',
    'scheduler.zoom.us','as.me','prezi.com','podcasts.apple.com','open.spotify.com','creators.spotify.com','anchor.fm',
    'tidycal.com', 'acuityscheduling.com', 'live.vcita.com', 'bit.ly', 'tinyurl.com',
    'voyagela.com', 'voyagedenver.com', 'canvasrebel.com', 'boldjourney.com', 'shoutoutla.com',
    'coachingfederation.org', 'noomii.com', 'bark.com', 'thumbtack.com', 'meetup.com', 'eventbrite.com',
    'amazon.com', 'canva.com', 'medium.com', 'substack.com', 'wix.com', 'squarespace.com',
]);
const VENDOR_DOMAINS = new Set([
    ...PLATFORM_DOMAINS, 'xecurify.com', 'surecart.com', 'jouwweb.nl', 'shopify.com', 'wordpress.com',
    'wordpress.org', 'godaddy.com', 'weebly.com', 'webflow.com', 'carrd.co', 'notion.so',
    'kajabi.com', 'teachable.com', 'thinkific.com', 'systeme.io', 'clickfunnels.com',
    'hubspot.com', 'mailchimp.com', 'stripe.com', 'paypal.com', 'zoom.us', 'yourmail.com',
    'example.com', 'example.org', 'yourdomain.com', 'domain.com', 'sentry.io',
]);
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'me.com', 'email.com', 'mail.com']);
const normalText = value => String(value || '').replace(/\s+/g, ' ').trim();
const hostOf = value => { try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const validHttpUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isPlatformWebsite = value => { const host = hostOf(value); return [...PLATFORM_DOMAINS].some(d => onDomain(host, d)); };
const isUnsafeContact = address => {
    const email = String(address || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return true;
    const [local, host] = email.split('@');
    return [...VENDOR_DOMAINS].some(d => onDomain(host, d))
        || /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|postmaster|abuse|privacy|security|legal|notifications?)$/.test(local)
        || /\d{5,}/.test(local) || /^(?:your[-_.]?(?:name|email)|john[-_.]?doe|jane[-_.]?doe|test|sample|example|email|name|username)$/.test(local)
        || /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|css|js)$/i.test(host);
};

function segmentsFromText(value) {
    const text = normalText(value).toLowerCase().replace(/coaching|coaches/g, 'coach');
    if (!/\bcoach\b/.test(text)) return [];
    const parts = text.split(/[|;\n]/);
    const has = pattern => parts.some(part => /\bcoach\b/.test(part) && pattern.test(part));
    const out = [];
    if (has(/\b(executive|leadership|leader|leaders|c[- ]?suite|executive presence|senior management)\b/)) out.push('EXECUTIVE');
    if (has(/\b(career|job search|interview|return to work|professional transition|outplacement)\b/)) out.push('CAREER');
    if (has(/\b(business|entrepreneur|founder|small business|smb|business owner|business owners)\b/)) out.push('BUSINESS');
    return out;
}

function emptyFact(reason = 'No reliable evidence has been collected.') {
    return { state: 'UNKNOWN', value: '', reason, evidence: [] };
}
function makeFact(state, value, reason, evidence) {
    return { state, value: normalText(value).slice(0, 500), reason: normalText(reason).slice(0, 700), evidence: evidence || [] };
}
function emptyResearch(input = {}, now = new Date().toISOString()) {
    return {
        version: VERSION, researchedAt: now, engine: 'rules', profileIdentityConfirmed: input.profileIdentityConfirmed === true,
        headline: normalText(input.headline).slice(0, 1000), about: normalText(input.about).slice(0, 5000),
        profileLocation: normalText(input.profileLocation).slice(0, 500),
        targetLocationRequired: input.targetLocationRequired === true,
        latestPostText: normalText(input.latestPostText).slice(0, 2500), lastActivityAt: input.lastActivityAt || null,
        activityStatus: input.activityStatus==='Inactive'&&!input.lastActivityAt?'Unknown':['Active', 'Inactive', 'Unknown'].includes(input.activityStatus) ? input.activityStatus : 'Unknown',
        activityEvidence:input.activityEvidence||null,followers:input.followers||null,connections:input.connections||null,
        linkedinUrl: input.linkedinUrl || input.url || '', website: '', websiteStatus: 'NONE',
        segments: segmentsFromText(input.headline), segment: segmentsFromText(input.headline)[0] || 'UNKNOWN',
        facts: Object.fromEntries(FACT_KEYS.map(key => [key, emptyFact()])),
        pages: [], limitations: [], contacts: [], description: null, crawl: null,
    };
}

// AI evidence must be an actual excerpt from the cited source, not a made-up quote.
function groundedFact(candidate, sources) {
    if (!candidate || !STATES.includes(candidate.state) || candidate.state === 'UNKNOWN') return emptyFact(candidate?.reason);
    const evidence = (Array.isArray(candidate.evidence) ? candidate.evidence : []).slice(0, 3).flatMap(item => {
        const source = item && sources[item.sourceIndex];
        if (!item) return [];
        const excerpt = normalText(item.excerpt);
        if (!source || excerpt.length < 12 || excerpt.length > 600 || !normalText(source.text).toLowerCase().includes(excerpt.toLowerCase())) return [];
        return [{ url: source.url, excerpt, source: source.kind || 'WEBSITE', observedAt: source.observedAt }];
    });
    return evidence.length ? makeFact(candidate.state, candidate.value, candidate.reason, evidence) : emptyFact('The proposed finding could not be checked against its source.');
}

function validateResearch(value) {
    if (!value || value.version !== VERSION || !value.facts || !Array.isArray(value.segments)) throw new Error('Invalid prospect research.');
    if (!Number.isFinite(Date.parse(value.researchedAt))) throw new Error('Research needs a valid date.');
    if (JSON.stringify(value).length > 1500000) throw new Error('Prospect research is too large.');
    const research = emptyResearch(value, value.researchedAt);
    for(const key of ['followers','connections']){
        const record=value[key];research[key]=record?{rawText:normalText(record.rawText).slice(0,200),count:Number.isSafeInteger(record.count)&&record.count>=0?record.count:null,
            checkedAt:validDate(record.checkedAt)?record.checkedAt:research.researchedAt,...(key==='followers'?{threshold:Number.isSafeInteger(record.threshold)&&record.threshold>=0?record.threshold:minFollowers()}:{})}:null;
    }
    research.linkedinUrl = typeof research.linkedinUrl === 'string' && validHttpUrl(research.linkedinUrl) ? research.linkedinUrl.slice(0, 2000) : '';
    research.lastActivityAt = validDate(value.lastActivityAt) ? value.lastActivityAt : null;
    if(!research.lastActivityAt)research.activityStatus='Unknown';
    if([1,2].includes(value.activityEvidence?.version)){
        const e=value.activityEvidence;
        const record=v=>v&&validDate(v.at)?{postUrn:normalText(v.postUrn).slice(0,200),authorUrn:normalText(v.authorUrn).slice(0,200),at:v.at,method:normalText(v.method).slice(0,40),association:normalText(v.association).slice(0,50),text:normalText(v.text).slice(0,2500)}:null;
        research.activityEvidence={version:e.version,endpoint:normalText(e.endpoint).slice(0,100),profileUrn:normalText(e.profileUrn).slice(0,200),profileUrl:validHttpUrl(e.profileUrl)?e.profileUrl:'',checkedAt:validDate(e.checkedAt)?e.checkedAt:research.researchedAt,feedElements:Math.max(0,Math.min(1000,Number(e.feedElements)||0)),unresolved:Math.max(0,Math.min(1000,Number(e.unresolved)||0)),...(e.version===2?{ignoredForeign:Math.max(0,Math.min(1000,Number(e.ignoredForeign)||0))}:{}),selected:record(e.selected),records:(Array.isArray(e.records)?e.records:[]).map(record).filter(Boolean).slice(0,10),reason:normalText(e.reason).slice(0,300)};
    }else research.activityEvidence=null;
    research.engine = ['rules', 'ai', 'manual'].includes(value.engine) ? value.engine : 'rules';
    research.website = typeof value.website === 'string' && validHttpUrl(value.website) ? value.website.slice(0, 2000) : '';
    research.websiteStatus = ['OWNED', 'PROFILE_PLATFORM', 'UNCONFIRMED', 'NONE'].includes(value.websiteStatus) ? value.websiteStatus : 'NONE';
    research.segments = [...new Set(value.segments.filter(s => SEGMENTS.includes(s)))];
    research.segment = research.segments.includes(value.segment) ? value.segment : research.segments[0] || 'UNKNOWN';
    for (const key of FACT_KEYS) {
        const fact = value.facts[key];
        if (!fact || !STATES.includes(fact.state)) continue;
        const evidence = (Array.isArray(fact.evidence) ? fact.evidence : []).slice(0, 4).filter(e => e && typeof e.excerpt === 'string' && e.excerpt.length >= 8 && typeof e.url === 'string' && validHttpUrl(e.url) && ['WEBSITE', 'PROFILE', 'MANUAL'].includes(e.source)).map(e => ({ url: e.url.slice(0, 2000), excerpt: e.excerpt.slice(0, 700), source: e.source, observedAt: validDate(e.observedAt) ? e.observedAt : research.researchedAt }));
        research.facts[key] = fact.state !== 'UNKNOWN' && !evidence.length ? emptyFact('Evidence is required for this finding.') : makeFact(fact.state, fact.value, fact.reason, evidence);
    }
    research.pages = (Array.isArray(value.pages) ? value.pages : []).slice(0, 1000).filter(p => p && typeof p.url === 'string' && validHttpUrl(p.url)).map(p => ({ url: p.url.slice(0, 1000), label: normalText(p.label).slice(0, 150), status: ['inspected', 'skipped'].includes(p.status) ? p.status : 'blocked', note: normalText(p.note).slice(0, 400),
        ...(value.crawl?.version === 2 ? { attempts: Math.max(0, Math.min(3, Number(p.attempts) || 0)), retryable: p.retryable === true, contactPage: p.contactPage === true, hasDescription: p.hasDescription === true } : {}) }));
    if (value.description && validHttpUrl(value.description.url)) research.description = { url: value.description.url.slice(0, 1000), text: normalText(value.description.text).slice(0, 2000) };
    if (value.crawl && [1, 2].includes(value.crawl.version)) {
        const urls = values => [...new Set((Array.isArray(values) ? values : []).filter(validHttpUrl).map(url => url.slice(0, 1000)))].slice(0, 2000);
        const c = value.crawl;
        research.crawl = { version: c.version, attributionVersion:[2,3].includes(c.attributionVersion)?c.attributionVersion:0, complete: c.complete === true, visited: urls(c.visited), pending: urls(c.pending), failed: urls(c.failed), roots: urls(c.roots), matchedHosts: (c.matchedHosts || []).filter(host => /^[a-z\d.-]+$/i.test(host)).slice(0, 8),
            contactMatchedHosts: (c.contactMatchedHosts || []).filter(host => /^[a-z\d.-]+$/i.test(host)).slice(0, 8),
            ...(c.version === 2 ? { retryable: c.retryable === true, attempted: urls(c.attempted), maxRoutes: Math.max(1, Math.min(600, Number(c.maxRoutes) || 600)), storageLimited: c.storageLimited === true,
                firstStartedAt:Number.isFinite(Date.parse(c.firstStartedAt))?new Date(c.firstStartedAt).toISOString():null,maxTimeMs:Math.max(0,Number(c.maxTimeMs)||0),elapsedMs:Math.max(0,Number(c.elapsedMs)||0),budgetExhausted:c.budgetExhausted===true,evidenceSufficient:c.evidenceSufficient===true } : {}),
            discovered: Math.max(0, Number(c.discovered) || 0), inspected: Math.max(0, Number(c.inspected) || 0), contactPages: Math.max(0, Number(c.contactPages) || 0), descriptionPages: Math.max(0, Number(c.descriptionPages) || 0), stoppedReason: normalText(c.stoppedReason).slice(0, 500),
            candidates: (Array.isArray(c.candidates) ? c.candidates : []).slice(0, 150).filter(contact => contact && !isUnsafeContact(contact.address) && validHttpUrl(contact.url)).map(contact => ({ address: normalText(contact.address).toLowerCase(), url: contact.url.slice(0, 1000), explicit: contact.explicit === true, contactPage: contact.contactPage === true, businessContact: contact.businessContact === true,contactInvitation:contact.contactInvitation===true,sharedContact:contact.sharedContact===true,contactEvidenceVersion:contact.contactEvidenceVersion===1?1:0 })),
        };
        research.crawl.complete = research.crawl.complete && !research.crawl.pending.length && !research.crawl.failed.length && !research.crawl.stoppedReason;
    }
    research.limitations = (Array.isArray(value.limitations) ? value.limitations : []).slice(0, 12).map(s => normalText(s).slice(0, 500));
    research.contacts = (Array.isArray(value.contacts) ? value.contacts : []).slice(0, 15).filter(c => c && !isUnsafeContact(c.address)).map(c => ({ address: String(c.address).trim().toLowerCase().slice(0, 320), source: ['linkedin', 'website', 'pattern_guess', 'manual'].includes(c.source) ? c.source : 'website', url: validHttpUrl(c.url) ? String(c.url).slice(0, 2000) : '', ownership: validHttpUrl(c.url) && ['PUBLISHED', 'DOMAIN_MATCH', 'GUESSED', 'UNCONFIRMED'].includes(c.ownership) ? c.ownership : 'UNCONFIRMED',...(c.excerpt?{excerpt:normalText(c.excerpt).slice(0,260)}:{}) }));
    return research;
}

function validateReview(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid review.');
    const review = { facts: {}, segment: value.segment || '', contactOwnership: value.contactOwnership || '', contactEmail: normalText(value.contactEmail).toLowerCase().slice(0, 320), note: normalText(value.note).slice(0, 1200), reviewedAt: new Date().toISOString() };
    if (review.segment && !SEGMENTS.includes(review.segment)) throw new Error('Choose an executive, career or business coaching segment.');
    if (review.contactOwnership && !['CONFIRMED', 'UNCONFIRMED'].includes(review.contactOwnership)) throw new Error('Invalid contact ownership choice.');
    if ((review.segment || review.contactOwnership) && review.note.length < 12) throw new Error('Record the evidence or conversation supporting your review.');
    for (const key of FACT_KEYS) {
        const fact = value.facts?.[key];
        if (!fact) continue;
        if (!STATES.includes(fact.state)) throw new Error(`Invalid finding for ${FACT_LABELS[key]}.`);
        const note = normalText(fact.note);
        if (fact.state !== 'UNKNOWN' && note.length < 12) throw new Error(`Add an evidence note for ${FACT_LABELS[key]}.`);
        if (fact.url && !validHttpUrl(fact.url)) throw new Error('Evidence links must be valid HTTP or HTTPS URLs.');
        review.facts[key] = { state: fact.state, note: note.slice(0, 700), url: String(fact.url || '').slice(0, 2000) };
    }
    return review;
}

function applyReview(research, review) {
    const result = validateResearch(research);
    if (!review) return result;
    for (const key of FACT_KEYS) {
        const fact = review.facts?.[key];
        if (!fact || !STATES.includes(fact.state)) continue;
        result.facts[key] = fact.state === 'UNKNOWN' ? emptyFact('Marked unknown in your review.') : makeFact(fact.state, fact.note, 'Recorded in your manual review.', [{ url: fact.url || result.linkedinUrl || result.website, excerpt: fact.note, source: 'MANUAL', observedAt: review.reviewedAt }]);
    }
    if (SEGMENTS.includes(review.segment)) { result.segment = review.segment; result.segments = [...new Set([review.segment, ...result.segments])]; }
    return result;
}

function assessProspect(researchInput, context = {}) {
    const baseResearch = validateResearch(researchInput);
    const research = applyReview(researchInput, context.review);
    const f = research.facts;
    const positive = key => ['OBSERVED', 'INDICATED'].includes(f[key].state);
    const observed = key => f[key].state === 'OBSERVED';
    const unknowns = FACT_KEYS.filter(k => f[k].state === 'UNKNOWN').map(k => FACT_LABELS[k]);
    const blockers = [];
    const researchAge = (Date.parse(context.now || new Date().toISOString()) - Date.parse(research.researchedAt)) / 86400000;
    const researchFresh = researchAge <= RESEARCH_MAX_AGE_DAYS && researchAge >= -1;
    const contraryCore = ['independentBusiness', 'marketingControl', 'targetMarket'].some(key => f[key].state === 'NEGATIVE');
    const explicitlyOther = research.segments.length === 0 && /\b(?:sports?|football|soccer|basketball|agile|scrum|fitness|health|wellness|nutrition)\s+coach(?:ing)?\b/i.test(research.headline);
    const fit = contraryCore || explicitlyOther ? 'OUTSIDE_ICP'
        : research.segments.length && positive('independentBusiness') && positive('paidOffer') ? 'MATCH'
        : research.segments.length ? 'POTENTIAL' : 'UNKNOWN';
    const weights = { independentBusiness: 20, paidOffer: 20, clientProof: 15, demandSignals: 15, funnelOpportunity: 20, marketingControl: 10 };
    let score = Object.entries(weights).reduce((sum, [key, weight]) => sum + (observed(key) ? weight : positive(key) ? Math.round(weight * 0.55) : 0), 0);
    // Business tiers are advisory rankings retained for discovery calls.
    // They do not determine lead qualification or CRM placement.
    const ready = researchFresh && fit === 'MATCH' && positive('targetMarket')
        && !['capacity', 'economics', 'clientProof'].some(key => f[key].state === 'NEGATIVE')
        && (research.profileIdentityConfirmed || context.review?.segment);
    let tier = fit === 'OUTSIDE_ICP' ? 'OUTSIDE_ICP' : ready ? 'A'
        : fit === 'MATCH' && (f.paidOffer.state === 'NEGATIVE' || f.clientProof.state === 'NEGATIVE' || f.demandSignals.state === 'NEGATIVE') ? 'C'
        : positive('independentBusiness') && (f.paidOffer.state === 'NEGATIVE' || f.capacity.state === 'NEGATIVE' || f.economics.state === 'NEGATIVE') ? 'C' : 'B';
    if (tier === 'OUTSIDE_ICP') score = 0;
    const email = String(context.email || '').trim().toLowerCase();
    const contact = research.contacts.find(c => c.address === email);
    const contactOverride = email && context.review?.contactEmail === email ? context.review.contactOwnership : '';
    const ownerConfirmed = contactOverride !== 'UNCONFIRMED' && (contactOverride === 'CONFIRMED' || contact?.ownership === 'PUBLISHED' || contact?.ownership === 'DOMAIN_MATCH');
    const ownership = !email ? 'NO_EMAIL' : isUnsafeContact(email) ? 'INVALID'
        : contactOverride === 'UNCONFIRMED' ? 'UNCONFIRMED'
        : contactOverride === 'CONFIRMED' ? 'MANUAL_CONFIRMED'
        : contact?.ownership || 'UNCONFIRMED';
    const contactability = !email || ownership === 'INVALID' ? (research.linkedinUrl ? 'LINKEDIN_ONLY' : 'UNAVAILABLE')
        : !ownerConfirmed ? 'OWNERSHIP_UNCLEAR' : context.emailProven ? 'EMAIL_READY' : 'EMAIL_NEEDS_VERIFICATION';
    const cautions = [];
    if (!researchFresh) cautions.push('This assessment needs fresh public research; the established practice remains in the research pool.');
    if (!research.profileIdentityConfirmed) cautions.push('Profile identity was not confirmed by a matching LinkedIn profile.');
    if (f.demandSignals.state !== 'UNKNOWN') cautions.push('Marketing activity does not establish actual traffic volume or lead quality.');
    if (!observed('economics')) cautions.push('Confirm price, contribution margin and sales conversion before agreeing to a performance-based build.');
    if (!observed('capacity')) cautions.push('Confirm willingness and capacity to take on new clients before agreeing to delivery.');
    if (research.websiteStatus !== 'OWNED') cautions.push('An owned business website has not been confirmed.');
    if (research.lastActivityAt) {
        const age = Math.max(0, Math.floor((Date.parse(context.now || new Date().toISOString()) - Date.parse(research.lastActivityAt)) / 86400000));
        if (age > 30) { score = Math.max(0, score - (age > 90 ? 8 : 4)); cautions.push(`Latest known LinkedIn activity was ${age} days ago; this lowers freshness, not business fit.`); }
    }
    // Business facts rank prospects; they do not gate the email/activity qualifier.
    const activityAge = research.lastActivityAt ? (Date.parse(context.now || new Date().toISOString()) - Date.parse(research.lastActivityAt)) / 86400000 : null;
    const activity = activityAge !== null && activityAge >= 0 && activityAge <= ACTIVITY_MAX_AGE_DAYS ? 'RECENT'
        : activityAge !== null && activityAge > ACTIVITY_MAX_AGE_DAYS ? 'INACTIVE' : 'UNKNOWN';
    const attributableEmail = Boolean(email && !isUnsafeContact(email) && ownerConfirmed);
    // Compatibility applies only when a reader explicitly displays a stored
    // pre-v2 assessment. Fresh work and explicit rechecks never set this flag.
    const legacyUnchecked=context.legacyFollowersUnchecked===true&&!research.followers;
    const followerGate=legacyUnchecked?{status:'CONTINUE',reason:null,threshold:context.minFollowers??research.followers?.threshold??minFollowers()}:followersDecision(research.followers,context.minFollowers??research.followers?.threshold??minFollowers());
    const location=research.targetLocationRequired?require('./discovery-location-evidence.cjs').parsePersonLocation(research.profileLocation):null;
    const locationGate=!location?{status:'CONTINUE',reason:null,country:null}:research.profileIdentityConfirmed&&location.status==='OUTSIDE_TARGET'
        ?{status:'REJECTED',reason:'LOCATION_OUTSIDE_TARGET',country:null}:research.profileIdentityConfirmed&&location.status==='CONFIRMED'
        ?{status:'CONTINUE',reason:null,country:location.country}:{status:'REVIEW',reason:'LOCATION_UNCONFIRMED',country:null};
    if (!research.profileIdentityConfirmed) blockers.push('LinkedIn profile identity could not be confirmed; retry the scrape.');
    if (activity === 'INACTIVE') blockers.push('No LinkedIn activity within the last 30 days.');
    else if (activity === 'UNKNOWN') blockers.push('LinkedIn activity could not be confirmed; retry the activity check.');
    if (!attributableEmail) blockers.push(!email ? 'No attributable email found.' : 'Email ownership needs confirmation.');
    const qualified = research.profileIdentityConfirmed && activity === 'RECENT' && attributableEmail && followerGate.status==='CONTINUE'&&locationGate.status==='CONTINUE';
    const incompleteEmail = activity !== 'INACTIVE' && !attributableEmail && research.crawl?.complete === false;
    const needsAttention = !research.profileIdentityConfirmed||followerGate.status==='REVIEW'||locationGate.status==='REVIEW'||incompleteEmail && research.crawl.retryable === false;
    const needsRetry = followerGate.status==='CONTINUE'&&locationGate.status==='CONTINUE'&&(!research.profileIdentityConfirmed || activity === 'UNKNOWN' || (incompleteEmail && !needsAttention));
    if(followerGate.reason)blockers.unshift(followerGate.reason);
    if(locationGate.reason)blockers.unshift(locationGate.reason);
    const qualification = { policy: 'EMAIL_ACTIVITY_FOLLOWERS_LOCATION_V3', qualified, activity, activityAgeDays: activityAge === null ? null : Math.floor(activityAge), attributableEmail, needsRetry, needsAttention,
        location:locationGate.status,locationReason:locationGate.reason,locationCountry:locationGate.country,
        followers:followerGate.status,followersReason:followerGate.reason,followersThreshold:followerGate.threshold };
    const nextAction = !research.profileIdentityConfirmed?'Review profile identity before applying follower or location evidence.':locationGate.status==='REJECTED'?'Not qualified: LOCATION_OUTSIDE_TARGET. Profile location: '+research.profileLocation+'.':followerGate.status==='REVIEW'?'Review the saved profile: '+followerGate.reason+'.':followerGate.status==='REJECTED'?'Not qualified: FOLLOWERS_BELOW_MIN. '+(research.followers?.rawText||research.followers?.count)+'; must be more than '+followerGate.threshold+'.':locationGate.status==='REVIEW'?'Review the saved profile location before qualification.':qualified ? (context.emailProven ? 'Qualified: email found and recent activity confirmed.' : 'Qualified: email found and recent activity confirmed. Verify the email before sending.')
        : needsAttention ? `Website needs attention: ${research.crawl.stoppedReason || 'Website could not be read; automatic retries stopped.'}`
        : needsRetry ? `Research incomplete: ${blockers[0] || 'continue crawling the remaining website routes.'}` : `Not qualified: ${blockers.join(' ')}`;
    return { version: legacyUnchecked?1:QUALIFICATION_VERSION, researchedAt: research.researchedAt, tier, segment: research.segment, segments: research.segments,
        score, businessFit: fit, qualification, readiness: qualified ? 'READY_TO_APPROACH' : activity === 'INACTIVE' ? 'EARLY' : 'NEEDS_REVIEW',
        engagementReady: tier === 'A' && observed('economics') && observed('capacity') && observed('marketingControl') && observed('demandSignals'),
        contact: { channel: contactability, ownership, email }, blockers, unknowns, cautions, nextAction, research, baseResearch };
}

function isContactNow(assessment) {
    const research = assessment?.research;
    const activityAge = research?.lastActivityAt ? (Date.now() - Date.parse(research.lastActivityAt)) / 86400000 : Infinity;
    const followersAllowed=assessment?.version===1||followersDecision(research?.followers,assessment?.qualification?.followersThreshold??research?.followers?.threshold??minFollowers()).status==='CONTINUE';
    const locationAllowed=!research?.targetLocationRequired||require('./discovery-location-evidence.cjs').parsePersonLocation(research.profileLocation).status==='CONFIRMED';
    return Boolean(Number.isInteger(assessment?.version)&&assessment.version>=VERSION&&assessment.version<=QUALIFICATION_VERSION && followersAllowed && locationAllowed && research?.profileIdentityConfirmed && activityAge >= 0 && activityAge <= ACTIVITY_MAX_AGE_DAYS);
}
function hasAttributableEmail(assessment) {
    return Boolean(assessment && isContactNow(assessment) && assessment.contact?.email && !isUnsafeContact(assessment.contact.email)
        && ['PUBLISHED', 'DOMAIN_MATCH', 'MANUAL_CONFIRMED'].includes(assessment.contact.ownership));
}
function isQualifiedRecord(lead) {
    return Boolean(lead && ['QUALIFIED', 'OUTREACH'].includes(lead.pipeline_status)
        && String(lead.email || '').trim() && !isUnsafeContact(lead.email)
        && (!lead.prospect_assessment || hasAttributableEmail(lead.prospect_assessment)));
}
function hasQualifiedEmail(lead) {
    const email = String(lead?.email || '').trim().toLowerCase();
    return Boolean(isQualifiedRecord(lead) && email && !isUnsafeContact(email)
        && (!lead.prospect_assessment || (hasAttributableEmail(lead.prospect_assessment) && lead.prospect_assessment.contact.email === email)));
}
function pipelineForAssessment(assessment) {
    if(assessment?.version>=2){
        if(!assessment.research?.profileIdentityConfirmed)return 'REVIEW';
        if(assessment.qualification?.location==='REJECTED')return 'NOT_QUALIFIED';
        const gate=followersDecision(assessment.research?.followers,assessment.qualification?.followersThreshold??assessment.research?.followers?.threshold??minFollowers());
        if(gate.status==='REVIEW')return 'REVIEW';
        if(gate.status==='REJECTED')return 'NOT_QUALIFIED';
        if(assessment.qualification?.location==='REVIEW'||!assessment.research?.profileIdentityConfirmed||assessment.qualification?.activity==='UNKNOWN'||assessment.qualification?.needsAttention||assessment.qualification?.needsRetry)return 'REVIEW';
    }
    return hasAttributableEmail(assessment) ? 'QUALIFIED' : 'NOT_QUALIFIED';
}
function extractMatchingProfile(response, slug) {
    const candidates = [response?.data?.profile, response?.profile, response?.data, response, ...(response?.included || []), ...(response?.data?.included || []), ...(response?.data?.elements || [])].filter(Boolean);
    const identifier = value => { try { return decodeURIComponent(String(value || '')).toLowerCase(); } catch { return String(value || '').toLowerCase(); } };
    const expected = identifier(slug);
    const matches = candidates.filter(item => [item.publicIdentifier, item.vanityName].some(value => typeof value === 'string' && identifier(value) === expected));
    const richness = item => (item.headline ? 4 : item.occupation ? 2 : 0) + (item.summary || item.about ? 2 : 0) + (item.firstName && item.lastName ? 1 : 0);
    return matches.sort((a, b) => richness(b) - richness(a))[0] || null;
}

function extractProfileLocation(response, slug) {
    const profile = extractMatchingProfile(response, slug);
    if (!profile) return '';
    const text = value => typeof value === 'string' ? normalText(value) : '';
    const direct = text(profile.locationName) || text(profile.geoLocationName) || text(profile.location);
    const included = [...(response?.included || []), ...(response?.data?.included || [])];
    const geo = profile.geoLocation;
    const geoRef = geo?.['*geo'] || geo?.geoUrn || profile['*geoLocation'];
    // Follow only this identified person's location. Employer positions and
    // unrelated included geographies are not evidence of their current market.
    const linked = typeof geoRef === 'string' && /^urn:li:(?:fsd|fs)_geo:/.test(geoRef)
        ? included.find(item => item?.entityUrn === geoRef) : null;
    const label = direct || text(linked?.defaultLocalizedName) || text(geo?.geo?.defaultLocalizedName) || text(geo?.name);
    const code = profile.location?.countryCode;
    let country = '';
    if (typeof code === 'string' && /^[a-z]{2}$/i.test(code)) {
        try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || ''; } catch { /* missing country */ }
    }
    return label && country && !label.toLowerCase().includes(country.toLowerCase()) ? `${label}, ${country}` : label || country;
}

function extractProfileContactInfo(response, slug) {
    const data = response?.data?.profileContactInfo || response?.profileContactInfo || response?.data || response || {};
    if (Array.isArray(data.websites) || data.emailAddress) return data;
    const matching = extractMatchingProfile(response, slug);
    if (matching?.profileContactInfo && typeof matching.profileContactInfo === 'object') return matching.profileContactInfo;
    if (matching && (Array.isArray(matching.websites) || matching.emailAddress)) return matching;
    const references = Object.entries(data).filter(([key, value]) => /contactInfo/i.test(key) && typeof value === 'string').map(([, value]) => value);
    const included = [...(response?.included || []), ...(response?.data?.included || [])];
    return included.find(item => item && (references.includes(item.entityUrn) || item.entityUrn === `urn:li:fs_profileContactInfo:${slug}`)
        && (Array.isArray(item.websites) || item.emailAddress)) || {};
}

module.exports = { VERSION, QUALIFICATION_VERSION, RESEARCH_MAX_AGE_DAYS, SEGMENTS, SEGMENT_LABELS, DEFAULT_TITLES, FACT_KEYS, FACT_LABELS, STATES, STATE_LABELS, TIER_LABELS, PLATFORM_DOMAINS, FREE_MAIL,
    normalText, hostOf, onDomain, isPlatformWebsite, isUnsafeContact, segmentsFromText, emptyFact, makeFact, emptyResearch,
    groundedFact, validateResearch, validateReview, applyReview, assessProspect, isContactNow, hasAttributableEmail, isQualifiedRecord, hasQualifiedEmail, pipelineForAssessment, extractMatchingProfile, extractProfileLocation, extractProfileContactInfo };
