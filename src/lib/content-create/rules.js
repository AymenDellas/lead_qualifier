export const PILLARS = ['breakdown', 'principle', 'transformation', 'pov'];
export const STATUSES = ['Idea', 'Researching', 'Drafting', 'Visuals', 'Ready for review', 'Approved', 'Scheduled', 'Published'];
export const METRICS = ['impressions', 'likes', 'comments', 'saves', 'shares', 'profileViews', 'followersGained', 'dms', 'leadsGenerated'];

export function validatePost(input, current = null) {
  if (!input || typeof input !== 'object') throw new Error('A post object is required');
  if (!String(input.title || '').trim()) throw new Error('A post title is required');
  if (!PILLARS.includes(input.pillar)) throw new Error('Select a valid content pillar');
  const status = input.status || current?.status || 'Idea';
  if (!STATUSES.includes(status)) throw new Error('Invalid post status');
  if (['Approved', 'Scheduled', 'Published'].includes(status) && !current?.approvedAt) throw new Error('Human approval is required before this status');
  if (status === 'Scheduled' && !input.plannedDate) throw new Error('Set a planned date before scheduling');
  if (status === 'Published' && !input.publishedDate) throw new Error('Set the actual published date');
  if (input.plannedDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.plannedDate)) throw new Error('Invalid planned date');
  return { ...input, status, title: input.title.trim() };
}

export function approvePost(current) {
  if (!current) throw new Error('Post not found');
  if (!String(current.body || '').trim()) throw new Error('A final draft is required before approval');
  if (!String(current.hook || '').trim()) throw new Error('Choose a hook before approval');
  return { ...current, status: 'Approved', approvedAt: new Date().toISOString() };
}

export function schedulePost(current, plannedDate) {
  if (!current?.approvedAt) throw new Error('Human approval is required before scheduling');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate || '')) throw new Error('Choose a valid scheduled date');
  return { ...current, status: 'Scheduled', plannedDate };
}

export function publishPost(current, publishedDate) {
  if (!current?.approvedAt) throw new Error('Human approval is required before marking this published');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate || '')) throw new Error('Enter the actual publication date');
  return { ...current, status: 'Published', publishedDate };
}

export function validateMetrics(input) {
  const values = {};
  for (const key of METRICS) {
    const value = Number(input[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error(`${key} must be a non-negative whole number`);
    values[key] = value;
  }
  return values;
}

export function analytics(posts, metrics) {
  const published = posts.filter(post => post.status === 'Published');
  const byId = new Map(metrics.map(metric => [metric.postId, metric]));
  const observed = published.map(post => ({ ...post, metrics: byId.get(post.id) || null })).filter(post => post.metrics);
  const totals = Object.fromEntries(METRICS.map(key => [key, observed.reduce((sum, post) => sum + post.metrics[key], 0)]));
  const groups = PILLARS.map(pillar => {
    const rows = observed.filter(post => post.pillar === pillar);
    const impressions = rows.reduce((sum, post) => sum + post.metrics.impressions, 0);
    const saves = rows.reduce((sum, post) => sum + post.metrics.saves, 0);
    return { pillar, count: rows.length, impressions, saves, saveRate: impressions ? saves / impressions : null };
  });
  const hookStyle = hook => String(hook || '').trim().endsWith('?') ? 'question' : /\b(no|not|never|worse|cost|broken|leak|miss|fail)\b/i.test(hook || '') ? 'negative consequence' : 'statement';
  const compare = (dimension, field) => {
    const values = [...new Set(observed.map(field).filter(Boolean))];
    const cohorts = values.map(value => {
      const rows = observed.filter(post => field(post) === value);
      const impressions = rows.reduce((sum, post) => sum + post.metrics.impressions, 0);
      const saves = rows.reduce((sum, post) => sum + post.metrics.saves, 0);
      return { value, count:rows.length, impressions, saves, saveRate:impressions ? saves / impressions : null };
    }).filter(cohort => cohort.count >= 5 && cohort.impressions > 0).sort((a,b) => b.saveRate - a.saveRate);
    if (cohorts.length < 2) return null;
    const best = cohorts[0], least = cohorts[cohorts.length-1];
    return { type:'Observed data', dimension, text:`${best.value} posts have a ${(best.saveRate*100).toFixed(2)}% save rate versus ${(least.saveRate*100).toFixed(2)}% for ${least.value} posts in this tracked sample. This is descriptive, not causal.`, sample:`${best.count} vs ${least.count} posts`, best, least };
  };
  const insights = [compare('pillar',post=>post.pillar),compare('format',post=>post.format),compare('topic',post=>post.topic),compare('hook style',post=>hookStyle(post.hook))].filter(Boolean);
  return { publishedCount: published.length, trackedCount: observed.length, totals, groups, insights, topPosts: [...observed].sort((a,b) => b.metrics.saves - a.metrics.saves).slice(0,5) };
}

