export const FORMATS = ['Text post', 'Carousel', 'Short video script'];

export const DEFAULT_DIRECTION = {
  audience: 'Coaches selling a high-value coaching offer',
  offer: 'Coaching funnel strategy, copy, and design',
  topics: 'Offer clarity, qualified bookings, buyer trust, and booking friction',
  beliefs: 'A funnel should make the next decision clearer. Qualified conversations matter more than raw conversion rates.',
  tone: 'Direct, conversational, specific, and thoughtfully opinionated. No hype or generic motivational advice.',
  examples: '',
  cta: 'Build trust and invite relevant conversations. Use a natural close; not every post needs a sales pitch.',
};

// Older drafts may already include their hook or CTA in body. Keep every export
// and preview consistent without duplicating either part.
export function postText(post) {
  const hook = String(post.hook || post.recommendedHook || '').trim();
  const body = String(post.body || '').trim();
  const cta = String(post.cta || '').trim();
  return [hook && !body.startsWith(hook) ? hook : '', body, cta && !body.endsWith(cta) ? cta : ''].filter(Boolean).join('\n\n');
}

export const EDITABLE_FIELDS = ['title', 'topic', 'hook', 'body', 'cta', 'shortVersion', 'slides', 'videoPlan'];

export function draftSnapshot(post) {
  return Object.fromEntries(EDITABLE_FIELDS.map(key => [key, post[key] ?? (key === 'slides' ? [] : key === 'videoPlan' ? null : '')]));
}
