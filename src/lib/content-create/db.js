import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const names = new Set(['posts', 'ideas', 'concepts', 'beliefs', 'settings', 'funnels', 'scoutRuns', 'ideaUsage', 'metrics', 'feedback']);

export function openDatabase(path = join(process.cwd(), 'data', 'content-studio.json')) {
  path ||= join(process.cwd(), 'data', 'content-studio.json');
  mkdirSync(dirname(path), { recursive:true });
  if (!existsSync(path)) writeFileSync(path, '{}', { flag:'wx' });
  return { path };
}

function table(name) { if (!names.has(name)) throw new Error('Invalid collection'); return name; }
function read(db) {
  const data = JSON.parse(readFileSync(db.path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Create storage is invalid');
  return data;
}
function write(db, data) {
  const temporary = `${db.path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  // Windows sync clients and virus scanners can briefly hold the destination
  // after a save. Keep replacement atomic and retry only transient locks.
  for (let attempt=0;attempt<6;attempt++) {
    try {renameSync(temporary,db.path);return;}
    catch (error) {
      if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt===5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(200,25*2**attempt));
    }
  }
}
export function list(db, name) {
  const rows = read(db)[table(name)] || {};
  return Object.values(rows).sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
export function get(db, name, id) { return read(db)[table(name)]?.[id] || null; }
export function put(db, name, value) {
  table(name);
  const data = read(db);
  const rows = data[name] || {};
  const current = value.id ? rows[value.id] : null;
  const now = new Date(Math.max(Date.now(), Date.parse(current?.updatedAt || '') + 1 || 0)).toISOString();
  const next = { ...current, ...value, id:value.id || randomUUID(), createdAt:current?.createdAt || now, updatedAt:now };
  data[name] = { ...rows, [next.id]:next };
  write(db, data);
  return next;
}
export function remove(db, name, id) {
  table(name);
  const data = read(db);
  if (!data[name]?.[id]) return false;
  delete data[name][id];
  if (name === 'posts') data.metrics = Object.fromEntries(Object.entries(data.metrics || {}).filter(([,row]) => row.postId !== id));
  write(db, data);
  return true;
}
export function addMetrics(db, postId, values) { return put(db, 'metrics', {postId, recordedAt:new Date().toISOString(), ...values}); }
export function latestMetrics(db) {
  const latest = new Map();
  for (const row of list(db, 'metrics').sort((a,b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))) {
    if (!latest.has(row.postId)) latest.set(row.postId, row);
  }
  return [...latest.values()];
}
