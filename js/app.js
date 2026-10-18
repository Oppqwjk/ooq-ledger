// OOQ Ledger + OOQ Manager: real cash, debts, orders, smart stock, fast tests, accounts,
// best moves, P&L calendar, spending and the monthly plan.
import * as db from './db.js';
import * as sync from './sync.js';
import * as B from './brain.js';
import { createAgent, MODES as AI_MODES } from './agent.js';

const C = { settings: 'lg-settings', models: 'lg-models', sales: 'lg-sales', orders: 'lg-orders', spend: 'lg-spend', income: 'lg-income', bills: 'lg-bills', goals: 'lg-goals', listings: 'lg-listings', chat: 'lg-chat', transfers: 'lg-transfers' };
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app'), sheetEl = $('#sheet'), toastEl = $('#toast');

/* ---------------- helpers ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monthKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1);
const todayKey = () => dayKey(new Date());
const curMonth = () => monthKey(new Date());
const pm = (mk) => { const [y, m] = mk.split('-').map(Number); return { y, m }; };
const daysIn = (mk) => { const { y, m } = pm(mk); return new Date(y, m, 0).getDate(); };
const shiftMonth = (mk, d) => { const { y, m } = pm(mk); return monthKey(new Date(y, m - 1 + d, 1)); };
const dateOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const shiftDay = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return dayKey(d); };
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 86400000);
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MSHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WD = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const monthName = (mk) => { const { y, m } = pm(mk); return MONTHS[m - 1] + ' ' + y; };
const shortDate = (k) => { const d = dateOf(k); return d.getDate() + ' ' + MSHORT[d.getMonth()]; };
const num = (v) => (v === null || v === undefined || v === '' ? NaN : parseFloat(String(v).replace(/\s/g, '').replace(',', '.')));
const n0 = (v) => { const x = num(v); return isNaN(x) ? 0 : x; };
const r2 = (v) => Math.round(v * 100) / 100;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
let fmtCache = {};
function eur(v, sign) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const a = Math.abs(r2(v)), dec = 2;
  if (!fmtCache[dec]) fmtCache[dec] = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: dec, maximumFractionDigits: 2, useGrouping: 'always' });
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + fmtCache[dec].format(a);
}
const short = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('es-ES', { useGrouping: 'always' });
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const STATUS = { ganador: 'Ganador', test: 'Test', espera: 'En espera', descartado: 'Descartado' };
const SORDER = { ganador: 0, test: 1, espera: 2, descartado: 3 };
const CATS = { personal: ['Comida', 'Ocio', 'Ropa', 'Transporte', 'Móvil y subs', 'Otros'], negocio: ['Boost Vinted', 'Envíos', 'Fotos y material', 'Otros negocio'] };
const METRICS = {
  bestMonth: 'Mejor mes de beneficio',
  streak: 'Meses seguidos por encima de un beneficio',
  cash: 'Caja real',
  totalProfit: 'Beneficio total acumulado',
  units: 'Relojes vendidos en total',
};
const DEF = { cash: 0, cashAt: '1970-01-01T00:00:00.000Z', cushion: 0, monthlyGoal: 1000, defaultCost: 10, perSale: 0, accounts: ['tictac spain', 'y2kwatches'] };

/* ---------------- data access ---------------- */
const L = (k) => db.all(C[k]);
const S0 = () => Object.assign({}, DEF, db.get(C.settings, 'settings') || {});
const model = (id) => db.get(C.models, id);
const goal = () => n0(S0().monthlyGoal) || 1000;
const planOf = (mk) => (S0().plan || {})[mk] || null;
const goalFor = (mk) => { const p = planOf(mk); return p && n0(p.profit) ? n0(p.profit) : goal(); };
// cost of one watch: the real one if known, otherwise the estimate from Ajustes
const costOf = (m) => (m && !isNaN(num(m.landed)) ? num(m.landed) : n0(S0().defaultCost));
const isEst = (m) => !m || isNaN(num(m.landed)) || m.landedSrc === 'estimado';
// where a unit cost comes from: an order (real, or estimated while DHL/IVA isn't known), typed by you, or the default
const costSrc = (m) => (!m || isNaN(num(m.landed)) ? 'por defecto' : m.landedSrc === 'real' ? 'real (pedido)' : m.landedSrc === 'estimado' ? 'estimado (pedido)' : 'puesto a mano');
// pouches: a supply that goes with some sales, not a product
const pouchCost = () => { const s = S0(); return n0(s.pouchCost !== undefined ? s.pouchCost : s.perSale); };
const pouches = () => n0(S0().pouches);
async function patchSettings(p) { await db.put(C.settings, { ...(db.get(C.settings, 'settings') || DEF), ...p, id: 'settings' }); }
const profitOf = (s) => (typeof s.profit === 'number' ? s.profit : n0(s.price) - n0(s.cost));
const on = (arr, pre, f = 'date') => arr.filter((x) => x[f] && x[f].startsWith(pre));

const payments = (o) => o.payments || [];
const orderCost = (o) => n0(o.paid) + sum(payments(o).map((p) => n0(p.amount))) + n0(o.owed) + n0(o.dhl);
const owedTotal = () => sum(L('orders').map((o) => n0(o.owed)));
const pendingDays = () => n0(S0().pendingDays) || B.FALLBACK.pendingDays;
// Money lives in 3 places, like in Vinted: PENDING (sold, buyer hasn't confirmed) -> VINTED BALANCE (released) -> BANK (withdrawal).
const isPending = (x) => !x.released && !x.cancelled;
const pendingSales = (acc) => L('sales').filter((x) => isPending(x) && (!acc || x.account === acc));
const pendingVinted = (acc) => sum(pendingSales(acc).map((x) => n0(x.price)));
function vintedBalance(acc) {
  const s = S0(), t = s.vbalAt || '', base = s.vbal || {};
  let b = acc ? n0(base[acc]) : sum(Object.values(base).map(n0));
  for (const x of L('sales')) if (x.released && !x.cancelled && (x.releasedAt || '') > t && (!acc || x.account === acc)) b += n0(x.price);
  for (const w of L('transfers')) if ((w.at || '') > t && (!acc || w.account === acc)) b -= n0(w.amount);
  return b;
}
function parts(pre) {
  const sales = on(L('sales'), pre).filter((x) => !x.cancelled), spend = on(L('spend'), pre), inc = on(L('income'), pre);
  const ord = on(L('orders'), pre).filter((o) => !o.draft), dhl = on(L('orders'), pre, 'receivedDate');
  const pays = sum(L('orders').flatMap((o) => payments(o)).filter((p) => p.date && p.date.startsWith(pre)).map((p) => n0(p.amount)));
  const p = {
    sales, nSales: sales.length,
    revenue: sum(sales.map((s) => n0(s.price))),
    profit: sum(sales.map(profitOf)),
    released: sum(L('sales').filter((x) => x.released && !x.cancelled && (x.releasedAt || '').slice(0, 10).startsWith(pre)).map((x) => n0(x.price))),
    withdraw: sum(on(L('transfers'), pre).map((w) => n0(w.amount))),
    biz: sum(spend.filter((x) => x.kind === 'negocio').map((x) => n0(x.amount))),
    pers: sum(spend.filter((x) => x.kind !== 'negocio').map((x) => n0(x.amount))),
    income: sum(inc.map((x) => n0(x.amount))),
    orders: sum(ord.map((o) => n0(o.paid))) + sum(dhl.map((o) => n0(o.dhl))) + pays,
    nOrders: ord.length,
  };
  p.net = p.profit - p.biz;
  p.flow = p.withdraw + p.income - p.biz - p.pers - p.orders; // what moves in your bank
  return p;
}
function bankNow() {
  const s = S0(), t = s.cashAt || '';
  let c = n0(s.cash);
  for (const w of L('transfers')) if ((w.at || '') > t) c += n0(w.amount);
  for (const x of L('income')) if ((x.at || '') > t) c += n0(x.amount);
  for (const x of L('spend')) if ((x.at || '') > t) c -= n0(x.amount);
  for (const o of L('orders')) {
    if (o.draft) continue;
    if ((o.at || '') > t) c -= n0(o.paid);
    for (const p of payments(o)) if ((p.at || '') > t) c -= n0(p.amount);
    if (o.receivedAt && o.receivedAt > t) c -= n0(o.dhl);
  }
  return c;
}
const cashNow = () => bankNow() + vintedBalance() + pendingVinted(); // all your money, wherever it is
const pendingBills = () => sum(L('bills').filter((b) => b.month <= curMonth() && !b.paid).map((b) => n0(b.amount)));
// you can only spend what's in the bank or already released in Vinted
const spendable = () => bankNow() + vintedBalance() - n0(S0().cushion) - pendingBills() - owedTotal();

// Which sales paid back which order: first in, first out, per watch model.
function payback() {
  const res = {}, lots = {};
  const orders = L('orders').filter((o) => !o.draft).sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  for (const o of orders) {
    res[o.id] = { units: 0, sold: 0, rev: 0, cost: orderCost(o), potential: 0, lots: [] };
    for (const l of o.lines || []) {
      const lot = { oid: o.id, modelId: l.modelId, date: o.date, recAt: o.status === 'recibido' ? (o.receivedAt || (o.receivedDate ? o.receivedDate + 'T12:00:00.000Z' : '')) : '', left: n0(l.qty) };
      res[o.id].units += n0(l.qty);
      res[o.id].lots.push(lot);
      (lots[l.modelId] = lots[l.modelId] || []).push(lot);
    }
  }
  const sales = L('sales').slice().sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  for (const s of sales) {
    // a sale counts toward an order only if it happened after the order was paid
    // a sale only pays back an order once that order has arrived; before that it's old stock
    if (s.cancelled) continue;
    const lot = (lots[s.modelId] || []).find((x) => x.left > 0 && x.recAt && (s.at || s.date + 'T23:00:00.000Z') >= x.recAt);
    if (!lot) continue;
    lot.left--;
    res[lot.oid].sold++;
    res[lot.oid].rev += n0(s.price);
  }
  for (const id in res) {
    res[id].potential = sum(res[id].lots.map((l) => { const m = model(l.modelId); return l.left * n0(m && (m.listPrice || m.minPrice)); }));
  }
  return res;
}

function lastUnitPrice(mid) {
  const os = L('orders').filter((o) => (o.lines || []).some((l) => l.modelId === mid)).sort((a, b) => b.date.localeCompare(a.date));
  if (!os.length) return null;
  const l = os[0].lines.find((x) => x.modelId === mid);
  return n0(l.unit) || null;
}
function monthRange() {
  const set = new Set();
  L('sales').forEach((s) => s.date && set.add(s.date.slice(0, 7)));
  L('spend').forEach((s) => s.date && set.add(s.date.slice(0, 7)));
  const ms = [...set].sort();
  if (!ms.length) return [curMonth()];
  const out = []; let m = ms[0];
  const end = ms[ms.length - 1] > curMonth() ? ms[ms.length - 1] : curMonth();
  while (m <= end) { out.push(m); m = shiftMonth(m, 1); }
  return out;
}
function metricValue(g) {
  switch (g.metric) {
    case 'bestMonth': return Math.max(0, ...monthRange().map((m) => parts(m).net));
    case 'streak': { const th = n0(g.threshold); let best = 0, run = 0; monthRange().forEach((m) => { if (parts(m).net >= th) { run++; best = Math.max(best, run); } else run = 0; }); return best; }
    case 'cash': case 'savings': return cashNow();
    case 'totalProfit': return sum(L('sales').map(profitOf)) - sum(L('spend').filter((x) => x.kind === 'negocio').map((x) => n0(x.amount)));
    case 'units': return L('sales').length;
  }
  return 0;
}

/* ---------------- manager engine ---------------- */
let brainCache = null;
function brain() {
  if (!brainCache) brainCache = B.analyze({ models: L('models'), sales: L('sales').filter((x) => !x.cancelled), orders: L('orders'), listings: L('listings'), settings: S0(), now: Date.now(), today: todayKey(), costOf, cashFree: spendable(), owed: owedTotal(), pouches: pouches(), bizMonth: parts(curMonth()).biz });
  return brainCache;
}
const stockOf = (id) => brain().stocks.find((s) => s.m.id === id) || null;
const agent = createAgent({ db, C, L, model, S0, brain, fresh: () => { brainCache = null; }, costOf, todayKey, nowISO, patchSettings, pouches, pouchCost, cashNow, bankNow, vintedBalance, pendingVinted, owedTotal, spendable, pendingBills, costSrc, landedFromOrder });
const SST = { 'en camino': ['En camino', 'mut'], 'no repone': ['No se repone', 'mut'], enfria: ['Se enfría', 'warn'], rotura: ['Sin stock', 'neg'], urgente: ['Urgente', 'neg'], pedir: ['Pedir', 'warn'], ok: ['OK', 'pos'], exceso: ['Exceso', 'warn'], parado: ['Parado', 'warn'], liquidar: ['Liquidar', 'warn'], lento: ['Lento', 'mut'], 'sin datos': ['Sin ventas', 'mut'], fuera: ['Fuera', 'mut'] };
const days1 = (v) => (v === Infinity || isNaN(v) ? '∞' : v >= 100 ? '99+' : String(Math.floor(v)));
const rate1 = (v) => (v ? v.toFixed(v < 1 ? 2 : 1).replace('.', ',') : '0');
const STG = { ganador: 'pos', oferta: 'pos', muerto: 'neg', portada: 'warn', datos: 'warn', bajar: 'warn', sigue: '', espera: 'mut', nopub: 'warn' };
const hh = (h) => (h < 48 ? Math.round(h) + 'h' : Math.floor(h / 24) + 'd ' + Math.round(h % 24) + 'h');
const ago = (iso) => { const h = (Date.now() - Date.parse(iso)) / 3600000; return h < 1 ? 'ahora' : 'hace ' + hh(h); };
const acctNames = () => S0().accounts || [];
const liveOf = (mid) => L('listings').filter((l) => l.modelId === mid && l.status === 'live');

/* ---------------- state ---------------- */
const TABS = [['inicio', 'Inicio'], ['calendario', 'P&L'], ['stock', 'Stock'], ['tests', 'Tests'], ['cuentas', 'Cuentas'], ['gastos', 'Gastos'], ['metas', 'Plan']];
const BAR = ['inicio', 'calendario', 'stock', 'tests', 'cuentas', 'gastos'];
const ICONS = {
  inicio: '<path d="M4 11 12 4.5l8 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
  manager: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 21v-3.5H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  stock: '<path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/>',
  tests: '<path d="M9.5 3.5h5M10.5 3.5v5.5L5.2 18a1.7 1.7 0 0 0 1.5 2.5h10.6a1.7 1.7 0 0 0 1.5-2.5L13.5 9V3.5"/><path d="M7.5 14.5h9"/>',
  cuentas: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.7.8 2.7 2.6 3 5.2"/>',
  gastos: '<rect x="3" y="6" width="18" height="13.5" rx="3"/><path d="M3 10h18M16 15h2"/>',
  metas: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};
const st = {
  tab: (location.hash.slice(1) && TABS.some((t) => t[0] === location.hash.slice(1))) ? location.hash.slice(1) : lsGet('lg_tab', 'inicio'),
  month: curMonth(), selDay: todayKey(), calMode: lsGet('lg_cal', 'profit'), stockSeg: lsGet('lg_seg', 'relojes'), filter: lsGet('lg_filter', 'activos'),
  confirm: null, sheet: null,
  chatBusy: false, chatErr: '', chatImgs: [], chatLive: [], aiSetup: false, briefNew: false, aiMovesBusy: false, aiMovesErr: '',
};

/* ---------------- shell ---------------- */
function shell() {
  app.innerHTML = `<header class="ribbon"><div class="wrap rib-in">
      <div class="brand"><img src="icons/icon-192.png" alt=""><b>OOQ</b></div>
      <nav class="toptabs" aria-label="Secciones">${TABS.map(([k, l]) => `<button data-a="tab" data-v="${k}">${l}</button>`).join('')}</nav>
      <div class="top-r"><button class="syncpill" data-a="settings" id="syncpill"><i></i><span>Local</span></button><button class="iconbtn addtop" data-a="add" aria-label="Añadir"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      <button class="iconbtn" data-a="settings" aria-label="Ajustes"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></div>
    </div></header>
    ${sync.configured() ? '' : '<div class="wrap"><div class="banner">Modo local: los datos solo están en este dispositivo.</div></div>'}
    <main id="main" class="wrap"></main>
    <button class="fab" data-a="add" aria-label="Añadir">+</button>
    <div class="ctip" id="ctip" hidden></div>
    <div class="composer" id="composer" hidden><div class="wrap comp-in">
      <div class="comp-imgs" id="comp-imgs"></div>
      <div class="comp-row"><label class="comp-cam" aria-label="Adjuntar captura"><input type="file" accept="image/*" id="comp-file" multiple hidden><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></label>
      <textarea id="comp-text" rows="1" placeholder="Escribe al Manager…"></textarea>
      <button class="comp-send" data-a="chat-send" aria-label="Enviar"><svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg></button></div></div></div>
    <nav class="tabbar" aria-label="Secciones">${TABS.filter(([k]) => BAR.includes(k)).map(([k, l]) => `<button data-a="tab" data-v="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg><span>${l}</span></button>`).join('')}</nav>`;
}
function updatePill() {
  const p = $('#syncpill'); if (!p) return;
  const s = sync.getStatus();
  let state = 'local', label = 'Local';
  if (s.enabled) {
    if (s.state === 'signed-out') { state = 'signed-out'; label = 'Sin sesión'; }
    else if (!s.online || s.state === 'offline') { state = 'offline'; label = 'Sin conexión'; }
    else if (s.state === 'error') { state = 'error'; label = 'Error'; }
    else if (s.state === 'syncing' || s.pending) { state = 'syncing'; label = 'Guardando'; }
    else { state = 'synced'; label = 'Sincronizado'; }
  }
  p.dataset.s = state; p.querySelector('span').textContent = label;
}

/* ---------------- render ---------------- */
let rq = false;
function renderSoon() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function render() {
  const main = $('#main'); if (!main) return;
  document.querySelectorAll('[data-a="tab"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.tab)));
  const v = { inicio: viewHome, calendario: viewCal, stock: viewStock, tests: viewTests, cuentas: viewAccounts, gastos: viewSpend, metas: viewGoals }[st.tab] || viewHome;
  brainCache = null;
  const chat = st.tab === 'manager' && !!agent.key() && !st.aiSetup;
  document.body.classList.toggle('chatmode', st.tab === 'manager');
  const comp = $('#composer'); if (comp) comp.hidden = !chat;
  document.querySelectorAll('[data-a="tab"][data-v="manager"]').forEach((b) => b.classList.toggle('dot', st.briefNew && st.tab !== 'manager'));
  if (st.tab === 'manager') st.briefNew = false;
  main.innerHTML = v();
  labelTables(main);
  if (chat) { const box = $('#chatlog'); if (box) window.scrollTo(0, document.body.scrollHeight); }
  updatePill();
}

// spreadsheet building blocks
const panel = (title, body, right = '') => `<section class="panel"><div class="ph"><span>${title}</span>${right ? `<span class="ph-r">${right}</span>` : ''}</div>${body}</section>`;
const money = (v, sign) => `<span class="${v < 0 ? 'neg' : sign && v > 0 ? 'pos' : ''}">${eur(v, sign)}</span>`;
const pbar = (p, cls2 = '') => `<div class="pbar ${cls2}"><i style="width:${Math.min(100, Math.max(0, p * 100))}%"></i></div>`;
const tr = (label, val, cl = '') => `<tr class="${cl}"><th>${label}</th><td class="n">${val}</td></tr>`;
const mnav = () => `<div class="mnav"><button data-a="mprev" aria-label="Mes anterior">‹</button><div class="ml">${monthName(st.month)}</div><button data-a="mnext" aria-label="Mes siguiente">›</button></div>`;
const empty = (t) => `<div class="empty">${t}</div>`;
const xbtn = (col, id) => { const c = st.confirm === col + '/' + id; return `<button class="del${c ? ' confirm' : ''}" data-a="del" data-col="${col}" data-id="${esc(id)}" aria-label="Borrar">${c ? '¿Borrar?' : '×'}</button>`; };

/* ---------------- charts (SVG, hover/tap shows the detail) ---------------- */
const bar = (x, y0, w, y1, r = 4) => { // rounded on the data end, flat on the baseline
  const up = y1 < y0, h = Math.abs(y1 - y0), rr = Math.min(r, h, w / 2);
  if (h < 0.5) return '';
  return up ? `M${x} ${y0}V${y1 + rr}Q${x} ${y1} ${x + rr} ${y1}H${x + w - rr}Q${x + w} ${y1} ${x + w} ${y1 + rr}V${y0}Z`
    : `M${x} ${y0}V${y1 - rr}Q${x} ${y1} ${x + rr} ${y1}H${x + w - rr}Q${x + w} ${y1} ${x + w} ${y1 - rr}V${y0}Z`;
};
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const kfmt = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0).replace('.', ',') + 'k' : String(Math.round(v)));
function monthsChart() {
  const cm = curMonth(), plan = S0().plan || {};
  const first = monthRange()[0] || cm, ms = [];
  for (let m = shiftMonth(cm, -5) < first ? first : shiftMonth(cm, -5); m <= shiftMonth(cm, 2); m = shiftMonth(m, 1)) ms.push(m);
  const rows = ms.map((mk) => ({ mk, v: mk <= cm ? parts(mk).net : null, plan: plan[mk] ? n0(plan[mk].profit) : null }));
  const W = 340, H = 190, L0 = 34, R0 = 6, T0 = 12, B0 = 24, iw = W - L0 - R0, ih = H - T0 - B0;
  const hi = niceMax(Math.max(1, ...rows.map((r) => Math.max(r.v || 0, r.plan || 0)))), lo = Math.min(0, ...rows.map((r) => r.v || 0));
  const y = (v) => T0 + (hi - v) / (hi - lo) * ih, band = iw / rows.length, bw = Math.min(26, band * 0.56);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, yy = y(v); g += `<line class="c-grid" x1="${L0}" x2="${W - R0}" y1="${yy}" y2="${yy}"/><text class="c-yt" x="${L0 - 6}" y="${yy + 3.5}" text-anchor="end">${kfmt(v)}</text>`; }
  const cols = rows.map((r, i) => {
    const cx = L0 + band * i + band / 2, x = cx - bw / 2, cur = r.mk === cm;
    const b = r.v !== null ? `<path class="c-bar${r.v < 0 ? ' neg' : ''}${cur ? ' cur' : ''}" d="${bar(x, y(0), bw, y(r.v))}"/>` : '';
    const pl = r.plan !== null ? `<line class="c-plan" x1="${cx - band * 0.4}" x2="${cx + band * 0.4}" y1="${y(r.plan)}" y2="${y(r.plan)}"/>` : '';
    const lbl = cur && r.v !== null ? `<text class="c-val" x="${cx}" y="${Math.min(y(r.v), y(0)) - 6}" text-anchor="middle">${kfmt(r.v)}</text>` : '';
    const tip = `${MSHORT[pm(r.mk).m - 1]} ${String(pm(r.mk).y).slice(2)} · ${r.v !== null ? 'beneficio ' + eur(r.v, true) : 'aún no'}${r.plan !== null ? ' · plan ' + eur(r.plan) : ''}`;
    return `<g class="c-col" data-tip="${esc(tip)}"><rect class="c-hit" x="${L0 + band * i}" y="${T0}" width="${band}" height="${ih}"/>${b}${pl}${lbl}<text class="c-xt${cur ? ' cur' : ''}" x="${cx}" y="${H - 7}" text-anchor="middle">${MSHORT[pm(r.mk).m - 1]}</text></g>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Beneficio por mes frente al plan">${g}<line class="c-base" x1="${L0}" x2="${W - R0}" y1="${y(0)}" y2="${y(0)}"/>${cols}</svg>
    <div class="legend"><span><i class="lg-bar"></i>Beneficio</span><span><i class="l2"></i>Plan</span></div></div>`;
}
function dailyChart() {
  const t = todayKey(), days = Array.from({ length: 30 }, (_, i) => shiftDay(t, i - 29));
  const rows = days.map((k) => { const ss = L('sales').filter((v) => v.date === k && !v.cancelled); return { k, n: ss.length, pr: sum(ss.map(profitOf)) }; });
  const avg = rows.map((_, i) => { const w = rows.slice(Math.max(0, i - 6), i + 1); return sum(w.map((r) => r.n)) / w.length; });
  const W = 340, H = 160, L0 = 26, R0 = 6, T0 = 10, B0 = 22, iw = W - L0 - R0, ih = H - T0 - B0;
  const hi = Math.max(2, Math.ceil(Math.max(...rows.map((r) => r.n)))), y = (v) => T0 + (hi - v) / hi * ih, band = iw / rows.length, bw = Math.max(3, band - 2);
  let g = ''; const step = hi <= 4 ? 1 : Math.ceil(hi / 4);
  for (let v = 0; v <= hi; v += step) g += `<line class="c-grid" x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}"/><text class="c-yt" x="${L0 - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  const cols = rows.map((r, i) => { const x = L0 + band * i + (band - bw) / 2; const d = dateOf(r.k);
    return `<g class="c-col" data-tip="${esc(`${d.getDate()} ${MSHORT[d.getMonth()]} · ${r.n} venta${r.n === 1 ? '' : 's'}${r.n ? ' · ' + eur(r.pr, true) : ''} · media 7d ${avg[i].toFixed(1).replace('.', ',')}`)}"><rect class="c-hit" x="${L0 + band * i}" y="${T0}" width="${band}" height="${ih}"/>${r.n ? `<path class="c-bar${r.k === t ? ' cur' : ''}" d="${bar(x, y(0), bw, y(r.n), 2)}"/>` : ''}${i % 7 === 2 || i === 29 ? `<text class="c-xt${r.k === t ? ' cur' : ''}" x="${L0 + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${d.getDate()} ${MSHORT[d.getMonth()]}</text>` : ''}</g>`; }).join('');
  const line = avg.map((v, i) => `${i ? 'L' : 'M'}${(L0 + band * i + band / 2).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const tot = sum(rows.map((r) => r.n)), last7 = sum(rows.slice(-7).map((r) => r.n));
  return `<div class="chart"><div class="c-kpi"><b>${tot}</b><span>ventas en 30 días · ${last7} esta semana · ${rate1(last7 / 7)}/día</span></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ventas por día, últimos 30 días">${g}<line class="c-base" x1="${L0}" x2="${W - R0}" y1="${y(0)}" y2="${y(0)}"/>${cols}<path class="c-line" d="${line}"/></svg>
    <div class="legend"><span><i class="lg-bar"></i>Ventas del día</span><span><i class="l1 lg-line"></i>Media 7 días</span></div></div>`;
}
function stockChart() {
  const bz = brain(), L_ = bz.lead.ddp, Ld = bz.lead.dhl;
  const rows = bz.stocks.filter((r) => r.m.status !== 'descartado' && r.rate > 0.02 && !['lento', 'sin datos'].includes(r.status)).sort((a, b) => a.coverAll - b.coverAll).slice(0, 10);
  if (!rows.length) return empty('Aún no hay ventas suficientes para calcular días de stock.');
  const W = 340, rowH = 38, T0 = 18, L0 = 4, R0 = 44, H = T0 + rows.length * rowH + 6, cap = Math.max(30, L_ * 2.5), iw = W - L0 - R0;
  const x = (v) => L0 + Math.min(v, cap) / cap * iw;
  const refs = `<line class="c-ref" x1="${x(L_)}" x2="${x(L_)}" y1="${T0 - 6}" y2="${H - 4}"/><text class="c-reft" x="${x(L_)}" y="${T0 - 8}" text-anchor="middle">DDP ${L_}d</text><line class="c-ref dhl" x1="${x(Ld)}" x2="${x(Ld)}" y1="${T0 - 6}" y2="${H - 4}"/><text class="c-reft" x="${x(Ld)}" y="${T0 - 8}" text-anchor="middle">DHL ${Ld}d</text>`;
  const bars = rows.map((r, i) => {
    const y0 = T0 + i * rowH, d = r.coverAll, low = d < L_, w = Math.max(3, x(d) - L0), name = r.m.name.length > 34 ? r.m.name.slice(0, 33) + '…' : r.m.name;
    const tip = `${r.m.name} · ${days1(d)} días de stock · ${r.home} en casa${r.transit ? ' + ' + r.transit + ' en camino' : ''} · ${rate1(r.rate)}/día${r.qty ? ' · pedir ' + (r.bridge ? 'DHL ' + r.bridge + ' ' : '') + (r.ddpQty ? 'DDP ' + r.ddpQty : '') : ''}`;
    return `<g class="c-col" data-tip="${esc(tip)}" data-a="model" data-id="${esc(r.m.id)}"><rect class="c-hit" x="0" y="${y0}" width="${W}" height="${rowH}"/><text class="c-name" x="${L0}" y="${y0 + 12}">${esc(name)}</text><path class="c-bar h${low ? ' warn' : ''}" d="M${L0} ${y0 + 18}H${L0 + w - 4}Q${L0 + w} ${y0 + 18} ${L0 + w} ${y0 + 22}V${y0 + 26}Q${L0 + w} ${y0 + 30} ${L0 + w - 4} ${y0 + 30}H${L0}Z"/><text class="c-hv${low ? ' warn' : ''}" x="${L0 + w + 6}" y="${y0 + 28}">${d === Infinity ? '∞' : d >= cap ? Math.round(cap) + '+' : Math.floor(d)}d${low ? ' · pide' : ''}</text></g>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Días de stock por reloj frente a lo que tarda un pedido">${refs}${bars}</svg>
    <div class="legend"><span><i class="lg-bar"></i>Aguanta más que un DDP</span><span><i class="lg-bar warn"></i>Se acaba antes de que llegue un DDP</span></div></div>`;
}
function spark(mk) {
  const n = daysIn(mk), g = goalFor(mk), cm = curMonth();
  const last = mk === cm ? new Date().getDate() : mk < cm ? n : 0;
  const cum = []; let c = 0;
  for (let d = 1; d <= last; d++) { c += parts(mk + '-' + pad(d)).net; cum.push(c); }
  const W = 320, H = 80, px = 6, py = 8;
  const maxY = Math.max(g, ...cum, 1), minY = Math.min(0, ...cum);
  const x = (d) => px + (d - 1) / (n - 1) * (W - 2 * px), y = (v) => H - py - (v - minY) / (maxY - minY) * (H - 2 * py);
  let grid = '';
  for (let i = 1; i <= 3; i++) { const yy = py + (H - 2 * py) * i / 4; grid += `<line class="gl" x1="${px}" x2="${W - px}" y1="${yy}" y2="${yy}"/>`; }
  let s = `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Beneficio acumulado del mes frente al ritmo de la meta">${grid}<line class="base" x1="${px}" x2="${W - px}" y1="${y(0)}" y2="${y(0)}"/><path class="pace-l" d="M${x(1)} ${y(0)}L${x(n)} ${y(g)}"/>`;
  if (cum.length) {
    const pts = cum.map((v, i) => x(i + 1).toFixed(1) + ' ' + y(v).toFixed(1));
    s += `<path class="area" d="M${x(1)} ${y(0)}L${pts.join('L')}L${x(cum.length)} ${y(0)}Z"/><path class="cum" d="M${pts.join('L')}"/><circle class="end" cx="${x(cum.length)}" cy="${y(cum[cum.length - 1])}" r="3"/>`;
  }
  return s + `</svg><div class="legend"><span><i class="l1"></i>Beneficio acumulado</span><span><i class="l2"></i>Ritmo para ${eur(g)}</span></div>`;
}

function monthTable(mk) {
  const p = parts(mk), g = goalFor(mk), cm = curMonth();
  let pace = '';
  if (mk === cm) {
    const left = daysIn(mk) - new Date().getDate(), rem = g - p.net;
    pace = rem <= 0 ? tr('Meta', '<span class="pos">cumplida</span>') : tr(`Falta por día (${left} días)`, eur(rem / Math.max(1, left)));
  }
  return `<table class="xl"><tbody>
    ${tr('Ventas (' + p.nSales + ')', money(p.revenue, true))}
    ${p.released ? tr('Liberado en Vinted', money(p.released, true)) : ''}
    ${tr('Retirado de Vinted al banco', money(p.withdraw, true))}
    ${p.income ? tr('Otros ingresos', money(p.income, true)) : ''}
    ${tr('Pedidos de stock', money(-p.orders))}
    ${tr('Gastos negocio', money(-p.biz))}
    ${tr('Gastos personales', money(-p.pers))}
    ${tr('Flujo del banco', money(p.flow, true), 'tot')}
    ${tr('Beneficio de ventas', money(p.profit, true) + '<span class="sub">venta − coste del reloj − bolsita</span>')}
    ${p.biz ? tr('− Gastos negocio', money(-p.biz)) : ''}
    ${tr('Beneficio neto', money(p.net, true), 'tot2')}
    <tr><th>Meta ${eur(g)}</th><td class="n barcell">${pbar(p.net / g)}<span>${Math.max(0, Math.round(p.net / g * 100))}%</span></td></tr>
    ${pace}
  </tbody></table>`;
}

function paceBlock() {
  const p = brain().pace, mn = MONTHS[pm(p.mk).m - 1];
  const netRow = tr('Beneficio neto', money(p.net, true) + `<span class="sub">ventas ${eur(p.P)}${p.biz ? ` − gastos negocio ${eur(p.biz)}` : ''}${p.PT ? ` · objetivo ${eur(p.PT)}` : ''}</span>`);
  if (!p.T) return panel('Este mes', `<table class="xl"><tbody>${tr('Ventas', p.S)}${netRow}</tbody></table><div class="foot"><button class="lnk" data-a="tab" data-v="metas">Pon el objetivo del mes en Plan</button></div>`);
  const pct = p.S / p.T, done = p.S >= p.T;
  return panel('Objetivo ' + mn, `<table class="xl"><tbody>
    <tr class="big"><th>Ventas</th><td class="n">${p.S}<span class="sub" style="display:inline"> de ${p.T}</span></td></tr>
    <tr><th>Progreso</th><td class="n barcell">${pbar(pct, done ? 'won' : '')}<span>${Math.round(pct * 100)}%</span></td></tr>
    ${tr('Mínimo del mes', p.MIN + (p.S >= p.MIN ? ' <span class="pos">✓</span>' : ` <span class="sub" style="display:inline">faltan ${p.MIN - p.S}</span>`))}
    ${tr('Tu ritmo', rate1(p.paceDay) + '/día')}
    ${done ? tr('Objetivo', '<span class="pos">cumplido</span>') : tr(`Necesitas (${p.left} días)`, `<b class="${p.paceDay >= p.need ? 'pos' : 'neg'}">${rate1(p.need)}/día</b>`)}
    ${tr('A este ritmo acabas en', `<span class="${p.ok ? 'pos' : p.minOk ? 'warn' : 'neg'}">${p.proj} ventas</span>` + (p.limit === 'stock' ? `<span class="sub warn">límite: stock (${p.inHand} en casa + ${p.landing} que llegan este mes)${p.projDemand > p.proj ? `, tu ritmo daría ${p.projDemand}` : ''}</span>` : ''), 'tot')}
    ${netRow}
  </tbody></table>`, '<button class="lnk" data-a="tab" data-v="metas">Plan</button>');
}
const TAGC = { Datos: 'neg', Deuda: 'neg', Caja: 'neg', Stock: 'acc', Venta: 'acc', Test: 'warn', Cuentas: 'blu', Anuncio: 'blu', Ritmo: 'mut' };
function moveAttrs(act) { return `data-a="${act.a}"${act.id ? ` data-id="${esc(act.id)}"` : ''}${act.v ? ` data-v="${esc(act.v)}"` : ''}`; }
function movesTable(ms, from = 0) {
  if (!ms.length) return empty('Nada urgente. Sube tests y mantén los ganadores publicados.');
  return `<table class="xl list moves"><tbody>${ms.map((mv, i) => `<tr class="click" ${moveAttrs(mv.act)}><td class="mi n">${from + i + 1}</td><td><span class="tag ${TAGC[mv.tag] || ''}">${esc(mv.tag)}</span> <b>${esc(mv.title)}</b><span class="sub">${esc(mv.why)}</span></td></tr>`).join('')}</tbody></table>`;
}
function cajaTable() {
  const s = S0(), pend = pendingBills(), ow = owedTotal(), bank = bankNow(), vb = vintedBalance(), pv = pendingVinted(), np = pendingSales().length;
  const accs = (s.accounts || []).filter((a) => Math.abs(vintedBalance(a)) > 0.005 || pendingVinted(a) > 0);
  const per = accs.length > 1 ? `<span class="sub">${accs.map((a) => `${esc(a)}: ${eur(vintedBalance(a))} saldo · ${eur(pendingVinted(a))} pendiente`).join('<br>')}</span>` : '';
  return `<table class="xl"><tbody>
    <tr class="big"><th>Banco</th><td class="n">${money(bank)}</td></tr>
    ${tr('Saldo en Vinted', money(vb) + per)}
    <tr class="click" data-a="pending"><th>Pendiente en Vinted <span class="sub">${np} venta${np === 1 ? '' : 's'} sin confirmar · toca para liberar</span></th><td class="n">${money(pv)}</td></tr>
    ${tr('Total', money(bank + vb + pv), 'tot')}
    ${ow ? tr('Debes de pedidos', money(-ow)) : ''}
    ${pend ? tr('Pagos fijos pendientes', money(-pend)) : ''}
    ${n0(s.cushion) ? tr('Colchón', money(-n0(s.cushion))) : ''}
    ${tr('Puedes gastar', money(spendable()) + '<span class="sub">banco + saldo, sin lo pendiente</span>', 'tot2')}
  </tbody></table><div class="foot btnrow"><button class="btn-g" data-a="withdraw">Retirar a banco</button><button class="btn-o" data-a="pending">Ventas pendientes</button></div>`;
}
/* AI moves on Inicio: Claude reads everything and decides; the rules list is only the fallback */
const AIM_KEY = 'ooq_ai_moves';
const aiStamp = () => [L('sales').length, L('orders').length, L('spend').length, sum(L('listings').map((l) => (l.snaps || []).length + (l.status === 'live' ? 1 : 0))), sum(L('models').map((m) => n0(m.home) * 7 + n0(m.transit) * 3 + (m.status || '').length)), sum(L('orders').map((o) => n0(o.owed)))].join('.');
const aiCached = () => { try { return JSON.parse(lsGet(AIM_KEY, 'null')); } catch { return null; } };
async function ensureAiMoves(force) {
  if (!agent.key() || st.aiMovesBusy) return;
  const c = aiCached(), age = c ? Date.now() - c.at : Infinity, stamp = aiStamp();
  if (!force && c && ((c.stamp === stamp && age < 3 * 3600000) || age < 30 * 60000)) return;
  st.aiMovesBusy = true; st.aiMovesErr = ''; renderSoon();
  try { const data = await agent.bestMoves(); lsSet(AIM_KEY, JSON.stringify({ at: Date.now(), stamp, data })); }
  catch (e) { st.aiMovesErr = e.message || String(e); }
  st.aiMovesBusy = false; renderSoon();
}
function irAct(ir) {
  const [k, id] = String(ir).split(':');
  if (k === 'test' && id) return { a: 'test', id }; if (k === 'model' && id) return { a: 'model', id };
  if (k === 'plan') return { a: 'goto-plan' }; if (k === 'catchup') return { a: 'catchup' };
  return { a: 'tab', v: ['manager', 'stock', 'tests', 'cuentas', 'metas', 'calendario', 'gastos'].includes(k) ? k : 'manager' };
}
function aiMovesPanel(bz) {
  const rules = movesTable(bz.moves.slice(0, 7));
  if (!agent.key()) return panel('Mejores movimientos', rules + `<div class="foot"><button class="lnk" data-a="tab" data-v="manager">Conecta la IA → decide por ti con toda tu situación</button></div>`, 'reglas');
  const c = aiCached();
  if (!c) return panel('Manager IA', `<div class="ai-sit">${st.aiMovesErr ? `<span class="neg">${esc(st.aiMovesErr)}</span>` : '<span class="dots"><i></i><i></i><i></i></span> Analizando tu situación…'}</div>` + rules, '<button class="lnk" data-a="ai-moves">Actualizar</button>');
  const d = c.data, mv = d.movimientos.map((x) => ({ tag: x.tag, title: x.titulo, why: x.porque, act: irAct(x.ir) }));
  const mins = Math.round((Date.now() - c.at) / 60000);
  return panel('Manager IA', `<div class="ai-sit">${esc(d.situacion)}</div>${movesTable(mv)}
    <div class="foot ai-foot"><span>${st.aiMovesBusy ? 'Actualizando…' : `Hace ${mins < 1 ? 'un momento' : mins < 60 ? mins + ' min' : Math.round(mins / 60) + ' h'}`}${st.aiMovesErr ? ` · <span class="neg">${esc(st.aiMovesErr)}</span>` : ''}</span><button class="lnk" data-a="ai-moves">Actualizar</button><button class="lnk" data-a="tab" data-v="manager">Hablar con el Manager</button></div>`, '<span class="tag acc">IA</span>');
}
/* milestones: the ladder to 5k a month, measured on your best month */
const MILES = [500, 1000, 1500, 2000, 3000, 4000, 5000];
const kLabel = (v) => (v >= 1000 ? String(v / 1000).replace('.', ',') + 'k' : String(v));
function milestonesCard() {
  const cm = curMonth(), cur = parts(cm).net, best = Math.max(0, cur, ...monthRange().map((m) => parts(m).net));
  const reached = MILES.filter((m) => best >= m).length, next = MILES[reached];
  const prev = reached ? MILES[reached - 1] : 0;
  const toNext = next ? Math.max(0, Math.min(1, cur / next)) : 1;
  const fill = next ? ((reached ? reached - 1 : 0) + (reached ? Math.max(0, Math.min(1, (best - prev) / (next - prev))) : 0)) / (MILES.length - 1) : 1;
  const left = daysIn(cm) - new Date().getDate() + 1, falta = next ? Math.max(0, next - cur) : 0;
  const planM = next ? Object.keys(S0().plan || {}).sort().find((mk) => n0(S0().plan[mk].profit) >= next * 0.9) : null;
  const track = `<div class="mile-track" style="--fill-n:${fill.toFixed(3)}">${MILES.map((m, i) => `<div class="ms${best >= m ? ' done' : ''}${i === reached ? ' cur' : ''}"><i>${best >= m ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : ''}</i><span>${kLabel(m)}</span></div>`).join('')}</div>`;
  const nextT = next ? `<div class="mile-next"><div class="kv"><span>Siguiente: <b>${kLabel(next)} €/mes</b>${planM ? ` <span class="mut">· plan ${MSHORT[pm(planM).m - 1]} ${String(pm(planM).y).slice(2)}</span>` : ''}</span><b>${Math.round(toNext * 100)}%</b></div>${pbar(toNext, toNext >= 1 ? 'won' : '')}<div class="mut sm2">${falta ? `Este mes faltan ${eur(falta)} → ${eur(falta / left)}/día los próximos ${left} días` : 'Conseguido este mes'}</div></div>` : '<div class="mile-next"><b class="pos">5k al mes conseguido.</b></div>';
  return panel('Camino a 5k', `<div class="mile-head"><div><div class="mh-big ${cur < 0 ? 'neg' : ''}">${eur(cur)}</div><div class="mut sm2">beneficio este mes · mejor mes ${eur(best)}</div></div><span class="lvl">Nivel ${reached}/${MILES.length}</span></div>${track}${nextT}`);
}
function viewHome() {
  const cm = curMonth(), pb = payback(), bz = brain();
  const moves = panel('Mejores movimientos', movesTable(bz.moves.slice(0, 7)) + (bz.moves.length > 7 ? `<div class="foot"><button class="lnk" data-a="moves">Ver los ${bz.moves.length}</button></div>` : ''), String(bz.moves.length));
  const exp = panel('Para tu Manager', `<div class="stack pad"><p class="lead2 mut">Copia tus datos y pégalos en tu proyecto de Claude.</p><div class="btnrow"><button class="btn-g" data-a="export-ai">Copiar para Claude</button><button class="btn-o" data-a="export-ai-file">Descargar .txt</button><button class="btn-o" data-a="import">Importar ventas</button></div></div>`);
  const caja = panel('Caja', cajaTable(), '<button class="lnk" data-a="settings">Ajustar</button>');
  const month = panel(monthName(cm), monthTable(cm));
  const open = L('orders').filter((o) => pb[o.id] && (o.status !== 'recibido' || pb[o.id].rev < pb[o.id].cost)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const orders = panel('Pedidos sin recuperar', open.length ? `<table class="xl list"><thead><tr><th>Pedido</th><th class="n">Coste</th><th class="n">Recuperado</th></tr></thead><tbody>${open.map((o) => {
    const r = pb[o.id], p = r.cost ? r.rev / r.cost : 0;
    return `<tr class="click" data-a="order" data-id="${esc(o.id)}"><td>${shortDate(o.date)} <span class="sub">${r.sold}/${r.units} vendidos${n0(o.owed) ? ` · <b class="neg">debes ${eur(n0(o.owed))}</b>` : ''}</span></td><td class="n">${eur(r.cost)}</td><td class="n barcell">${pbar(p)}<span>${Math.round(p * 100)}%</span></td></tr>`;
  }).join('')}</tbody></table>` : empty('Nada pendiente. Al apuntar un pedido verás aquí cuánto te falta para recuperarlo.'), '<button class="lnk" data-a="goto-orders">Ver todos</button>');
  const gs = L('goals').slice().sort((a, b) => n0(a.order) - n0(b.order));
  const goals = gs.length ? panel('Metas', goalsTable(gs, true), '<button class="lnk" data-a="tab" data-v="metas">Ver</button>') : '';
  return `<div class="cols"><div class="col">${milestonesCard()}${moves}${paceBlock()}</div><div class="col">${caja}${panel('Beneficio por mes', monthsChart(), 'vs plan')}${exp}${month}${orders}${goals}</div></div>`;
}
function orderBody(o, pb) {
  const cost = pb.cost, rec = pb.rev, pct = cost ? Math.min(1, rec / cost) : 0, gap = cost - rec;
  return `<table class="xl"><tbody>
    ${tr('Fecha', shortDate(o.date) + (o.note ? ' · ' + esc(o.note) : ''))}
    ${tr('Estado', o.status === 'recibido' ? `<span class="pos">Recibido ${shortDate(o.receivedDate)}</span>` : '<span class="warn">En camino</span>')}
    ${(o.lines || []).map((l) => { const m = model(l.modelId); return tr(esc(m ? m.name : l.name || 'Reloj'), `${n0(l.qty)} × ${eur(n0(l.unit))}`); }).join('')}
    ${o.pouches ? tr('Bolsitas', `${n0(o.pouches.qty)} × ${eur(n0(o.pouches.unit))}`) : ''}
    ${tr('Vía', LANE[o.lane || 'otro'] + (o.status !== 'recibido' ? ` · llega ~${shortDate(B.etaOf(o, brain().lead))}` : ''))}
    ${tr('Pagado al pedir', eur(n0(o.paid)))}
    ${payments(o).map((p) => tr('Pagado ' + shortDate(p.date), eur(n0(p.amount)))).join('')}
    ${n0(o.owed) ? tr('Debes', `<b class="neg">${eur(n0(o.owed))}</b>`) : ''}
    ${tr('Cobro DHL', o.status === 'recibido' ? eur(n0(o.dhl)) : '<span class="sub">al llegar</span>')}
    ${tr('Coste total', eur(cost), 'tot')}
    ${tr('Vendidos', pb.sold + ' de ' + pb.units)}
    ${tr('Recuperado', money(rec))}
    <tr><th>Progreso</th><td class="n barcell">${pbar(pct)}<span>${Math.round(pct * 100)}%</span></td></tr>
    ${tr(gap > 0 ? 'Falta para cubrirlo' : 'Beneficio limpio', gap > 0 ? money(-gap) : money(-gap, true), 'tot2')}
    ${pb.potential ? tr('Si vendes el resto a precio', money(rec + pb.potential - cost, true)) : ''}
  </tbody></table>`;
}

function viewCal() {
  const mk = st.month, p = parts(mk), mode = st.calMode;
  return `<div class="toolbar">${mnav()}<div class="seg sm"><button data-a="calmode" data-v="profit" aria-pressed="${mode === 'profit'}">Beneficio</button><button data-a="calmode" data-v="cash" aria-pressed="${mode === 'cash'}">Caja</button><button data-a="calmode" data-v="units" aria-pressed="${mode === 'units'}">Ventas</button></div></div>
    <div class="cols wide"><div class="col">${panel(mode === 'profit' ? 'Beneficio por día' : mode === 'units' ? 'Relojes vendidos por día' : 'Banco: lo que entra − sale por día', calGrid(mk))}${panel('Ventas · últimos 30 días', dailyChart())}${panel('Total del mes', monthTable(mk))}</div>
    <div class="col">${dayPanel()}${panel('Beneficio por mes', monthsChart(), 'vs plan')}${mode === 'profit' ? panel('Acumulado del mes', spark(mk)) : ''}</div></div>`;
}
function dayVal(k) { const p = parts(k); return st.calMode === 'profit' ? p.net : st.calMode === 'units' ? p.nSales : p.flow; }
const calTxt = (v) => (st.calMode === 'units' ? String(v) : short(v));
function calGrid(mk) {
  const { y, m } = pm(mk), n = daysIn(mk), first = (new Date(y, m - 1, 1).getDay() + 6) % 7, tk = todayKey();
  const vals = []; for (let d = 1; d <= n; d++) vals.push(dayVal(mk + '-' + pad(d)));
  const cells = []; for (let i = 0; i < first; i++) cells.push(null); for (let d = 1; d <= n; d++) cells.push(d); while (cells.length % 7) cells.push(null);
  let h = '<div class="cal"><div class="ch">L</div><div class="ch">M</div><div class="ch">X</div><div class="ch">J</div><div class="ch">V</div><div class="ch">S</div><div class="ch">D</div><div class="ch wkc">Sem.</div>';
  for (let r = 0; r < cells.length; r += 7) {
    let ws = 0;
    for (let c = 0; c < 7; c++) {
      const d = cells[r + c];
      if (!d) { h += '<div class="day blank"></div>'; continue; }
      const k = mk + '-' + pad(d), v = vals[d - 1]; ws += v;
      const no = L('orders').some((o) => o.date === k || o.receivedDate === k);
      h += `<button class="day${v > 0 ? ' p' : v < 0 ? ' n' : ''}${k === tk ? ' today' : ''}${k > tk ? ' future' : ''}" data-a="day" data-v="${k}" aria-pressed="${k === st.selDay}" aria-label="${d} ${MONTHS[m - 1]}: ${v ? eur(v, true) : 'sin movimientos'}">
        <span class="dn">${d}${no ? '<i class="od"></i>' : ''}</span><span class="dv">${v ? calTxt(v) : ''}</span></button>`;
    }
    h += `<div class="wk"><span class="${cls(ws)}">${ws ? calTxt(ws) : '·'}</span></div>`;
  }
  return h + '</div>';
}
function dayPanel() {
  const k = st.selDay, d = dateOf(k);
  const title = WD[d.getDay()].replace(/^./, (c) => c.toUpperCase()) + ' ' + d.getDate() + ' de ' + MONTHS[d.getMonth()];
  const rows = dayRows(k), v = dayVal(k);
  return panel(title, (rows ? `<table class="xl list"><tbody>${rows}${tr('Total del día', st.calMode === 'units' ? v + ' vendidos' : money(v, true), 'tot')}</tbody></table>` : empty('Nada este día.')) +
    `<div class="foot"><button class="lnk" data-a="add" data-date="${k}">+ Añadir a este día</button></div>`);
}
function line(label, sub, amount, col, id) {
  return `<tr><td>${label}${sub ? ` <span class="sub">${sub}</span>` : ''}</td><td class="n">${amount}</td><td class="x">${col ? xbtn(col, id) : ''}</td></tr>`;
}
function dayRows(k) {
  let h = '';
  const prof = st.calMode === 'profit';
  L('sales').filter((s) => s.date === k).forEach((s) => { h += line(esc(s.modelName || 'Venta'), 'vendido ' + eur(n0(s.price)) + (s.account ? ' · ' + esc(s.account) : ''), prof ? money(profitOf(s), true) : `<span class="sub">${eur(n0(s.price))} → Vinted</span>`, 'sales', s.id); });
  L('orders').filter((o) => o.date === k).forEach((o) => { h += line('Pedido de stock', (o.lines || []).reduce((a, l) => a + n0(l.qty), 0) + ' relojes', prof ? '<span class="sub">no resta beneficio</span>' : money(-n0(o.paid)), null, o.id); });
  L('orders').filter((o) => o.receivedDate === k && n0(o.dhl)).forEach((o) => { h += line('Cobro DHL', 'pedido ' + shortDate(o.date), prof ? '<span class="sub">va en el coste</span>' : money(-n0(o.dhl)), null, o.id + 'd'); });
  L('spend').filter((x) => x.date === k).forEach((x) => { const biz = x.kind === 'negocio'; h += line(esc(x.cat) + (x.note ? ' · ' + esc(x.note) : ''), biz ? 'negocio' : 'personal', biz || !prof ? money(-n0(x.amount)) : `<span class="sub">${eur(-n0(x.amount))}</span>`, 'spend', x.id); });
  L('income').filter((x) => x.date === k).forEach((x) => { h += line(esc(x.note || 'Ingreso'), 'ingreso', money(n0(x.amount), true), 'income', x.id); });
  L('transfers').filter((x) => x.date === k).forEach((x) => { h += line('Retiro de Vinted', esc(x.account || ''), prof ? `<span class="sub">${eur(n0(x.amount))}</span>` : money(n0(x.amount), true), 'transfers', x.id); });
  return h;
}

const LANE = { dhl: 'DHL', ddp: 'DDP', otro: 'DDP' };
function stockBadge(r) {
  if (!r) return '';
  const [lb, c] = SST[r.status] || ['', ''];
  const q = r.bridge ? `DHL ${r.bridge}${r.ddpQty ? ' + DDP ' + r.ddpQty : ''}` : r.ddpQty ? 'DDP ' + r.ddpQty : '';
  return `<b class="${c}">${lb}</b>${q && ['rotura', 'urgente', 'pedir'].includes(r.status) ? ' · ' + q : ''}`;
}
function viewStock() {
  const segs = [['relojes', 'Relojes'], ['plan', 'Qué pedir'], ['pedidos', 'Pedidos']];
  const seg = `<div class="seg">${segs.map(([v, l]) => `<button data-a="seg" data-v="${v}" aria-pressed="${st.stockSeg === v}">${l}</button>`).join('')}</div>`;
  const bz = brain();
  if (st.stockSeg === 'pedidos') {
    const pb = payback();
    const os = L('orders').filter((o) => pb[o.id]).sort((a, b) => b.date.localeCompare(a.date));
    const out = sum(os.map((o) => pb[o.id].cost)), back = sum(os.map((o) => Math.min(pb[o.id].rev, pb[o.id].cost)));
    const sumT = `<table class="xl"><tbody>${tr('Invertido en pedidos', eur(out))}${tr('Recuperado', money(back))}${tr('Por recuperar', money(-(out - back)), 'tot')}${owedTotal() ? tr('Debes', money(-owedTotal())) : ''}${tr('Relojes en camino', sum(L('models').map((m) => n0(m.transit))) + ' uds')}</tbody></table>`;
    const list = os.length ? `<table class="xl list"><thead><tr><th>Pedido</th><th class="n">Uds</th><th class="n">Coste</th><th class="n">Recuperado</th></tr></thead><tbody>${os.map((o) => {
      const r = pb[o.id], p = r.cost ? r.rev / r.cost : 0, eta = o.status !== 'recibido' ? B.etaOf(o, bz.lead) : '';
      return `<tr class="click" data-a="order" data-id="${esc(o.id)}"><td>${shortDate(o.date)} <span class="sub ${o.status === 'recibido' ? '' : 'warn'}">${LANE[o.lane || 'otro']} · ${o.status === 'recibido' ? 'recibido' : 'llega ~' + shortDate(eta)}${n0(o.owed) ? ` · <b class="neg">debes ${eur(n0(o.owed))}</b>` : ''}</span></td><td class="n">${r.units}</td><td class="n">${eur(r.cost)}</td><td class="n barcell">${pbar(p)}<span>${Math.round(p * 100)}%</span></td></tr>`;
    }).join('')}</tbody></table><div class="foot">Toca un pedido para ver el detalle, pagar lo que debes o marcar que ha llegado.</div>` : empty('Aún no hay pedidos. Al guardar uno se resta de la caja y los relojes pasan a "en camino".');
    return `<div class="toolbar">${seg}<button class="btn-g" data-a="add" data-mode="pedido">+ Pedido</button></div><div class="cols"><div class="col">${panel('Resumen', sumT)}</div><div class="col">${panel('Pedidos', list)}</div></div>`;
  }
  if (st.stockSeg === 'plan') return viewPlan(seg, bz);
  const ms = L('models').slice().sort((a, b) => (SORDER[a.status] ?? 9) - (SORDER[b.status] ?? 9) || n0(a.order) - n0(b.order) || String(a.name).localeCompare(b.name));
  const live = ms.filter((m) => m.status !== 'descartado');
  const home = sum(live.map((m) => n0(m.home))), trn = sum(live.map((m) => n0(m.transit)));
  const val = sum(live.map((m) => n0(m.home) * costOf(m))), pot = sum(live.map((m) => n0(m.home) * n0(m.listPrice)));
  const f = st.filter, shown = ms.filter((m) => (f === 'todos' ? true : f === 'activos' ? m.status !== 'descartado' : m.status === f));
  const chips = [['activos', 'Activos'], ['ganador', 'Ganadores'], ['test', 'Test'], ['espera', 'En espera'], ['descartado', 'Descartados'], ['todos', 'Todos']]
    .map(([v, l]) => `<button class="chip" data-a="filter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('');
  const parked = sum(bz.stocks.filter((r) => ['parado', 'liquidar', 'exceso'].includes(r.status)).map((r) => r.capital));
  const sumT = `<table class="xl"><tbody>${tr('En casa', home + ' uds')}${tr('En camino', trn + ' uds')}${tr('Stock a coste', eur(val))}${tr('Stock a precio de venta', eur(pot), 'tot')}${parked ? tr('Dinero parado (stock que no rota)', `<span class="warn">${eur(parked)}</span>`) : ''}${tr('Bolsitas en casa', `<span class="${pouches() < 5 ? 'neg' : ''}">${pouches()}</span> <span class="sub" style="display:inline">· ${eur(pouchCost())}/ud</span>`)}</tbody></table><div class="foot"><button class="lnk" data-a="settings">Cambiar bolsitas</button></div>`;
  const table = `<div class="tscroll"><table class="xl list stock"><thead><tr><th>Reloj</th><th class="n">Casa</th><th class="n">Cam.</th><th class="n">/día</th><th class="n">Días</th><th class="n">Coste</th></tr></thead><tbody>${shown.map((m) => {
    const r = stockOf(m.id), est = isEst(m), eff = r ? r.m.status : m.status, stt = STATUS[eff] ? eff : 'test';
    const live = liveOf(m.id).length;
    return `<tr class="click${m.status === 'descartado' ? ' off' : ''}" data-a="model" data-id="${esc(m.id)}"><td>${esc(m.name)}<span class="sub"><span class="st-${stt}">${STATUS[stt]}</span>${r && r.status !== 'sin datos' ? ' · ' + stockBadge(r) : ''}${m.status === 'ganador' && eff !== 'ganador' ? ' · <span class="warn">sin prueba</span>' : ''}${live ? ` · ${live} anuncio${live > 1 ? 's' : ''}` : ''}</span></td>
      <td class="n">${n0(m.home)}</td><td class="n">${n0(m.transit) || '·'}</td><td class="n">${r && r.rate ? rate1(r.rate) : '·'}</td><td class="n ${r && r.rate && r.coverAll < r.lead ? 'neg' : ''}">${r && r.rate ? days1(r.coverAll) : '·'}</td><td class="n ${est ? 'est' : ''}">${est ? '≈' : ''}${eur(costOf(m)).replace(/\s?€/, '')}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No hay relojes en este filtro.</td></tr>'}</tbody></table></div><div class="foot">/día = ventas por día (las recientes pesan más). Días = días de stock contando lo que viene en camino. Toca un reloj para ver todo su análisis.</div>`;
  const alerts = bz.stocks.filter((r) => ['rotura', 'urgente', 'pedir', 'parado', 'liquidar', 'exceso'].includes(r.status)).sort((a, b) => ({ rotura: 0, urgente: 1, pedir: 2, parado: 3, liquidar: 4, exceso: 5 }[a.status] - { rotura: 0, urgente: 1, pedir: 2, parado: 3, liquidar: 4, exceso: 5 }[b.status]));
  const al = alerts.length ? `<table class="xl list"><tbody>${alerts.map((r) => `<tr class="click" data-a="model" data-id="${esc(r.m.id)}"><td>${esc(r.m.name)}<span class="sub">${stockBadge(r)} · ${esc(r.why)}</span></td></tr>`).join('')}</tbody></table><div class="foot"><button class="lnk" data-a="seg" data-v="plan">Ver qué pedir con tu caja</button></div>` : empty('Todo el stock aguanta. Nada que pedir hoy.');
  return `<div class="toolbar">${seg}<span style="display:flex;gap:6px"><button class="btn-o" data-a="catchup">Ponerme al día</button><button class="btn-g" data-a="model">+ Reloj</button></span></div>
    <div class="cols wide"><div class="col">${panel('Relojes', `<div class="filters">${chips}</div>` + table)}</div>
    <div class="col">${panel('Días de stock', stockChart(), 'toca uno')}${panel('Alertas de stock', al, alerts.length ? String(alerts.length) : '')}${panel('Resumen', sumT)}</div></div>`;
}
function viewPlan(seg, bz) {
  const pl = bz.plan, ld = bz.lead;
  const leadTxt = (k) => `${ld[k]} días <span class="sub" style="display:inline">${ld[k + 'N'] ? `· medido en ${ld[k + 'N']} pedido${ld[k + 'N'] > 1 ? 's' : ''}` : '· estimado'}</span>`;
  const head2 = `<table class="xl"><tbody>${tr('Puedes gastar', money(pl.cash))}${tr('DHL tarda', leadTxt('dhl'))}${tr('DDP tarda', leadTxt('ddp'))}</tbody></table>`;
  const row = (l) => `<tr class="click" data-a="model" data-id="${esc(l.m.id)}"><td>${esc(l.m.name)}<span class="sub">${stockBadge(l.s)}${l.qty < l.want ? ` · querías ${l.want}, la caja da ${l.qty}` : ''}</span></td><td class="n">${l.qty}</td><td class="n">${eur(l.cost)}</td><td class="n pos">${eur(l.qty * l.s.unitProfit)}</td></tr>`;
  const block = (lane, t) => {
    const ls = pl.lines.filter((l) => l.lane === lane); if (!ls.length) return '';
    return `<tr class="grp"><td colspan="4">${lane === 'dhl' ? 'DHL urgente · llega en ~' + ld.dhl + ' días' : 'DDP · llega en ~' + ld.ddp + ' días'}</td></tr>${ls.map(row).join('')}
      <tr class="tot"><td>Total ${LANE[lane]}${t.kg ? ` · ${t.kg.toFixed(2).replace('.', ',')} kg` : ''}</td><td class="n">${t.units}</td><td class="n">${eur(t.cost)}</td><td class="n pos">${eur(t.profit)}</td></tr>`;
  };
  const body = pl.lines.length ? `<table class="xl list"><thead><tr><th>Reloj</th><th class="n">Uds</th><th class="n">Coste</th><th class="n">Benef.</th></tr></thead><tbody>${block('dhl', pl.dhl)}${block('ddp', pl.ddp)}</tbody></table>
    <div class="foot" style="display:flex;gap:8px;flex-wrap:wrap">${pl.dhl.units ? '<button class="btn-g" data-a="plan-order" data-v="dhl">Crear pedido DHL</button>' : ''}${pl.ddp.units ? '<button class="btn-g" data-a="plan-order" data-v="ddp">Crear pedido DDP</button>' : ''}<span>Te quedan ${eur(pl.left)} después.</span></div>`
    : pl.skipped.length ? empty(`Hay que pedir, pero ahora no hay caja (puedes gastar ${eur(pl.cash)}). Abajo lo que falta: paga deudas y vende primero.`) : empty('Nada que pedir: todos los relojes que se venden tienen stock para más que lo que tarda un DDP.');
  const skip = pl.skipped.length ? panel('Sin caja para', `<table class="xl list"><tbody>${pl.skipped.map((k) => `<tr><td>${esc(k.s.m.name)}<span class="sub">${LANE[k.lane]} ${k.want} uds · ${eur(k.want * costOf(k.s.m))} · ${esc(k.s.why)}</span></td></tr>`).join('')}</tbody></table><div class="foot">Vende o paga deudas primero. En cuanto haya caja aparece arriba.</div>`) : '';
  const how = `<div class="foot">Ritmo = ventas de 28 días, las recientes pesan más. Colchón de seguridad según cuánto varían tus ventas. Pide para cubrir lo que tarda el DDP + ${n0(S0().cycleDays) || B.FALLBACK.cycleDays} días. Si se acaba antes de que llegue un DDP, el hueco va por DHL. Coste por unidad = coste puesto del reloj.</div>`;
  return `<div class="toolbar">${seg}</div><div class="cols wide"><div class="col">${panel('Pedido recomendado', body)}${skip}</div><div class="col">${panel('Tu caja y plazos', head2 + how)}</div></div>`;
}

/* ---------------- manager (AI) ---------------- */
function mdLite(t) {
  const lines = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let h = '', inList = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) { if (!inList) { h += '<ul>'; inList = true; } h += `<li>${m[1]}</li>`; continue; }
    if (inList) { h += '</ul>'; inList = false; }
    const hd = ln.match(/^#{1,4}\s+(.*)/);
    h += hd ? `<p class="mh">${hd[1]}</p>` : ln.trim() ? `<p>${ln}</p>` : '';
  }
  return h + (inList ? '</ul>' : '');
}
const QUICK = [['¿Qué hago hoy?', 'Qué hago hoy: los 3 movimientos con más impacto, con números.'], ['Qué pido', '¿Qué pido ahora con mi caja? Dame el pedido exacto y por qué vía.'], ['Tests', '¿Cómo van mis tests? Veredicto de cada uno y qué hago.'], ['Cuentas', '¿Cómo reparto los anuncios entre cuentas y cuántas cuentas necesito?'], ['¿Llego al mes?', '¿Llego al objetivo del mes? Qué tengo que cambiar para llegar.']];
function viewManager() {
  if (!agent.key() || st.aiSetup) {
    const cur = agent.mode(), u = agent.usage(), days = Math.max(1, Object.keys(u.byDay || {}).length), perDay = u.usd / days;
    return `<div class="toolbar"><span class="ttl">OOQ Manager</span>${agent.key() ? '<button class="btn-o" data-a="ai-setup">Volver al chat</button>' : ''}</div>
      <div class="cols"><div class="col">${panel('Conectar la IA', `<div class="stack pad">
        <p class="lead2">El Manager es Claude dentro de tu app: ve todos tus datos, te habla, apunta lo que le dices, lee tus capturas de Vinted y cada mañana te dice qué hacer.</p>
        <ol class="steps"><li>console.anthropic.com → crea cuenta</li><li>Billing → añade 10 €</li><li>Limits → pon un límite al mes (ej. 10 €)</li><li>API Keys → Create key → cópiala</li><li>Pégala aquí abajo → Guardar</li></ol>
        <div class="field"><label for="ai-key">Clave de la API</label><input id="ai-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(agent.key())}"></div>
        <div class="field"><label for="ai-model">Modo</label><select id="ai-model">${AI_MODES.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        ${u.calls ? `<div class="preview"><div class="kv"><span class="mut">Gastado este mes (este dispositivo)</span><b>≈ ${u.usd.toFixed(2).replace('.', ',')} $</b></div><div class="kv"><span class="mut">Llamadas</span><b>${u.calls}</b></div><div class="kv"><span class="mut">A este ritmo, al mes</span><b>≈ ${(perDay * 30).toFixed(1).replace('.', ',')} $</b></div></div>` : ''}
        <div class="hint">La clave se guarda solo en este dispositivo (en el móvil y en el PC la pegas una vez en cada uno). Nunca se sube a GitHub ni a ningún sitio.</div>
        <div class="err" id="ai-err"></div><button class="primary" data-a="ai-save">Guardar y empezar</button></div>`)}</div><div class="col">${panel('Avisos en el móvil', `<div class="stack pad"><p class="lead2">Briefing a las 9:00, tests a las 24h y 48h, stock urgente y resumen a las 21:00, por Telegram, con la app cerrada.</p><button class="ghost" data-a="notif">Cómo activarlo (5 pasos)</button></div>`)}</div></div>`;
  }
  const hist = agent.history().filter((m) => !m.hidden || m.role === 'assistant');
  const msgs = hist.map((m) => m.role === 'user'
    ? `<div class="msg me"><div class="bub">${m.images ? `<span class="imgtag">${m.images} captura${m.images > 1 ? 's' : ''}</span>` : ''}${esc(m.text === '[captura]' ? '' : m.text).replace(/\n/g, '<br>')}</div></div>`
    : `<div class="msg ai"><div class="bub">${mdLite(m.text || '')}${(m.actions || []).length ? `<div class="acts">${m.actions.map((a) => `<div>✓ ${esc(a)}</div>`).join('')}</div>` : ''}<div class="mt">${new Date(m.at).toLocaleString('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div></div></div>`).join('');
  const live = st.chatBusy ? `<div class="msg ai"><div class="bub think">${st.chatLive.length ? `<div class="acts">${st.chatLive.map((a) => `<div>${esc(a)}</div>`).join('')}</div>` : ''}<span class="dots"><i></i><i></i><i></i></span></div></div>` : '';
  const err = st.chatErr ? `<div class="msg ai"><div class="bub errb">${esc(st.chatErr)}</div></div>` : '';
  const hello = !hist.length ? `<div class="msg ai"><div class="bub"><p><b>Soy tu OOQ Manager.</b></p><p>Veo tu caja, stock, tests, cuentas y plan. Dime lo que pasa ("vendí 2 oro a 30", "subí el negro a tictac") y lo apunto. Mándame capturas de las stats de Vinted y decido el test. Pregúntame qué hacer y te digo el mejor movimiento con números.</p></div></div>` : '';
  return `<div class="toolbar"><span class="ttl">OOQ Manager</span><span style="display:flex;gap:6px"><button class="btn-o" data-a="notif">Avisos</button><button class="btn-o" data-a="chat-clear">${st.confirm === 'chat/all' ? '¿Borrar chat?' : 'Borrar chat'}</button><button class="btn-o" data-a="ai-setup">IA</button></span></div>
    <div class="chatlog" id="chatlog">${hello}${msgs}${live}${err}</div>
    <div class="quick">${QUICK.map(([l, q], i) => `<button class="chip" data-a="chat-quick" data-v="${i}"${st.chatBusy ? ' disabled' : ''}>${l}</button>`).join('')}</div>`;
}
async function chatSend(text, heavy) {
  const ta = $('#comp-text');
  const t = (text !== undefined ? text : ta ? ta.value : '').trim(), imgs = st.chatImgs.slice();
  if ((!t && !imgs.length) || st.chatBusy) return;
  if (ta && text === undefined) { ta.value = ''; ta.style.height = ''; }
  st.chatImgs = []; drawImgs();
  st.chatBusy = true; st.chatErr = ''; st.chatLive = []; renderSoon();
  try { await agent.send(t, imgs, { heavy: !!heavy, onAction: (a, bad) => { st.chatLive.push((bad ? '✗ ' : '✓ ') + a); renderSoon(); } }); }
  catch (e) { st.chatErr = e.message || String(e); }
  st.chatBusy = false; st.chatLive = []; renderSoon();
}
function drawImgs() { const b = $('#comp-imgs'); if (b) b.innerHTML = st.chatImgs.map((im, i) => `<span class="cimg"><img src="data:${im.media_type};base64,${im.data}" alt=""><button data-a="chat-rmimg" data-v="${i}" aria-label="Quitar">×</button></span>`).join(''); }
function readImage(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const img = new Image(); img.onload = () => {
      const k = Math.min(1, 1400 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res({ media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
    }; img.onerror = rej; img.src = fr.result; };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}
async function morningBriefing() {
  if (!agent.key() || lsGet('lg_brief', '') === todayKey() || new Date().getHours() < 6) return;
  if (L('chat').some((m) => m.source === 'server' && (m.at || '').slice(0, 10) === new Date().toISOString().slice(0, 10))) return; // the server already sent today's briefing
  lsSet('lg_brief', todayKey());
  try {
    const r = await agent.send('Briefing de la mañana. Cómo voy (caja, deuda, mes vs objetivo y mínimo), los 3 movimientos con más impacto de hoy con números, y qué tests tocan control. Corto y agresivo.', [], { hidden: true });
    if (st.tab !== 'manager') { st.briefNew = true; toast('Tu briefing de hoy está listo en Manager'); }
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      const body = (r.text || '').replace(/[*#]/g, '').split('\n').find((x) => x.trim()) || 'Tu plan de hoy está listo.';
      if (reg) reg.showNotification('OOQ Manager', { body, icon: 'icons/icon-192.png', tag: 'brief' }); else new Notification('OOQ Manager', { body });
    }
  } catch (e) { lsSet('lg_brief', ''); console.warn('briefing', e); }
  renderSoon();
}

/* ---------------- tests ---------------- */
const TORDER = { oferta: 0, ganador: 1, muerto: 2, portada: 3, datos: 4, bajar: 5, nopub: 6, sigue: 7, espera: 8 };
function viewTests() {
  const bz = brain(), b = bz.bench;
  const ts = bz.tests.slice().sort((x, y) => (TORDER[x.stage] ?? 9) - (TORDER[y.stage] ?? 9) || y.score - x.score);
  const pct = (v) => Math.round(v * 100) + '%';
  const bench = `<table class="xl"><tbody>
    <tr class="big"><th>Tests corriendo</th><td class="n"><span class="${bz.running < bz.benchN ? 'neg' : 'pos'}">${bz.running}</span><span class="sub" style="display:inline"> de ${bz.benchN} a la vez</span></td></tr>
    ${tr('Tests por semana', `<b>${bz.tp.perWeek}</b>`)}
    ${tr('Ganadores que faltan', `${bz.tp.winnersNeeded} <span class="sub" style="display:inline">· para ${bz.tp.target} ventas/mes, un ganador hace ~${Math.round(bz.tp.perWinner)}/mes</span>`)}
    ${tr('De cada 4 tests sale', `${(bz.tp.hit * 4).toFixed(1).replace('.', ',')} ganador`)}
    ${tr('Favoritos de un ganador tuyo', pct(b.fav))}
    ${tr('Vistas por día de un ganador', Math.round(b.vpd))}
    ${tr('Ofertas por 100 vistas', b.opv.toFixed(1).replace('.', ','))}
  </tbody></table><div class="foot">${b.learned ? `Medido en ${b.n} datos de tus ganadores.` : 'Valores de arranque: en cuanto metas stats de tus ganadores, se calculan con tus datos.'}</div>`;
  const rules = `<table class="xl list"><tbody>
    <tr><td><b>24h</b><span class="sub">pocas vistas para lo que hace un ganador → portada y título nuevos ya</span></td></tr>
    <tr><td><b>48h · veredicto</b><span class="sub">0 ofertas → MUERTO. 2+ ofertas, o 1 oferta con favs de ganador → GANADOR, pide</span></td></tr>
    <tr><td><b>1 oferta floja</b><span class="sub">24h de última oportunidad a −3 €. A las 72h sin venta → MUERTO</span></td></tr>
    <tr><td><b>Siempre</b><span class="sub">1 venta = ganador. Oferta con buen beneficio = acéptala</span></td></tr>
  </tbody></table>`;
  const list = ts.length ? `<div class="tscroll"><table class="xl list stock"><thead><tr><th>Test</th><th class="n">Tiempo</th><th class="n">Vistas</th><th class="n">Favs</th><th class="n">Ofer.</th><th class="n">Nota</th></tr></thead><tbody>${ts.map((t) => `
    <tr class="click" data-a="test" data-id="${esc(t.m.id)}"><td>${esc(t.m.name)}<span class="sub"><b class="${STG[t.stage] || ''}">${B.STAGE[t.stage]}</b> · ${esc(t.act || t.why)}</span></td>
    <td class="n">${t.ls.length ? hh(t.hours) : '·'}</td><td class="n">${t.ls.length ? t.views : '·'}</td><td class="n">${t.views ? pct(t.favRate) : '·'}</td><td class="n">${t.ls.length ? t.offers + (t.best ? `<span class="sub">${t.best} €</span>` : '') : '·'}</td>
    <td class="n barcell">${t.ls.length ? pbar(t.score / 100, t.score >= 70 ? 'won' : '') + `<span>${t.score}</span>` : '·'}</td></tr>`).join('')}</tbody></table></div><div class="foot">Toca un test para meter stats, cambiar precio o decidir.</div>`
    : empty(`No hay tests. Necesitas ${brain().tp.perWeek} esta semana: los ganadores nuevos salen de aquí.`);
  return `<div class="toolbar"><span class="ttl">Tests</span><button class="btn-g" data-a="newtest">+ Test nuevo</button></div>
    <div class="cols wide"><div class="col">${panel('En test', list)}</div><div class="col">${panel('Banco de tests', bench)}${panel('Reglas rápidas', rules)}</div></div>`;
}

/* ---------------- accounts ---------------- */
const HEALTH = { ok: ['OK', 'pos'], riesgo: ['Riesgo', 'warn'], peligro: ['Peligro', 'neg'], restringida: ['Restringida', 'neg'], pausada: ['Pausada', 'mut'] };
function viewAccounts() {
  const bz = brain(), A = bz.acc, nd = bz.need, p = bz.pace;
  const accT = A.accs.length ? `<div class="tscroll"><table class="xl list stock"><thead><tr><th>Cuenta</th><th class="n">Activos</th><th class="n">7 días</th><th class="n">30 días</th><th class="n">/día</th><th class="n">Retir.</th></tr></thead><tbody>${A.accs.map((a) => {
    const [hl, hc] = HEALTH[a.health] || ['', ''];
    return `<tr class="click" data-a="acc" data-v="${esc(a.name)}"><td>${esc(a.name)}<span class="sub"><b class="${hc}">${hl}</b>${a.main ? ' · principal (tests)' : ''}${a.owner ? ' · ' + esc(a.owner) : ''}</span></td><td class="n">${a.live.length}</td><td class="n">${a.s7}</td><td class="n">${a.s30}</td><td class="n">${rate1(a.rate)}</td><td class="n ${a.rem14 ? 'neg' : ''}">${a.rem30 || '·'}</td></tr>`;
  }).join('')}</tbody></table></div><div class="foot">Retir. = anuncios retirados por Vinted en 30 días. Toca una cuenta para cambiar su estado.</div>` : empty('Añade tus cuentas en Ajustes.');
  const needT = nd.need ? `<table class="xl"><tbody>${tr('Una cuenta tuya vende', rate1(nd.per) + '/día · ' + Math.round(nd.perMonth) + '/mes')}${tr('Objetivo del mes', p.T + ' ventas')}${tr('Cuentas activas', nd.have)}${tr('Necesitas', `<b class="${nd.have >= nd.need ? 'pos' : 'neg'}">${nd.need} cuenta${nd.need > 1 ? 's' : ''}</b>`, 'tot')}</tbody></table>
    <div class="foot">${nd.have >= nd.need ? 'Con las cuentas que tienes llegas: el trabajo es tener stock y ganadores publicados.' : `Te faltan ${nd.need - nd.have}. Cada cuenta nueva = una persona real con su móvil, su DNI y su banco, vendiendo tu stock. Nunca cuentas con tus datos repetidos.`}</div>`
    : empty(p.T ? 'Aún no hay ventas por cuenta para calcularlo.' : 'Pon el objetivo del mes en Plan para calcular cuántas cuentas necesitas.');
  const dist = bz.dist.slice().sort((a, b) => b.p - a.p);
  const distT = dist.length ? `<table class="xl list"><tbody>${dist.map((d) => `<tr><td><b class="${d.k === 'publicar' ? 'pos' : d.k === 'mover' ? 'warn' : 'neg'}">${d.k === 'publicar' ? 'Publicar' : d.k === 'mover' ? 'Mover' : 'Quitar'}</b> ${esc(d.m.name)} <span class="sub">${d.k === 'publicar' ? 'en' : 'de'} ${esc(d.acc)} · ${esc(d.why)}</span></td><td class="x" style="width:auto;padding:0 8px">${d.k === 'publicar' ? `<button class="cellbtn" data-a="newlisting" data-id="${esc(d.m.id)}" data-v="${esc(d.acc)}">Publicado</button>` : `<button class="cellbtn" data-a="dist-down" data-id="${esc(d.m.id)}" data-v="${esc(d.acc)}">Hecho</button>`}</td></tr>`).join('')}</tbody></table>
    <div class="foot">Cada ganador en máx. ${n0(S0().maxAccPerModel) || B.FALLBACK.maxAccPerModel} cuentas, con fotos y texto distintos. Lo retirado por reportes sale de esa cuenta 30 días; 2 retiradas = fuera de todas.</div>` : empty('Bien repartido. Nada que mover.');
  const live = L('listings').filter((l) => l.status === 'live').sort((a, b) => String(a.account).localeCompare(b.account) || a.listedAt.localeCompare(b.listedAt));
  const accs = [...new Set(live.map((l) => l.account))];
  const liveT = live.length ? `<table class="xl list"><tbody>${accs.map((a) => `<tr class="grp"><td colspan="2">${esc(a)} · ${live.filter((l) => l.account === a).length}</td></tr>` + live.filter((l) => l.account === a).map((l) => {
    const m = model(l.modelId), sn = B.latestSnap(l), d = Math.floor((Date.now() - Date.parse(l.renewedAt || l.listedAt)) / 86400000);
    return `<tr class="click" data-a="listing" data-id="${esc(l.id)}"><td>${esc(m ? m.name : 'Reloj borrado')}<span class="sub">${eur(n0(l.price))} · ${d ? d + (d === 1 ? ' día' : ' días') : 'hoy'}${sn ? ` · ${n0(sn.views)} vistas · ${n0(sn.favs)} favs · ${n0(sn.offers)} oferta${n0(sn.offers) === 1 ? '' : 's'}` : ''}</span></td><td class="n ${d >= 4 && m && m.status === 'ganador' ? 'warn' : ''}">${d >= 4 && m && m.status === 'ganador' ? 'renovar' : ''}</td></tr>`;
  }).join('')).join('')}</tbody></table>` : empty('Sin anuncios apuntados. Apunta cada anuncio que subes y el reparto se calcula solo.');
  return `<div class="toolbar"><span class="ttl">Cuentas</span><button class="btn-g" data-a="newlisting">+ Anuncio</button></div>
    <div class="cols"><div class="col">${panel('Cuentas', accT, '<button class="lnk" data-a="settings">Añadir</button>')}${panel('Reparto', distT, dist.length ? String(dist.length) : '')}</div>
    <div class="col">${panel('Cuántas cuentas necesitas', needT)}${panel('Anuncios activos', liveT, String(live.length))}</div></div>`;
}

function viewSpend() {
  const mk = st.month, p = parts(mk);
  const per = on(L('spend'), mk).filter((x) => x.kind !== 'negocio');
  const byCat = {}; per.forEach((x) => { byCat[x.cat] = (byCat[x.cat] || 0) + n0(x.amount); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...cats.map((c) => c[1]));
  const totals = `<table class="xl"><tbody>${tr('Personal', eur(p.pers))}${tr('Negocio (boosts, envíos…)', eur(p.biz))}${p.income ? tr('Otros ingresos', money(p.income, true)) : ''}${tr('Total gastado', eur(p.pers + p.biz), 'tot')}</tbody></table>
    ${cats.length ? `<table class="xl list"><thead><tr><th>Categoría</th><th class="n">Importe</th><th class="n">%</th></tr></thead><tbody>${cats.map(([c, v]) => `<tr><td>${esc(c)}</td><td class="n">${eur(v)}</td><td class="n barcell">${pbar(v / mx)}<span>${Math.round(v / (p.pers || 1) * 100)}%</span></td></tr>`).join('')}</tbody></table>` : ''}`;
  const list = [...on(L('spend'), mk).map((x) => ({ ...x, _t: 's' })), ...on(L('income'), mk).map((x) => ({ ...x, _t: 'i' }))].sort((a, b) => b.date.localeCompare(a.date) || (b.at || '').localeCompare(a.at || ''));
  const moves = list.length ? `<table class="xl list"><thead><tr><th>Concepto</th><th class="n">Importe</th><th></th></tr></thead><tbody>${list.map((x) => x._t === 'i'
    ? line(esc(x.note || 'Ingreso'), shortDate(x.date) + ' · ingreso', money(n0(x.amount), true), 'income', x.id)
    : line(esc(x.cat) + (x.note ? ' · ' + esc(x.note) : ''), shortDate(x.date) + ' · ' + (x.kind === 'negocio' ? 'negocio' : 'personal'), money(-n0(x.amount)), 'spend', x.id)).join('')}</tbody></table>` : empty('Sin movimientos este mes.');
  const months = [...new Set(L('bills').map((b) => b.month))].sort().filter((m) => m >= curMonth() || L('bills').some((b) => b.month === m && !b.paid)).slice(0, 5);
  const bills = months.length ? `<table class="xl list bills"><tbody>${months.map((m) => {
    const bs = L('bills').filter((b) => b.month === m).sort((a, b) => String(a.concept).localeCompare(b.concept));
    return `<tr class="grp"><td colspan="2">${monthName(m)}</td><td class="n">${eur(sum(bs.filter((b) => !b.paid).map((b) => n0(b.amount))))}</td><td></td></tr>` + bs.map((b) =>
      `<tr class="${b.paid ? 'paid' : ''}"><td class="cb"><button class="chk" data-a="paid" data-id="${esc(b.id)}" aria-pressed="${!!b.paid}" aria-label="Marcar pagado">${b.paid ? '✓' : ''}</button></td><td>${esc(b.concept)}</td><td class="n">${eur(n0(b.amount))}</td><td class="x">${xbtn('bills', b.id)}</td></tr>`).join('');
  }).join('')}</tbody></table><div class="foot">Al marcar un pago se resta de la caja.</div>` : empty('Sin pagos fijos pendientes.');
  return `<div class="toolbar">${mnav()}<span style="display:flex;gap:6px"><button class="btn-o" data-a="add" data-mode="ingreso">+ Ingreso</button><button class="btn-g" data-a="add" data-mode="gasto">+ Gasto</button></span></div>
    <div class="cols"><div class="col">${panel('Gastos de ' + MONTHS[pm(mk).m - 1], totals)}${panel('Movimientos', moves)}</div><div class="col">${panel('Pagos fijos', bills, '<button class="lnk" data-a="bill">+ Pago</button>')}</div></div>`;
}

function fmtMetric(g, v) {
  if (g.metric === 'streak') return v + (v === 1 ? ' mes' : ' meses');
  if (g.metric === 'units') return v + ' uds';
  return eur(v);
}
function goalNote(g, now, tg, won) {
  const money2 = g.metric !== 'streak' && g.metric !== 'units';
  let note = '';
  if (g.metric === 'streak') note = `meses con ${eur(n0(g.threshold))} o más, seguidos`;
  if (g.deadline && !won) {
    const { y, m } = pm(g.deadline), c = pm(curMonth()), left = (y - c.y) * 12 + (m - c.m) + 1;
    if (left > 0 && money2) note += (note ? ' · ' : '') + `${eur((tg - now) / left)}/mes hasta ${MSHORT[m - 1]} ${y}`;
    else if (left <= 0) note += (note ? ' · ' : '') + 'fecha límite pasada';
  }
  return won ? 'conseguido' + (note ? ' · ' + note : '') : note;
}
function goalsTable(gs, compact) {
  return `<table class="xl list goals"><thead><tr><th>Meta</th><th class="n">Actual</th><th class="n">Progreso</th>${compact ? '' : '<th></th>'}</tr></thead><tbody>${gs.map((g) => {
    const now = metricValue(g), tg = n0(g.target) || 1, won = now >= tg, p = Math.min(1, Math.max(0, now / tg)), note = goalNote(g, now, tg, won);
    return `<tr><td>${esc(g.title)}${note ? `<span class="sub ${won ? 'pos' : ''}">${note}</span>` : ''}</td><td class="n">${fmtMetric(g, now)}<span class="sub">de ${fmtMetric(g, tg)}</span></td><td class="n barcell">${pbar(p, won ? 'won' : '')}<span>${Math.round(p * 100)}%</span></td>${compact ? '' : `<td class="x">${xbtn('goals', g.id)}</td>`}</tr>`;
  }).join('')}</tbody></table>`;
}
function viewGoals() {
  const gs = L('goals').slice().sort((a, b) => n0(a.order) - n0(b.order));
  const plan = S0().plan || {}, months = Object.keys(plan).sort(), cm = curMonth();
  const pt = months.length ? `<div class="tscroll"><table class="xl list stock"><thead><tr><th>Mes</th><th class="n">Ventas</th><th class="n">Mín.</th><th class="n">Hechas</th><th class="n">Benef. obj.</th><th class="n">Benef.</th></tr></thead><tbody>${months.map((mk) => {
    const p = plan[mk], pr = parts(mk), past = mk < cm, cur = mk === cm;
    const sc = pr.nSales >= n0(p.sales) ? 'pos' : pr.nSales >= n0(p.min) ? 'warn' : past ? 'neg' : '';
    return `<tr class="${cur ? 'tot2' : ''}"><td>${MSHORT[pm(mk).m - 1]} ${String(pm(mk).y).slice(2)}${cur ? '<span class="sub">este mes</span>' : ''}</td><td class="n">${n0(p.sales)}</td><td class="n">${n0(p.min)}</td><td class="n ${past || cur ? sc : ''}">${past || cur ? pr.nSales : '·'}</td><td class="n">${eur(n0(p.profit)).replace(/,00/, '')}</td><td class="n">${past || cur ? money(pr.net, true) : '·'}</td></tr>`;
  }).join('')}</tbody></table></div><div class="foot">Si no llegas al mínimo de un mes, no se abre cuenta nueva el siguiente: primero se arregla lo que falla.</div>` : empty('Sin plan mensual.');
  return `<div class="toolbar"><span class="ttl">Plan</span><span style="display:flex;gap:6px"><button class="btn-o" data-a="planedit">Editar plan</button><button class="btn-g" data-a="goal">+ Meta</button></span></div>
    <div class="cols"><div class="col">${milestonesCard()}${paceBlock()}${panel('Plan mensual', pt)}</div><div class="col">${panel('Metas', gs.length ? goalsTable(gs, false) : empty('Aún no hay metas.'))}</div></div>`;
}

/* ---------------- sheets ---------------- */
function openSheet(kind, ctx) {
  brainCache = null;
  st.sheet = { kind, ctx: ctx || {} };
  sheetEl.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sh-t">${sheetHTML()}</div>`;
  sheetEl.hidden = false; document.body.classList.add('locked');
  afterSheet();
}
function redrawSheet() { brainCache = null; const p = $('.sheet-panel', sheetEl); if (p) { p.innerHTML = sheetHTML(); afterSheet(); labelTables(p); } }
// phone: wide tables become cards; each value gets its column name as a label
function labelTables(root) {
  root.querySelectorAll('table.stock, table.goals').forEach((t) => {
    const hs = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    t.style.setProperty('--cols', Math.max(1, hs.slice(1).filter(Boolean).length));
    t.querySelectorAll('tbody tr').forEach((r) => [...r.children].forEach((c, i) => { if (i && hs[i]) c.dataset.l = hs[i]; }));
  });
}
function closeSheet() { sheetEl.hidden = true; sheetEl.innerHTML = ''; st.sheet = null; document.body.classList.remove('locked'); }
const head = (t) => `<div class="sheet-head"><h2 id="sh-t">${t}</h2><button class="xbtn" data-a="close" aria-label="Cerrar">×</button></div>`;
const fld = (id, label, val, attrs) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(val == null ? '' : val)}" ${attrs || 'inputmode="decimal"'}></div>`;
const dateFld = (id, val, label = 'Fecha') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="date" value="${esc(val || todayKey())}"></div>`;
const sv = (id) => { const e = sheetEl.querySelector('#' + id); return e ? e.value.trim() : ''; };
const shErr = (t) => { const e = sheetEl.querySelector('#sh-err'); if (e) e.textContent = t; };
const sortedModels = () => L('models').slice().sort((a, b) => (SORDER[a.status] ?? 9) - (SORDER[b.status] ?? 9) || n0(b.home) - n0(a.home) || String(a.name).localeCompare(b.name));

function sheetHTML() {
  const { kind, ctx } = st.sheet;
  if (kind === 'add') {
    const mode = ctx.mode || 'venta';
    const body = { venta: saleBody, pedido: orderForm, gasto: spendBody, ingreso: incomeBody }[mode](ctx);
    return head('AÑADIR') + `<div class="seg">${[['venta', 'Venta'], ['pedido', 'Pedido'], ['gasto', 'Gasto'], ['ingreso', 'Ingreso']].map(([v, l]) => `<button data-a="mode" data-v="${v}" aria-pressed="${mode === v}">${l}</button>`).join('')}</div><div id="sh-body" class="stack">${body}</div>`;
  }
  if (kind === 'order') {
    const o = db.get(C.orders, ctx.id); if (!o) return head('PEDIDO') + empty('Este pedido ya no existe.');
    const pb = payback()[o.id], c = st.confirm === 'orders/' + o.id;
    return head('PEDIDO ' + shortDate(o.date).toUpperCase()) + orderBody(o, pb) +
      (n0(o.owed) ? `<div class="fields2">${fld('d-amt', 'Pagar ahora de lo que debes (€)', String(n0(o.owed)).replace('.', ','))}<div class="field"><label>&nbsp;</label><button class="btn-g" data-a="save-debt" style="padding:10px">Pagar</button></div></div><div class="err" id="sh-err"></div>` : '') +
      (o.status !== 'recibido' ? `<button class="primary" data-a="receive" data-id="${esc(o.id)}">Ha llegado</button>` : '') +
      `<button class="danger" data-a="del-order">${c ? 'Pulsa otra vez para borrar' : 'Borrar pedido'}</button>`;
  }
  if (kind === 'receive') {
    const o = db.get(C.orders, ctx.id) || {};
    return head('PEDIDO RECIBIDO') + `<div class="hint">Pedido del ${shortDate(o.date)} · ${(o.lines || []).reduce((a, l) => a + n0(l.qty), 0)} relojes. Los relojes pasan de "en camino" a "en casa".</div>
      <div class="fields2">${fld('r-dhl', 'Cobro de DHL al llegar (€)', ctx.dhl || '', 'inputmode="decimal" placeholder="0"')}${dateFld('r-date', ctx.date)}</div>
      <div class="preview" id="r-prev"></div><div class="err" id="sh-err"></div><button class="primary" data-a="save-receive">Guardar</button>`;
  }
  if (kind === 'model') {
    const m = ctx.id ? model(ctx.id) || {} : { status: 'test', home: 0, transit: 0 };
    return head(ctx.id ? 'EDITAR RELOJ' : 'NUEVO RELOJ') + fld('m-name', 'Nombre', m.name, 'autocomplete="off"') +
      `<div class="field"><label for="m-status">Estado</label><select id="m-status">${Object.keys(STATUS).map((k) => `<option value="${k}"${m.status === k ? ' selected' : ''}>${STATUS[k]}</option>`).join('')}</select></div>
      <div class="fields2">${fld('m-landed', 'Coste puesto (€)', m.landed)}${fld('m-list', 'Precio de venta (€)', m.listPrice)}</div>
      <div class="fields2">${fld('m-min', 'Precio mínimo (€)', m.minPrice)}${fld('m-unit', '€/ud en 1688', m.unitPrice)}</div>
      <div class="fields2">${fld('m-home', 'En casa', m.home || 0, 'inputmode="numeric"')}${fld('m-transit', 'En camino', m.transit || 0, 'inputmode="numeric"')}</div>
      <div class="fields2">${fld('m-w', 'Peso con bolsa (g)', m.weight, 'inputmode="numeric"')}<div></div></div>
      <div class="hint">Coste puesto = precio 1688 + envío + DHL/IVA, por unidad. Se calcula solo con los pedidos: el envío se reparte por peso (por eso hace falta el peso). ${ctx.id ? `Ahora: <b>${costSrc(m)}</b>.` : ''} Ganador solo con prueba: 1 venta o 2 ofertas; si no, se guarda como Test.</div><div class="err" id="sh-err"></div>
      <button class="primary" data-a="save-model">Guardar</button>${ctx.id ? modelAnalysis(ctx.id) + mergeBlock(ctx.id) : ''}${ctx.id ? `<button class="danger" data-a="del-model">${st.confirm === 'models/' + ctx.id ? 'Pulsa otra vez para borrar' : 'Borrar reloj'}</button>` : ''}`;
  }
  if (kind === 'settings') {
    const s = S0(), ss = sync.getStatus();
    return head('AJUSTES') + `<div class="field"><label for="s-cash">Dinero en el banco ahora mismo (€)</label><input id="s-cash" inputmode="decimal" value="${esc(String(r2(bankNow())).replace('.', ','))}"></div>
      <div class="fields2">${acctNames().map((a) => fld('s-vb-' + a.replace(/\W/g, '_'), 'Saldo en Vinted · ' + esc(a) + ' (€)', String(r2(vintedBalance(a))).replace('.', ','))).join('')}</div>
      <div class="hint">Banco = lo que ves en tu banco. Saldo Vinted = lo ya liberado que aún no has retirado (en Vinted → Saldo). Lo pendiente va venta a venta: Caja → Ventas pendientes.</div>
      <div class="fields2">${fld('s-cushion', 'Colchón: no bajar de (€)', s.cushion)}${fld('s-goal', 'Meta de beneficio al mes (€)', s.monthlyGoal)}</div>
      <div class="fields2">${fld('s-defcost', 'Coste por reloj si no sabes el exacto (€)', s.defaultCost)}<div></div></div>
      <div class="fields2">${fld('s-pouches', 'Bolsitas en casa', pouches(), 'inputmode="numeric"')}${fld('s-pouchcost', 'Coste por bolsita (€)', pouchCost())}</div>
      <div class="hint">Con un número aproximado basta. Cuando sepas el coste real de un reloj, ponlo en Stock → Editar y se usará ese.</div>
      ${fld('s-acc', 'Cuentas de venta (separadas por comas)', (s.accounts || []).join(', '), 'autocomplete="off"')}
      <div class="fields2">${fld('s-pend', 'Días que Vinted retiene el dinero', pendingDays(), 'inputmode="numeric"')}${fld('s-bench', 'Tests a la vez', n0(s.testBench) || B.FALLBACK.bench, 'inputmode="numeric"')}</div>
      <div class="fields2">${fld('s-maxacc', 'Máx. cuentas por reloj', n0(s.maxAccPerModel) || B.FALLBACK.maxAccPerModel, 'inputmode="numeric"')}${fld('s-cycle', 'Un DDP cubre (días de ventas)', n0(s.cycleDays) || B.FALLBACK.cycleDays, 'inputmode="numeric"')}</div>
      <div class="fields2">${fld('s-ldhl', 'DHL tarda (días, hasta medirlo)', n0(s.leadDHL) || B.FALLBACK.leadDHL, 'inputmode="numeric"')}${fld('s-lddp', 'DDP tarda (días, hasta medirlo)', n0(s.leadDDP) || B.FALLBACK.leadDDP, 'inputmode="numeric"')}</div>
      <div class="hint">Los plazos se miden solos con tus pedidos recibidos; estos números solo se usan hasta entonces.</div>
      <div class="err" id="sh-err"></div><button class="primary" data-a="save-settings">Guardar</button>
      <button class="ghost" data-a="theme" style="justify-self:start">${document.documentElement.dataset.theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}</button>
      <div class="card" style="padding:14px;display:grid;gap:8px"><div class="eyebrow">Sincronización</div>
        <div style="font-size:14px">${ss.enabled ? (ss.user ? `Conectado como <b>${esc(ss.user)}</b>` : 'Sin sesión') : 'Solo en este dispositivo (sin conectar)'}${ss.enabled && ss.at ? `<div class="hint">Última sincronización ${new Date(ss.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}${ss.pending ? ` · ${ss.pending} cambios por subir` : ''}</div>` : ''}${ss.error ? `<div class="hint neg">${esc(ss.error)}</div>` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${ss.enabled ? '<button class="ghost" data-a="sync-now">Sincronizar ahora</button>' : ''}<button class="ghost" data-a="export-ai">Copiar para Claude</button><button class="ghost" data-a="import">Importar ventas (CSV)</button><button class="ghost" data-a="export">Descargar copia</button>${ss.enabled && ss.user ? '<button class="ghost" data-a="logout">Cerrar sesión</button>' : ''}</div></div>`;
  }
  if (kind === 'import') {
    const accs = acctNames(), main = brain().acc.mainName || accs[0], other = accs.find((a) => a !== main) || main;
    return head('IMPORTAR VENTAS') + `<div class="hint">Tu historial en CSV: <b>date,item,sold,cost,boost</b>. Gold, Silver, Bronze → Watch 1 · TWIY → Watch 2 · el resto (Mstianq, Rokyn, Poedagar…) queda como descartado.</div>
      <div class="field"><label for="imp-txt">Pega el CSV</label><textarea id="imp-txt" rows="7" style="font:13px/1.4 ui-monospace,monospace;background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:10px 12px;width:100%;resize:vertical" placeholder="date,item,sold,cost,boost&#10;2026-07-12,TWIY,34.41,6.13,1.86">${esc(ctx.txt || '')}</textarea></div>
      <div class="field"><label for="imp-file">o un archivo .csv</label><input id="imp-file" type="file" accept=".csv,.txt,text/csv,text/plain"></div>
      <div class="fields2"><div class="field"><label for="imp-acc">Cuenta de esas ventas</label><select id="imp-acc">${accs.length > 1 ? `<option value="__split" selected>Repartir entre ${esc(other)} y ${esc(main)}</option>` : ''}${accs.map((a) => `<option>${esc(a)}</option>`).join('')}</select></div>${accs.length > 1 ? fld('imp-pct', '% en ' + esc(other), '65', 'inputmode="numeric"') : ''}</div>
      <div class="hint">Si no sabes de qué cuenta fue cada venta, se reparten por fechas en ese % (marcadas como cuenta aproximada).</div>
      <div id="imp-prev">${importPreview(ctx.txt || '')}</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-import">Importar</button>`;
  }
  if (kind === 'moves') return head('MEJORES MOVIMIENTOS') + movesTable(brain().moves);
  if (kind === 'pending') {
    const ps = pendingSales().sort((a, b) => (a.at || a.date).localeCompare(b.at || b.date)), accs = [...new Set(ps.map((x) => x.account || '—'))];
    const old = ps.filter((x) => B.diffD(x.date, todayKey()) >= pendingDays()).length;
    return head('PENDIENTE EN VINTED') + `<div class="hint">Ventas que el comprador aún no ha confirmado. Cuando Vinted te las libere, márcalas: pasan a tu saldo de Vinted.</div>
      ${ps.length ? `<table class="xl list"><tbody>${accs.map((a) => `<tr class="grp"><td colspan="3">${esc(a)} · ${eur(pendingVinted(a === '—' ? null : a))}</td></tr>` + ps.filter((x) => (x.account || '—') === a).map((x) => { const d = B.diffD(x.date, todayKey()); return `<tr><td>${esc(x.modelName || 'Venta')}<span class="sub">${shortDate(x.date)} · hace ${d} día${d === 1 ? '' : 's'}${d >= pendingDays() ? ' · <b class="warn">¿ya liberada?</b>' : ''}</span></td><td class="n">${eur(n0(x.price))}</td><td class="x" style="width:auto"><button class="cellbtn" data-a="release" data-id="${esc(x.id)}">Liberada</button></td></tr>`; }).join('')).join('')}</tbody></table>` : empty('Nada pendiente.')}
      ${ps.length > 1 ? `<button class="ghost" data-a="release-all">Liberar todas (${ps.length})</button>` : ''}${old ? `<div class="hint">${old} llevan ${pendingDays()}+ días: lo normal es que ya estén liberadas.</div>` : ''}`;
  }
  if (kind === 'withdraw') {
    const accs = acctNames(), acc = ctx.acc || accs.find((a) => vintedBalance(a) > 0) || accs[0];
    return head('RETIRAR A BANCO') + `<div class="field"><label for="w-acc2">Cuenta de Vinted</label><select id="w-acc2">${accs.map((a) => `<option${a === acc ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></div>
      <div class="fields2">${fld('w-amt', 'Importe (€)', String(r2(Math.max(0, vintedBalance(acc)))).replace('.', ','))}${dateFld('w-date', ctx.date)}</div>
      <div class="hint">Saldo en Vinted de esa cuenta: ${eur(vintedBalance(acc))}. Sale del saldo de Vinted y entra en tu banco.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-withdraw">Guardar retiro</button>`;
  }
  if (kind === 'notif') return head('AVISOS EN EL MÓVIL') + `<div class="hint">Te llegan por Telegram aunque la app esté cerrada: briefing a las 9:00 escrito por la IA, controles de 24h y 48h de cada test, stock a punto de romperse, deuda y resumen a las 21:00. Lo envía un proceso gratis de GitHub cada hora.</div>
    <ol class="steps"><li><b>Telegram</b> → busca @BotFather → /newbot → ponle nombre (ej. OOQ Manager) → copia el token</li><li>Abre tu bot nuevo → pulsa <b>Start</b></li><li><b>Supabase</b> → tu proyecto → Project Settings → API Keys → Secret keys → copia la clave (sb_secret_…)</li><li><b>GitHub</b> → repo ooq-ledger → Settings → Secrets and variables → Actions → New repository secret, 3 veces:<br>· TELEGRAM_BOT_TOKEN = token del paso 1<br>· SUPABASE_SECRET_KEY = clave del paso 3<br>· ANTHROPIC_API_KEY = tu clave de la IA</li><li>GitHub → pestaña <b>Actions</b> → OOQ Manager notifications → Run workflow → te llega el briefing al momento</li></ol>
    <div class="hint">Las claves quedan cifradas en GitHub; nadie las ve, ni en el repo público. Desde ahí funciona solo cada hora.</div>`;
  if (kind === 'catchup') {
    const ms = sortedModels().filter((m) => m.status !== 'descartado'), accs = acctNames();
    return head('PONERME AL DÍA') + `<div class="hint">Lo que la app no sabe. Rellena solo lo que cambia; lo vacío se queda igual. "Vendidos" = los de los últimos 14 días que NO apuntaste (solo para calcular ritmo, no cuentan como ventas en la caja).</div>
      ${ms.map((m) => { const lv = liveOf(m.id).map((l) => l.account); return `<div class="cu"><b>${esc(m.name)}</b><span class="sub">${STATUS[m.status] || ''}${lv.length ? ' · publicado en ' + esc(lv.join(', ')) : ''}</span>
        <div class="fields3">${fld('cu-h-' + m.id, 'En casa', n0(m.home), 'inputmode="numeric"')}${fld('cu-s-' + m.id, 'Vendidos 14 días', m.baseAt && m.baseAt >= shiftDay(todayKey(), -13) ? n0(m.base14) : '', 'inputmode="numeric" placeholder="0"')}
        <div class="field"><label for="cu-a-${m.id}">Publicado en</label><select id="cu-a-${esc(m.id)}"><option value="">${lv.length ? 'ya apuntado' : 'no / no sé'}</option>${accs.filter((a) => !lv.includes(a)).map((a) => `<option>${esc(a)}</option>`).join('')}</select></div></div></div>`; }).join('')}
      <div class="err" id="sh-err"></div><button class="primary" data-a="save-catchup">Guardar</button>`;
  }
  if (kind === 'test') {
    const t = brain().tests.find((z) => z.m.id === ctx.id);
    if (!t) return head('TEST') + empty('Este reloj ya no está en test.') + `<button class="ghost" data-a="model" data-id="${esc(ctx.id)}">Abrir reloj</button>`;
    const pct = (v) => Math.round(v * 100) + '%';
    const lsel = t.live.length > 1 ? `<div class="field"><label for="t-l">Anuncio</label><select id="t-l">${t.live.map((l) => `<option value="${esc(l.id)}">${esc(l.account)} · ${eur(n0(l.price))}</option>`).join('')}</select></div>` : t.live.length ? `<input type="hidden" id="t-l" value="${esc(t.live[0].id)}">` : '';
    const snapForm = t.live.length ? `${lsel}<div class="eyebrow">Stats de ahora</div><div class="fields4">${fld('t-v', 'Vistas', '', 'inputmode="numeric"')}${fld('t-f', 'Favs', '', 'inputmode="numeric"')}${fld('t-o', 'Ofertas', '', 'inputmode="numeric"')}${fld('t-b', 'Mejor oferta €', '', 'inputmode="decimal"')}</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-snap">Guardar stats</button>`
      : `<div class="hint">No está publicado. Apúntalo cuando lo subas a Vinted y empieza el reloj de 24h.</div><button class="primary" data-a="newlisting" data-id="${esc(t.m.id)}" data-v="${esc(brain().acc.mainName || '')}">Lo acabo de publicar</button>`;
    return head('TEST · ' + esc(t.m.name).toUpperCase()) + `<div class="verdict ${STG[t.stage] || ''}"><b>${B.STAGE[t.stage]}</b><span>${esc(t.why)}</span><span class="act">${esc(t.act)}</span></div>
      ${t.ls.length ? `<table class="xl"><tbody>${tr('Publicado', hh(t.hours) + (t.next ? ` · siguiente control a las ${t.next}h` : ''))}${tr('Vistas', t.views + ` <span class="sub" style="display:inline">· ${Math.round(t.vpd)}/día (ganador ${Math.round(brain().bench.vpd)})</span>`)}${tr('Favoritos', t.favs + ` <span class="sub" style="display:inline">· ${t.views ? pct(t.favRate) : '—'} (ganador ${pct(brain().bench.fav)})</span>`)}${tr('Ofertas', t.offers + (t.best ? ` <span class="sub" style="display:inline">· mejor ${t.best} €</span>` : ''))}${tr('Vendidos', t.sold)}${tr('Nota', t.score + '/100', 'tot')}${t.lastSnap ? tr('Últimas stats', ago(t.lastSnap)) : ''}</tbody></table>` : ''}
      ${snapForm}
      <div class="btnrow">${t.stage === 'bajar' && t.live.length ? `<button class="btn-o" data-a="test-price" data-id="${esc(t.m.id)}">Bajado a ${eur(t.newPrice)}</button>` : ''}${t.live.length ? `<button class="btn-o" data-a="test-cover" data-id="${esc(t.m.id)}">Cambié la portada</button>` : ''}</div>
      <div class="fields2"><button class="primary" data-a="test-win" data-id="${esc(t.m.id)}">Ganador → pedir ${t.firstQty}</button><button class="danger" data-a="test-kill" data-id="${esc(t.m.id)}">Muerto</button></div>`;
  }
  if (kind === 'newtest') {
    const accs = acctNames(), main = brain().acc.mainName;
    return head('TEST NUEVO') + fld('n-name', 'Nombre del reloj', '', 'autocomplete="off" placeholder="Ej. Cuadrado plateado esfera azul"') +
      `<div class="fields2">${fld('n-unit', '€/ud en 1688', '', 'inputmode="decimal" placeholder="6"')}${fld('n-w', 'Peso con bolsa (g)', '', 'inputmode="numeric" placeholder="35"')}</div>
      <div class="fields2">${fld('n-price', 'Precio en Vinted (€)', '34,95')}${fld('n-home', 'Uds en casa', '', 'inputmode="numeric" placeholder="3"')}</div>
      <div class="fields2">${fld('n-cost', 'Coste puesto (€, si lo sabes)', '', 'inputmode="decimal" placeholder="≈ 1688 + envío"')}<div class="field"><label for="n-acc">Cuenta</label><select id="n-acc">${accs.map((a) => `<option${a === main ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" id="n-live" checked> Ya está publicado en Vinted (empieza el reloj ahora)</label>
      <div class="hint">Nada que parezca de marca: es lo que más reportes atrae.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-newtest">Empezar test</button>`;
  }
  if (kind === 'newlisting') {
    const ms = sortedModels().filter((m) => m.status !== 'descartado'), accs = acctNames();
    const m = model(ctx.id) || ms[0] || {}, acc = ctx.acc || brain().acc.mainName;
    const lp = !isNaN(num(m.listPrice)) ? String(m.listPrice).replace('.', ',') : '34,95';
    return head('ANUNCIO PUBLICADO') + `<div class="field"><label for="w-m">Reloj</label><select id="w-m">${ms.map((z) => `<option value="${esc(z.id)}"${z.id === m.id ? ' selected' : ''}>${esc(z.name)} · ${n0(z.home)} en casa</option>`).join('')}</select></div>
      <div class="fields2"><div class="field"><label for="w-acc">Cuenta</label><select id="w-acc">${accs.map((a) => `<option${a === acc ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></div>${fld('w-price', 'Precio (€)', lp)}</div>
      <div class="hint">Cada anuncio apuntado = tests a tiempo, reparto entre cuentas y avisos de renovar.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-listing">Guardar</button>`;
  }
  if (kind === 'listing') {
    const l = db.get(C.listings, ctx.id); if (!l) return head('ANUNCIO') + empty('Ya no existe.');
    const m = model(l.modelId), snaps = (l.snaps || []).slice().sort((a, b) => b.at.localeCompare(a.at));
    const lsts = { live: 'Activo', sold: 'Vendido', removed: 'Retirado por Vinted', down: 'Quitado por ti' };
    return head('ANUNCIO · ' + esc(m ? m.name : '').toUpperCase()) + `<table class="xl"><tbody>${tr('Cuenta', esc(l.account))}${tr('Precio', eur(n0(l.price)))}${tr('Publicado', ago(l.listedAt))}${l.renewedAt ? tr('Renovado', ago(l.renewedAt)) : ''}${tr('Estado', lsts[l.status] || l.status, 'tot')}${l.reason ? tr('Motivo', esc(l.reason)) : ''}</tbody></table>
      ${snaps.length ? `<table class="xl list"><thead><tr><th>Stats</th><th class="n">Vistas</th><th class="n">Favs</th><th class="n">Ofer.</th></tr></thead><tbody>${snaps.slice(0, 6).map((z) => `<tr><td>${ago(z.at)}</td><td class="n">${n0(z.views)}</td><td class="n">${n0(z.favs)}</td><td class="n">${n0(z.offers)}${n0(z.best) ? ` · ${n0(z.best)} €` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      ${l.status === 'live' ? `<input type="hidden" id="t-l" value="${esc(l.id)}"><div class="fields4">${fld('t-v', 'Vistas', '', 'inputmode="numeric"')}${fld('t-f', 'Favs', '', 'inputmode="numeric"')}${fld('t-o', 'Ofertas', '', 'inputmode="numeric"')}${fld('t-b', 'Mejor oferta €', '', 'inputmode="decimal"')}</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-snap">Guardar stats</button>
      ${fld('l-price', 'Cambiar precio (€)', String(n0(l.price)).replace('.', ','))}
      <div class="btnrow"><button class="btn-o" data-a="l-price">Guardar precio</button><button class="btn-o" data-a="l-renew">Renovado hoy</button><button class="btn-o" data-a="l-status" data-v="down">Lo quité</button></div>
      ${fld('l-reason', 'Si Vinted lo retiró: motivo', '', 'autocomplete="off" placeholder="Ej. reporte de falsificación"')}<button class="danger" data-a="l-status" data-v="removed">Retirado por Vinted</button>` : `<button class="ghost" data-a="l-status" data-v="live">Volver a activo</button>`}
      <button class="ghost" data-a="del-listing">${st.confirm === 'listings/' + l.id ? 'Pulsa otra vez para borrar' : 'Borrar anuncio'}</button>`;
  }
  if (kind === 'acc') {
    const meta = (S0().accMeta || {})[ctx.name] || {}, main = brain().acc.mainName === ctx.name;
    return head('CUENTA · ' + esc(ctx.name).toUpperCase()) + `<div class="field"><label for="a-st">Estado</label><select id="a-st">${['activa', 'restringida', 'pausada'].map((v) => `<option${(meta.status || 'activa') === v ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      ${fld('a-own', 'De quién es', meta.owner || '', 'autocomplete="off" placeholder="Ej. yo, mi primo"')}
      <label class="check"><input type="checkbox" id="a-main"${main ? ' checked' : ''}> Cuenta principal (solo aquí van los tests)</label>
      <div class="hint">Restringida o pausada = no se le reparte nada. Cada cuenta es de una persona real con sus propios datos.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-acc">Guardar</button>`;
  }
  if (kind === 'planedit') {
    const plan = ctx.plan || S0().plan || {}, months = Object.keys(plan).sort();
    return head('PLAN MENSUAL') + `<div class="hint">Ventas objetivo, mínimo y beneficio objetivo de cada mes.</div><table class="xl list"><thead><tr><th>Mes</th><th class="n">Ventas</th><th class="n">Mín.</th><th class="n">Benef. €</th></tr></thead><tbody>${months.map((mk) => `<tr><td>${MSHORT[pm(mk).m - 1]} ${String(pm(mk).y).slice(2)}</td><td><input class="cell" id="p-s-${mk}" inputmode="numeric" value="${n0(plan[mk].sales)}"></td><td><input class="cell" id="p-m-${mk}" inputmode="numeric" value="${n0(plan[mk].min)}"></td><td><input class="cell" id="p-p-${mk}" inputmode="decimal" value="${n0(plan[mk].profit)}"></td></tr>`).join('')}</tbody></table>
      <button class="ghost" data-a="plan-addmonth">+ Añadir mes</button><div class="err" id="sh-err"></div><button class="primary" data-a="save-plan">Guardar plan</button>`;
  }
  if (kind === 'bill') {
    return head('PAGO FIJO') + fld('b-concept', 'Concepto', '', 'autocomplete="off" placeholder="Ej. Carnet 1/4"') + `<div class="fields2">${fld('b-amt', 'Importe (€)', '')}<div class="field"><label for="b-month">Mes</label><input id="b-month" type="month" value="${curMonth()}"></div></div><div class="err" id="sh-err"></div><button class="primary" data-a="save-bill">Guardar</button>`;
  }
  if (kind === 'goal') {
    return head('NUEVA META') + fld('g-title', 'Nombre de la meta', '', 'autocomplete="off" placeholder="Ej. Primer mes de 1.500 €"') +
      `<div class="field"><label for="g-metric">Qué mide</label><select id="g-metric">${Object.keys(METRICS).map((k) => `<option value="${k}">${METRICS[k]}</option>`).join('')}</select></div>
      <div class="fields2">${fld('g-target', 'Objetivo', '', 'inputmode="decimal" placeholder="1000"')}<div class="field" id="g-th-wrap" hidden><label for="g-th">Beneficio mínimo al mes (€)</label><input id="g-th" inputmode="decimal" placeholder="1500"></div></div>
      <div class="field"><label for="g-dead">Fecha límite (opcional)</label><input id="g-dead" type="month"></div>
      <div class="hint" id="g-hint">Objetivo en euros.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-goal">Guardar</button>`;
  }
  return '';
}
function saleBody(ctx) {
  const ms = sortedModels();
  const pre = ctx.model || (ms.find((m) => n0(m.home) > 0) || ms[0] || {}).id;
  const accs = (S0().accounts || []).concat(['Wallapop']);
  if (!ms.length) return '<div class="empty">Primero crea un reloj en <b>Stock → + Reloj</b>.</div>';
  return `<div class="field"><label for="f-model">Reloj</label><select id="f-model">${ms.map((m) => `<option value="${esc(m.id)}"${m.id === pre ? ' selected' : ''}>${esc(m.name)} · ${n0(m.home)} en casa</option>`).join('')}</select></div>
    <div class="fields2">${fld('f-price', 'Vendido a (€)', '', 'inputmode="decimal" placeholder="30"')}${fld('f-cost', 'Coste del reloj (€)', '')}</div>
    <div class="hint" id="f-esthint"></div>
    <label class="check"><input type="checkbox" id="f-pouch"${lsGet('lg_pouch', '1') === '1' ? ' checked' : ''}> Va con bolsita (${eur(pouchCost())} · quedan ${pouches()})</label>
    <div class="fields2">${dateFld('f-date', ctx.date)}<div class="field"><label for="f-acc">Cuenta</label><select id="f-acc">${accs.map((a) => `<option>${esc(a)}</option>`).join('')}</select></div></div>
    <label class="check"><input type="checkbox" id="f-dec" checked> Restar 1 del stock en casa</label>
    <label class="check"><input type="checkbox" id="f-relist" checked> Lo vuelvo a publicar en la misma cuenta</label>
    <div class="preview"><div class="kv"><span class="mut">Beneficio</span><b id="f-prev">—</b></div><div class="kv"><span class="mut">Va a pendiente en Vinted</span><b id="f-cash">—</b></div></div><div class="err" id="sh-err"></div>
    <button class="primary" data-a="save-sale">Guardar venta</button>`;
}
function orderForm(ctx) {
  const ms = sortedModels().filter((m) => m.status !== 'descartado');
  if (!ctx.lines || !ctx.lines.length) ctx.lines = [{ modelId: (ms[0] || {}).id || '__new', qty: '', unit: '', name: '' }];
  for (const l of ctx.lines) { const m = model(l.modelId); if (m && (l.unit === undefined || l.unit === '') && n0(m.unitPrice)) l.unit = String(m.unitPrice).replace('.', ','); if (m && (l.w === undefined || l.w === '') && n0(m.weight)) l.w = String(m.weight); }
  const opts = (sel) => ms.map((m) => `<option value="${esc(m.id)}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join('') + `<option value="__new"${sel === '__new' ? ' selected' : ''}>+ Reloj nuevo…</option>`;
  const lines = ctx.lines.map((l, i) => `<div class="stack" style="gap:6px"><div class="line-ed">
      <div class="field"><label for="l-m-${i}">${i === 0 ? 'Reloj' : '&nbsp;'}</label><select id="l-m-${i}" data-line="${i}">${opts(l.modelId)}</select></div>
      <div class="field"><label for="l-q-${i}">${i === 0 ? 'Uds' : '&nbsp;'}</label><input id="l-q-${i}" inputmode="numeric" value="${esc(l.qty)}" placeholder="10"></div>
      <div class="field"><label for="l-u-${i}">${i === 0 ? '€/ud 1688' : '&nbsp;'}</label><input id="l-u-${i}" inputmode="decimal" value="${esc(l.unit)}" placeholder="6,50"></div>
      <div class="field"><label for="l-w-${i}">${i === 0 ? 'Peso g' : '&nbsp;'}</label><input id="l-w-${i}" inputmode="numeric" value="${esc(l.w || '')}" placeholder="30"></div>
      <button class="del" data-a="rmline" data-i="${i}" aria-label="Quitar línea" ${ctx.lines.length === 1 ? 'disabled style="opacity:.3"' : ''}>✕</button></div>
      ${l.modelId === '__new' ? `<input id="l-n-${i}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:10px 12px;font-size:15px" placeholder="Nombre del reloj nuevo" value="${esc(l.name)}" autocomplete="off">` : ''}</div>`).join('');
  return `${lines}<div><button class="ghost" data-a="addline">+ Otra línea</button></div>
    <div class="fields2">${fld('o-pq', 'Bolsitas (uds)', ctx.pq || '', 'inputmode="numeric" placeholder="0"')}${fld('o-pu', '€/bolsita en 1688', ctx.pu || '', 'inputmode="decimal" placeholder="0,30"')}</div>
    <div class="fields2"><div class="field"><label for="o-lane">Vía</label><select id="o-lane">${[['dhl', 'DHL (rápido, IVA al llegar)'], ['ddp', 'DDP (barato, impuestos incluidos)']].map(([v, l]) => `<option value="${v}"${(ctx.lane || 'ddp') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>${fld('o-ship', 'Envío del agente (€)', ctx.ship || '', 'inputmode="decimal" placeholder="70"')}</div>
    <div class="fields2">${fld('o-owed', 'Queda por pagar (€)', ctx.owed || '', 'inputmode="decimal" placeholder="0"')}${dateFld('o-date', ctx.date)}</div>
    ${fld('o-note', 'Nota (opcional)', ctx.note || '', 'autocomplete="off" placeholder="Ej. caja DHL 4 kg"')}
    <div class="preview" id="o-prev"></div>
    <div class="hint">Lo que pagas hoy (relojes + envío) sale de la caja ya. El cobro de DHL lo apuntas al recibirlo.</div>
    <div class="err" id="sh-err"></div><button class="primary" data-a="save-order">Guardar pedido</button>`;
}
function spendBody(ctx) {
  const kind = ctx.kind || 'personal', cat = ctx.cat || CATS[kind][0];
  return `<div class="seg sm"><button data-a="kind" data-v="personal" aria-pressed="${kind === 'personal'}">Personal</button><button data-a="kind" data-v="negocio" aria-pressed="${kind === 'negocio'}">Negocio</button></div>
    ${fld('x-amt', 'Importe (€)', ctx.amt || '', 'inputmode="decimal" placeholder="12"')}
    <div class="field"><span class="lb">Categoría</span><div class="chips">${CATS[kind].map((c) => `<button class="chip" data-a="cat" data-v="${esc(c)}" aria-pressed="${c === cat}">${esc(c)}</button>`).join('')}</div></div>
    <div class="fields2">${fld('x-note', 'Nota (opcional)', ctx.note || '', 'autocomplete="off"')}${dateFld('x-date', ctx.date)}</div>
    ${kind === 'negocio' ? '<div class="hint">Los pedidos de stock van en "Pedido", no aquí.</div>' : ''}
    <div class="err" id="sh-err"></div><button class="primary" data-a="save-spend">Guardar gasto</button>`;
}
function incomeBody(ctx) {
  return `${fld('i-amt', 'Importe (€)', '', 'inputmode="decimal" placeholder="50"')}<div class="fields2">${fld('i-note', 'De dónde viene', '', 'autocomplete="off" placeholder="Ej. cliente QooMedia"')}${dateFld('i-date', ctx.date)}</div>
    <div class="hint">Dinero que entra y no es una venta de reloj. Suma a la caja, no al beneficio de relojes.</div><div class="err" id="sh-err"></div><button class="primary" data-a="save-income">Guardar ingreso</button>`;
}
const POUCH_G = 10;
// Landed cost per unit: shipping split by weight when every watch in the box has a weight (else by value),
// the DHL/IVA charge on arrival split by value. Before arrival, a DHL box is estimated with 21% IVA on top.
function allocLanded(lines, pq, pu, ship, dhl, ivaEst) {
  const goods = sum(lines.map((l) => l.qty * l.unit)) + pq * pu;
  const ws = lines.map((l) => n0(l.w) || n0((model(l.modelId) || {}).weight));
  const byW = lines.length > 0 && ws.every((w) => w > 0);
  const totW = byW ? sum(lines.map((l, i) => l.qty * ws[i])) + pq * POUCH_G : 0;
  const share = (val, w) => (byW ? ship * w / totW : goods ? ship * val / goods : 0) + (goods ? dhl * val / goods : 0);
  const per = {};
  lines.forEach((l, i) => {
    const val = l.qty * l.unit, tot = (val + share(val, l.qty * ws[i])) * (ivaEst ? 1.21 : 1);
    const k = l.modelId; per[k] = per[k] || { qty: 0, tot: 0 }; per[k].qty += l.qty; per[k].tot += tot;
  });
  for (const k in per) per[k].landed = r2(per[k].tot / per[k].qty);
  const pouch = pq ? r2((pq * pu + share(pq * pu, pq * POUCH_G)) * (ivaEst ? 1.21 : 1) / pq) : 0;
  return { per, pouch, byW, kg: totW / 1000, goods };
}
function modelAnalysis(id) {
  const r = stockOf(id), m = model(id); if (!r || !m) return '';
  const d = r.d, live = liveOf(id), tnd = d.prev7 ? Math.round(d.trend * 100) : null;
  const arr = r.arrivals.map((a) => `${a.qty} uds ${LANE[a.lane]} ~${shortDate(a.eta)}`).join(' · ');
  return `<div class="eyebrow">Análisis</div><div class="verdict ${(SST[r.status] || [])[1] || ''}"><b>${(SST[r.status] || ['—'])[0]}</b><span>${esc(r.why || 'stock correcto para tu ritmo')}</span></div>
    <table class="xl"><tbody>
    ${tr('Ventas últimos 7 días', d.last7 + (tnd !== null ? ` <span class="sub" style="display:inline">· ${tnd >= 0 ? '+' : ''}${tnd}% vs 7 anteriores</span>` : ''))}
    ${tr('Ventas totales', d.total)}
    ${tr('Ritmo', rate1(r.rate) + '/día')}
    ${r.rate ? tr('Días de stock en casa', days1(r.coverHome) + (r.outDate ? ` <span class="sub" style="display:inline">· se acaba ~${shortDate(r.outDate)}</span>` : '')) : ''}
    ${r.rate ? tr('Con lo que viene', days1(r.coverAll) + ' días') : ''}
    ${arr ? tr('En camino', arr) : ''}
    ${r.rate ? tr('Pedir cuando queden', Math.ceil(r.rop) + ' uds <span class="sub" style="display:inline">· colchón ' + r.safety + '</span>') : ''}
    ${r.qty ? tr('Pedir ahora', `<b>${r.bridge ? `DHL ${r.bridge}` : ''}${r.bridge && r.ddpQty ? ' + ' : ''}${r.ddpQty ? `DDP ${r.ddpQty}` : ''}</b>`, 'tot') : ''}
    ${tr('Beneficio por venta', money(r.unitProfit, true))}
    ${r.rate ? tr('Beneficio por día', money(r.profitDay, true)) : ''}
    ${r.home ? tr('Dinero en stock', eur(r.capital)) : ''}
    ${tr('Anuncios activos', live.length ? live.map((l) => esc(l.account)).join(', ') : '<span class="warn">ninguno</span>')}
    </tbody></table>
    <div class="btnrow"><button class="btn-o" data-a="newlisting" data-id="${esc(id)}">+ Anuncio publicado</button>${r.qty ? `<button class="btn-g" data-a="order-model" data-id="${esc(id)}">Pedir ${r.qty}</button>` : ''}</div>`;
}
// Same watch saved twice: move everything (sales, listings, order lines, stock) into one and delete the other.
function mergeBlock(id) {
  const m = model(id), others = sortedModels().filter((z) => z.id !== id);
  if (!m || !others.length) return '';
  const dup = B.possibleDupes(L('models'), S0().notDupes || []).find((d) => d.a.id === id || d.b.id === id), twin = dup ? (dup.a.id === id ? dup.b : dup.a) : null;
  const nS = L('sales').filter((v) => v.modelId === id).length, c = st.confirm === 'merge/' + id;
  return `<div class="eyebrow">Fusionar</div>${twin ? `<div class="verdict warn"><b>¿Es el mismo que ${esc(twin.name)}?</b><span>Si lo es, fusiónalos: sus ventas cuentan juntas para el stock.</span><span class="btnrow"><button class="btn-o" data-a="not-dupe" data-id="${esc(id)}" data-v="${esc(twin.id)}">No es el mismo</button></span></div>` : ''}
    <div class="hint">Pasa ${nS} venta${nS === 1 ? '' : 's'}, anuncios, pedidos y stock de <b>${esc(m.name)}</b> al reloj que elijas, y borra este.</div>
    <div class="fields2"><div class="field"><label for="m-merge">Fusionar en</label><select id="m-merge">${others.map((z) => `<option value="${esc(z.id)}"${twin && z.id === twin.id ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button class="btn-o" data-a="merge-model" style="padding:10px">${c ? 'Pulsa otra vez' : 'Fusionar'}</button></div></div>`;
}
async function mergeModel(srcId, dstId) {
  const a = model(srcId), b = model(dstId); if (!a || !b || a.id === b.id) return false;
  for (const v of L('sales').filter((x) => x.modelId === a.id)) await db.patch(C.sales, v.id, { modelId: b.id, modelName: b.name, mergedFrom: a.name });
  for (const l of L('listings').filter((x) => x.modelId === a.id)) await db.patch(C.listings, l.id, { modelId: b.id });
  for (const o of L('orders').filter((x) => (x.lines || []).some((l) => l.modelId === a.id))) await db.patch(C.orders, o.id, { lines: o.lines.map((l) => (l.modelId === a.id ? { ...l, modelId: b.id, name: b.name } : l)) });
  const p = { home: n0(b.home) + n0(a.home), transit: n0(b.transit) + n0(a.transit), alias: [b.alias, a.name].filter(Boolean).join(' · ') };
  for (const k of ['landed', 'landedSrc', 'listPrice', 'minPrice', 'unitPrice', 'weight', 'testStart']) if ((b[k] === undefined || b[k] === null || b[k] === '') && a[k] !== undefined && a[k] !== null && a[k] !== '') p[k] = a[k];
  if (a.status === 'ganador' && b.status !== 'descartado') p.status = 'ganador';
  if (n0(a.base14) || n0(b.base14)) { p.base14 = n0(a.base14) + n0(b.base14); p.baseAt = [a.baseAt, b.baseAt].filter(Boolean).sort().pop(); }
  await db.patch(C.models, b.id, p);
  await db.remove(C.models, a.id);
  return true;
}
// Unit cost from the last order of each watch: 1688 price + its share of shipping (by weight) + DHL/IVA (by value).
const latestOrderOf = (mid) => L('orders').filter((o) => !o.draft && (o.lines || []).some((l) => l.modelId === mid)).sort((a, b) => (b.date + (b.at || '')).localeCompare(a.date + (a.at || '')))[0] || null;
function landedFromOrder(o) {
  const lines = (o.lines || []).map((l) => ({ modelId: l.modelId, qty: n0(l.qty), unit: n0(l.unit) }));
  if (!lines.length || lines.some((l) => !(l.unit > 0) || !(l.qty > 0))) return null;
  const rec = o.status === 'recibido', pq = o.pouches ? n0(o.pouches.qty) : 0, pu = o.pouches ? n0(o.pouches.unit) : 0;
  const al = allocLanded(lines, pq, pu, n0(o.shipping), rec ? n0(o.dhl) : 0, !rec && o.lane === 'dhl');
  const kinds = new Set(lines.map((l) => l.modelId)).size;
  // real = nothing left to pay on arrival (DDP, or received) and shipping split by weight (or only one watch in the box)
  al.src = (rec || o.lane !== 'dhl') && (al.byW || kinds === 1) ? 'real' : 'estimado';
  return al;
}
async function recalcOrder(o) {
  const al = o && landedFromOrder(o); if (!al) return;
  for (const id in al.per) { const m = model(id); if (!m) continue; const lo = latestOrderOf(id); if (lo && lo.id !== o.id) continue; await db.patch(C.models, id, { landed: al.per[id].landed, landedSrc: al.src, landedOrder: o.id }); }
}
function readLines() {
  const c = st.sheet.ctx;
  c.lines = c.lines.map((l, i) => {
    const mid = sv('l-m-' + i) || l.modelId, changed = mid !== l.modelId;
    if (changed) for (const k of ['l-u-', 'l-w-']) { const e = sheetEl.querySelector('#' + k + i); if (e) e.value = ''; }
    // another watch picked on this line: its own 1688 price and weight get filled in again
    return { modelId: mid, qty: sv('l-q-' + i), unit: changed ? '' : sv('l-u-' + i), w: changed ? '' : sheetEl.querySelector('#l-w-' + i) ? sv('l-w-' + i) : l.w, name: sheetEl.querySelector('#l-n-' + i) ? sv('l-n-' + i) : l.name };
  });
  c.ship = sv('o-ship'); c.date = sv('o-date'); c.note = sv('o-note'); c.pq = sv('o-pq'); c.pu = sv('o-pu'); c.lane = sv('o-lane') || c.lane; c.owed = sv('o-owed');
  return c.lines;
}
function orderPreview() {
  const box = sheetEl.querySelector('#o-prev'); if (!box) return;
  const lines = readLines(), ship = n0(sv('o-ship')), pq = n0(sv('o-pq')), pu = n0(sv('o-pu')), pg = pq * pu, lane = sv('o-lane'), owed = n0(sv('o-owed'));
  const ls = lines.filter((l) => n0(l.qty) && n0(l.unit)).map((l) => ({ modelId: l.modelId, qty: n0(l.qty), unit: n0(l.unit), w: n0(l.w), name: l.name }));
  const wgoods = sum(ls.map((l) => l.qty * l.unit)), goods = wgoods + pg, units = sum(lines.map((l) => n0(l.qty)));
  const al = allocLanded(ls, pq, pu, ship, 0, lane === 'dhl'), now = goods + ship - owed, iva = lane === 'dhl' ? 0.21 * (goods + ship) : 0;
  box.innerHTML = `<div class="kv"><span class="mut">Relojes</span><b>${units} uds · ${eur(wgoods)}</b></div>${pg ? `<div class="kv"><span class="mut">Bolsitas</span><b>${pq} uds · ${eur(pg)}</b></div>` : ''}${al.byW ? `<div class="kv"><span class="mut">Peso de la caja</span><b>${(al.kg + 0.4).toFixed(2).replace('.', ',')} kg aprox.</b></div>` : ''}
    <div class="kv"><span class="mut">Pagas hoy</span><b class="neg">${eur(now)}</b></div>${owed ? `<div class="kv"><span class="mut">Debes después</span><b class="neg">${eur(owed)}</b></div>` : ''}${iva ? `<div class="kv"><span class="mut">Al llegar: IVA 21% + gestión DHL</span><b class="warn">≈ ${eur(iva)} + gestión</b></div>` : ''}
    <div class="kv"><span class="mut">Banco después</span><b class="${bankNow() - now < 0 ? 'neg' : ''}">${eur(bankNow() - now)}</b></div>
    ${ls.map((l) => { const m = model(l.modelId), p = al.per[l.modelId]; return p ? `<div class="kv"><span class="mut">Coste/ud ${esc(m ? m.name : l.name || 'nuevo')}${al.byW ? '' : ' (sin peso: envío por valor)'}</span><b>≈ ${eur(p.landed)}</b></div>` : ''; }).join('')}`;
}
function afterSheet() {
  const sel = sheetEl.querySelector('#f-model');
  if (sel) {
    const prev = () => {
      const p = num(sv('f-price')), c = num(sv('f-cost')) + ($('#f-pouch', sheetEl).checked ? pouchCost() : 0), o = $('#f-prev', sheetEl), k = $('#f-cash', sheetEl);
      k.textContent = isNaN(p) ? '—' : eur(p, true); k.className = isNaN(p) ? '' : 'pos';
      if (isNaN(p) || isNaN(c)) { o.textContent = '—'; o.className = ''; return; }
      o.textContent = eur(p - c, true); o.className = cls(p - c);
    };
    const sync_ = () => {
      const m = model(sel.value), c = $('#f-cost', sheetEl);
      c.value = m ? String(costOf(m)).replace('.', ',') : '';
      $('#f-esthint', sheetEl).textContent = isEst(m) ? 'Coste estimado (no sabes el exacto de este reloj). Cámbialo si lo sabes.' : '';
      $('#f-dec', sheetEl).checked = !!m && n0(m.home) > 0; prev();
    };
    sel.addEventListener('change', sync_);
    $('#f-price', sheetEl).addEventListener('input', prev); $('#f-cost', sheetEl).addEventListener('input', prev); $('#f-pouch', sheetEl).addEventListener('change', prev);
    sync_();
  }
  if (sheetEl.querySelector('#o-prev')) {
    sheetEl.querySelectorAll('[id^="l-m-"]').forEach((s) => s.addEventListener('change', () => { readLines(); redrawSheet(); }));
    sheetEl.querySelector('#sh-body').addEventListener('input', orderPreview);
    orderPreview();
  }
  const rp = sheetEl.querySelector('#r-prev');
  if (rp) {
    const o = db.get(C.orders, st.sheet.ctx.id) || {};
    const up = () => {
      const dhl = n0(sv('r-dhl')), pq = o.pouches ? n0(o.pouches.qty) : 0, pu = o.pouches ? n0(o.pouches.unit) : 0;
      const al = allocLanded((o.lines || []).map((l) => ({ modelId: l.modelId, qty: n0(l.qty), unit: n0(l.unit) })), pq, pu, n0(o.shipping), dhl, false);
      rp.innerHTML = `<div class="kv"><span class="mut">Coste total del pedido</span><b>${eur(orderCost(o) + dhl)}</b></div>` + Object.keys(al.per).map((id) => { const m = model(id); return `<div class="kv"><span class="mut">Coste puesto ${esc(m ? m.name : '')}</span><b>${eur(al.per[id].landed)}</b></div>`; }).join('');
    };
    sheetEl.querySelector('#r-dhl').addEventListener('input', up); up();
  }
  const it = sheetEl.querySelector('#imp-txt');
  if (it) {
    const up = () => { st.sheet.ctx.txt = it.value; $('#imp-prev', sheetEl).innerHTML = importPreview(it.value); labelTables(sheetEl); };
    it.addEventListener('input', up);
    $('#imp-file', sheetEl).addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; if (f) { it.value = await f.text(); up(); } });
  }
  const gm = sheetEl.querySelector('#g-metric');
  if (gm) {
    const up = () => { const v = gm.value; $('#g-th-wrap', sheetEl).hidden = v !== 'streak'; $('#g-hint', sheetEl).textContent = v === 'streak' ? 'Objetivo en meses seguidos (ej. 2).' : v === 'units' ? 'Objetivo en relojes vendidos.' : 'Objetivo en euros.'; };
    gm.addEventListener('change', up); up();
  }
}

/* ---------------- writes ---------------- */
function toast(t) { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { toastEl.hidden = true; }, 2000); }
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
async function saveSale() {
  const m = model(sv('f-model')), price = num(sv('f-price')), cost = num(sv('f-cost')), date = sv('f-date');
  if (!m) return shErr('Elige un reloj.');
  if (isNaN(price) || price <= 0) return shErr('Pon el precio al que lo vendiste.');
  if (isNaN(cost) || cost < 0) return shErr('Pon el coste puesto. Sin él no se puede calcular el beneficio.');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  const dec = $('#f-dec', sheetEl).checked && n0(m.home) > 0;
  const withPouch = $('#f-pouch', sheetEl).checked, extra = withPouch ? pouchCost() : 0, pouchFromStock = withPouch && pouches() > 0, est = isEst(m) && r2(cost) === r2(n0(S0().defaultCost));
  const acc = sv('f-acc');
  const lst = L('listings').filter((l) => l.modelId === m.id && l.account === acc && l.status === 'live').sort((a, b) => a.listedAt.localeCompare(b.listedAt))[0];
  const sale = await db.put(C.sales, { date, at: nowISO(), modelId: m.id, modelName: m.name, price: r2(price), cost: r2(cost + extra), watchCost: r2(cost), extra: r2(extra), estimated: est, profit: r2(price - cost - extra), account: acc, fromStock: dec, pouch: withPouch, pouchFromStock, listingId: lst ? lst.id : null });
  if (lst) {
    await db.patch(C.listings, lst.id, { status: 'sold', endedAt: nowISO(), saleId: sale.id });
    if ($('#f-relist', sheetEl).checked && n0(m.home) - (dec ? 1 : 0) > 0) await db.put(C.listings, { modelId: m.id, account: acc, price: lst.price, listedAt: nowISO(), status: 'live', snaps: [], relistOf: lst.id });
  }
  lsSet('lg_pouch', withPouch ? '1' : '0');
  if (pouchFromStock) await patchSettings({ pouches: pouches() - 1 });
  const patch = {}; if (dec) patch.home = n0(m.home) - 1; if (isNaN(num(m.landed)) && !est) patch.landed = r2(cost);
  if (Object.keys(patch).length) await db.patch(C.models, m.id, patch);
  closeSheet(); st.selDay = date; st.month = date.slice(0, 7); toast('Venta guardada · ' + eur(price - cost - extra, true));
}
async function saveOrder() {
  const lines = readLines(), ship = num(sv('o-ship')), date = sv('o-date');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  const pq = parseInt(sv('o-pq'), 10) || 0, pu = num(sv('o-pu'));
  if (pq > 0 && !(pu > 0)) return shErr('Pon el precio por bolsita.');
  const used = lines.filter((l) => String(l.qty).trim() || String(l.unit).trim() || (l.modelId === '__new' && l.name));
  if (!used.length && !pq) return shErr('Añade al menos un reloj o bolsitas.');
  lines.length = 0; used.forEach((l) => lines.push(l));
  for (const l of lines) {
    if (l.modelId === '__new' && !l.name) return shErr('Ponle nombre al reloj nuevo.');
    if (!(parseInt(l.qty, 10) > 0)) return shErr('Pon cuántas unidades de cada reloj.');
    if (!(num(l.unit) > 0)) return shErr('Pon el precio por unidad de 1688 de cada línea.');
    if (!(num(l.w) > 0)) return shErr('Pon el peso (g, con bolsa) de cada reloj: el envío se reparte por peso.');
  }
  const out = [];
  for (const l of lines) {
    let mid = l.modelId;
    if (mid === '__new') { const m = await db.put(C.models, { name: l.name, status: 'test', home: 0, transit: 0, order: L('models').length + 1 }); mid = m.id; }
    await db.patch(C.models, mid, { weight: Math.round(num(l.w)), unitPrice: r2(num(l.unit)) });
    const m = model(mid);
    out.push({ modelId: mid, name: m ? m.name : l.name, qty: parseInt(l.qty, 10), unit: r2(num(l.unit)) });
  }
  const goods = r2(sum(out.map((l) => l.qty * l.unit)) + (pq ? pq * pu : 0)), sh = isNaN(ship) ? 0 : r2(ship), lane = sv('o-lane') === 'dhl' ? 'dhl' : 'ddp';
  const owed = Math.min(goods + sh, Math.max(0, r2(n0(sv('o-owed'))))), al = allocLanded(out, pq, pq ? pu : 0, sh, 0, lane === 'dhl');
  const o = await db.put(C.orders, { date, at: nowISO(), note: sv('o-note'), lane, lines: out, pouches: pq ? { qty: pq, unit: r2(pu) } : null, goods, shipping: sh, paid: r2(goods + sh - owed), owed: r2(owed), payments: [], dhl: 0, status: 'camino' });
  const lf = landedFromOrder(o);
  for (const id in al.per) { const m = model(id); const l = out.find((z) => z.modelId === id); await db.patch(C.models, id, { transit: n0(m && m.transit) + al.per[id].qty, landed: al.per[id].landed, landedSrc: lf ? lf.src : 'estimado', landedOrder: o.id, unitPrice: l.unit }); }
  closeSheet(); st.tab = 'stock'; st.stockSeg = 'pedidos'; lsSet('lg_seg', 'pedidos'); location.hash = 'stock'; renderSoon(); toast('Pedido guardado · −' + eur(goods + sh - owed) + ' de caja' + (owed ? ' · debes ' + eur(owed) : ''));
}
async function saveReceive() {
  const o = db.get(C.orders, st.sheet.ctx.id); if (!o) return closeSheet();
  const dhl = num(sv('r-dhl')), date = sv('r-date');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  const d = isNaN(dhl) ? 0 : r2(dhl);
  const pq = o.pouches ? n0(o.pouches.qty) : 0, pu = o.pouches ? n0(o.pouches.unit) : 0;
  const al = allocLanded((o.lines || []).map((l) => ({ modelId: l.modelId, qty: n0(l.qty), unit: n0(l.unit) })), pq, pu, n0(o.shipping), d, false);
  await db.patch(C.orders, o.id, { status: 'recibido', dhl: d, receivedDate: date, receivedAt: nowISO() });
  for (const id in al.per) { const m = model(id); if (!m) continue; await db.patch(C.models, id, { transit: Math.max(0, n0(m.transit) - al.per[id].qty), home: n0(m.home) + al.per[id].qty, landed: al.per[id].landed, landedSrc: al.byW || Object.keys(al.per).length === 1 ? 'real' : 'estimado', landedOrder: o.id }); }
  if (pq) await patchSettings({ pouches: pouches() + pq, pouchCost: al.pouch });
  closeSheet(); toast('Recibido · pasado a casa');
}
async function saveSpend() {
  const amt = num(sv('x-amt')), date = sv('x-date'), c = st.sheet.ctx, kind = c.kind || 'personal';
  if (isNaN(amt) || amt <= 0) return shErr('Pon el importe.');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  await db.put(C.spend, { date, at: nowISO(), amount: r2(amt), kind, cat: c.cat || CATS[kind][0], note: sv('x-note') });
  closeSheet(); toast('Gasto guardado · −' + eur(amt));
}
async function saveIncome() {
  const amt = num(sv('i-amt')), date = sv('i-date');
  if (isNaN(amt) || amt <= 0) return shErr('Pon el importe.');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  await db.put(C.income, { date, at: nowISO(), amount: r2(amt), note: sv('i-note') });
  closeSheet(); toast('Ingreso guardado · ' + eur(amt, true));
}
async function saveModel() {
  const id = st.sheet.ctx.id, name = sv('m-name');
  if (!name) return shErr('Ponle un nombre.');
  const opt = (v) => { const x = num(v); return isNaN(x) ? null : r2(x); };
  const data = { name, status: sv('m-status'), landed: opt(sv('m-landed')), listPrice: opt(sv('m-list')), minPrice: opt(sv('m-min')), unitPrice: opt(sv('m-unit')), weight: opt(sv('m-w')), home: Math.max(0, Math.round(n0(sv('m-home')))), transit: Math.max(0, Math.round(n0(sv('m-transit')))) };
  const old = id ? model(id) || {} : {};
  let note = 'Guardado';
  if (data.status === 'ganador' && old.status !== 'ganador' && !B.proofOf({ ...old, id }, L('sales').filter((x) => !x.cancelled), L('listings')).ok) { data.status = 'test'; note = 'Guardado como Test: ganador con 1 venta o 2 ofertas'; }
  if (id && data.landed !== null && r2(n0(old.landed)) !== data.landed) data.landedSrc = 'manual';
  if (id) await db.patch(C.models, id, data);
  else await db.put(C.models, { ...data, order: L('models').length + 1 });
  // new weight or 1688 price → redo the cost split of its last order (the other watches in that box change too)
  if (id && (n0(old.weight) !== n0(data.weight) || n0(old.unitPrice) !== n0(data.unitPrice))) {
    const o = latestOrderOf(id);
    if (o && data.unitPrice) { await db.patch(C.orders, o.id, { lines: o.lines.map((l) => (l.modelId === id && !(n0(l.unit) > 0) ? { ...l, unit: data.unitPrice } : l)) }); await recalcOrder(db.get(C.orders, o.id)); }
  }
  closeSheet(); toast(note);
}
async function saveSettings() {
  const cash = num(sv('s-cash')), cush = num(sv('s-cushion')), g = num(sv('s-goal'));
  if (isNaN(cash)) return shErr('Pon el dinero que tienes ahora.');
  if (isNaN(g) || g <= 0) return shErr('Pon tu meta mensual.');
  const accs = sv('s-acc').split(',').map((s) => s.trim()).filter(Boolean);
  const dc = num(sv('s-defcost')), pc = num(sv('s-pouchcost')), pq = num(sv('s-pouches'));
  const cur = S0(), patch = { cushion: isNaN(cush) ? 0 : r2(cush), monthlyGoal: r2(g), defaultCost: isNaN(dc) ? 10 : r2(dc), pouchCost: isNaN(pc) ? 0 : r2(pc), pouches: isNaN(pq) ? 0 : Math.max(0, Math.round(pq)), accounts: accs.length ? accs : cur.accounts };
  const int = (id, d) => { const v = Math.round(num(sv(id))); return isNaN(v) || v <= 0 ? d : v; };
  Object.assign(patch, { pendingDays: int('s-pend', B.FALLBACK.pendingDays), testBench: int('s-bench', B.FALLBACK.bench), maxAccPerModel: int('s-maxacc', B.FALLBACK.maxAccPerModel), cycleDays: int('s-cycle', B.FALLBACK.cycleDays), leadDHL: int('s-ldhl', B.FALLBACK.leadDHL), leadDDP: int('s-lddp', B.FALLBACK.leadDDP) });
  if (r2(cash) !== r2(bankNow())) { patch.cash = r2(cash); patch.cashAt = nowISO(); }
  const vb = {}; let vChanged = false;
  for (const a of acctNames()) { const v = num(sv('s-vb-' + a.replace(/\W/g, '_'))); vb[a] = isNaN(v) ? r2(vintedBalance(a)) : r2(v); if (vb[a] !== r2(vintedBalance(a))) vChanged = true; }
  if (vChanged) { patch.vbal = vb; patch.vbalAt = nowISO(); }
  await db.put(C.settings, { ...(db.get(C.settings, 'settings') || DEF), ...patch, id: 'settings' });
  closeSheet(); toast('Guardado');
}
async function saveBill() {
  const c = sv('b-concept'), a = num(sv('b-amt')), m = sv('b-month');
  if (!c) return shErr('Pon el concepto.'); if (isNaN(a) || a <= 0) return shErr('Pon el importe.'); if (!/^\d{4}-\d{2}$/.test(m)) return shErr('Elige el mes.');
  await db.put(C.bills, { concept: c, amount: r2(a), month: m, paid: false });
  closeSheet(); toast('Pago añadido');
}
async function saveGoal() {
  const t = sv('g-title'), me = sv('g-metric'), tg = num(sv('g-target')), th = num(sv('g-th')), dl = sv('g-dead');
  if (!t) return shErr('Ponle un nombre.'); if (isNaN(tg) || tg <= 0) return shErr('Pon el objetivo.');
  if (me === 'streak' && (isNaN(th) || th <= 0)) return shErr('Pon el beneficio mínimo de cada mes.');
  const d = { title: t, metric: me, target: r2(tg), order: L('goals').length + 1 };
  if (me === 'streak') d.threshold = r2(th); if (/^\d{4}-\d{2}$/.test(dl)) d.deadline = dl;
  await db.put(C.goals, d); closeSheet(); toast('Meta creada');
}
async function togglePaid(id) {
  const b = db.get(C.bills, id); if (!b) return;
  if (!b.paid) {
    const s = await db.put(C.spend, { date: todayKey(), at: nowISO(), amount: n0(b.amount), kind: 'personal', cat: 'Pagos fijos', note: b.concept, billId: b.id });
    await db.patch(C.bills, id, { paid: true, spendId: s.id }); toast('Pagado · −' + eur(n0(b.amount)) + ' de caja');
  } else {
    if (b.spendId) await db.remove(C.spend, b.spendId);
    await db.patch(C.bills, id, { paid: false, spendId: null });
  }
}
async function del(col, id) {
  if (col === 'sales') {
    const s = db.get(C.sales, id); await db.remove(C.sales, id);
    const ls = s && s.listingId && db.get(C.listings, s.listingId);
    if (ls && ls.saleId === id) {
      const re = L('listings').find((l) => l.relistOf === ls.id && !(l.snaps || []).length);
      if (re) await db.remove(C.listings, re.id);
      await db.patch(C.listings, ls.id, { status: 'live', endedAt: null, saleId: null });
    }
    const m = s && s.fromStock && model(s.modelId); if (m) await db.patch(C.models, m.id, { home: n0(m.home) + 1 });
    if (s && s.pouchFromStock) await patchSettings({ pouches: pouches() + 1 });
    toast(m ? 'Venta borrada · +1 al stock' : 'Venta borrada'); return;
  }
  if (col === 'orders') {
    const o = db.get(C.orders, id); await db.remove(C.orders, id);
    if (o && o.status !== 'recibido') for (const l of o.lines || []) { const m = model(l.modelId); if (m) await db.patch(C.models, m.id, { transit: Math.max(0, n0(m.transit) - n0(l.qty)) }); }
    toast('Pedido borrado'); return;
  }
  if (col === 'spend') { const x = db.get(C.spend, id); if (x && x.billId) await db.patch(C.bills, x.billId, { paid: false, spendId: null }); }
  if (col === 'bills') { const b = db.get(C.bills, id); if (b && b.spendId) await db.remove(C.spend, b.spendId); }
  await db.remove(C[col], id); toast('Borrado');
}
async function saveCatchup() {
  const t = todayKey();
  for (const m of L('models').filter((z) => z.status !== 'descartado')) {
    const h = sv('cu-h-' + m.id), sd = sv('cu-s-' + m.id), a = sv('cu-a-' + m.id), p = {};
    if (h !== '' && Math.round(n0(h)) !== n0(m.home)) p.home = Math.max(0, Math.round(n0(h)));
    if (sd !== '') { p.base14 = Math.max(0, Math.round(n0(sd))); p.baseAt = t; }
    if (Object.keys(p).length) await db.patch(C.models, m.id, p);
    if (a) await db.put(C.listings, { modelId: m.id, account: a, price: n0(m.listPrice) || 34.95, listedAt: nowISO(), status: 'live', snaps: [] });
  }
  closeSheet(); toast('Al día · los cálculos ya usan tus números reales');
}
async function saveSnap() {
  const id = sv('t-l'), l = db.get(C.listings, id); if (!l) return shErr('Elige el anuncio.');
  const v = num(sv('t-v')), f = num(sv('t-f')), o = num(sv('t-o')), b = num(sv('t-b'));
  if (isNaN(v) || v < 0) return shErr('Pon las vistas que ves en Vinted.');
  if (!isNaN(f) && f > v) return shErr('Más favoritos que vistas: revisa los números.');
  const snap = { at: nowISO(), views: Math.round(v), favs: isNaN(f) ? 0 : Math.round(f), offers: isNaN(o) ? 0 : Math.round(o), best: isNaN(b) ? 0 : r2(b) };
  await db.patch(C.listings, id, { snaps: [...(l.snaps || []), snap] });
  toast('Stats guardadas'); redrawSheet();
}
async function saveNewTest() {
  const name = sv('n-name'); if (!name) return shErr('Ponle un nombre.');
  const opt = (v) => { const x = num(v); return isNaN(x) ? null : r2(x); };
  const price = opt(sv('n-price')) || 34.95, home = Math.max(0, Math.round(n0(sv('n-home'))));
  const m = await db.put(C.models, { name, status: 'test', home, transit: 0, unitPrice: opt(sv('n-unit')), weight: opt(sv('n-w')), listPrice: price, landed: opt(sv('n-cost')), order: L('models').length + 1 });
  if ($('#n-live', sheetEl).checked) await db.put(C.listings, { modelId: m.id, account: sv('n-acc'), price, listedAt: nowISO(), status: 'live', snaps: [] });
  closeSheet(); setTab('tests'); toast('Test empezado · stats a las 24h');
}
async function saveListing() {
  const m = model(sv('w-m')); if (!m) return shErr('Elige el reloj.');
  const price = num(sv('w-price')); if (isNaN(price) || price <= 0) return shErr('Pon el precio.');
  await db.put(C.listings, { modelId: m.id, account: sv('w-acc'), price: r2(price), listedAt: nowISO(), status: 'live', snaps: [] });
  if (isNaN(num(m.listPrice))) await db.patch(C.models, m.id, { listPrice: r2(price) });
  closeSheet(); toast('Anuncio apuntado');
}
async function saveAcc() {
  const name = st.sheet.ctx.name, meta = { ...(S0().accMeta || {}) };
  const isMain = $('#a-main', sheetEl).checked;
  if (isMain) for (const k in meta) meta[k] = { ...meta[k], main: false };
  meta[name] = { ...(meta[name] || {}), status: sv('a-st') || 'activa', owner: sv('a-own'), main: isMain };
  await patchSettings({ accMeta: meta }); closeSheet(); toast('Cuenta guardada');
}
function readPlan() {
  const base = st.sheet.ctx.plan || S0().plan || {}, out = {};
  for (const mk of Object.keys(base)) {
    const g = (k) => { const e = sheetEl.querySelector(`#p-${k}-${mk}`); return e ? n0(e.value) : n0(base[mk][{ s: 'sales', m: 'min', p: 'profit' }[k]]); };
    out[mk] = { ...base[mk], sales: Math.round(g('s')), min: Math.round(g('m')), profit: r2(g('p')) };
  }
  return out;
}
async function savePlan() { await patchSettings({ plan: readPlan() }); closeSheet(); toast('Plan guardado'); }
async function saveDebt() {
  const o = db.get(C.orders, st.sheet.ctx.id); if (!o) return closeSheet();
  const a = num(sv('d-amt')); if (isNaN(a) || a <= 0) return shErr('Pon cuánto pagas.');
  const amt = Math.min(r2(a), n0(o.owed));
  await db.patch(C.orders, o.id, { owed: r2(n0(o.owed) - amt), payments: [...payments(o), { at: nowISO(), date: todayKey(), amount: amt }] });
  toast('Pagado ' + eur(amt) + ' · −' + eur(amt) + ' de caja'); redrawSheet();
}
function openOrderFor(lines, lane) {
  openSheet('add', { mode: 'pedido', lane, lines: lines.map((l) => { const m = model(l.modelId), u = (m && m.unitPrice) || lastUnitPrice(l.modelId); return { modelId: l.modelId, qty: String(l.qty), unit: u ? String(u).replace('.', ',') : '', name: '' }; }) });
}
async function listingsOf(mid, acc) { return L('listings').filter((l) => l.modelId === mid && l.status === 'live' && (!acc || l.account === acc)); }

// Everything Claude needs to manage the business, in one paste.
async function saveWithdraw() {
  const amt = num(sv('w-amt')), acc = sv('w-acc2'), date = sv('w-date');
  if (isNaN(amt) || amt <= 0) return shErr('Pon el importe.');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  await db.put(C.transfers, { date, at: nowISO(), amount: r2(amt), account: acc });
  closeSheet(); toast('Retiro guardado · +' + eur(amt) + ' al banco');
}
async function releaseSale(id) { const x = db.get(C.sales, id); if (x) await db.patch(C.sales, id, { released: true, releasedAt: nowISO() }); }
function exportForClaude() {
  const snap = agent.snapshot() || {}, bz = brain(), e2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const months = [shiftMonth(curMonth(), -2), shiftMonth(curMonth(), -1), curMonth()].map((mk) => {
    const p = parts(mk);
    return `${mk}: ${p.nSales} ventas · beneficio ventas ${e2(p.profit)} € − gastos negocio ${e2(p.biz)} € = beneficio neto ${e2(p.net)} €` +
      ` | banco: retirado de Vinted +${e2(p.withdraw)}, otros ingresos +${e2(p.income)}, pedidos −${e2(p.orders)}, gastos negocio −${e2(p.biz)}, gastos personales −${e2(p.pers)} = flujo ${e2(p.flow)} €`;
  });
  const perModel = L('models').filter((m) => m.status !== 'descartado' || n0(m.home)).map((m) => {
    const ss = L('sales').filter((v) => v.modelId === m.id && !v.cancelled), d30 = ss.filter((v) => v.date >= shiftDay(todayKey(), -29));
    const r = stockOf(m.id), eff = r ? r.m.status : m.status;
    return `${m.name} [${eff}${eff !== m.status ? ', marcado ' + m.status : ''}]: ${ss.length} ventas total, ${d30.length} en 30 días, precio medio ${d30.length ? e2(sum(d30.map((v) => n0(v.price))) / d30.length) + ' €' : '-'}, coste ${e2(costOf(m))} € (${costSrc(m)}), 1688 ${n0(m.unitPrice) ? e2(n0(m.unitPrice)) + ' €' : 'FALTA'}, peso ${n0(m.weight) ? n0(m.weight) + ' g' : 'FALTA'}, en casa ${n0(m.home)}, en camino ${n0(m.transit)}`;
  });
  const t = new Date(), fix = [...(S0().migr9log || []), ...(S0().migr10log || [])];
  return `OOQ LEDGER · export ${todayKey()} ${pad(t.getHours())}:${pad(t.getMinutes())}\n` +
    `Datos de mi negocio de relojes. "calculos", "st" (estado de stock) y "pedido_sugerido" los calcula la app. "e" = estado real (ganador solo con 1 venta o 2 ofertas). Dime los mejores movimientos de stock y números.\n\n` +
    `MESES\n${months.join('\n')}\n\nPOR RELOJ\n${perModel.join('\n')}\n` +
    (fix.length ? `\nCORRECCIONES DE DATOS\n${fix.join('\n')}\n` : '') +
    `\nDATOS\n${JSON.stringify(snap)}`;
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
}
function downloadText(name, txt) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function exportBackup() {
  const data = JSON.stringify({ app: 'ooq-ledger', at: nowISO(), records: db.exportRecords().filter((r) => r.col.startsWith('lg-')) }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'ooq-ledger-' + todayKey() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- events ---------------- */
const SAVE = { 'save-sale': saveSale, 'save-order': saveOrder, 'save-receive': saveReceive, 'save-spend': saveSpend, 'save-income': saveIncome, 'save-model': saveModel, 'save-settings': saveSettings, 'save-bill': saveBill, 'save-goal': saveGoal,
  'save-snap': saveSnap, 'save-withdraw': saveWithdraw, 'save-catchup': saveCatchup, 'save-newtest': saveNewTest, 'save-listing': saveListing, 'save-acc': saveAcc, 'save-plan': savePlan, 'save-debt': saveDebt };
function setTab(v) { st.tab = v; lsSet('lg_tab', v); if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v); window.scrollTo(0, 0); renderSoon(); }
document.addEventListener('click', async (e) => {
  if (e.target === sheetEl) { closeSheet(); return; }
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a !== 'del' && a !== 'del-model' && a !== 'merge-model' && a !== 'del-order' && a !== 'del-listing' && a !== 'chat-clear' && st.confirm) { st.confirm = null; renderSoon(); }
  if (SAVE[a]) {
    b.disabled = true;
    try { await SAVE[a](); } catch (err) { console.error(err); shErr('No se pudo guardar: ' + (err.message || err)); }
    if (document.body.contains(b)) b.disabled = false;
    return;
  }
  switch (a) {
    case 'tab': setTab(v); break;
    case 'goto-orders': st.stockSeg = 'pedidos'; lsSet('lg_seg', 'pedidos'); setTab('stock'); break;
    case 'mprev': case 'mnext': { st.month = shiftMonth(st.month, a === 'mprev' ? -1 : 1); const t = todayKey(); st.selDay = t.startsWith(st.month) ? t : st.month + '-01'; renderSoon(); break; }
    case 'day': st.selDay = v; renderSoon(); break;
    case 'calmode': st.calMode = v; lsSet('lg_cal', v); renderSoon(); break;
    case 'seg': st.stockSeg = v; lsSet('lg_seg', v); renderSoon(); break;
    case 'filter': st.filter = v; lsSet('lg_filter', v); renderSoon(); break;
    case 'add': openSheet('add', { mode: b.dataset.mode || (st.tab === 'gastos' ? 'gasto' : st.tab === 'stock' && st.stockSeg === 'pedidos' ? 'pedido' : 'venta'), date: b.dataset.date || (st.tab === 'calendario' ? st.selDay : todayKey()) }); break;
    case 'restock': { const m = model(b.dataset.id); openSheet('add', { mode: 'pedido', lines: [{ modelId: m.id, qty: b.dataset.q, unit: lastUnitPrice(m.id) ? String(lastUnitPrice(m.id)).replace('.', ',') : '', name: '' }] }); break; }
    case 'mode': { const c = st.sheet.ctx; c.mode = v; redrawSheet(); break; }
    case 'kind': case 'cat': { const c = st.sheet.ctx; c.amt = sv('x-amt'); c.note = sv('x-note'); c.date = sv('x-date'); if (a === 'kind') { c.kind = v; c.cat = null; } else c.cat = v; $('#sh-body', sheetEl).innerHTML = spendBody(c); break; }
    case 'addline': readLines(); st.sheet.ctx.lines.push({ modelId: (sortedModels().filter((m) => m.status !== 'descartado')[0] || {}).id || '__new', qty: '', unit: '', name: '' }); redrawSheet(); break;
    case 'rmline': readLines(); st.sheet.ctx.lines.splice(Number(b.dataset.i), 1); redrawSheet(); break;
    case 'close': closeSheet(); break;
    case 'model': openSheet('model', { id: b.dataset.id }); break;
    case 'receive': openSheet('receive', { id: b.dataset.id }); break;
    case 'order': openSheet('order', { id: b.dataset.id }); break;
    case 'theme': { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; lsSet('lg_theme', t); redrawSheet(); break; }
    case 'del-order': {
      const id = st.sheet.ctx.id, key = 'orders/' + id;
      if (st.confirm === key) { st.confirm = null; closeSheet(); await del('orders', id); }
      else { st.confirm = key; redrawSheet(); }
      break;
    }
    case 'settings': openSheet('settings'); break;
    case 'import': openSheet('import', {}); break;
    case 'save-import': {
      const btn = b; btn.disabled = true; const res = await runImport(sv('imp-txt'), sv('imp-acc'), sv('imp-pct'));
      btn.disabled = false; if (res.err) { shErr(res.err); break; }
      closeSheet(); toast(`${res.nS} ventas importadas · boosts ${eur(res.boosts)}`); break;
    }
    case 'chat-send': chatSend(); break;
    case 'chat-quick': chatSend(QUICK[Number(v)][1], true); break;
    case 'chat-rmimg': st.chatImgs.splice(Number(v), 1); drawImgs(); break;
    case 'chat-clear': {
      if (st.confirm === 'chat/all') { st.confirm = null; for (const m of L('chat')) await db.remove(C.chat, m.id); st.chatErr = ''; toast('Chat borrado'); }
      else { st.confirm = 'chat/all'; setTimeout(() => { if (st.confirm === 'chat/all') { st.confirm = null; renderSoon(); } }, 3500); }
      renderSoon(); break;
    }
    case 'ai-setup': st.aiSetup = !st.aiSetup; renderSoon(); break;
    case 'ai-save': {
      const k = ($('#ai-key') || {}).value?.trim() || '', md = ($('#ai-model') || {}).value || 'auto';
      if (!/^sk-ant-/.test(k)) { const e = $('#ai-err'); if (e) e.textContent = 'La clave empieza por sk-ant-'; break; }
      lsSet('ooq_ai_key', k); lsSet('ooq_ai_mode', md); st.aiSetup = false;
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      renderSoon(); toast('IA conectada'); break;
    }
    case 'goto-plan': st.stockSeg = 'plan'; lsSet('lg_seg', 'plan'); if (st.sheet) closeSheet(); setTab('stock'); break;
    case 'moves': openSheet('moves'); break;
    case 'pending': openSheet('pending'); break;
    case 'withdraw': openSheet('withdraw', { date: todayKey() }); break;
    case 'release': await releaseSale(b.dataset.id); toast('Liberada · pasa a tu saldo de Vinted'); redrawSheet(); break;
    case 'release-all': { for (const x of pendingSales()) await releaseSale(x.id); toast('Todas liberadas'); redrawSheet(); break; }
    case 'export-ai': { const ok = await copyText(exportForClaude()); toast(ok ? 'Copiado · pégalo en tu proyecto de Claude' : 'No se pudo copiar: usa Descargar .txt'); break; }
    case 'export-ai-file': downloadText('ooq-' + todayKey() + '.txt', exportForClaude()); toast('Descargado · súbelo a tu proyecto de Claude'); break;
    case 'ai-moves': ensureAiMoves(true); break;
    case 'catchup': openSheet('catchup'); break;
    case 'notif': openSheet('notif'); break;
    case 'test': openSheet('test', { id: b.dataset.id }); break;
    case 'newtest': openSheet('newtest'); break;
    case 'listing': openSheet('listing', { id: b.dataset.id }); break;
    case 'newlisting': openSheet('newlisting', { id: b.dataset.id, acc: v }); break;
    case 'acc': openSheet('acc', { name: v }); break;
    case 'planedit': openSheet('planedit', {}); break;
    case 'plan-addmonth': { const pl = readPlan(), ks = Object.keys(pl).sort(), last = ks[ks.length - 1] || shiftMonth(curMonth(), -1); pl[shiftMonth(last, 1)] = { ...(pl[last] || { sales: 0, min: 0, profit: 0 }) }; st.sheet.ctx.plan = pl; redrawSheet(); break; }
    case 'plan-order': { const ls = brain().plan.lines.filter((l) => l.lane === v); openOrderFor(ls.map((l) => ({ modelId: l.m.id, qty: l.qty })), v); break; }
    case 'order-model': { const r = stockOf(b.dataset.id); if (r) openOrderFor([{ modelId: r.m.id, qty: r.bridge || r.ddpQty || 10 }], r.bridge ? 'dhl' : 'ddp'); break; }
    case 'test-win': {
      const t = brain().tests.find((z) => z.m.id === b.dataset.id); if (!t) break;
      if (t.stage !== 'ganador' && !B.proofOf(t.m, L('sales').filter((x) => !x.cancelled), L('listings')).ok) { toast('Aún no: ganador = 1 venta o 2 ofertas'); break; }
      await db.patch(C.models, t.m.id, { status: 'ganador' });
      toast('Ganador · ahora pide stock');
      openOrderFor([{ modelId: t.m.id, qty: t.firstQty }], n0(t.m.home) <= 2 ? 'dhl' : 'ddp'); break;
    }
    case 'test-kill': { await db.patch(C.models, b.dataset.id, { status: 'descartado' }); closeSheet(); toast('Fuera · sube el siguiente test'); break; }
    case 'test-price': { const t = brain().tests.find((z) => z.m.id === b.dataset.id); if (!t) break; for (const l of t.live) await db.patch(C.listings, l.id, { price: t.newPrice }); await db.patch(C.models, t.m.id, { listPrice: t.newPrice }); toast('Precio ' + eur(t.newPrice) + ' · manda oferta a los favs'); redrawSheet(); break; }
    case 'test-cover': { const t = brain().tests.find((z) => z.m.id === b.dataset.id); if (!t) break; for (const l of t.live) await db.patch(C.listings, l.id, { renewedAt: nowISO() }); toast('Apuntado · stats otra vez en 24h'); redrawSheet(); break; }
    case 'l-status': {
      const id = st.sheet.ctx.id, patch = { status: v, endedAt: v === 'live' ? null : nowISO() };
      if (v === 'removed') patch.reason = sv('l-reason') || 'retirado por Vinted';
      await db.patch(C.listings, id, patch); toast(v === 'removed' ? 'Apuntado: esa cuenta no lo vuelve a subir en 30 días' : 'Guardado'); redrawSheet(); break;
    }
    case 'l-renew': await db.patch(C.listings, st.sheet.ctx.id, { renewedAt: nowISO() }); toast('Renovado'); redrawSheet(); break;
    case 'l-price': { const pr = num(sv('l-price')); if (pr > 0) { await db.patch(C.listings, st.sheet.ctx.id, { price: r2(pr) }); toast('Precio cambiado'); redrawSheet(); } break; }
    case 'del-listing': {
      const id = st.sheet.ctx.id, key = 'listings/' + id;
      if (st.confirm === key) { st.confirm = null; await db.remove(C.listings, id); closeSheet(); toast('Anuncio borrado'); }
      else { st.confirm = key; redrawSheet(); }
      break;
    }
    case 'dist-down': { for (const l of await listingsOf(b.dataset.id, v)) await db.patch(C.listings, l.id, { status: 'down', endedAt: nowISO() }); toast('Quitado de ' + v); break; }
    case 'bill': openSheet('bill'); break;
    case 'goal': openSheet('goal'); break;
    case 'sync-now': sync.syncNow(); toast('Sincronizando…'); break;
    case 'export': exportBackup(); break;
    case 'logout': await sync.logout(); location.reload(); break;
    case 'bump': { const m = model(b.dataset.id); if (m) await db.patch(C.models, m.id, { [b.dataset.f]: Math.max(0, n0(m[b.dataset.f]) + Number(b.dataset.d)) }); break; }
    case 'paid': togglePaid(b.dataset.id); break;
    case 'del': {
      const key = b.dataset.col + '/' + b.dataset.id;
      if (st.confirm === key) { st.confirm = null; await del(b.dataset.col, b.dataset.id); }
      else { st.confirm = key; clearTimeout(del._t); del._t = setTimeout(() => { st.confirm = null; renderSoon(); }, 3500); }
      renderSoon(); break;
    }
    case 'merge-model': {
      const id = st.sheet.ctx.id, dst = sv('m-merge'), key = 'merge/' + id;
      if (st.confirm === key) { st.confirm = null; const to = model(dst); if (await mergeModel(id, dst)) { closeSheet(); toast('Fusionado en ' + (to ? to.name : '')); } }
      else { st.confirm = key; redrawSheet(); }
      break;
    }
    case 'not-dupe': { const nd = S0().notDupes || []; await patchSettings({ notDupes: [...nd, b.dataset.id + '|' + v] }); toast('Vale, son distintos'); redrawSheet(); break; }
    case 'del-model': {
      const id = st.sheet.ctx.id, key = 'models/' + id;
      if (st.confirm === key) { st.confirm = null; await db.remove(C.models, id); closeSheet(); toast('Reloj borrado'); }
      else { st.confirm = key; redrawSheet(); }
      break;
    }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.sheet) closeSheet(); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.some((t) => t[0] === h) && h !== st.tab) setTab(h); });

/* ---------------- your watch names + importing your sales history ---------------- */
const nm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// the names you use. winners need proof (sales); sanda and black are tests
const CORE = {
  gold: { name: 'Watch 1 golden', win: true, re: /^(watch 1 golden|watch 1 gold|reloj oro|oro|gold|golden)$/ },
  silver: { name: 'Watch 1 silver', win: true, re: /^(watch 1 silver|reloj plata|plata|silver)$/ },
  bronze: { name: 'Watch 1 bronze', win: true, re: /bron/ },
  twiy: { name: 'Watch 2 The World Is Yours', win: true, re: /world is yours|twiy|^watch 2/ },
  sanda: { name: 'Sanda', re: /sanda/ },
  black: { name: 'Black gothic', re: /^(negro escultorico|black gothic|black gotic|black|negro)/ },
};
const keyOfItem = (item) => { const n = nm(item); return /^boost/.test(n) ? 'boost' : /gold|golden|^oro|dorad/.test(n) ? 'gold' : /silver|plata|platead/.test(n) ? 'silver' : /bron/.test(n) ? 'bronze' : /twiy|world is yours/.test(n) ? 'twiy' : /sanda/.test(n) ? 'sanda' : /black|negro|got/.test(n) ? 'black' : null; };
// finds your model for a name (merging copies of the same watch), renames it, and sets its status
async function ensureCore(k, create) {
  const c = CORE[k], score = (m) => n0(m.home) * 3 + n0(m.transit) * 2 + L('sales').filter((v) => v.modelId === m.id).length;
  const ms = L('models').filter((m) => m.status !== 'descartado' && c.re.test(nm(m.name))).sort((a, b) => score(b) - score(a));
  let m = ms[0];
  for (const o of ms.slice(1)) await mergeModel(o.id, m.id);
  if (!m && !create) return null;
  if (!m) m = await db.put(C.models, { name: c.name, status: 'test', home: 0, transit: 0, order: L('models').length + 1 });
  m = model(m.id);
  const status = c.win ? (B.proofOf(m, L('sales').filter((x) => !x.cancelled), L('listings')).ok ? 'ganador' : 'test') : 'test';
  const p = {}; if (m.name !== c.name) { p.name = c.name; p.alias = [m.alias, m.name].filter(Boolean).join(' · '); } if (m.status !== status) p.status = status;
  if (Object.keys(p).length) await db.patch(C.models, m.id, p);
  if (p.name) {
    for (const v of L('sales').filter((x) => x.modelId === m.id && x.modelName !== c.name)) await db.patch(C.sales, v.id, { modelName: c.name });
    for (const o of L('orders').filter((x) => (x.lines || []).some((l) => l.modelId === m.id))) await db.patch(C.orders, o.id, { lines: o.lines.map((l) => (l.modelId === m.id ? { ...l, name: c.name } : l)) });
  }
  return model(m.id);
}
// your CSV: date,item,sold,cost,boost. "boost" = Vinted boost paid that day (business spend). BoostOnly = boost without a sale.
function parseImport(txt) {
  const rows = [], bad = [];
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^date\b/i.test(line)) continue;
    const f = (line.includes(';') ? line.split(';') : line.split(',')).map((x) => x.trim());
    const [date, item, sold, cost, boost] = f;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !item || isNaN(num(sold)) || isNaN(num(cost))) { bad.push(line); continue; }
    rows.push({ date, item, sold: r2(num(sold)), cost: r2(num(cost)), boost: r2(n0(boost)), key: keyOfItem(item) });
  }
  return { rows, bad, sales: rows.filter((r) => r.key !== 'boost' && r.sold > 0), boosts: r2(sum(rows.map((r) => r.boost))) };
}
function importPreview(txt) {
  const p = parseImport(txt); if (!p.rows.length) return `<div class="hint">Pega aquí el CSV: date,item,sold,cost,boost</div>${p.bad.length ? `<div class="hint neg">${p.bad.length} línea${p.bad.length === 1 ? '' : 's'} sin leer</div>` : ''}`;
  const by = {}; for (const r of p.sales) { const n = r.key ? CORE[r.key].name : r.item; (by[n] = by[n] || { n: 0, rev: 0, pr: 0, k: r.key }); by[n].n++; by[n].rev += r.sold; by[n].pr += r.sold - r.cost; }
  const exist = new Set(L('sales').map((v) => v.id)), dupe = importRows(p).filter((x) => exist.has(x.id)).length;
  const odd = p.sales.filter((r) => r.key === 'twiy' && r.cost > 8).map((r) => `${r.date} TWIY coste ${r.cost}`);
  return `<table class="xl list"><thead><tr><th>Reloj</th><th class="n">Ventas</th><th class="n">Benef.</th></tr></thead><tbody>${Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([n, v]) => `<tr><td>${esc(n)}<span class="sub">${v.k ? (CORE[v.k].win ? 'ganador' : 'test') : 'descartado (ya no lo vendes)'} · media ${eur(v.rev / v.n)}</span></td><td class="n">${v.n}</td><td class="n pos">${eur(v.pr)}</td></tr>`).join('')}
    <tr class="tot"><td>Total</td><td class="n">${p.sales.length}</td><td class="n pos">${eur(sum(p.sales.map((r) => r.sold - r.cost)))}</td></tr></tbody></table>
    <div class="hint">Boosts: ${eur(p.boosts)} → van a Gastos negocio (Boost Vinted), uno por día. Ventas antiguas: ya liberadas, no tocan banco, saldo ni stock.${dupe ? ` ${dupe} ya estaban importadas: se actualizan, no se duplican.` : ''}${p.bad.length ? ` <span class="neg">${p.bad.length} línea${p.bad.length === 1 ? '' : 's'} sin leer.</span>` : ''}</div>${odd.length ? `<div class="hint warn">Revisa: ${esc(odd.join(', '))} (las demás TWIY cuestan 6,12)</div>` : ''}`;
}
// stable ids: importing the same file twice updates instead of duplicating
function importRows(p) {
  const seen = {};
  return p.sales.map((r) => { const base = `imp-${r.date}-${nm(r.item).replace(/ /g, '')}-${r.sold}-${r.cost}`; seen[base] = (seen[base] || 0) + 1; return { ...r, id: base + '-' + seen[base] }; });
}
async function runImport(txt, acc, pct) {
  const accs = acctNames(), main = brain().acc.mainName || accs[0], other = accs.find((a) => a !== main) || main, split = acc === '__split', f = Math.max(0, Math.min(100, n0(pct))) / 100;
  const p = parseImport(txt); if (!p.sales.length) return { err: 'No hay ventas que leer.' };
  const mids = {};
  for (const k of Object.keys(CORE)) if (p.sales.some((r) => r.key === k)) mids[k] = (await ensureCore(k, true)).id;
  for (const r of p.sales.filter((z) => !z.key)) {
    const n = nm(r.item); if (mids['x:' + n]) continue;
    let m = L('models').find((z) => nm(z.name) === n || nm(z.name).startsWith(n + ' ') || nm(z.name).split(' ')[0] === n.split(' ')[0] && n.length >= 5);
    if (!m) m = await db.put(C.models, { name: r.item.charAt(0).toUpperCase() + r.item.slice(1), status: 'descartado', home: 0, transit: 0, order: L('models').length + 1 });
    else if (!n0(m.home) && !n0(m.transit) && m.status !== 'descartado') await db.patch(C.models, m.id, { status: 'descartado' });
    mids['x:' + n] = m.id;
  }
  let nS = 0;
  // split by date order: the other account gets f of the sales, spread evenly over time
  const rowsI = importRows(p).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  rowsI.forEach((r, i) => { r.acc = !split ? acc : Math.floor((i + 1) * f) > Math.floor(i * f) ? other : main; });
  for (const r of rowsI) {
    const mid = r.key ? mids[r.key] : mids['x:' + nm(r.item)], m = model(mid), at = r.date + 'T12:00:00.000Z';
    await db.put(C.sales, { id: r.id, date: r.date, at, modelId: mid, modelName: m ? m.name : r.item, price: r.sold, cost: r.cost, watchCost: r.cost, extra: 0, estimated: false, profit: r2(r.sold - r.cost), account: r.acc, accountEstimated: split || undefined, fromStock: false, pouch: false, released: true, releasedAt: at, imported: true });
    nS++;
  }
  const days = {}; for (const r of p.rows) if (r.boost > 0) { const d = (days[r.date] = days[r.date] || { amt: 0, n: 0 }); d.amt += r.boost; d.n++; }
  for (const [date, d] of Object.entries(days)) await db.put(C.spend, { id: 'imp-boost-' + date, date, at: date + 'T12:00:00.000Z', amount: r2(d.amt), kind: 'negocio', cat: 'Boost Vinted', note: `boost importado (${d.n})`, imported: true });
  for (const k of Object.keys(mids)) if (CORE[k]) await ensureCore(k, false); // now with sales → winners
  return { nS, boosts: p.boosts };
}

/* ---------------- first run data ---------------- */
async function seedIfEmpty() {
  if (db.get(C.settings, 'settings') || (await db.getMeta('seeded'))) return;
  const mk = (o) => o;
  await db.seed(C.settings, [{ id: 'settings', cash: 374, cashAt: '2026-10-15T19:45:00.000Z', cushion: 0, monthlyGoal: 1000, accounts: ['tictac spain', 'y2kwatches'] }]);
  await db.seed(C.models, [
    mk({ id: 'm-bronce', name: 'Bronce vestir · correa marrón', status: 'ganador', landed: 9, listPrice: 34.95, minPrice: 28, home: 0, transit: 0, order: 0 }),
    mk({ id: 'm-sanda', name: 'Sanda retro ana-digi', status: 'ganador', landed: 14.23, listPrice: 44.95, minPrice: 36, home: 1, transit: 0, order: 1 }),
    mk({ id: 'm-reloj1', name: 'Reloj 1 · vestir dorado/plateado', status: 'ganador', landed: 9.98, listPrice: 34.95, minPrice: 26, home: 0, transit: 40, order: 2 }),
    mk({ id: 'm-reloj2', name: 'Reloj 2 · grande de hombre', status: 'ganador', landed: 7.98, listPrice: 27.95, minPrice: 20, home: 0, transit: 10, order: 3 }),
    mk({ id: 'm-jaula', name: 'Jaula metálica roja Y2K', status: 'espera', listPrice: 29.95, home: 1, transit: 0, order: 4 }),
    mk({ id: 'm-granulado', name: 'Octogonal dorado granulado', status: 'test', home: 0, transit: 0, order: 5 }),
    mk({ id: 'm-derretido', name: 'Derretido dorado surrealista', status: 'test', home: 0, transit: 0, order: 6 }),
    mk({ id: 'm-min-verde', name: 'Minimalista verde · brazalete', status: 'test', listPrice: 39.95, home: 1, transit: 0, order: 7 }),
    mk({ id: 'm-min-azul', name: 'Minimalista azul · brazalete', status: 'test', listPrice: 39.95, home: 1, transit: 0, order: 8 }),
    mk({ id: 'm-negro', name: 'Negro escultórico', status: 'test', listPrice: 39.95, home: 1, transit: 0, order: 9 }),
    mk({ id: 'm-cuero', name: 'Correa de cuero marrón', status: 'descartado', listPrice: 34.95, home: 0, transit: 0, order: 10 }),
    mk({ id: 'm-naranja', name: 'Pin Time esfera naranja', status: 'descartado', listPrice: 39.95, home: 0, transit: 0, order: 11 }),
    mk({ id: 'm-octo-blanco', name: 'Octogonal blanco Who cares', status: 'descartado', listPrice: 29.95, home: 0, transit: 0, order: 12 }),
  ]);
  const sale = (n, price, at) => ({ id: 'sale-20261015-' + n, date: '2026-10-15', at, modelId: 'm-bronce', modelName: 'Bronce vestir · correa marrón', price, cost: 9, profit: price - 9, account: 'tictac spain', fromStock: false });
  await db.seed(C.sales, [sale(1, 30, '2026-10-15T16:00:00.000Z'), sale(2, 28, '2026-10-15T17:30:00.000Z'), sale(3, 26, '2026-10-15T19:25:00.000Z')]);
  await db.seed(C.goals, [
    { id: 'g-1000', title: 'Primer mes de 1.000 € de beneficio', metric: 'bestMonth', target: 1000, order: 1 },
    { id: 'g-autonomo', title: '2 meses seguidos de 1.500 € → autónomo', metric: 'streak', threshold: 1500, target: 2, order: 2 },
    { id: 'g-5000', title: '5.000 € en caja', metric: 'cash', target: 5000, deadline: '2027-05', order: 3 },
  ]);
  const bills = [['Portátil 1/2', 100, '2026-10'], ['Personal', 30, '2026-10'], ['Portátil 2/2', 100, '2026-11'], ['Carnet 1/4', 300, '2026-11'], ['Personal', 30, '2026-11'], ['Devolver a amigo 1/2', 200, '2026-12'], ['Personal', 30, '2026-12'], ['Carnet 2/4', 300, '2027-01'], ['Personal', 30, '2027-01'], ['Devolver a amigo 2/2', 200, '2027-02'], ['Personal', 30, '2027-02'], ['Carnet 3/4', 300, '2027-03'], ['Personal', 30, '2027-03'], ['Carnet 4/4', 300, '2027-04'], ['Personal', 30, '2027-04'], ['Personal', 30, '2027-05']];
  await db.seed(C.bills, bills.map(([concept, amount, month], i) => ({ id: 'bill-' + pad(i + 1), concept, amount, month, paid: false })));
  await db.setMeta('seeded', true);
}

// One-time upgrade of existing data for OOQ Manager: monthly plan, account status, known 1688 prices and weights.
async function migrate() {
  const cur = db.get(C.settings, 'settings'); if (!cur || n0(cur.migr) >= 6) return;
  const patch = { migr: 6 };
  if (!cur.plan) patch.plan = {
    '2026-10': { sales: 25, min: 19, profit: 500 }, '2026-11': { sales: 63, min: 47, profit: 1220 }, '2026-12': { sales: 105, min: 79, profit: 1950 },
    '2027-01': { sales: 90, min: 68, profit: 1625 }, '2027-02': { sales: 120, min: 90, profit: 2100 }, '2027-03': { sales: 153, min: 115, profit: 2620 },
    '2027-04': { sales: 190, min: 143, profit: 3175 }, '2027-05': { sales: 235, min: 176, profit: 3875 }, '2027-06': { sales: 275, min: 206, profit: 4500 },
  };
  if (!cur.accMeta) {
    const meta = {};
    for (const a of cur.accounts || []) meta[a] = { status: /y2k/i.test(a) ? 'restringida' : 'activa', main: a === 'tictac spain' };
    patch.accMeta = meta;
  }
  await patchSettings(patch);
  const known = { 'm-reloj1': { unitPrice: 7, weight: 30 }, 'm-bronce': { unitPrice: 7, weight: 30 }, 'm-reloj2': { unitPrice: 4.5, weight: 150 }, 'm-sanda': { unitPrice: 11, weight: 135 }, 'm-negro': { unitPrice: 6, weight: 135 } };
  for (const id in known) {
    const m = model(id); if (!m) continue;
    const p = {}; for (const k in known[id]) if (m[k] === undefined || m[k] === null || m[k] === '') p[k] = known[id][k];
    if (Object.keys(p).length) await db.patch(C.models, id, p);
  }
}

// v7: money in 3 places. Recent sales start as pending in Vinted; old ones count as already released.
async function migrate7() {
  const cur = db.get(C.settings, 'settings'); if (!cur || n0(cur.migr) >= 7) return;
  const lim = shiftDay(todayKey(), -14);
  for (const x of L('sales')) if (x.released === undefined) {
    const old = x.date < lim;
    await db.patch(C.sales, x.id, { released: old, releasedAt: old ? (x.at || x.date + 'T12:00:00.000Z') : null });
  }
  await patchSettings({ migr: 7, vbal: cur.vbal || {}, vbalAt: cur.vbalAt || nowISO() });
}

// v8 (one time): DDP takes 12 days; add the 2 sales missing vs Vinted (Poedagar 14,40 € and the y2kwatches one of 52 €, 14 oct) and fix the bronze 34,95 → 34,90.
async function migrate8() {
  const cur = db.get(C.settings, 'settings'); if (!cur || n0(cur.migr) >= 8) return;
  const accs = cur.accounts || [], tic = accs.find((a) => /tictac/i.test(a)) || accs[0], y2k = accs.find((a) => /y2k/i.test(a));
  const sales = L('sales'), models = L('models');
  const mkSale = (m, price, acc, note) => ({ date: '2026-10-14', at: '2026-10-14T12:00:00.000Z', modelId: m.id, modelName: m.name, price, cost: r2(costOf(m)), watchCost: r2(costOf(m)), extra: 0, estimated: isEst(m), profit: r2(price - costOf(m)), account: acc, fromStock: false, released: false, releasedAt: null, note });
  if (!sales.some((x) => /poedagar/i.test(x.modelName || ''))) {
    const m = models.find((z) => /poedagar/i.test(z.name)) || await db.put(C.models, { name: 'Poedagar verde', status: 'espera', home: 0, transit: 0, listPrice: 34.95, order: models.length + 1 });
    await db.put(C.sales, mkSale(m, 14.4, tic, 'añadida para cuadrar con Vinted'));
  }
  if (y2k && !sales.some((x) => x.account === y2k && x.date === '2026-10-14')) {
    const m = models.find((z) => z.id === 'm-sinesp') || await db.put(C.models, { id: 'm-sinesp', name: 'Reloj sin especificar', status: 'descartado', home: 0, transit: 0, order: models.length + 2 });
    await db.put(C.sales, mkSale(m, 52, y2k, 'añadida para cuadrar con Vinted · dime qué reloj era'));
  }
  const br = sales.find((x) => n0(x.price) === 34.95 && /bron/i.test(x.modelName || ''));
  if (br) await db.patch(C.sales, br.id, { price: 34.9, profit: r2(n0(br.profit) - 0.05) });
  await patchSettings({ migr: 8, leadDDP: n0(cur.leadDDP) && n0(cur.leadDDP) !== 18 ? cur.leadDDP : 12 });
}

// v9 (one time): the 16 fixes from the export review.
// 1) the seeded "Bronce vestir" and your "Reloj bronze" are the same watch → one model, so its 4 sales count together
// 2) "ganador" without a sale or 2 offers → back to test   3) orders marked "otro" were DDP
// 4) unit cost recomputed from each watch's last order (shipping by weight when weights exist), marked real/estimado
async function migrate9() {
  const cur = db.get(C.settings, 'settings'); if (!cur || n0(cur.migr) >= 9) return;
  const log = [];
  const br = model('m-bronce'), cand = L('models').filter((m) => m.id !== 'm-bronce' && m.status !== 'descartado' && /bron/i.test(m.name || ''));
  if (br && cand.length === 1 && await mergeModel(br.id, cand[0].id)) log.push(`fusionado "${br.name}" en "${cand[0].name}"`);
  for (const o of L('orders')) if (!o.lane || o.lane === 'otro') { await db.patch(C.orders, o.id, { lane: 'ddp' }); log.push('pedido ' + o.date + ' otro → DDP'); }
  for (const m of L('models')) {
    const p = {}, lo = latestOrderOf(m.id), ln = lo && lo.lines.find((l) => l.modelId === m.id);
    if (!(n0(m.unitPrice) > 0) && ln && n0(ln.unit) > 0) p.unitPrice = n0(ln.unit);
    if (m.status === 'ganador' && !B.proofOf(m, L('sales').filter((x) => !x.cancelled), L('listings')).ok) { p.status = 'test'; log.push(`${m.name}: ganador sin ventas → test`); }
    if (Object.keys(p).length) await db.patch(C.models, m.id, p);
  }
  const os = L('orders').filter((o) => !o.draft).sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  for (const o of os) {
    const al = landedFromOrder(o); if (!al) continue;
    for (const id in al.per) {
      const m = model(id), lo = latestOrderOf(id); if (!m || !lo || lo.id !== o.id) continue;
      const p = { landed: al.per[id].landed, landedSrc: al.src, landedOrder: o.id };
      if (!isNaN(num(m.landed)) && Math.abs(num(m.landed) - p.landed) > 0.05) { p.landedOld = num(m.landed); log.push(`${m.name}: coste ${m.landed} → ${p.landed}`); }
      await db.patch(C.models, id, p);
    }
  }
  await patchSettings({ migr: 9, migr9log: log });
}

// v10 (one time): your names. Watch 1 golden / silver / bronze, Watch 2 The World Is Yours (winners, need sales as proof), Sanda and Black gothic in test.
async function migrate10() {
  const cur = db.get(C.settings, 'settings'); if (!cur || n0(cur.migr) >= 10) return;
  const log = [];
  for (const k of Object.keys(CORE)) { const before = L('models').filter((m) => m.status !== 'descartado' && CORE[k].re.test(nm(m.name))).map((m) => m.name); const m = await ensureCore(k, false); if (m && before.length) log.push(`${before.join(' + ')} → ${m.name} (${m.status})`); }
  await patchSettings({ migr: 10, migr10log: log });
}

/* ---------------- login ---------------- */
function loginView(done) {
  const email = lsGet('lg-login-email', '');
  app.innerHTML = `<div class="wrap login"><form class="card" novalidate><img src="icons/icon-192.png" alt=""><h1>OOQ LEDGER</h1><p>Entra una vez en cada dispositivo y se queda guardado. La primera vez crea tu cuenta con la contraseña que pongas.</p>
    <div class="field"><label for="lg-email">Email</label><input id="lg-email" type="email" autocomplete="username" inputmode="email" value="${esc(email)}"></div>
    <div class="field"><label for="lg-pass">Contraseña</label><input id="lg-pass" type="password" autocomplete="current-password" minlength="6"></div>
    <div class="err" id="lg-err"></div><button class="primary" type="submit">Entrar</button></form></div>`;
  $('form', app).addEventListener('submit', async (e) => {
    e.preventDefault();
    const em = $('#lg-email').value.trim(), pw = $('#lg-pass').value, err = $('#lg-err');
    if (!/^\S+@\S+\.\S+$/.test(em)) { err.textContent = 'Pon un email válido.'; return; }
    if (pw.length < 6) { err.textContent = 'La contraseña necesita 6 caracteres o más.'; return; }
    const btn = $('button[type=submit]', app); btn.disabled = true; btn.textContent = 'Entrando…';
    try { await sync.passwordLogin(em, pw); lsSet('lg-login-email', em); done(); }
    catch (ex) { err.textContent = navigator.onLine ? (ex.message || 'No se pudo entrar.') : 'Sin conexión. Conéctate para entrar la primera vez.'; btn.disabled = false; btn.textContent = 'Entrar'; }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  document.documentElement.dataset.theme = lsGet('lg_theme', 'light');
  await db.init();
  if (sync.configured()) {
    await sync.currentSession().catch(() => null);
    if (!sync.knownUser()) { await new Promise((res) => loginView(res)); }
    // pull what already exists before seeding, so a second device doesn't start from the defaults
    await sync.syncNow().catch(() => {});
  }
  await seedIfEmpty();
  await migrate().catch((e) => console.warn('migrate', e));
  await migrate7().catch((e) => console.warn('migrate7', e));
  await migrate8().catch((e) => console.warn('migrate8', e));
  await migrate9().catch((e) => console.warn('migrate9', e));
  await migrate10().catch((e) => console.warn('migrate10', e));
  shell(); render();
  const ta = $('#comp-text'), fi = $('#comp-file');
  ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); chatSend(); } });
  fi.addEventListener('change', async () => { for (const f of [...fi.files].slice(0, 4)) { try { st.chatImgs.push(await readImage(f)); } catch {} } fi.value = ''; drawImgs(); });
  db.subscribe(() => renderSoon());
  const tip = $('#ctip'); let tipT;
  const showTip = (e) => { const g = e.target.closest && e.target.closest('[data-tip]'); if (!g) { tip.hidden = true; return; } tip.textContent = g.dataset.tip; tip.hidden = false; const r = tip.getBoundingClientRect(); let x = e.clientX - r.width / 2, yy = e.clientY - r.height - 14; x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x)); if (yy < 8) yy = e.clientY + 18; tip.style.left = x + 'px'; tip.style.top = yy + 'px'; clearTimeout(tipT); if (e.pointerType === 'touch') tipT = setTimeout(() => { tip.hidden = true; }, 2600); };
  document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showTip(e); });
  document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') showTip(e); });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  sync.onStatus(updatePill);
  sync.start();
  setInterval(() => { if (document.visibilityState === 'visible') renderSoon(); }, 60000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch((e) => { console.error(e); app.innerHTML = `<div class="wrap login"><div class="card"><h1>ERROR</h1><p>${esc(e.message || e)}</p></div></div>`; });
