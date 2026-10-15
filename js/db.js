// Local-first store: IndexedDB for persistence, an in-memory map for fast reads.
// Every record: { id, col, updated_at, deleted, dirty, data: {...} }
// Sync reads dirty records and merges remote ones with last-write-wins on updated_at.

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowStamp = () => new Date().toISOString();

const DB_NAME = 'ooq-ledger';
const DB_VERSION = 1;

let idb = null;
const mem = new Map(); // id -> record
const cache = new Map(); // col -> array (derived)
const listeners = new Set();

function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function init() {
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rows = await req(idb.transaction('records').objectStore('records').getAll());
  mem.clear();
  for (const r of rows) mem.set(r.id, r);
  cache.clear();
}

async function persist(records) {
  const t = idb.transaction('records', 'readwrite');
  const s = t.objectStore('records');
  for (const r of records) s.put(r);
  await txDone(t);
}

// Sources: 'local' (my edit), 'quiet' (my edit, screen already shows it), 'remote' (from sync).
let queued = null;
function emit(source) {
  cache.clear();
  if (queued) {
    queued.add(source);
    return;
  }
  queued = new Set([source]);
  queueMicrotask(() => {
    const set = queued;
    queued = null;
    const src = set.has('local') ? 'local' : set.has('remote') ? (set.has('quiet') ? 'local' : 'remote') : 'quiet';
    for (const fn of listeners) fn(src);
  });
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function view(r) {
  return { ...r.data, id: r.id, updated_at: r.updated_at };
}

/** All live objects in a collection. */
export function all(col) {
  if (!cache.has(col)) {
    const out = [];
    for (const r of mem.values()) if (r.col === col && !r.deleted) out.push(view(r));
    cache.set(col, out);
  }
  return cache.get(col);
}
export function get(col, id) {
  const r = mem.get(id);
  return r && r.col === col && !r.deleted ? view(r) : null;
}

let lastStamp = '';
function stamp() {
  // strictly increasing on this device, so quick successive edits keep their order
  let s = nowStamp();
  if (s <= lastStamp) s = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = s;
  return s;
}

/** Create or replace. Returns the saved object. opts.quiet: don't re-render the screen. */
export async function put(col, obj, opts = {}) {
  const id = obj.id || uid();
  const data = { ...obj };
  delete data.id;
  delete data.updated_at;
  const rec = { id, col, updated_at: stamp(), deleted: false, dirty: 1, data };
  mem.set(id, rec);
  emit(opts.quiet ? 'quiet' : 'local');
  await persist([rec]);
  return view(rec);
}
export async function putMany(col, objs) {
  const recs = objs.map((obj) => {
    const id = obj.id || uid();
    const data = { ...obj };
    delete data.id;
    delete data.updated_at;
    return { id, col, updated_at: stamp(), deleted: false, dirty: 1, data };
  });
  for (const r of recs) mem.set(r.id, r);
  emit('local');
  await persist(recs);
}
export async function patch(col, id, partial) {
  const cur = mem.get(id);
  const base = cur && !cur.deleted ? cur.data : {};
  return put(col, { ...base, ...partial, id });
}
export async function remove(col, id) {
  const cur = mem.get(id);
  if (!cur) return;
  const rec = { ...cur, col, deleted: true, dirty: 1, updated_at: stamp() };
  mem.set(id, rec);
  emit('local');
  await persist([rec]);
}

/**
 * Insert defaults with an old timestamp so any real (synced) version always wins.
 * Skips ids that already exist locally, including deleted ones.
 */
export async function seed(col, objs) {
  const recs = [];
  for (const obj of objs) {
    if (mem.has(obj.id)) continue;
    const data = { ...obj };
    delete data.id;
    recs.push({ id: obj.id, col, updated_at: '2000-01-01T00:00:00.000Z', deleted: false, dirty: 1, data });
  }
  if (!recs.length) return;
  for (const r of recs) mem.set(r.id, r);
  emit('local');
  await persist(recs);
}

// ---- sync support ----
export function dirtyRecords() {
  const out = [];
  for (const r of mem.values()) if (r.dirty) out.push(r);
  return out;
}
export function pendingCount() {
  let n = 0;
  for (const r of mem.values()) if (r.dirty) n++;
  return n;
}
/** Mark pushed records clean, unless they changed again while pushing. */
export async function markClean(pushed) {
  const changed = [];
  for (const p of pushed) {
    const cur = mem.get(p.id);
    if (cur && cur.dirty && cur.updated_at === p.updated_at) {
      const r = { ...cur, dirty: 0 };
      mem.set(p.id, r);
      changed.push(r);
    }
  }
  if (changed.length) await persist(changed);
}
/** Merge rows from the server: newest updated_at wins. */
export async function applyRemote(rows) {
  const changed = [];
  for (const row of rows) {
    const cur = mem.get(row.id);
    const remoteTs = new Date(row.updated_at).toISOString();
    if (cur && cur.updated_at >= remoteTs) continue;
    const r = { id: row.id, col: row.collection, updated_at: remoteTs, deleted: !!row.deleted, dirty: 0, data: row.data || {} };
    mem.set(r.id, r);
    changed.push(r);
  }
  if (changed.length) {
    await persist(changed);
    emit('remote');
  }
  return changed.length;
}

export async function getMeta(key) {
  const r = await req(idb.transaction('meta').objectStore('meta').get(key));
  return r ? r.value : undefined;
}
export async function setMeta(key, value) {
  const t = idb.transaction('meta', 'readwrite');
  t.objectStore('meta').put({ key, value });
  await txDone(t);
}

// ---- backup ----
export function exportRecords() {
  return [...mem.values()].filter((r) => !r.deleted).map((r) => ({ id: r.id, col: r.col, updated_at: r.updated_at, data: r.data }));
}
/**
 * Restore a backup: every backed-up record is written as a fresh local change,
 * and anything not in the backup is deleted. Sync then pushes the restored state.
 */
export async function importRecords(records) {
  const keep = new Set(records.map((r) => r.id));
  const out = [];
  for (const r of records) {
    const rec = { id: r.id, col: r.col, updated_at: stamp(), deleted: false, dirty: 1, data: r.data || {} };
    mem.set(rec.id, rec);
    out.push(rec);
  }
  for (const r of [...mem.values()]) {
    if (!keep.has(r.id) && !r.deleted) {
      const rec = { ...r, deleted: true, dirty: 1, updated_at: stamp() };
      mem.set(r.id, rec);
      out.push(rec);
    }
  }
  emit('local');
  await persist(out);
}

/** Wipe everything on this device (used on log out). */
export async function clearAll() {
  const t = idb.transaction(['records', 'meta'], 'readwrite');
  t.objectStore('records').clear();
  t.objectStore('meta').clear();
  await txDone(t);
  mem.clear();
  emit('local');
}
