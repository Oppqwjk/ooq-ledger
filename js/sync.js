// Sync with Supabase: push dirty records, pull changes. Last write wins by updated_at.
// Only rows whose collection starts with "lg-" belong to OOQ Ledger.

import * as db from './db.js';
import { loadScript } from './loader.js';

const SUPABASE_JS = 'vendor/supabase.js';
const TABLE = 'ooq_records';
const USER_KEY = 'ooq-ledger-user';
const PREFIX = 'lg-';

const cfg = window.OOQ_CONFIG || {};
let client = null;
let session = null;
let running = false;
let again = false;
let timer = null;
const statusListeners = new Set();
let status = { state: 'idle', at: null, error: null };

export function configured() {
  return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
}
export function knownUser() {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}
function remember(email) {
  try { if (email) localStorage.setItem(USER_KEY, email); } catch {}
}
export function getStatus() {
  return { ...status, pending: db.pendingCount(), online: navigator.onLine, enabled: configured(), user: knownUser() };
}
export function onStatus(fn) {
  statusListeners.add(fn);
}
function setStatus(s) {
  status = { ...status, ...s };
  for (const fn of statusListeners) fn(getStatus());
}

async function ensureClient() {
  if (client || !configured()) return client;
  await loadScript(SUPABASE_JS);
  client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  client.auth.onAuthStateChange((event, s) => {
    session = s;
    if (s?.user?.email) remember(s.user.email);
    if (event === 'SIGNED_IN') schedule(0);
  });
  const { data } = await client.auth.getSession();
  session = data.session;
  if (session?.user?.email) remember(session.user.email);
  return client;
}

export async function start() {
  if (!configured()) return;
  try {
    await ensureClient();
  } catch {
    setStatus({ state: 'offline', error: 'No se pudo cargar la sincronización' });
  }
  db.subscribe((src) => {
    if (src !== 'remote') schedule(1200);
  });
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') schedule(0);
  }, 30000);
  schedule(0);
}

export function schedule(ms = 1000) {
  if (!configured()) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export async function syncNow() {
  if (!configured()) return;
  if (running) {
    again = true;
    return;
  }
  if (!navigator.onLine) {
    setStatus({ state: 'offline' });
    return;
  }
  running = true;
  setStatus({ state: 'syncing', error: null });
  try {
    await ensureClient();
    if (!session) session = (await client.auth.getSession()).data.session;
    if (!session) {
      setStatus({ state: 'signed-out' });
      return;
    }
    const userId = session.user.id;

    const dirty = db.dirtyRecords();
    for (let i = 0; i < dirty.length; i += 500) {
      const chunk = dirty.slice(i, i + 500);
      const rows = chunk.map((r) => ({
        user_id: userId,
        id: r.id,
        collection: r.col,
        data: r.data,
        updated_at: r.updated_at,
        deleted: !!r.deleted,
      }));
      const { error } = await client.from(TABLE).upsert(rows, { onConflict: 'user_id,id' });
      if (error) throw error;
      await db.markClean(chunk);
    }

    let since = (await db.getMeta('pulled_at')) || '1970-01-01T00:00:00.000Z';
    for (let page = 0; ; page++) {
      let q = client.from(TABLE).select('id,collection,data,updated_at,deleted,server_updated_at').like('collection', PREFIX + '%');
      q = page === 0
        ? q.gte('server_updated_at', new Date(Date.parse(since) - 5000).toISOString())
        : q.gt('server_updated_at', since);
      const { data, error } = await q.order('server_updated_at', { ascending: true }).limit(1000);
      if (error) throw error;
      if (data.length) {
        await db.applyRemote(data);
        since = data[data.length - 1].server_updated_at;
        await db.setMeta('pulled_at', since);
      }
      if (data.length < 1000) break;
    }
    setStatus({ state: 'synced', at: new Date().toISOString(), error: null });
  } catch (e) {
    console.warn('sync failed', e);
    setStatus({ state: navigator.onLine ? 'error' : 'offline', error: e.message || String(e) });
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule(500);
    }
  }
}

/** Email + password. Creates the account the first time (needs "Confirm email" off in Supabase). */
export async function passwordLogin(email, password) {
  await ensureClient();
  let r = await client.auth.signInWithPassword({ email, password });
  if (!r.error) { session = r.data.session; remember(email); return session; }
  if (!/invalid login credentials/i.test(r.error.message)) throw r.error;
  const up = await client.auth.signUp({ email, password });
  if (up.error) throw up.error;
  if (!up.data.session) {
    throw new Error(up.data.user && up.data.user.identities && up.data.user.identities.length === 0
      ? 'Contraseña incorrecta.'
      : 'Supabase pide confirmar el email. Desactiva "Confirm email" en Authentication → Sign In / Providers → Email.');
  }
  session = up.data.session; remember(email);
  return session;
}
export async function sendLoginEmail(email) {
  await ensureClient();
  const redirect = location.origin + location.pathname;
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
  if (error) throw error;
}
export async function verifyCode(email, token) {
  await ensureClient();
  const { data, error } = await client.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
  session = data.session;
  if (session?.user?.email) remember(session.user.email);
  return session;
}
export async function currentSession() {
  if (!configured()) return null;
  try {
    await ensureClient();
  } catch {
    return null;
  }
  return session;
}
export async function logout() {
  try {
    await ensureClient();
    await client.auth.signOut();
  } catch (e) {
    console.warn(e);
  }
  session = null;
  try { localStorage.removeItem(USER_KEY); } catch {}
  await db.clearAll();
}
