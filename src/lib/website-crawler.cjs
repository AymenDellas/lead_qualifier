'use strict';
const { hostOf, isPlatformWebsite } = require('./prospect-qualification.cjs');

// Only supplied URLs, redirects and links actually present in HTML are read.
function routeUrl(value, publicUrl) {
    const url = publicUrl(value);
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|mc_[ce]id)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
}
function routeKey(value) {
    const url = new URL(value);
    return hostOf(value) + (url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/') + url.search;
}
function publicRoute(value) {
    const url = new URL(value);
    return !/\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|mp[34]|mov|woff2?|ttf|css|js|xml|json|rss|docx?|xlsx?|pptx?|ics|csv|vcf)(?:$|\/)/i.test(url.pathname)
        && !/\/(?:wp-admin|wp-login\.php|wp-json|cdn-cgi|logout|signout|login|signin|cart|checkout)(?:\/|$)/i.test(url.pathname)
        && !/\/(?:events?|calendar)\/(?:\d{4}(?:-\d{2})*|month|day|week|list|feed)(?:\/|$)/i.test(url.pathname)
        && ![...url.searchParams.keys()].some(key => /^(?:s|search|add-to-cart|action|replytocom|ical|outlook-ical|tribe-bar-date|eventDate|eventDisplay|calendar_date)$/i.test(key));
}
function routePriority(item) {
    const label = (item.label || '') + ' ' + new URL(item.url).pathname;
    return /contact|get.in.touch|reach.out|connect/i.test(label) ? 0
        : /about|biography|our.story|who.we|meet/i.test(label) ? 1
        : /coaching|services|work.with|offer|program/i.test(label) ? 2 : 3;
}
function failureKind(error) {
    const note = String(error?.message || 'Website could not be read.').slice(0, 300);
    const status = Number(error?.httpStatus || note.match(/HTTP\s+(\d{3})/i)?.[1]);
    if ([404, 410].includes(status) || error?.code === 'NON_HTML' || /did not return HTML/i.test(note)) return { status: 'skipped', retryable: false, note };
    const terminal = [400, 401, 403].includes(status) || /ENOTFOUND|ENODATA|private or unsupported|size limit|certificate|CERT_|too many website redirects/i.test(note);
    return { status: 'blocked', retryable: !terminal, note };
}

async function crawlWebsiteRoutes(input, options) {
    const { publicUrl, fetchPage, parsePage, ownedPage, contactMatchedPage } = options;
    const previous = options.previousResearch?.crawl;
    const resume = [1, 2].includes(previous?.version) && !previous.complete;
    const migrate = resume && (previous.version === 1 || previous.attributionVersion !== 3);
    const validRoute = value => { try { return !(options.rejectedHosts||[]).includes(hostOf(value))&&publicRoute(routeUrl(value, publicUrl)); } catch { return false; } };
    const pages = resume ? [...new Map((options.previousResearch.pages || []).filter(page => validRoute(page.url)).map(page => [routeKey(page.url), { ...page }])).values()] : [];
    const parsed = [], sources = [];
    const visited = new Map((resume ? previous.visited.filter(validRoute) : []).map(url => [routeKey(url), url]));
    const failed = new Map();
    const roots = new Set(resume ? previous.roots.filter(validRoute) : []);
    const matchedHosts = new Set(resume ? previous.matchedHosts.filter(h=>!(options.rejectedHosts||[]).includes(h)) : []);
    const contactMatchedHosts = new Set(resume ? (previous.contactMatchedHosts || []).filter(h=>!(options.rejectedHosts||[]).includes(h)) : []);
    const candidates = resume ? [...previous.candidates.filter(contact => validRoute(contact.url))] : [];
    const queue = new Map();
    const discovered = new Set(visited.keys());
    // The pass budget allows useful progress; the persistent budget bounds all
    // resumes, including jobs continuing research after qualification.
    const attempted = new Map((resume && previous.version===2 ? (previous.attempted || []).filter(validRoute) : []).map(url => [routeKey(url), url]));
    const maxRoutes = Math.max(1, Math.min(600, previous?.version === 2 ? previous.maxRoutes || 600 : options.maxRoutes || 600));
    const maxPages = Math.max(1, Math.min(200, options.maxPages || 200));
    const deadline = Date.now() + Math.max(100, Math.min(90000, options.maxTimeMs || 90000));
    let description = resume && options.previousResearch.description && validRoute(options.previousResearch.description.url) ? options.previousResearch.description : null;
    const descriptionScore = value => !value ? -1 : (/about|biography|our.story|meet|who.we/i.test(new URL(value.url).pathname) ? 4 : 0) + (/coach(?:ing)?|leadership|career|practice/i.test(value.text) ? 2 : 0);
    let attempts = 0, storageLimited = resume && !migrate && previous.storageLimited === true;
    const rootKey = url => [...roots].some(root => routeKey(root) === routeKey(url));
    const enqueue = (value, label = '', root = false, retry = false) => {
        try {
            const url = routeUrl(value, publicUrl), key = routeKey(url);
            if (!validRoute(url) || isPlatformWebsite(url)) return;
            if (url.length > 1000 || discovered.size >= 2000 && !discovered.has(key)) { storageLimited = true; return; }
            discovered.add(key);
            if ((!visited.has(key) || retry) && !queue.has(key)) queue.set(key, { url, label, root });
            if (root) roots.add(url);
        } catch { /* invalid/private/unsupported route */ }
    };
    if (resume) {
        if (migrate) {
            // Recheck actual roots/contact/about links once under the repaired
            // parser. Retain previously read content and revalidate contacts.
            for (const page of pages) {
                page.attempts = 0;
                if (page.status === 'blocked') Object.assign(page, failureKind(new Error(page.note)));
            }
            for (const url of previous.roots.filter(validRoute)) { visited.delete(routeKey(url)); enqueue(url, 'Linked website', true, true); }
            for (const page of pages) if (routePriority(page) <= 1) { visited.delete(routeKey(page.url)); enqueue(page.url, page.label, rootKey(page.url), true); }
        }
        for (const url of previous.pending) enqueue(url, '', rootKey(url));
        for (const url of previous.failed.filter(validRoute)) {
            const record = pages.find(page => routeKey(page.url) === routeKey(url));
            if (record?.status === 'skipped') continue;
            failed.set(routeKey(url), url);
            if (record?.retryable !== false && (record?.attempts || 0) < 3) enqueue(url, record?.label, rootKey(url), true);
        }
        // Older saved candidates did not retain whether the site explicitly
        // offered an address as its business inbox. Re-read that observed
        // source once, including a team page outside contact/about routes.
        for(const contact of candidates)if(contact.contactEvidenceVersion!==1&&contact.explicit&&contact.contactInvitation){
            contact.contactEvidenceVersion=1;
            enqueue(contact.url,'Published contact evidence',rootKey(contact.url),true);
        }
    }
    for (const url of websiteInputs(input)) enqueue(url, 'Linked website', true);
    const sameSite = url => [...roots].some(root => hostOf(root) === hostOf(url));
    const savePage = (record, originalUrl = record.url) => {
        const index = pages.findIndex(page => routeKey(page.url) === routeKey(record.url) || routeKey(page.url) === routeKey(originalUrl));
        if (index >= 0) pages[index] = record; else pages.push(record);
    };
    while (queue.size && attempts < maxPages && Date.now() < deadline) {
        const batch = [...queue.values()].filter(item => attempted.has(routeKey(item.url)) || attempted.size < maxRoutes)
            .sort((a, b) => routePriority(a) - routePriority(b)).slice(0, Math.min(3, maxPages - attempts));
        let remaining = maxRoutes - attempted.size;
        const eligible = batch.filter(item => attempted.has(routeKey(item.url)) || remaining-- > 0);
        if (!eligible.length) break;
        for (const item of eligible) {
            const key = routeKey(item.url);
            item.attempts = (pages.find(page => routeKey(page.url) === key)?.attempts || 0) + 1;
            queue.delete(key); visited.set(key, item.url); attempted.set(key, item.url); attempts++;
        }
        const results = await Promise.allSettled(eligible.map(async item => {
            let fetched,page;
            try{
                fetched = await fetchPage(item.url, { timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) });
                page=parsePage(fetched.html,routeUrl(fetched.url||item.url,publicUrl));
            }catch(error){
                if(!options.renderPage||!item.root&&routePriority(item)>1||[404,410].includes(error.httpStatus)||/private|unsupported|CERT_|certificate|size limit|NON_HTML/i.test(error.code+' '+error.message))throw error;
                try{fetched=await options.renderPage(item.url,{timeoutMs:Math.max(1,Math.min(10000,deadline-Date.now()))});}
                catch(renderError){error.message+=' Browser fallback: '+renderError.message;throw error;}
                page=parsePage(fetched.html,routeUrl(fetched.url||item.url,publicUrl));
            }
            if(options.renderPage&&(!page.readable||!page.contacts.length&&(item.root||routePriority(item)===0))&&deadline-Date.now()>1000){
                try{const rendered=await options.renderPage(page.url,{timeoutMs:Math.max(1,Math.min(10000,deadline-Date.now()))});const richer=parsePage(rendered.html,routeUrl(rendered.url||page.url,publicUrl));if(richer.readable&&(richer.contacts.length>page.contacts.length||!page.readable))page=richer;}catch{/* normal bounded failure stays in crawl evidence */}
            }
            return { page };
        }));
        for (let i = 0; i < results.length; i++) {
            const result = results[i], item = eligible[i], originalKey = routeKey(item.url);
            if (result.status === 'rejected') {
                const kind = failureKind(result.reason);
                if(item.root&&kind.status==='skipped'&&[404,410].includes(Number(result.reason?.httpStatus)))Object.assign(kind,{status:'blocked',retryable:false,note:'Linked website is unavailable: '+kind.note});
                kind.retryable &&= item.attempts < 3;
                if (kind.status === 'blocked') failed.set(originalKey, item.url); else failed.delete(originalKey);
                savePage({ url: item.url, label: item.label || 'Public route', ...kind, attempts: item.attempts });
                continue;
            }
            const page = result.value.page;
            if (item.root) roots.add(page.url);
            if (!sameSite(page.url) || isPlatformWebsite(page.url)) {
                failed.delete(originalKey);
                savePage({ url: item.url, label: item.label || 'Public route', status: 'skipped', retryable: false, attempts: item.attempts, note: 'Redirect left the linked business website.' });
                continue;
            }
            const key = routeKey(page.url);
            failed.delete(originalKey); failed.delete(key);
            if (page.canonical && sameSite(page.canonical)) {
                const canonicalKey = routeKey(page.canonical);
                if (visited.has(canonicalKey) && canonicalKey !== key && pages.some(p => routeKey(p.url) === canonicalKey && p.status === 'inspected')) {
                    savePage({ url: item.url, label: item.label || 'Public route', status: 'skipped', retryable: false, attempts: item.attempts, note: 'Canonical duplicate of an inspected page.' });
                    continue;
                }
                visited.set(canonicalKey, page.canonical); queue.delete(canonicalKey);
            }
            if (parsed.some(p => routeKey(p.url) === key)) continue;
            visited.set(key, page.url); discovered.add(key); queue.delete(key);
            const practiceRoot = [...roots].some(root => hostOf(root) === hostOf(page.url) && !/\/(?:team|staff|employees|our-coaches|people|members)(?:\/|$)/i.test(new URL(root).pathname));
            if (practiceRoot && ownedPage(page, input)) matchedHosts.add(hostOf(page.url));
            if (practiceRoot && contactMatchedPage?.(page,input)) contactMatchedHosts.add(hostOf(page.url));
            parsed.push(page);
            const contactPage = routePriority({ url: page.url, label: page.title }) === 0;
            if (page.description?.length >= 50) {
                const candidate = { url: page.url, text: page.description };
                if (descriptionScore(candidate) > descriptionScore(description)) description = candidate;
            }
            candidates.push(...page.contacts.map(contact => ({ ...contact, url: page.url, contactPage })));
            sources.push({ url: page.url, text: page.text, links: page.links, label: page.title || item.label, kind: 'WEBSITE', owned: false, observedAt: options.now });
            const record = { url: page.url, label: page.title || item.label || 'Public route', status: page.readable ? 'inspected' : 'blocked', retryable: !page.readable && item.attempts < 3, attempts: item.attempts,
                contactPage, hasDescription: page.description?.length >= 50,
                note: page.readable ? 'Public page inspected for contact information and description.' : 'Page has too little readable text; JavaScript or access restrictions may hide content.' };
            savePage(record, item.url);
            if (!page.readable) failed.set(key, page.url);
            for (const link of page.links) if (sameSite(link.url)) enqueue(link.url, link.text);
        }
    }
    for (const source of sources) source.owned = matchedHosts.has(hostOf(source.url));
    const contacts = [...new Map(candidates.map(contact => [contact.address + '|' + contact.url, contact])).values()];
    const blocked = pages.filter(page => page.status === 'blocked');
    const routeLimited = queue.size > 0 && attempted.size >= maxRoutes && [...queue.keys()].some(key => !attempted.has(key));
    const retryable = !storageLimited && !routeLimited && (queue.size > 0 || blocked.some(page => page.retryable && page.attempts < 3));
    const stoppedReason = storageLimited ? 'Website route storage limit reached; manual review is needed.'
        : routeLimited ? 'Website exceeds the ' + maxRoutes + '-route crawl limit; contact/about routes were prioritized. Manual review is needed.'
        : queue.size ? 'Pass budget reached; remaining discovered routes are saved.'
        : blocked.length ? blocked.length + ' website route(s) could not be read' + (retryable ? '; a bounded retry is available' : '; automatic retries stopped') + '. ' + blocked[0].url + ': ' + blocked[0].note : '';
    const inspected = pages.filter(page => page.status === 'inspected');
    return { pages, parsed, sources, description,
        crawl: { version: 2, attributionVersion:3, complete: !queue.size && !failed.size && !storageLimited, retryable, maxRoutes, storageLimited, attempted: [...attempted.values()],
            visited: [...visited.values()], pending: [...queue.values()].map(item => item.url), failed: [...failed.values()], roots: [...roots], matchedHosts: [...matchedHosts],contactMatchedHosts:[...contactMatchedHosts],
            discovered: discovered.size, inspected: inspected.length, contactPages: inspected.filter(page => page.contactPage || routePriority(page) === 0).length,
            descriptionPages: inspected.filter(page => page.hasDescription).length, stoppedReason, candidates: contacts },
    };
}
function websiteInputs(input) {
    return [...new Set([...(input.websites || []),input.website].filter(value=>typeof value==='string'&&value.trim())
        .flatMap(value=>value.split(/[,;]\s*(?=(?:https?:\/\/|www\.))/i).map(url=>url.trim())))].slice(0,8);
}
module.exports = { crawlWebsiteRoutes, websiteInputs, routeUrl, routeKey, publicRoute, routePriority, failureKind };
