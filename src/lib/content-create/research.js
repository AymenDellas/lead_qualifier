import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function publicIp(ip) {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    return !(parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(ip) === 6) return !(ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || ip === '::');
  return false;
}

async function validateUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP or HTTPS URLs are supported');
  if (url.username || url.password) throw new Error('URLs with credentials are not supported');
  if (url.port && !['80','443'].includes(url.port)) throw new Error('Non-standard ports are not supported');
  const records = await lookup(url.hostname, { all: true });
  if (!records.length || records.some(record => !publicIp(record.address))) throw new Error('Private or local URLs cannot be researched');
  return url;
}

function decodeEntities(text) {
  return text.replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi,(_,hex,decimal)=>String.fromCodePoint(parseInt(hex || decimal,hex?16:10))).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
}

function extract(html, baseUrl) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1].replace(/\s+/g,' ').trim());
  const description = decodeEntities((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [,''])[1]);
  const visible = html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi,' ');
  const headings = [...visible.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(match => decodeEntities(match[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())).filter(line=>line && line.length<260).slice(0,30);
  const h1 = [...visible.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(match=>decodeEntities(match[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())).find(line=>line && line.length<260) || '';
  const buttons = [...visible.matchAll(/<(?:button|a)[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)].map(match => decodeEntities(match[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())).filter(line=>line && line.length<180).slice(0,60);
  const links = [...visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => {
    const href = (match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [,''])[1];
    const label = decodeEntities(match[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    try { const url = new URL(decodeEntities(href),baseUrl); return ['http:','https:'].includes(url.protocol) && label ? {label,url:url.href} : null; } catch { return null; }
  }).filter(Boolean).slice(0,120);
  const formCount = [...visible.matchAll(/<form\b/gi)].length;
  const formActions = [...visible.matchAll(/<(?:input|button)\b([^>]*)>/gi)].map(match=>{
    if(!/\btype\s*=\s*["']?submit\b/i.test(match[1])) return '';
    return decodeEntities((match[1].match(/\bvalue\s*=\s*["']([^"']+)["']/i) || [,''])[1]);
  }).filter(Boolean).slice(0,10);
  const text = decodeEntities(visible.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()).slice(0,24000);
  return { title, description, h1, headings, buttons, links, formCount, formActions, text };
}

export async function researchUrl(raw) {
  let url = await validateUrl(raw);
  for (let redirects=0; redirects<4; redirects++) {
    const response = await fetch(url, { redirect:'manual', headers:{ 'User-Agent':'CompelContentOS/1.0 (+local research)' }, signal:AbortSignal.timeout(12000) });
    if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('Redirect has no destination'); url = await validateUrl(new URL(location,url).href); continue; }
    if (!response.ok) throw new Error(`Website returned ${response.status}`);
    if (!(response.headers.get('content-type') || '').includes('text/html')) throw new Error('The URL is not an HTML page. Paste text from this source instead.');
    const html = await response.text();
    if (html.length > 1_000_000) throw new Error('Page is too large to analyze');
    return { url:url.href, ...extract(html,url.href), fetchedAt:new Date().toISOString(), limitations:'HTML text extraction only. Dynamic content, booking flow, and mobile rendering may not be visible.' };
  }
  throw new Error('Too many redirects');
}

