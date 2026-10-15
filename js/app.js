// OOQ Ledger: real cash, orders, stock, restock, P&L calendar, spending and goals.
import * as db from './db.js';
import * as sync from './sync.js';

const C = { settings: 'lg-settings', models: 'lg-models', sales: 'lg-sales', orders: 'lg-orders', spend: 'lg-spend', income: 'lg-income', bills: 'lg-bills', goals: 'lg-goals' };
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
  const a = Math.abs(r2(v)), dec = Number.isInteger(a) ? 0 : 2;
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
const DEF = { cash: 0, cashAt: '1970-01-01T00:00:00.000Z', cushion: 0, monthlyGoal: 1000, accounts: ['tictac spain', 'y2kwatches'] };

/* ---------------- data access ---------------- */
const L = (k) => db.all(C[k]);
const S0 = () => Object.assign({}, DEF, db.get(C.settings, 'settings') || {});
const model = (id) => db.get(C.models, id);
const goal = () => n0(S0().monthlyGoal) || 1000;
const profitOf = (s) => (typeof s.profit === 'number' ? s.profit : n0(s.price) - n0(s.cost));
const on = (arr, pre, f = 'date') => arr.filter((x) => x[f] && x[f].startsWith(pre));

function parts(pre) {
  const sales = on(L('sales'), pre), spend = on(L('spend'), pre), inc = on(L('income'), pre);
  const ord = on(L('orders'), pre), dhl = on(L('orders'), pre, 'receivedDate');
  const p = {
    sales, nSales: sales.length,
    revenue: sum(sales.map((s) => n0(s.price))),
    profit: sum(sales.map(profitOf)),
    biz: sum(spend.filter((x) => x.kind === 'negocio').map((x) => n0(x.amount))),
    pers: sum(spend.filter((x) => x.kind !== 'negocio').map((x) => n0(x.amount))),
    income: sum(inc.map((x) => n0(x.amount))),
    orders: sum(ord.map((o) => n0(o.paid))) + sum(dhl.map((o) => n0(o.dhl))),
    nOrders: ord.length,
  };
  p.net = p.profit - p.biz;
  p.flow = p.revenue + p.income - p.biz - p.pers - p.orders;
  return p;
}
function cashNow() {
  const s = S0(), t = s.cashAt || '';
  let c = n0(s.cash);
  for (const x of L('sales')) if ((x.at || '') > t) c += n0(x.price);
  for (const x of L('income')) if ((x.at || '') > t) c += n0(x.amount);
  for (const x of L('spend')) if ((x.at || '') > t) c -= n0(x.amount);
  for (const o of L('orders')) {
    if ((o.at || '') > t) c -= n0(o.paid);
    if (o.receivedAt && o.receivedAt > t) c -= n0(o.dhl);
  }
  return c;
}
const pendingBills = () => sum(L('bills').filter((b) => b.month <= curMonth() && !b.paid).map((b) => n0(b.amount)));
const spendable = () => cashNow() - n0(S0().cushion) - pendingBills();

// Which sales paid back which order: first in, first out, per watch model.
function payback() {
  const res = {}, lots = {};
  const orders = L('orders').slice().sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  for (const o of orders) {
    res[o.id] = { units: 0, sold: 0, rev: 0, cost: n0(o.paid) + n0(o.dhl), potential: 0, lots: [] };
    for (const l of o.lines || []) {
      const lot = { oid: o.id, modelId: l.modelId, date: o.date, at: o.at || '', left: n0(l.qty) };
      res[o.id].units += n0(l.qty);
      res[o.id].lots.push(lot);
      (lots[l.modelId] = lots[l.modelId] || []).push(lot);
    }
  }
  const sales = L('sales').slice().sort((a, b) => (a.date + (a.at || '')).localeCompare(b.date + (b.at || '')));
  for (const s of sales) {
    // a sale counts toward an order only if it happened after the order was paid
    const lot = (lots[s.modelId] || []).find((x) => x.left > 0 && (x.at && s.at ? s.at >= x.at : s.date > x.date));
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

function restockInfo(m) {
  const home = n0(m.home), tr = n0(m.transit);
  const sold = L('sales').filter((s) => s.modelId === m.id);
  if (!sold.length || m.status === 'descartado') return null;
  const today = todayKey(), from = shiftDay(today, -13);
  const recent = sold.filter((s) => s.date >= from && s.date <= today).length;
  const first = sold.map((s) => s.date).sort()[0];
  const span = Math.max(7, Math.min(14, daysBetween(first, today) + 1));
  const rate = recent / span;
  if (!rate) return { rate: 0, recent, need: false };
  const cover = (home + tr) / rate;
  const sug = Math.max(5, Math.ceil((rate * 30 - (home + tr)) / 5) * 5);
  const lastUnit = lastUnitPrice(m.id);
  return { rate, recent, cover, need: cover < 10, out: home + tr === 0, sug, unit: lastUnit, cost: sug * (lastUnit ? lastUnit * 1.25 : n0(m.landed)) };
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

/* ---------------- state ---------------- */
const TABS = [['inicio', 'Inicio'], ['calendario', 'Calendario'], ['stock', 'Stock'], ['gastos', 'Gastos'], ['metas', 'Metas']];
const ICONS = {
  inicio: '<path d="M4 11.5 12 5l8 6.5V20H4z"/><path d="M10 20v-5h4v5"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  stock: '<circle cx="12" cy="12" r="6"/><path d="M9 6.5 9.8 2.5h4.4L15 6.5M9 17.5l.8 4h4.4l.8-4M12 9.5V12l1.8 1.2"/>',
  gastos: '<rect x="3" y="6" width="18" height="13.5" rx="3"/><path d="M3 10h18M16 15h2"/>',
  metas: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};
const st = {
  tab: (location.hash.slice(1) && TABS.some((t) => t[0] === location.hash.slice(1))) ? location.hash.slice(1) : lsGet('lg_tab', 'inicio'),
  month: curMonth(), selDay: todayKey(), calMode: lsGet('lg_cal', 'profit'), stockSeg: lsGet('lg_seg', 'relojes'), filter: lsGet('lg_filter', 'activos'),
  confirm: null, sheet: null,
};

/* ---------------- shell ---------------- */
function shell() {
  app.innerHTML = `<div class="wrap">
    <header class="top">
      <div class="brand"><img src="icons/icon-192.png" alt=""><b>OOQ</b><span>Ledger</span></div>
      <nav class="toptabs" aria-label="Secciones">${TABS.map(([k, l]) => `<button data-a="tab" data-v="${k}">${l}</button>`).join('')}</nav>
      <div class="top-r"><button class="syncpill" data-a="settings" id="syncpill"><i></i><span>Local</span></button>
      <button class="iconbtn" data-a="settings" aria-label="Ajustes"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></div>
    </header>
    ${sync.configured() ? '' : '<div class="banner">Modo local: los datos solo están en este dispositivo hasta que se conecte la sincronización.</div>'}
    <main id="main"></main>
  </div>
  <button class="fab" data-a="add" aria-label="Añadir">+</button>
  <nav class="tabbar" aria-label="Secciones">${TABS.map(([k, l]) => `<button data-a="tab" data-v="${k}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg>${l}</button>`).join('')}</nav>`;
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
  const v = { inicio: viewHome, calendario: viewCal, stock: viewStock, gastos: viewSpend, metas: viewGoals }[st.tab] || viewHome;
  main.innerHTML = v();
  updatePill();
}
const stat = (l, v, c = '') => `<div class="stat"><div class="eyebrow">${l}</div><div class="v ${c}">${v}</div></div>`;
const mini = (l, v, c, s) => `<div class="mini"><div class="eyebrow">${l}</div><div class="v ${c}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const mnav = () => `<div class="mnav"><button data-a="mprev" aria-label="Mes anterior">‹</button><div class="ml">${monthName(st.month)}</div><button data-a="mnext" aria-label="Mes siguiente">›</button></div>`;

function bezel(p) {
  const lit = Math.min(60, Math.round(Math.max(0, p) * 60)); let t = '';
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 - 90) * Math.PI / 180, mj = i % 5 === 0, r1 = mj ? 43 : 47, r2v = 54;
    t += `<line class="tk${mj ? ' mj' : ''}${i < lit ? ' on' : ''}" x1="${(60 + r1 * Math.cos(a)).toFixed(2)}" y1="${(60 + r1 * Math.sin(a)).toFixed(2)}" x2="${(60 + r2v * Math.cos(a)).toFixed(2)}" y2="${(60 + r2v * Math.sin(a)).toFixed(2)}"/>`;
  }
  const pc = Math.max(0, Math.round(p * 100));
  return `<svg class="bezel" viewBox="0 0 120 120" role="img" aria-label="${pc}% de la meta">${t}<text class="bz-pct" x="60" y="57">${pc}%</text><text class="bz-lbl" x="60" y="76">META</text></svg>`;
}
function spark(mk) {
  const n = daysIn(mk), g = goal(), cm = curMonth();
  const last = mk === cm ? new Date().getDate() : mk < cm ? n : 0;
  const cum = []; let c = 0;
  for (let d = 1; d <= last; d++) { c += parts(mk + '-' + pad(d)).net; cum.push(c); }
  const W = 320, H = 70, px = 4, py = 6;
  const maxY = Math.max(g, ...cum, 1), minY = Math.min(0, ...cum);
  const x = (d) => px + (d - 1) / (n - 1) * (W - 2 * px), y = (v) => H - py - (v - minY) / (maxY - minY) * (H - 2 * py);
  let s = `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Beneficio acumulado frente al ritmo de la meta"><line class="base" x1="${px}" x2="${W - px}" y1="${y(0)}" y2="${y(0)}"/><path class="pace-l" d="M${x(1)} ${y(0)}L${x(n)} ${y(g)}"/>`;
  if (cum.length) {
    const pts = cum.map((v, i) => x(i + 1).toFixed(1) + ' ' + y(v).toFixed(1));
    s += `<path class="area" d="M${x(1)} ${y(0)}L${pts.join('L')}L${x(cum.length)} ${y(0)}Z"/><path class="cum" d="M${pts.join('L')}"/><circle class="end" cx="${x(cum.length)}" cy="${y(cum[cum.length - 1])}" r="3.5"/>`;
  }
  return s + '</svg>';
}

function goalDial(mk) {
  const p = parts(mk), g = goal(), cm = curMonth();
  let pace = '';
  if (mk === cm) {
    const left = daysIn(mk) - new Date().getDate(), rem = g - p.net;
    pace = rem <= 0 ? '<div class="pace"><b>Meta cumplida.</b> Lo que entre ahora es extra.</div>'
      : `<div class="pace">Faltan <b>${eur(rem)}</b> → <b>${eur(rem / Math.max(1, left))}/día</b> ${left > 0 ? `los ${left} días que quedan` : 'hoy'}</div>`;
  }
  return `<section class="card dial"><div><div class="eyebrow">Beneficio · ${MONTHS[pm(mk).m - 1]}</div><div class="big2 ${cls(p.net)}">${eur(p.net, true)}</div><div class="mut" style="font-size:13px">de ${eur(g)} · ${p.nSales} vendidos</div></div>${bezel(p.net / g)}<div style="grid-column:1/-1">${spark(mk)}</div>${pace}</section>`;
}

function viewHome() {
  const cm = curMonth(), p = parts(cm), cash = cashNow(), sp = spendable(), s = S0();
  const pb = payback();
  const hero = `<section class="card hero">
    <div class="hero-top"><div><div class="eyebrow">Caja real</div><div class="big ${cash < 0 ? 'neg' : ''}">${eur(cash)}</div></div><button class="ghost" data-a="settings">Ajustar</button></div>
    <div class="sub">${sp >= 0 ? `Puedes gastar <b>${eur(sp)}</b>${n0(s.cushion) ? ` sin bajar de tu colchón de ${eur(n0(s.cushion))}` : ''}${pendingBills() ? ` y pagar los ${eur(pendingBills())} de pagos fijos` : ''}.` : `Te faltan <b class="neg">${eur(-sp)}</b> para cubrir ${n0(s.cushion) ? 'colchón y ' : ''}pagos fijos. Nada de gastos extra.`}</div>
    <div class="flowrow">
      ${mini('Flujo de caja · ' + MSHORT[pm(cm).m - 1], eur(p.flow, true), cls(p.flow), 'Lo que entra − lo que sale')}
      ${mini('Beneficio · ' + MSHORT[pm(cm).m - 1], eur(p.net, true), cls(p.net), 'Ventas − coste − gastos negocio')}
    </div>
    <div class="breakdown">
      <div class="kv"><span class="mut">Ventas</span><span class="num pos">${eur(p.revenue, true)}</span></div>
      ${p.income ? `<div class="kv"><span class="mut">Otros ingresos</span><span class="num pos">${eur(p.income, true)}</span></div>` : ''}
      <div class="kv"><span class="mut">Pedidos de stock</span><span class="num ${p.orders ? 'neg' : ''}">${p.orders ? '−' + eur(p.orders) : eur(0)}</span></div>
      <div class="kv"><span class="mut">Gastos negocio</span><span class="num ${p.biz ? 'neg' : ''}">${p.biz ? '−' + eur(p.biz) : eur(0)}</span></div>
      <div class="kv"><span class="mut">Gastos personales</span><span class="num ${p.pers ? 'neg' : ''}">${p.pers ? '−' + eur(p.pers) : eur(0)}</span></div>
    </div>
  </section>`;
  const open = L('orders').filter((o) => o.status !== 'recibido' || pb[o.id].rev < pb[o.id].cost).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const ordersCard = `<section class="card"><div class="sec-head"><div><div class="eyebrow">Pedidos</div><h2 class="sec">¿Ya los has recuperado?</h2></div><button class="ghost" data-a="goto-orders">Ver todos</button></div>
    ${open.length ? `<div class="stack">${open.map((o) => orderBody(o, pb[o.id], true)).join('<div style="border-top:1px solid var(--line-soft)"></div>')}</div>` : '<div class="empty">No tienes pedidos sin recuperar. Cuando pagues uno, apúntalo con <b>+ → Pedido</b> y aquí verás cuánto te falta para cubrirlo.</div>'}</section>`;
  const rs = restockList();
  const restockCard = `<section class="card"><div class="sec-head"><div><div class="eyebrow">Reponer</div><h2 class="sec">${rs.length ? 'Se te acaban' : 'Stock al día'}</h2></div></div>${rs.length ? restockRows(rs) : '<div class="empty">Ningún reloj que se esté vendiendo va a quedarse sin stock en los próximos 10 días.</div>'}</section>`;
  const gs = L('goals').slice().sort((a, b) => n0(a.order) - n0(b.order));
  const goalsCard = gs.length ? `<section class="card"><div class="sec-head"><div><div class="eyebrow">Metas</div><h2 class="sec">Progreso</h2></div><button class="ghost" data-a="tab" data-v="metas">Ver</button></div>${gs.map((g) => {
    const now = metricValue(g), tg = n0(g.target) || 1;
    return `<div class="gmini"><div class="kv"><span>${esc(g.title)}</span><span class="num mut">${fmtMetric(g, now)} / ${fmtMetric(g, tg)}</span></div><div class="bar"><i style="width:${Math.min(100, Math.max(0, now / tg * 100))}%"></i></div></div>`;
  }).join('')}</section>` : '';
  return `<div class="grid2 wide-l"><div class="stack">${hero}${goalDial(cm)}</div><div class="stack">${ordersCard}${restockCard}${goalsCard}</div></div>`;
}
function restockList() {
  return L('models').map((m) => ({ m, r: restockInfo(m) })).filter((x) => x.r && x.r.need).sort((a, b) => a.r.cover - b.r.cover);
}
function restockRows(rs) {
  return rs.map(({ m, r }) => `<div class="rs"><div class="tx"><div class="t1">${esc(m.name)}</div>
    <div class="t2"><b>${r.recent}</b> vendidos en 14 días · ${r.out ? '<span class="neg">agotado</span>' : `te quedan <b>${n0(m.home) + n0(m.transit)}</b> (≈${Math.floor(r.cover)} días)`} · pide <b>${r.sug}</b>${r.cost ? ` ≈ <b>${eur(Math.round(r.cost))}</b>` : ''}</div></div>
    <button class="btn-g" data-a="restock" data-id="${esc(m.id)}" data-q="${r.sug}">Pedir</button></div>`).join('') +
    `<div class="hint" style="margin-top:8px">Calculado con el ritmo de ventas de los últimos 14 días para cubrir 30 días.</div>`;
}
function orderBody(o, pb, compact) {
  const cost = pb.cost, rec = pb.rev, pct = cost ? Math.min(1, rec / cost) : 0, gap = cost - rec;
  const lines = (o.lines || []).map((l) => { const m = model(l.modelId); return `<span>${esc(m ? m.name : l.name || 'Reloj')} <b>×${n0(l.qty)}</b></span>`; }).join('');
  return `<div class="order">
    <div class="o-top"><div><div class="o-title">Pedido ${shortDate(o.date)}${o.note ? ' · ' + esc(o.note) : ''}</div><div class="o-sub">${pb.units} relojes · pagado ${eur(n0(o.paid))}${n0(o.dhl) ? ' + DHL ' + eur(n0(o.dhl)) : o.status !== 'recibido' ? ' · DHL al llegar' : ''}</div></div>
      <span class="pill ${o.status === 'recibido' ? 'ok' : 'camino'}">${o.status === 'recibido' ? 'Recibido' : 'En camino'}</span></div>
    ${compact ? '' : `<div class="o-lines">${lines}</div>`}
    <div class="o-nums"><span><span class="big3 ${gap > 0 ? '' : 'pos'}">${eur(rec)}</span> <span class="mut">de ${eur(cost)}</span></span><span class="num mut">${Math.round(pct * 100)}%</span></div>
    <div class="bar thick"><i style="width:${pct * 100}%"></i></div>
    <div class="o-foot"><span>${gap > 0 ? `Te faltan <b class="neg num">${eur(gap)}</b> para cubrirlo` : `Cubierto · <b class="pos num">${eur(-gap, true)}</b> limpio`} · vendidos ${pb.sold}/${pb.units}</span>
      ${pb.potential ? `<span class="mut">Si vendes el resto a precio: <b class="num" style="color:var(--fg)">${eur(rec + pb.potential - cost, true)}</b></span>` : ''}</div>
    ${compact ? '' : `<div class="o-foot">${o.status !== 'recibido' ? `<button class="btn-g" data-a="receive" data-id="${esc(o.id)}">Ha llegado</button>` : `<span class="mut">Llegó el ${shortDate(o.receivedDate)}</span>`}
      <button class="del${st.confirm === 'orders/' + o.id ? ' confirm' : ''}" data-a="del" data-col="orders" data-id="${esc(o.id)}" aria-label="Borrar pedido">${st.confirm === 'orders/' + o.id ? '¿Borrar?' : '✕'}</button></div>`}
  </div>`;
}

function viewCal() {
  const mk = st.month, p = parts(mk), mode = st.calMode;
  const stats = mode === 'profit'
    ? `<div class="stats">${stat('Vendidos', p.nSales + ' uds')}${stat('Ingresos', eur(p.revenue))}${stat('Ticket medio', p.nSales ? eur(p.revenue / p.nSales) : '—')}${stat('Gastos negocio', p.biz ? '−' + eur(p.biz) : eur(0))}</div>`
    : `<div class="stats">${stat('Entra', eur(p.revenue + p.income, true), 'pos')}${stat('Pedidos', p.orders ? '−' + eur(p.orders) : eur(0), p.orders ? 'neg' : '')}${stat('Gastos', (p.biz + p.pers) ? '−' + eur(p.biz + p.pers) : eur(0), (p.biz + p.pers) ? 'neg' : '')}${stat('Flujo neto', eur(p.flow, true), cls(p.flow))}</div>`;
  return `<div class="stack"><div class="sec-head" style="margin:0">${mnav()}<div class="seg sm" style="min-width:210px"><button data-a="calmode" data-v="profit" aria-pressed="${mode === 'profit'}">Beneficio</button><button data-a="calmode" data-v="cash" aria-pressed="${mode === 'cash'}">Caja</button></div></div>
    <div class="grid2 wide-l"><div class="stack">${calGrid(mk)}${stats}</div><div class="stack">${dayPanel()}${mode === 'profit' ? goalDial(mk) : ''}</div></div></div>`;
}
function dayVal(k) { const p = parts(k); return st.calMode === 'profit' ? p.net : p.flow; }
function calGrid(mk) {
  const { y, m } = pm(mk), n = daysIn(mk), first = (new Date(y, m - 1, 1).getDay() + 6) % 7, tk = todayKey();
  const vals = []; for (let d = 1; d <= n; d++) vals.push(dayVal(mk + '-' + pad(d)));
  const maxA = Math.max(1, ...vals.map(Math.abs));
  const cells = []; for (let i = 0; i < first; i++) cells.push(null); for (let d = 1; d <= n; d++) cells.push(d); while (cells.length % 7) cells.push(null);
  let h = `<section class="card"><div class="wk-head"><div>L</div><div>M</div><div>X</div><div>J</div><div>V</div><div>S</div><div>D</div><div class="wkc">SEM</div></div><div class="grid">`;
  for (let r = 0; r < cells.length; r += 7) {
    let ws = 0;
    for (let c = 0; c < 7; c++) {
      const d = cells[r + c];
      if (!d) { h += '<div class="day blank"></div>'; continue; }
      const k = mk + '-' + pad(d), v = vals[d - 1]; ws += v;
      const ns = L('sales').filter((s) => s.date === k).length, no = L('orders').filter((o) => o.date === k || o.receivedDate === k).length;
      const s = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
      const t = Math.round(14 + 50 * Math.abs(v) / maxA);
      h += `<button class="day${k === tk ? ' today' : ''}${k > tk ? ' future' : ''}" data-a="day" data-v="${k}" aria-pressed="${k === st.selDay}"${s ? ` data-s="${s}" style="--t:${t}%"` : ''} aria-label="${d} ${MONTHS[m - 1]}: ${v ? eur(v, true) : 'sin movimientos'}">
        <span class="dn">${d}</span>${ns || no ? `<span class="pips">${'<i class="o"></i>'.repeat(Math.min(no, 1))}${'<i></i>'.repeat(Math.min(ns, 3))}</span>` : ''}<span class="dv">${v ? short(v) : ''}</span></button>`;
    }
    h += `<div class="wk"><span class="eyebrow">S${r / 7 + 1}</span><span class="num ${cls(ws)}">${ws ? short(ws) : '0'}</span></div>`;
  }
  return h + `</div><div class="legend"><span><i style="background:var(--fg)"></i>venta</span><span><i style="background:var(--warn)"></i>pedido o DHL</span><span>${st.calMode === 'profit' ? 'Cifra = beneficio del día' : 'Cifra = dinero que entra − sale ese día'}</span></div></section>`;
}
function dayPanel() {
  const k = st.selDay, d = dateOf(k);
  const title = WD[d.getDay()].replace(/^./, (c) => c.toUpperCase()) + ' ' + d.getDate() + ' de ' + MONTHS[d.getMonth()];
  const rows = dayRows(k), v = dayVal(k);
  return `<section class="card"><div class="sec-head"><div><div class="eyebrow">${st.calMode === 'profit' ? 'Beneficio del día' : 'Caja del día'}</div><h2 class="sec">${title}</h2></div><div class="num ${cls(v)}" style="font-weight:600;font-size:17px">${rows ? eur(v, true) : ''}</div></div>
    ${rows ? `<div class="rows">${rows}</div>` : '<div class="empty">Nada este día. Pulsa <b>+</b> para apuntar algo.</div>'}
    <div style="margin-top:12px"><button class="ghost" data-a="add" data-date="${k}">Añadir a este día</button></div></section>`;
}
function dayRows(k) {
  let h = '';
  L('sales').filter((s) => s.date === k).forEach((s) => { h += row('s', '€', esc(s.modelName || 'Venta'), esc((s.account ? s.account + ' · ' : '') + 'vendido a ' + eur(n0(s.price)) + ' · coste ' + eur(n0(s.cost))), `<span class="${cls(profitOf(s))}">${eur(st.calMode === 'profit' ? profitOf(s) : n0(s.price), true)}</span>`, 'sales', s.id); });
  L('orders').filter((o) => o.date === k).forEach((o) => { h += row('o', 'P', 'Pedido de stock', (o.lines || []).reduce((a, l) => a + n0(l.qty), 0) + ' relojes', st.calMode === 'profit' ? '<span class="mut">no resta beneficio</span>' : `<span class="neg">−${eur(n0(o.paid))}</span>`, null, o.id); });
  L('orders').filter((o) => o.receivedDate === k && n0(o.dhl)).forEach((o) => { h += row('o', 'D', 'Cobro DHL', 'Pedido del ' + shortDate(o.date), st.calMode === 'profit' ? '<span class="mut">va en el coste</span>' : `<span class="neg">−${eur(n0(o.dhl))}</span>`, null, o.id + 'd'); });
  L('spend').filter((x) => x.date === k).forEach((x) => { const biz = x.kind === 'negocio'; h += row(biz ? 'g' : 'p', biz ? 'N' : 'G', esc(x.cat) + (x.note ? ' · ' + esc(x.note) : ''), biz ? 'Gasto del negocio' : 'Gasto personal', `<span class="${biz || st.calMode === 'cash' ? 'neg' : 'mut'}">−${eur(n0(x.amount))}</span>`, 'spend', x.id); });
  L('income').filter((x) => x.date === k).forEach((x) => { h += row('i', '+', esc(x.note || 'Ingreso'), 'Otro ingreso', `<span class="pos">${eur(n0(x.amount), true)}</span>`, 'income', x.id); });
  return h;
}
function row(ic, icT, t1, t2, amt, col, id) {
  const key = col + '/' + id, c = st.confirm === key;
  return `<div class="row"><div class="ic ${ic}">${icT}</div><div class="tx"><div class="t1">${t1}</div><div class="t2">${t2}</div></div><div class="amt">${amt}</div>${col ? `<button class="del${c ? ' confirm' : ''}" data-a="del" data-col="${col}" data-id="${esc(id)}" aria-label="Borrar">${c ? '¿Borrar?' : '✕'}</button>` : '<span style="width:30px;flex:none"></span>'}</div>`;
}

function viewStock() {
  const seg = `<div class="seg" style="max-width:340px"><button data-a="seg" data-v="relojes" aria-pressed="${st.stockSeg === 'relojes'}">Relojes</button><button data-a="seg" data-v="pedidos" aria-pressed="${st.stockSeg === 'pedidos'}">Pedidos</button></div>`;
  if (st.stockSeg === 'pedidos') {
    const pb = payback();
    const os = L('orders').slice().sort((a, b) => b.date.localeCompare(a.date));
    const out = sum(os.map((o) => pb[o.id].cost)), back = sum(os.map((o) => Math.min(pb[o.id].rev, pb[o.id].cost)));
    return `<div class="stack">${seg}<div class="stats">${stat('Invertido en pedidos', eur(out))}${stat('Recuperado', eur(back), 'pos')}${stat('Por recuperar', eur(out - back), out - back > 0 ? 'neg' : '')}${stat('En camino', sum(L('models').map((m) => n0(m.transit))) + ' uds')}</div>
      <div class="sec-head" style="margin:0"><h2 class="sec">Pedidos</h2><button class="btn-g" data-a="add" data-mode="pedido">+ Pedido</button></div>
      ${os.length ? `<div class="models">${os.map((o) => `<article class="card">${orderBody(o, pb[o.id], false)}</article>`).join('')}</div>` : '<div class="card empty">Aún no hay pedidos. Apunta el próximo con <b>+ Pedido</b>: resta de la caja al momento y suma los relojes a "en camino".</div>'}</div>`;
  }
  const ms = L('models').slice().sort((a, b) => (SORDER[a.status] ?? 9) - (SORDER[b.status] ?? 9) || n0(a.order) - n0(b.order) || String(a.name).localeCompare(b.name));
  const live = ms.filter((m) => m.status !== 'descartado');
  const home = sum(live.map((m) => n0(m.home))), tr = sum(live.map((m) => n0(m.transit)));
  const val = sum(live.map((m) => n0(m.home) * n0(m.landed))), pot = sum(live.map((m) => n0(m.home) * n0(m.listPrice)));
  const f = st.filter, shown = ms.filter((m) => (f === 'todos' ? true : f === 'activos' ? m.status !== 'descartado' : m.status === f));
  const chips = [['activos', 'Activos'], ['ganador', 'Ganadores'], ['test', 'Test'], ['espera', 'En espera'], ['descartado', 'Descartados'], ['todos', 'Todos']]
    .map(([v, l]) => `<button class="chip" data-a="filter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('');
  const rs = restockList();
  return `<div class="stack">${seg}<div class="stats">${stat('En casa', home + ' uds')}${stat('En camino', tr + ' uds')}${stat('Stock a coste', eur(val))}${stat('Stock a precio', eur(pot))}</div>
    ${rs.length ? `<section class="card"><div class="sec-head"><div><div class="eyebrow">Reponer</div><h2 class="sec">Se te acaban</h2></div></div>${restockRows(rs)}</section>` : ''}
    <div class="sec-head" style="margin:0"><div class="chips">${chips}</div><button class="ghost" data-a="model">+ Reloj</button></div>
    <div class="models">${shown.map(modelCard).join('') || '<div class="card empty">No hay relojes en este filtro.</div>'}</div></div>`;
}
function modelCard(m) {
  const h = n0(m.home), t = n0(m.transit);
  const sold = L('sales').filter((s) => s.modelId === m.id), sp = sum(sold.map(profitOf));
  const Lc = num(m.landed), P = num(m.listPrice), mn = num(m.minPrice), marg = !isNaN(Lc) && !isNaN(P) ? P - Lc : NaN;
  const sk = STATUS[m.status] ? m.status : 'test', r = restockInfo(m);
  const id = esc(m.id);
  return `<article class="card model${m.status === 'descartado' ? ' off' : ''}">
    <div class="m-top"><div class="m-name">${esc(m.name)}</div><div class="m-pills">${r && r.need ? '<span class="pill reponer">Reponer</span>' : ''}<span class="pill ${sk}">${STATUS[sk]}</span></div></div>
    <div class="counts">
      <div class="count"><button class="step" data-a="bump" data-id="${id}" data-f="home" data-d="-1" aria-label="Quitar uno en casa">−</button><div><div class="eyebrow">En casa</div><div class="n">${h}</div></div><button class="step" data-a="bump" data-id="${id}" data-f="home" data-d="1" aria-label="Añadir uno en casa">+</button></div>
      <div class="count"><button class="step" data-a="bump" data-id="${id}" data-f="transit" data-d="-1" aria-label="Quitar uno en camino">−</button><div><div class="eyebrow">En camino</div><div class="n">${t}</div></div><button class="step" data-a="bump" data-id="${id}" data-f="transit" data-d="1" aria-label="Añadir uno en camino">+</button></div>
    </div>
    <div class="m-meta"><span>Coste <b>${isNaN(Lc) ? 'falta' : eur(Lc)}</b></span><span>Precio <b>${isNaN(P) ? '—' : eur(P)}</b></span><span>Mín <b>${isNaN(mn) ? '—' : eur(mn)}</b></span>${isNaN(marg) ? '' : `<span>Margen <b class="pos">${eur(marg, true)}</b></span>`}</div>
    ${r && r.rate ? `<div class="m-meta"><span>Últimos 14 días <b>${r.recent}</b> vendidos</span><span>Cubre <b>${r.out ? '0' : '≈' + Math.floor(r.cover)}</b> días</span></div>` : ''}
    <div class="m-foot"><span class="mut">Vendidos <b class="num" style="color:var(--fg)">${sold.length}</b>${sold.length ? ` · <span class="num ${cls(sp)}">${eur(sp, true)}</span>` : ''}</span>
      <span style="display:flex;gap:6px">${r && r.need ? `<button class="btn-g" data-a="restock" data-id="${id}" data-q="${r.sug}">Pedir ${r.sug}</button>` : ''}<button class="ghost" data-a="model" data-id="${id}">Editar</button></span></div>
  </article>`;
}

function viewSpend() {
  const mk = st.month, p = parts(mk);
  const per = on(L('spend'), mk).filter((x) => x.kind !== 'negocio');
  const byCat = {}; per.forEach((x) => { byCat[x.cat] = (byCat[x.cat] || 0) + n0(x.amount); });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...cats.map((c) => c[1]));
  const bars = cats.length ? `<div class="bars">${cats.map(([c, v]) => `<div class="bar-row"><span>${esc(c)}</span><span class="num">${eur(v)}</span><div class="bar"><i style="width:${v / mx * 100}%"></i></div></div>`).join('')}</div>` : `<div class="empty">Sin gastos personales en ${MONTHS[pm(mk).m - 1]}.</div>`;
  const list = [...on(L('spend'), mk).map((x) => ({ ...x, _t: 's' })), ...on(L('income'), mk).map((x) => ({ ...x, _t: 'i' }))].sort((a, b) => b.date.localeCompare(a.date) || (b.at || '').localeCompare(a.at || ''));
  const rows = list.map((x) => x._t === 'i'
    ? row('i', '+', esc(x.note || 'Ingreso'), shortDate(x.date) + ' · ingreso', `<span class="pos">${eur(n0(x.amount), true)}</span>`, 'income', x.id)
    : row(x.kind === 'negocio' ? 'g' : 'p', x.kind === 'negocio' ? 'N' : 'G', esc(x.cat) + (x.note ? ' · ' + esc(x.note) : ''), shortDate(x.date) + ' · ' + (x.kind === 'negocio' ? 'negocio' : 'personal'), '−' + eur(n0(x.amount)), 'spend', x.id)).join('');
  const spent = `<section class="card"><div class="sec-head"><div><div class="eyebrow">Gastado en ${MONTHS[pm(mk).m - 1]}</div><h2 class="sec num" style="font-size:22px;margin-top:4px">${eur(p.pers + p.biz)}</h2></div><button class="btn-g" data-a="add" data-mode="gasto">+ Gasto</button></div>
    <div class="kv"><span class="mut">Personal</span><span class="num">${eur(p.pers)}</span></div><div class="kv" style="margin-bottom:12px"><span class="mut">Negocio (boosts, envíos…)</span><span class="num">${eur(p.biz)}</span></div>${bars}
    ${rows ? `<div class="rows" style="margin-top:14px">${rows}</div>` : ''}</section>`;
  const months = [...new Set(L('bills').map((b) => b.month))].sort().filter((m) => m >= curMonth() || L('bills').some((b) => b.month === m && !b.paid)).slice(0, 5);
  let bl = '';
  months.forEach((m) => {
    const bs = L('bills').filter((b) => b.month === m).sort((a, b) => String(a.concept).localeCompare(b.concept));
    bl += `<div class="bill-m">${monthName(m)} · ${eur(sum(bs.filter((b) => !b.paid).map((b) => n0(b.amount))))} pendiente</div><div class="rows">${bs.map((b) => {
      const c = st.confirm === 'bills/' + b.id;
      return `<div class="row${b.paid ? ' paid' : ''}"><button class="chk" data-a="paid" data-id="${esc(b.id)}" aria-pressed="${!!b.paid}" aria-label="Marcar pagado">${b.paid ? '✓' : ''}</button><div class="tx"><div class="t1">${esc(b.concept)}</div></div><div class="amt">${eur(n0(b.amount))}</div><button class="del${c ? ' confirm' : ''}" data-a="del" data-col="bills" data-id="${esc(b.id)}" aria-label="Borrar">${c ? '¿Borrar?' : '✕'}</button></div>`;
    }).join('')}</div>`;
  });
  const bills = `<section class="card"><div class="sec-head" style="margin-bottom:0"><div><div class="eyebrow">Pagos fijos</div><div class="hint" style="margin-top:4px">Al marcarlo pagado se resta de la caja.</div></div><button class="ghost" data-a="bill">+ Pago</button></div>${bl || '<div class="empty" style="margin-top:10px">Sin pagos fijos pendientes.</div>'}</section>`;
  return `<div class="stack"><div class="sec-head" style="margin:0">${mnav()}<button class="ghost" data-a="add" data-mode="ingreso">+ Ingreso</button></div><div class="grid2">${spent}${bills}</div></div>`;
}

function fmtMetric(g, v) {
  if (g.metric === 'streak') return v + (v === 1 ? ' mes' : ' meses');
  if (g.metric === 'units') return v + ' uds';
  return eur(v);
}
function viewGoals() {
  const gs = L('goals').slice().sort((a, b) => n0(a.order) - n0(b.order));
  const cards = gs.map((g) => {
    const now = metricValue(g), tg = n0(g.target) || 1, won = now >= tg, p = Math.min(1, Math.max(0, now / tg));
    const money = g.metric !== 'streak' && g.metric !== 'units';
    let note = '';
    if (g.metric === 'streak') note = `Cuenta los meses con <b>${eur(n0(g.threshold))}</b> o más de beneficio, seguidos.`;
    if (g.metric === 'bestMonth') note = `Tu mejor mes hasta ahora: <b>${eur(now)}</b>.`;
    if (g.deadline && !won) {
      const { y, m } = pm(g.deadline), c = pm(curMonth()), left = (y - c.y) * 12 + (m - c.m) + 1;
      if (left > 0 && money) note += (note ? ' ' : '') + `Faltan <b>${eur(tg - now)}</b> → <b>${eur((tg - now) / left)}/mes</b> durante ${left} ${left === 1 ? 'mes' : 'meses'} (hasta ${monthName(g.deadline)}).`;
      else if (left <= 0) note += (note ? ' ' : '') + 'La fecha límite ya pasó.';
    }
    if (won) note = '<b style="color:var(--accent)">Conseguido.</b> ' + note;
    const bar = g.metric === 'streak' && tg <= 12 ? `<div class="ticks">${Array.from({ length: tg }, (_, i) => `<i class="${i < now ? 'on' : ''}"></i>`).join('')}</div>` : `<div class="bar thick"><i style="width:${p * 100}%"></i></div>`;
    const c = st.confirm === 'goals/' + g.id;
    return `<article class="card goal${won ? ' won' : ''}"><div class="g-top"><div><div class="eyebrow">${esc(METRICS[g.metric] || '')}</div><div class="g-title">${esc(g.title)}</div></div><button class="del${c ? ' confirm' : ''}" data-a="del" data-col="goals" data-id="${esc(g.id)}" aria-label="Borrar meta">${c ? '¿Borrar?' : '✕'}</button></div>
      <div class="g-prog"><span class="now ${won ? 'pos' : ''}">${fmtMetric(g, now)}</span><span class="mut num">de ${fmtMetric(g, tg)}</span></div>${bar}${note ? `<div class="g-note">${note}</div>` : ''}</article>`;
  }).join('');
  return `<div class="stack"><div class="sec-head" style="margin:0"><h2 class="sec">Metas</h2><button class="btn-g" data-a="goal">+ Meta</button></div>${cards ? `<div class="models">${cards}</div>` : '<div class="card empty">Aún no hay metas. Añade la primera con <b>+ Meta</b>.</div>'}</div>`;
}

/* ---------------- sheets ---------------- */
function openSheet(kind, ctx) {
  st.sheet = { kind, ctx: ctx || {} };
  sheetEl.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sh-t">${sheetHTML()}</div>`;
  sheetEl.hidden = false; document.body.classList.add('locked');
  afterSheet();
}
function redrawSheet() { const p = $('.sheet-panel', sheetEl); if (p) { p.innerHTML = sheetHTML(); afterSheet(); } }
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
      <div class="fields2">${fld('m-min', 'Precio mínimo (€)', m.minPrice)}<div></div></div>
      <div class="fields2">${fld('m-home', 'En casa', m.home || 0, 'inputmode="numeric"')}${fld('m-transit', 'En camino', m.transit || 0, 'inputmode="numeric"')}</div>
      <div class="hint">Coste puesto = precio 1688 + envío + DHL, por unidad. Se actualiza solo cuando apuntas un pedido.</div><div class="err" id="sh-err"></div>
      <button class="primary" data-a="save-model">Guardar</button>${ctx.id ? `<button class="danger" data-a="del-model">${st.confirm === 'models/' + ctx.id ? 'Pulsa otra vez para borrar' : 'Borrar reloj'}</button>` : ''}`;
  }
  if (kind === 'settings') {
    const s = S0(), ss = sync.getStatus();
    return head('AJUSTES') + `<div class="field"><label for="s-cash">Dinero que tienes ahora mismo (€)</label><input id="s-cash" inputmode="decimal" value="${esc(String(r2(cashNow())).replace('.', ','))}"></div>
      <div class="hint">Pon lo que ves en tu cuenta ahora. Desde este momento la app suma las ventas e ingresos y resta pedidos, DHL y gastos que apuntes.</div>
      <div class="fields2">${fld('s-cushion', 'Colchón: no bajar de (€)', s.cushion)}${fld('s-goal', 'Meta de beneficio al mes (€)', s.monthlyGoal)}</div>
      ${fld('s-acc', 'Cuentas de venta (separadas por comas)', (s.accounts || []).join(', '), 'autocomplete="off"')}
      <div class="err" id="sh-err"></div><button class="primary" data-a="save-settings">Guardar</button>
      <div class="card" style="padding:14px;display:grid;gap:8px"><div class="eyebrow">Sincronización</div>
        <div style="font-size:14px">${ss.enabled ? (ss.user ? `Conectado como <b>${esc(ss.user)}</b>` : 'Sin sesión') : 'Solo en este dispositivo (sin conectar)'}${ss.enabled && ss.at ? `<div class="hint">Última sincronización ${new Date(ss.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}${ss.pending ? ` · ${ss.pending} cambios por subir` : ''}</div>` : ''}${ss.error ? `<div class="hint neg">${esc(ss.error)}</div>` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${ss.enabled ? '<button class="ghost" data-a="sync-now">Sincronizar ahora</button>' : ''}<button class="ghost" data-a="export">Descargar copia</button>${ss.enabled && ss.user ? '<button class="ghost" data-a="logout">Cerrar sesión</button>' : ''}</div></div>`;
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
    <div class="fields2">${fld('f-price', 'Vendido a (€)', '', 'inputmode="decimal" placeholder="30"')}${fld('f-cost', 'Coste puesto (€)', '')}</div>
    <div class="fields2">${dateFld('f-date', ctx.date)}<div class="field"><label for="f-acc">Cuenta</label><select id="f-acc">${accs.map((a) => `<option>${esc(a)}</option>`).join('')}</select></div></div>
    <label class="check"><input type="checkbox" id="f-dec" checked> Restar 1 del stock en casa</label>
    <div class="preview"><div class="kv"><span class="mut">Beneficio</span><b id="f-prev">—</b></div><div class="kv"><span class="mut">Entra en caja</span><b id="f-cash">—</b></div></div><div class="err" id="sh-err"></div>
    <button class="primary" data-a="save-sale">Guardar venta</button>`;
}
function orderForm(ctx) {
  const ms = sortedModels().filter((m) => m.status !== 'descartado');
  if (!ctx.lines || !ctx.lines.length) ctx.lines = [{ modelId: (ms[0] || {}).id || '__new', qty: '', unit: '', name: '' }];
  const opts = (sel) => ms.map((m) => `<option value="${esc(m.id)}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join('') + `<option value="__new"${sel === '__new' ? ' selected' : ''}>+ Reloj nuevo…</option>`;
  const lines = ctx.lines.map((l, i) => `<div class="stack" style="gap:6px"><div class="line-ed">
      <div class="field"><label for="l-m-${i}">${i === 0 ? 'Reloj' : '&nbsp;'}</label><select id="l-m-${i}" data-line="${i}">${opts(l.modelId)}</select></div>
      <div class="field"><label for="l-q-${i}">${i === 0 ? 'Uds' : '&nbsp;'}</label><input id="l-q-${i}" inputmode="numeric" value="${esc(l.qty)}" placeholder="10"></div>
      <div class="field"><label for="l-u-${i}">${i === 0 ? '€/ud 1688' : '&nbsp;'}</label><input id="l-u-${i}" inputmode="decimal" value="${esc(l.unit)}" placeholder="6,50"></div>
      <button class="del" data-a="rmline" data-i="${i}" aria-label="Quitar línea" ${ctx.lines.length === 1 ? 'disabled style="opacity:.3"' : ''}>✕</button></div>
      ${l.modelId === '__new' ? `<input id="l-n-${i}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:10px 12px;font-size:15px" placeholder="Nombre del reloj nuevo" value="${esc(l.name)}" autocomplete="off">` : ''}</div>`).join('');
  return `${lines}<div><button class="ghost" data-a="addline">+ Otra línea</button></div>
    <div class="fields2">${fld('o-ship', 'Envío del agente (€)', ctx.ship || '', 'inputmode="decimal" placeholder="70"')}${dateFld('o-date', ctx.date)}</div>
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
function readLines() {
  const c = st.sheet.ctx;
  c.lines = c.lines.map((l, i) => ({ modelId: sv('l-m-' + i) || l.modelId, qty: sv('l-q-' + i), unit: sv('l-u-' + i), name: sheetEl.querySelector('#l-n-' + i) ? sv('l-n-' + i) : l.name }));
  c.ship = sv('o-ship'); c.date = sv('o-date'); c.note = sv('o-note');
  return c.lines;
}
function orderPreview() {
  const box = sheetEl.querySelector('#o-prev'); if (!box) return;
  const lines = readLines(), ship = n0(sv('o-ship'));
  const goods = sum(lines.map((l) => n0(l.qty) * n0(l.unit))), units = sum(lines.map((l) => n0(l.qty)));
  const f = goods > 0 ? (goods + ship) / goods : 1;
  box.innerHTML = `<div class="kv"><span class="mut">Relojes</span><b>${units} uds · ${eur(goods)}</b></div><div class="kv"><span class="mut">Pagas hoy</span><b class="neg">${eur(goods + ship)}</b></div>
    <div class="kv"><span class="mut">Caja después</span><b class="${cashNow() - goods - ship < 0 ? 'neg' : ''}">${eur(cashNow() - goods - ship)}</b></div>
    ${goods ? lines.filter((l) => n0(l.unit)).map((l) => { const m = model(l.modelId); return `<div class="kv"><span class="mut">Coste/ud ${esc(m ? m.name : l.name || 'nuevo')}</span><b>≈ ${eur(n0(l.unit) * f)} + DHL</b></div>`; }).join('') : ''}`;
}
function afterSheet() {
  const sel = sheetEl.querySelector('#f-model');
  if (sel) {
    const prev = () => {
      const p = num(sv('f-price')), c = num(sv('f-cost')), o = $('#f-prev', sheetEl), k = $('#f-cash', sheetEl);
      k.textContent = isNaN(p) ? '—' : eur(p, true); k.className = isNaN(p) ? '' : 'pos';
      if (isNaN(p) || isNaN(c)) { o.textContent = '—'; o.className = ''; return; }
      o.textContent = eur(p - c, true); o.className = cls(p - c);
    };
    const sync_ = () => {
      const m = model(sel.value), c = $('#f-cost', sheetEl);
      c.value = m && !isNaN(num(m.landed)) ? String(m.landed).replace('.', ',') : '';
      $('#f-dec', sheetEl).checked = !!m && n0(m.home) > 0; prev();
    };
    sel.addEventListener('change', sync_);
    $('#f-price', sheetEl).addEventListener('input', prev); $('#f-cost', sheetEl).addEventListener('input', prev);
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
      const dhl = n0(sv('r-dhl')), goods = n0(o.goods), f = goods > 0 ? (goods + n0(o.shipping) + dhl) / goods : 1;
      rp.innerHTML = `<div class="kv"><span class="mut">Coste total del pedido</span><b>${eur(n0(o.paid) + dhl)}</b></div>` + (o.lines || []).map((l) => { const m = model(l.modelId); return `<div class="kv"><span class="mut">Coste puesto ${esc(m ? m.name : l.name || '')}</span><b>${eur(r2(n0(l.unit) * f))}</b></div>`; }).join('');
    };
    sheetEl.querySelector('#r-dhl').addEventListener('input', up); up();
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
  await db.put(C.sales, { date, at: nowISO(), modelId: m.id, modelName: m.name, price: r2(price), cost: r2(cost), profit: r2(price - cost), account: sv('f-acc'), fromStock: dec });
  const patch = {}; if (dec) patch.home = n0(m.home) - 1; if (isNaN(num(m.landed))) patch.landed = r2(cost);
  if (Object.keys(patch).length) await db.patch(C.models, m.id, patch);
  closeSheet(); st.selDay = date; st.month = date.slice(0, 7); toast('Venta guardada · ' + eur(price - cost, true));
}
async function saveOrder() {
  const lines = readLines(), ship = num(sv('o-ship')), date = sv('o-date');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  for (const l of lines) {
    if (l.modelId === '__new' && !l.name) return shErr('Ponle nombre al reloj nuevo.');
    if (!(parseInt(l.qty, 10) > 0)) return shErr('Pon cuántas unidades de cada reloj.');
    if (!(num(l.unit) > 0)) return shErr('Pon el precio por unidad de 1688 de cada línea.');
  }
  const out = [];
  for (const l of lines) {
    let mid = l.modelId;
    if (mid === '__new') { const m = await db.put(C.models, { name: l.name, status: 'test', home: 0, transit: 0, order: L('models').length + 1 }); mid = m.id; }
    const m = model(mid);
    out.push({ modelId: mid, name: m ? m.name : l.name, qty: parseInt(l.qty, 10), unit: r2(num(l.unit)) });
  }
  const goods = r2(sum(out.map((l) => l.qty * l.unit))), sh = isNaN(ship) ? 0 : r2(ship), f = (goods + sh) / goods;
  await db.put(C.orders, { date, at: nowISO(), note: sv('o-note'), lines: out, goods, shipping: sh, paid: r2(goods + sh), dhl: 0, status: 'camino' });
  const byModel = {}; out.forEach((l) => { byModel[l.modelId] = byModel[l.modelId] || { qty: 0, unit: l.unit }; byModel[l.modelId].qty += l.qty; });
  for (const id in byModel) { const m = model(id); await db.patch(C.models, id, { transit: n0(m && m.transit) + byModel[id].qty, landed: r2(byModel[id].unit * f) }); }
  closeSheet(); st.tab = 'stock'; st.stockSeg = 'pedidos'; lsSet('lg_seg', 'pedidos'); location.hash = 'stock'; toast('Pedido guardado · −' + eur(goods + sh) + ' de caja');
}
async function saveReceive() {
  const o = db.get(C.orders, st.sheet.ctx.id); if (!o) return closeSheet();
  const dhl = num(sv('r-dhl')), date = sv('r-date');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  const d = isNaN(dhl) ? 0 : r2(dhl), goods = n0(o.goods), f = goods > 0 ? (goods + n0(o.shipping) + d) / goods : 1;
  await db.patch(C.orders, o.id, { status: 'recibido', dhl: d, receivedDate: date, receivedAt: nowISO() });
  const byModel = {}; (o.lines || []).forEach((l) => { byModel[l.modelId] = byModel[l.modelId] || { qty: 0, unit: l.unit }; byModel[l.modelId].qty += n0(l.qty); });
  for (const id in byModel) { const m = model(id); if (!m) continue; await db.patch(C.models, id, { transit: Math.max(0, n0(m.transit) - byModel[id].qty), home: n0(m.home) + byModel[id].qty, landed: r2(n0(byModel[id].unit) * f) }); }
  closeSheet(); toast('Recibido · relojes pasados a casa');
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
  const data = { name, status: sv('m-status'), landed: opt(sv('m-landed')), listPrice: opt(sv('m-list')), minPrice: opt(sv('m-min')), home: Math.max(0, Math.round(n0(sv('m-home')))), transit: Math.max(0, Math.round(n0(sv('m-transit')))) };
  if (id) await db.patch(C.models, id, data);
  else await db.put(C.models, { ...data, order: L('models').length + 1 });
  closeSheet(); toast('Guardado');
}
async function saveSettings() {
  const cash = num(sv('s-cash')), cush = num(sv('s-cushion')), g = num(sv('s-goal'));
  if (isNaN(cash)) return shErr('Pon el dinero que tienes ahora.');
  if (isNaN(g) || g <= 0) return shErr('Pon tu meta mensual.');
  const accs = sv('s-acc').split(',').map((s) => s.trim()).filter(Boolean);
  const cur = S0(), patch = { cushion: isNaN(cush) ? 0 : r2(cush), monthlyGoal: r2(g), accounts: accs.length ? accs : cur.accounts };
  if (r2(cash) !== r2(cashNow())) { patch.cash = r2(cash); patch.cashAt = nowISO(); }
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
    const m = s && s.fromStock && model(s.modelId); if (m) await db.patch(C.models, m.id, { home: n0(m.home) + 1 });
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
function exportBackup() {
  const data = JSON.stringify({ app: 'ooq-ledger', at: nowISO(), records: db.exportRecords().filter((r) => r.col.startsWith('lg-')) }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'ooq-ledger-' + todayKey() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- events ---------------- */
const SAVE = { 'save-sale': saveSale, 'save-order': saveOrder, 'save-receive': saveReceive, 'save-spend': saveSpend, 'save-income': saveIncome, 'save-model': saveModel, 'save-settings': saveSettings, 'save-bill': saveBill, 'save-goal': saveGoal };
function setTab(v) { st.tab = v; lsSet('lg_tab', v); if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v); window.scrollTo(0, 0); renderSoon(); }
document.addEventListener('click', async (e) => {
  if (e.target === sheetEl) { closeSheet(); return; }
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a !== 'del' && a !== 'del-model' && st.confirm) { st.confirm = null; renderSoon(); }
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
    case 'settings': openSheet('settings'); break;
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

/* ---------------- login ---------------- */
function loginView(done) {
  let email = lsGet('lg-login-email', '');
  const step1 = () => {
    app.innerHTML = `<div class="wrap login"><form class="card" novalidate><img src="icons/icon-192.png" alt=""><h1>OOQ LEDGER</h1><p>Entra con tu email. Te llega un código.</p>
      <div class="field"><label for="lg-email">Email</label><input id="lg-email" type="email" autocomplete="email" inputmode="email" value="${esc(email)}"></div>
      <div class="err" id="lg-err"></div><button class="primary" type="submit">Enviar código</button>${email ? '<button class="ghost" type="button" id="lg-have" style="justify-self:center">Ya tengo un código</button>' : ''}</form></div>`;
    $('#lg-have')?.addEventListener('click', step2);
    $('form', app).addEventListener('submit', async (e) => {
      e.preventDefault(); email = $('#lg-email').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) { $('#lg-err').textContent = 'Pon un email válido.'; return; }
      const btn = $('button[type=submit]', app); btn.disabled = true; btn.textContent = 'Enviando…';
      try { await sync.sendLoginEmail(email); lsSet('lg-login-email', email); step2(); }
      catch (ex) { $('#lg-err').textContent = navigator.onLine ? ex.message || 'No se pudo enviar el email.' : 'Sin conexión. Conéctate para entrar la primera vez.'; btn.disabled = false; btn.textContent = 'Enviar código'; }
    });
  };
  const step2 = () => {
    app.innerHTML = `<div class="wrap login"><form class="card" novalidate><h1>MIRA TU EMAIL</h1><p>Enviado a <b style="color:var(--fg)">${esc(email)}</b>. Escribe el código o pulsa el enlace del email.</p>
      <div class="field"><label for="lg-code">Código</label><input id="lg-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" style="font-family:var(--f-num);font-size:24px;letter-spacing:.2em"></div>
      <div class="err" id="lg-err"></div><button class="primary" type="submit">Entrar</button><button class="ghost" type="button" id="lg-back" style="justify-self:center">Usar otro email</button></form></div>`;
    $('#lg-back').addEventListener('click', step1);
    $('form', app).addEventListener('submit', async (e) => {
      e.preventDefault(); const code = $('#lg-code').value.replace(/\D/g, '');
      if (code.length < 6) { $('#lg-err').textContent = 'Escribe el código del email.'; return; }
      try { await sync.verifyCode(email, code); finish(); } catch (ex) { $('#lg-err').textContent = ex.message || 'Ese código no funciona.'; }
    });
  };
  const poll = setInterval(() => { if (sync.knownUser()) finish(); }, 1000);
  let finished = false;
  function finish() { if (finished) return; finished = true; clearInterval(poll); done(); }
  step1();
}

/* ---------------- boot ---------------- */
async function boot() {
  await db.init();
  if (sync.configured()) {
    await sync.currentSession().catch(() => null);
    if (!sync.knownUser()) { await new Promise((res) => loginView(res)); }
    // pull what already exists before seeding, so a second device doesn't start from the defaults
    await sync.syncNow().catch(() => {});
  }
  await seedIfEmpty();
  shell(); render();
  db.subscribe(() => renderSoon());
  sync.onStatus(updatePill);
  sync.start();
  setInterval(() => { if (document.visibilityState === 'visible') renderSoon(); }, 60000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch((e) => { console.error(e); app.innerHTML = `<div class="wrap login"><div class="card"><h1>ERROR</h1><p>${esc(e.message || e)}</p></div></div>`; });
