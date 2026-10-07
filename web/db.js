/* Local-first storage. Readings live in IndexedDB on the device. Encrypted
   backups are explicit file exports and nothing here uploads data. */
'use strict';

const DB_NAME = 'bpdigitizer';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('readings')) {
        const s = db.createObjectStore('readings', { keyPath: 'id', autoIncrement: true });
        // Every list and chart query is "most recent first, within a range".
        s.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('ocrAudits')) {
        const s = db.createObjectStore('ocrAudits', { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    // IDBRequest.result may legitimately be undefined (a missing key, delete,
    // or put with no useful return value). Checking the value therefore turns
    // a missing preference into the request object itself, which then poisons
    // defaults such as `getKV('rangeDays') ?? 30` on a clean install.
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* Tags reach us in three shapes: this app's comma-joined `tag_*` keys, the
   Android export's JSON array of BpTag enum names, and the odd hand-edited
   string. Normalise all of them to one comma-joined key list, because
   everything downstream calls .split(',') on it. */
export function normalizeTags(v) {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(',');
  return parts
    .map((x) => String(x).trim())
    .filter(Boolean)
    // BpTag.ON_WAKING and tag_on_waking are the same tag under two spellings.
    .map((x) => (x.startsWith('tag_') ? x : `tag_${x.toLowerCase()}`))
    .join(',');
}

export async function addReading(r) {
  const row = {
    timestamp: r.timestamp ?? Date.now(),
    systolic: r.systolic,
    diastolic: r.diastolic,
    pulse: r.pulse ?? null,
    category: r.category,
    notes: r.notes ?? null,
    tags: normalizeTags(r.tags),
    source: r.source ?? 'manual',
  };
  return tx('readings', 'readwrite', (s) => s.add(row));
}

export async function updateReading(r) {
  return tx('readings', 'readwrite', (s) => s.put(r));
}

export async function deleteReading(id) {
  return tx('readings', 'readwrite', (s) => s.delete(id));
}

export async function allReadings() {
  const rows = await tx('readings', 'readonly', (s) => s.getAll());
  const broken = (rows || []).filter((r) => typeof r.tags !== 'string');
  if (broken.length) {
    for (const r of broken) await updateReading({ ...r, tags: normalizeTags(r.tags) });
    return allReadings();
  }
  return (rows || []).sort((a, b) => b.timestamp - a.timestamp);
}

export async function readingsSince(ms) {
  const all = await allReadings();
  return ms ? all.filter((r) => r.timestamp >= Date.now() - ms) : all;
}

export async function lastReading() {
  const all = await allReadings();
  return all[0] || null;
}

/* Import is timestamp-deduplicated, matching the Android behaviour: a file
   imported twice must not double every point on the chart. */
export async function importReadings(rows) {
  const existing = new Set((await allReadings()).map((r) => r.timestamp));
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (existing.has(r.timestamp)) { skipped++; continue; }
    await addReading(r);
    existing.add(r.timestamp);
    added++;
  }
  return { added, skipped };
}

export const getKV = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

export const addOcrAudit = (row) =>
  tx('ocrAudits', 'readwrite', (s) => s.add(row));

export const getOcrAudit = (id) =>
  tx('ocrAudits', 'readonly', (s) => s.get(id));

export async function updateOcrAudit(id, patch) {
  const row = await getOcrAudit(id);
  if (!row) return false;
  await tx('ocrAudits', 'readwrite', (s) => s.put({ ...row, ...patch, id }));
  return true;
}

export async function allOcrAudits() {
  const rows = await tx('ocrAudits', 'readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => b.createdAt - a.createdAt);
}

export const deleteOcrAudit = (id) =>
  tx('ocrAudits', 'readwrite', (s) => s.delete(id));

export const clearOcrAudits = () =>
  tx('ocrAudits', 'readwrite', (s) => s.clear());

export async function pruneOcrAudits(maxEntries) {
  const rows = await allOcrAudits();
  for (const row of rows.slice(maxEntries)) await deleteOcrAudit(row.id);
}

export async function stats() {
  const all = await allReadings();
  return {
    count: all.length,
    first: all.length ? all[all.length - 1].timestamp : null,
    last: all.length ? all[0].timestamp : null,
  };
}

export async function wipe() {
  await tx('readings', 'readwrite', (s) => s.clear());
}
