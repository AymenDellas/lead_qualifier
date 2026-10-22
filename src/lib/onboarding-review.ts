/** Readable source-based previews. Originals are never replaced by a preview. */
export type ReviewKey = 'differentiation' | 'unsuitableClients' | 'trafficSources' | 'coachBio' | 'proof';
const plain = (value: string) => value.replace(/\r/g, '').replace(/^#{1,6}\s+|^[-*•]\s+/gm, '').trim();
const words = (value: string) => value.split(/\s+/).filter(Boolean);

export function sourceExcerpt(value: string, limit = 42): string {
    const text = plain(value).replace(/\s+/g, ' ').replace(/^[“"]|[”"]$/g, '');
    if (words(text).length <= limit) return text;
    const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(s => s.trim()).filter(Boolean) || [text];
    const result = sentences.find(s => /\b(?:helped|able to|now|confidence|clarity|clear|achieved|changed|result|learned|learn|brought|gave|gained|began|courage)\b/i.test(s) && words(s).length <= limit)
        || sentences.find(s => /\b(?:experience|years|certified|trained)\b/i.test(s) && words(s).length <= limit)
        || sentences.find(s => words(s).length >= 6 && words(s).length <= limit);
    if (result) return `${text.startsWith(result) ? '' : '… '}${result}${text.endsWith(result) ? '' : ' …'}`;
    return `${words(text).slice(0, limit).join(' ')}…`;
}

export function reviewSummary(value: string, key: ReviewKey): string {
    const text = plain(value);
    if (!text) return '';
    if (key === 'proof') return proofPreview(text).items.map(item => `${item.excerpt}${item.attribution ? ` — ${item.attribution}` : ''}`).join('\n\n');
    // Select complete, relevant factual sentences instead of rendering promotional paragraphs.
    const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(s => s.trim()).filter(Boolean) || [text];
    const relevant = key === 'coachBio' ? sentences.filter(s => /\b(?:years?|experience|certified|trained|background|worked|founded|coach|help|approach)\b/i.test(s)) : sentences;
    const selected = (relevant.length ? relevant : sentences).slice(0, key === 'coachBio' ? 2 : 1).join(' ');
    return sourceExcerpt(selected, key === 'coachBio' ? 55 : 38);
}

export function proofPreview(value: string) {
    const text = plain(value);
    const structured = [...text.matchAll(/(?:^|\n\n)Quote:\s*\n?([\s\S]+?)\nAttribution:\s*([^\n]+)(?:\nSource:\s*[^\n]*)?(?:\nCategory:\s*[^\n]*)?(?=\n\nQuote:|$)/g)]
        .map(match => ({ quote: match[1].trim(), attribution: match[2].trim() }));
    const quoted = [...text.matchAll(/[“"]([^“”"]{35,})[”"](?:\s*\n(?:[—–-]\s*)?([^\n]{2,120}))?/g)]
        .map(match => ({ quote: match[1].trim(), attribution: match[2]?.trim() || '' }));
    const items = structured.length ? structured : quoted.length ? quoted : text.split(/\n\s*\n/).filter(s => s.trim().length > 30)
        .map(quote => ({ quote, attribution: '' }));
    if (!items.length && text) items.push({ quote: text, attribution: '' });
    return { total: items.length, items: items.slice(0, 3).map(item => ({ ...item, excerpt: sourceExcerpt(item.quote) })) };
}
