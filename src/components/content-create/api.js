export async function api(path, options = {}) {
  const response = await fetch(`/api/content-create/${path}`, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('The dashboard did not return JSON for Create.'); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

export const today = () => new Date().toLocaleDateString('en-CA');
export const startOfWeek = (date = today()) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString('en-CA');
};
export const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};
export const formatDate = (date, options = { day:'numeric', month:'short' }) => date ? new Date(`${date}T12:00:00`).toLocaleDateString('en-US', options) : '—';
export const fmt = number => Number(number || 0).toLocaleString('en-US');

export const PILLARS = {
  breakdown: { label:'Funnel breakdown', short:'Breakdown', color:'#c7ff38' },
  principle: { label:'Principle', short:'Principle', color:'#7dd3fc' },
  transformation: { label:'Before / after', short:'Before / after', color:'#c4b5fd' },
  pov: { label:'POV', short:'POV', color:'#fb923c' },
};
export const STATUSES = ['Idea','Researching','Drafting','Visuals','Ready for review','Approved','Scheduled','Published'];
export const METRICS = { impressions:'Impressions',likes:'Likes',comments:'Comments',saves:'Saves',shares:'Shares',profileViews:'Profile views',followersGained:'Followers gained',dms:'DMs',leadsGenerated:'Leads generated' };

