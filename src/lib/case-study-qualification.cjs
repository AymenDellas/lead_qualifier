// Pure qualification rules shared by the worker, server actions and scanner UI.
const { defaultTitles } = require('./case-study-title-rules.json');
const DEFAULT_TARGET_TITLES = Object.freeze(defaultTitles.slice());

function words(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleKey(value) {
    return words(value).replace(/\b(?:coaching|coaches)\b/g, 'coach');
}

function normalizeTitles(values) {
    const items = Array.isArray(values) ? values : String(values || '').split(/[,\r\n]+/);
    const seen = new Set();
    const cleaned = items.map(value => String(value || '').trim()).filter(value => {
        const key = titleKey(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 30);
    return cleaned.length ? cleaned : DEFAULT_TARGET_TITLES.slice();
}

const families = {
    'executive coach': ['(?:executive|c suite|ceo|cxo)', /\b(?:executives?|c suite|senior leaders?|(?:coach|coaching|help|for) ceos?)\b/],
    'business coach': ['(?:business|entrepreneur|entrepreneurial|founder)', /\b(?:business (?:owners?|growth|development|strategy|success)|entrepreneurs?|startups?|(?:coach|coaching|help|for) founders?)\b/],
    'leadership coach': ['leadership', /\b(?:leadership|leaders?)\b/],
    'career coach': ['(?:career|professional development)', /\b(?:careers?|job search|jobseekers?|job seekers?|professional development)\b/],
    'life coach': ['life', /\b(?:life|personal development)\b/],
    'health coach': ['health', /\bhealth\b/],
    'wellness coach': ['(?:wellness|wellbeing|well being)', /\b(?:wellness|wellbeing|well being)\b/],
    'performance coach': ['performance', /\bperformance\b/],
    'mindset coach': ['mindset', /\bmindset\b/],
    'communication coach': ['(?:communication|public speaking|soft skills)', /\b(?:communication|public speaking|soft skills)\b/],
    'sales coach': ['sales', /\bsales\b/],
    'confidence coach': ['confidence', /\bconfidence\b/],
    'personal development coach': ['personal development', /\bpersonal development\b/],
    'transformational coach': ['(?:transformational|transformation)', /\b(?:transformational|transformation)\b/],
    'entrepreneur coach': ['(?:entrepreneur|entrepreneurial)', /\bentrepreneurs?\b/],
    'founder coach': ['founder', /\bfounders?\b/],
    'team coach': ['team', /\bteams?\b/],
};
const bridge = '(?:and|or|executive|business|leadership|career|life|health|wellness|mindset|performance|communication|sales|team|personal|professional|development|transition|ownership|clarity|strategy|strategic|growth|high|peak|mental|certified|accredited|master|trainer|mentor|facilitator|confidence|success|transformation|transformational|management|entrepreneur|founder)';
const ownCoachRole = /^(?:(?:i am|i m|an?|icf|emcc|acc|pcc|mcc|certified|accredited|credentialed|professional|personal|master|international|global|independent|mentor|trainer|facilitator|speaker|author|educator|and)\s+){0,8}coach\b/;
const coachingVerb = /^(?:i |we )?coach(?:ing)?\s+(?:for |to |with )?(?:executives?|leaders?|founders?|entrepreneurs?|business owners?|professionals?|job seekers?|clients?)\b/;
const coachCredential = /\b(?:icf (?:certified |accredited |credentialed )?(?:acc|pcc|mcc)|(?:acc|pcc|mcc) (?:certified |accredited )?icf)\b/;
const sportsContext = /\b(?:sports?|athletes?|athletic|football|soccer|basketball|baseball|tennis|golf|cricket|badminton|strength and conditioning|conditioning coach|personal trainer|ncaa|nba|nfl|para sport)\b/;
const technicalContext = /\b(?:agile coach|scrum coach|coding coach|programming coach|devops coach)\b/;
const primaryTitles = new Set(['executive coach', 'business coach', 'leadership coach', 'career coach', 'life coach']);

function usableSegment(segment) {
    // These describe customers, tools or vacancies rather than the person's role.
    if (/^(?:i |we )?(?:help|helping|serve|serving|support|supporting|teach|teaching|build|building|create|creating|design|designing|sell|selling|provide|providing)\b/.test(segment)
        && /\bcoaches\b/.test(segment)) return false;
    const firstCoach = segment.search(/\bcoach(?:es|ing)?\b/);
    const reference = segment.search(/\b(?:hire|hired|hiring|seeking|looking for|work with|services for|websites for|funnels for|my|your) (?:[a-z]+ ){0,4}coach(?:es|ing)?\b/);
    if (reference >= 0 && reference < firstCoach) return false;
    if (/\bcoaching (?:software|platform|app|directory|marketplace)\b/.test(segment)) return false;
    if (/^(?:i am |i m )?(?:not|not a|former|retired|ex|aspiring|trainee|student|looking for|seeking|hiring)\b/.test(segment)
        && /\bcoach(?:ing)?\b/.test(segment)) return false;
    return true;
}

function qualifyHeadline(headline, configuredTitles) {
    const raw = String(headline || '').trim();
    const targetTitles = normalizeTitles(configuredTitles);
    const verdict = (qualified, matches, reason) => ({ qualified, matches, reason, targetTitles });
    if (!raw || !words(raw)) return verdict(false, [], 'LinkedIn did not expose a readable headline.');
    const segments = raw.split(/[|\u2022\u00b7;\r\n]+/).map(words).filter(usableSegment);
    const normalized = segments.join(' ');
    const declaredRole = segments.some(segment => ownCoachRole.test(titleKey(segment)) || coachingVerb.test(segment))
        || coachCredential.test(normalized);
    const matches = targetTitles.filter(title => {
        const key = titleKey(title);
        // Coach, Coaches and Coaching are equivalent only in a declared title.
        if (segments.some(segment => (` ${titleKey(segment)} `).includes(` ${key} `))) return true;
        const family = families[key];
        if (family) {
            const compound = new RegExp('\\b' + family[0] + '(?: ' + bridge + '){0,5} coach\\b');
            if (segments.some(segment => compound.test(titleKey(segment)))) return true;
            return declaredRole && segments.some(segment => family[1].test(segment));
        }
        // A declared generic professional coach remains worth website review;
        // this does not infer a coaching role from Founder/CEO/Consultant alone.
        return key === 'professional coach' && declaredRole;
    });
    const primaryMatch = matches.some(title => primaryTitles.has(titleKey(title)));
    if (sportsContext.test(normalized) && !primaryMatch && !matches.some(title => sportsContext.test(words(title))))
        return verdict(false, [], 'The headline describes sports coaching, outside the configured ICP.');
    if (technicalContext.test(normalized) && !primaryMatch && !matches.some(title => technicalContext.test(titleKey(title))))
        return verdict(false, [], 'The headline describes technical/agile coaching without a configured business, leadership or career coaching role.');
    if (!matches.length) return verdict(false, [], `No declared coaching role matched the configured target titles: ${targetTitles.join(', ')}.`);
    const genericOnly = matches.every(title => titleKey(title) === 'professional coach');
    return verdict(true, matches, `Matched ${matches.join(', ')} through title variants or a declared coaching role with relevant headline context.`
        + (genericOnly ? ' Coaching niche and commercial fit still need website review.' : ''));
}

function isMissedCoachCandidate(data, targetTitles) {
    return Boolean(data && !data.crmLeadId && data.source !== 'MANUAL' && data.scanStatus === 'COMPLETE'
        && data.stage === 'FOUND' && !data.lastContactedAt && !data.headlineQualification?.qualified
        && qualifyHeadline(data.headline, targetTitles).qualified);
}

module.exports = { DEFAULT_TARGET_TITLES, normalizeTitles, qualifyHeadline, isMissedCoachCandidate };
