// OOQ Manager notifications. Runs every hour on GitHub Actions (free): reads your Ledger from Supabase,
// runs the same engine as the app, asks Claude for the morning briefing and sends what matters to your Telegram.
// Secrets (repo Settings -> Secrets and variables -> Actions): SUPABASE_SECRET_KEY, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY.
import * as B from '../js/brain.js';
import { createAgent, SYSTEM } from '../js/agent.js';

const E = process.env;
const SB = E.SUPABASE_URL || 'https://bnxgswbnoablgplqfkru.supabase.co';
const KEY = E.SUPABASE_SECRET_KEY, TG = E.TELEGRAM_BOT_TOKEN, AI = E.ANTHROPIC_API_KEY;
const MODEL = E.AI_MODEL || 'claude-sonnet-5-5', APP = E.APP_URL || 'https://oppqwjk.github.io/ooq-ledger/';
const FORCE = E.FORCE_BRIEF === '1';
const TGAPI = E.TG_API || 'https://api.telegram.org';
if (!KEY || !TG) { console.log('Falta SUPABASE_SECRET_KEY o TELEGRAM_BOT_TOKEN en los secrets del repo.'); process.exit(0); }
const H = KEY.startsWith('eyJ') ? { apikey: KEY, Authorization: 'Bearer ' + KEY } : { apikey: KEY };
const n0 = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
const sum = (a) => a.reduce((s, x) => s + x, 0);

// local time in Madrid
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`, hour = Number(parts.hour) % 24;

/* ---------- read the Ledger ---------- */
const res = await fetch(`${SB}/rest/v1/ooq_records?select=user_id,id,collection,data,deleted&collection=like.lg-*&deleted=eq.false&limit=20000`, { headers: H });
if (!res.ok) { console.error('Supabase', res.status, await res.text()); process.exit(1); }
const rows = await res.json();
const owner = (rows.find((r) => r.collection === 'lg-settings') || rows[0] || {}).user_id;
if (!owner) { console.log('Sin datos todavía.'); process.exit(0); }
const mine = rows.filter((r) => r.user_id === owner);
const col = (c) => mine.filter((r) => r.collection === 'lg-' + c).map((r) => ({ ...r.data, id: r.id }));
const DEF = { cash: 0, cashAt: '1970-01-01T00:00:00.000Z', cushion: 0, monthlyGoal: 1000, defaultCost: 10, accounts: ['tictac spain'] };
const settings = { ...DEF, ...((col('settings').find((x) => x.id === 'settings')) || {}) };
const data = { models: col('models'), sales: col('sales'), orders: col('orders'), listings: col('listings'), spend: col('spend'), income: col('income'), bills: col('bills') };
const stateRow = col('notify').find((x) => x.id === 'notify-state') || { id: 'notify-state', sent: {} };
const sent = stateRow.sent || {};

/* ---------- same money maths as the app ---------- */
const costOf = (m) => (m && !isNaN(parseFloat(m.landed)) ? n0(m.landed) : n0(settings.defaultCost));
const payments = (o) => o.payments || [];
function cashNow() {
  const t = settings.cashAt || ''; let c = n0(settings.cash);
  for (const x of data.sales) if ((x.at || '') > t) c += n0(x.price);
  for (const x of data.income) if ((x.at || '') > t) c += n0(x.amount);
  for (const x of data.spend) if ((x.at || '') > t) c -= n0(x.amount);
  for (const o of data.orders) { if ((o.at || '') > t) c -= n0(o.paid); for (const p of payments(o)) if ((p.at || '') > t) c -= n0(p.amount); if (o.receivedAt && o.receivedAt > t) c -= n0(o.dhl); }
  return c;
}
const pendingDays = n0(settings.pendingDays) || B.FALLBACK.pendingDays;
const pendingVinted = () => sum(data.sales.filter((x) => (x.at || '') > (settings.cashAt || '') && Date.parse(x.at) > Date.now() - pendingDays * 864e5).map((x) => n0(x.price)));
const owedTotal = () => sum(data.orders.map((o) => n0(o.owed)));
const pendingBills = () => sum(data.bills.filter((b) => b.month <= today.slice(0, 7) && !b.paid).map((b) => n0(b.amount)));
const spendable = () => cashNow() - pendingVinted() - n0(settings.cushion) - pendingBills() - owedTotal();
let cache = null;
const brain = () => cache || (cache = B.analyze({ models: data.models, sales: data.sales, orders: data.orders, listings: data.listings, settings, now: Date.now(), today, costOf, cashFree: spendable(), owed: owedTotal() }));
const L = (k) => data[k] || [];
const agent = createAgent({ db: null, C: {}, L, model: (id) => data.models.find((m) => m.id === id), S0: () => settings, brain, fresh: () => { cache = null; }, costOf, todayKey: () => today, nowISO: () => new Date().toISOString(), patchSettings: async () => {}, pouches: () => n0(settings.pouches), pouchCost: () => n0(settings.pouchCost), cashNow, pendingVinted, owedTotal, spendable });

/* ---------- Telegram ---------- */
let chatId = E.TELEGRAM_CHAT_ID || stateRow.chatId;
if (!chatId) {
  const u = await (await fetch(`${TGAPI}/bot${TG}/getUpdates`)).json();
  const last = (u.result || []).map((x) => x.message || x.edited_message).filter(Boolean).pop();
  if (!last) { console.log('Abre tu bot en Telegram y pulsa Start (o escribe /start). Luego vuelve a lanzar.'); process.exit(0); }
  chatId = String(last.chat.id);
}
async function tg(text) {
  const r = await fetch(`${TGAPI}/bot${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }) });
  if (!r.ok) console.error('Telegram', r.status, await r.text());
}
async function claude(prompt) {
  if (!AI) return null;
  const r = await fetch((E.AI_API || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AI, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: SYSTEM + '\n\nDATOS (ahora mismo):\n' + JSON.stringify(agent.snapshot()), messages: [{ role: 'user', content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Claude', r.status, JSON.stringify(j).slice(0, 300)); return null; }
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/\*\*/g, '').trim();
}
async function upsert(list) {
  const r = await fetch(`${SB}/rest/v1/ooq_records?on_conflict=user_id,id`, { method: 'POST', headers: { ...H, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(list.map(([collection, id, d]) => ({ user_id: owner, id, collection, data: d, updated_at: new Date().toISOString(), deleted: false }))) });
  if (!r.ok) console.error('Supabase write', r.status, await r.text());
}

/* ---------- what to say ---------- */
const bz = brain(), out = [], once = (k) => (sent[k] ? false : (sent[k] = new Date().toISOString(), true));
const chatRows = [];
// morning briefing 9:00–12:59
if ((hour >= 9 && hour < 13 && once('brief:' + today)) || FORCE) {
  const txt = await claude('Briefing de la mañana para Telegram. Cómo voy (caja, deuda, mes vs objetivo y mínimo), los 3 movimientos con más impacto de HOY con números, y qué tests tocan control. Texto plano, sin markdown ni emojis, máximo 900 caracteres. Agresivo.')
    || ['OOQ · ' + today, ...bz.moves.slice(0, 5).map((m, i) => `${i + 1}. ${m.title} — ${m.why}`)].join('\n');
  await tg(txt + '\n\n' + APP + '#manager');
  chatRows.push(['lg-chat', 'chat-srv-brief-' + today, { role: 'assistant', text: txt, at: new Date().toISOString(), actions: [], source: 'server' }]);
}
// test checkpoints
for (const t of bz.tests) {
  if (!t.ls.length || !t.start) continue;
  for (const cp of [24, 48, 72]) {
    if (t.hours >= cp && t.hours < cp + 10 && once(`test:${t.m.id}:${cp}:${t.start}`)) {
      out.push(t.stage === 'datos' ? `${t.m.name}: ${cp}h → manda la captura de stats al Manager ya` : `${t.m.name}: ${cp}h → ${(B.STAGE[t.stage] || t.stage).toUpperCase()} · ${t.why} → ${t.act}`);
    }
  }
}
// stock about to break, once a day per watch
for (const s of bz.stocks) if (['rotura', 'urgente'].includes(s.status) && once(`stock:${s.m.id}:${today}`)) out.push(`${s.m.name}: ${s.why}`);
// debt reminder once a day in the morning window
if (owedTotal() > 0 && hour >= 9 && once('debt:' + today)) out.push(`Debes ${Math.round(owedTotal())} €: deuda primero`);
// evening: how the day went
if (hour >= 21 && once('eve:' + today)) {
  const p = bz.pace, sold = data.sales.filter((v) => v.date === today);
  out.push(`Hoy: ${sold.length} venta${sold.length === 1 ? '' : 's'} (+${Math.round(sum(sold.map((v) => n0(v.profit))))} €). Mes: ${p.S}${p.T ? ' de ' + p.T : ''}${p.T ? ` → necesitas ${p.need.toFixed(1)}/día` : ''}.` + (sold.length ? '' : ' Si vendiste y no lo apuntaste, díselo al Manager.'));
}
if (out.length) await tg('OOQ Manager\n' + out.map((x) => '- ' + x).join('\n') + '\n\n' + APP);
// keep only the last 400 keys
const keys = Object.keys(sent).sort((a, b) => sent[a].localeCompare(sent[b])); for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete sent[k];
await upsert([...chatRows, ['lg-notify', 'notify-state', { id: 'notify-state', sent, chatId }]]);
console.log(`ok · ${today} ${hour}h · ${out.length} avisos${chatRows.length ? ' + briefing' : ''}`);
