export function approvedTestimonials(proof: string): { quote: string; attribution: string; category?: string }[] {
  return [...proof.matchAll(/(?:^|\n)Quote:\n([\s\S]*?)\nAttribution: ([^\n]+)(?:\nSource: [^\n]+)?(?:\nCategory: ([^\n]+))?/g)]
    .map(match => ({ quote: match[1], attribution: match[2], ...(match[3] ? { category: match[3] } : {}) }));
}
