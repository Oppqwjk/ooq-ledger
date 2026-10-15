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
// cost of one watch: the real one if known, otherwise the estimate from Ajustes
const costOf = (m) => (m && !isNaN(num(m.landed)) ? num(m.landed) : n0(S0().defaultCost));
const isEst = (m) => !m || isNaN(num(m.landed));
// pouches: a supply that goes with some sales, not a product
const pouchCost = () => { const s = S0(); return n0(s.pouchCost !== undefined ? s.pouchCost : s.perSale); };
const pouches = () => n0(S0().pouches);
async function patchSettings(p) { await db.put(C.settings, { ...(db.get(C.settings, 'settings') || DEF), ...p, id: 'settings' }); }
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
  return { rate, recent, cover, need: cover < 10, out: home + tr === 0, sug, unit: lastUnit, cost: sug * (lastUnit ? lastUnit * 1.25 : costOf(m)) };
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
  app.innerHTML = `<header class="ribbon"><div class="wrap rib-in">
      <div class="brand"><img src="icons/icon-192.png" alt=""><b>OOQ Ledger</b></div>
      <nav class="toptabs" aria-label="Secciones">${TABS.map(([k, l]) => `<button data-a="tab" data-v="${k}">${l}</button>`).join('')}</nav>
      <div class="top-r"><button class="syncpill" data-a="settings" id="syncpill"><i></i><span>Local</span></button>
      <button class="iconbtn" data-a="settings" aria-label="Ajustes"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button></div>
    </div></header>
    ${sync.configured() ? '' : '<div class="wrap"><div class="banner">Modo local: los datos solo están en este dispositivo.</div></div>'}
    <main id="main" class="wrap"></main>
    <button class="fab" data-a="add" aria-label="Añadir">+</button>
    <nav class="tabbar" aria-label="Secciones">${TABS.map(([k, l]) => `<button data-a="tab" data-v="${k}">${l}</button>`).join('')}</nav>`;
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

// spreadsheet building blocks
const panel = (title, body, right = '') => `<section class="panel"><div class="ph"><span>${title}</span>${right ? `<span class="ph-r">${right}</span>` : ''}</div>${body}</section>`;
const money = (v, sign) => `<span class="${v < 0 ? 'neg' : sign && v > 0 ? 'pos' : ''}">${eur(v, sign)}</span>`;
const pbar = (p, cls2 = '') => `<div class="pbar ${cls2}"><i style="width:${Math.min(100, Math.max(0, p * 100))}%"></i></div>`;
const tr = (label, val, cl = '') => `<tr class="${cl}"><th>${label}</th><td class="n">${val}</td></tr>`;
const mnav = () => `<div class="mnav"><button data-a="mprev" aria-label="Mes anterior">‹</button><div class="ml">${monthName(st.month)}</div><button data-a="mnext" aria-label="Mes siguiente">›</button></div>`;
const empty = (t) => `<div class="empty">${t}</div>`;
const xbtn = (col, id) => { const c = st.confirm === col + '/' + id; return `<button class="del${c ? ' confirm' : ''}" data-a="del" data-col="${col}" data-id="${esc(id)}" aria-label="Borrar">${c ? '¿Borrar?' : '×'}</button>`; };

function spark(mk) {
  const n = daysIn(mk), g = goal(), cm = curMonth();
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
  const p = parts(mk), g = goal(), cm = curMonth();
  let pace = '';
  if (mk === cm) {
    const left = daysIn(mk) - new Date().getDate(), rem = g - p.net;
    pace = rem <= 0 ? tr('Meta', '<span class="pos">cumplida</span>') : tr(`Falta por día (${left} días)`, eur(rem / Math.max(1, left)));
  }
  return `<table class="xl"><tbody>
    ${tr('Ventas (' + p.nSales + ')', money(p.revenue, true))}
    ${p.income ? tr('Otros ingresos', money(p.income, true)) : ''}
    ${tr('Pedidos de stock', money(-p.orders))}
    ${tr('Gastos negocio', money(-p.biz))}
    ${tr('Gastos personales', money(-p.pers))}
    ${tr('Flujo de caja', money(p.flow, true), 'tot')}
    ${tr('Beneficio', money(p.net, true), 'tot2')}
    <tr><th>Meta ${eur(g)}</th><td class="n barcell">${pbar(p.net / g)}<span>${Math.max(0, Math.round(p.net / g * 100))}%</span></td></tr>
    ${pace}
  </tbody></table>`;
}

function viewHome() {
  const cm = curMonth(), cash = cashNow(), sp = spendable(), s = S0(), pb = payback(), pend = pendingBills();
  const caja = panel('Caja', `<table class="xl"><tbody>
    <tr class="big"><th>Caja real</th><td class="n">${money(cash)}</td></tr>
    ${tr('Pagos fijos pendientes', money(-pend))}
    ${n0(s.cushion) ? tr('Colchón', money(-n0(s.cushion))) : ''}
    ${tr('Puedes gastar', money(sp), 'tot')}
  </tbody></table>`, '<button class="lnk" data-a="settings">Ajustar</button>');
  const month = panel(monthName(cm), monthTable(cm));
  const open = L('orders').filter((o) => o.status !== 'recibido' || pb[o.id].rev < pb[o.id].cost).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const orders = panel('Pedidos sin recuperar', open.length ? `<table class="xl list"><thead><tr><th>Pedido</th><th class="n">Coste</th><th class="n">Recuperado</th></tr></thead><tbody>${open.map((o) => {
    const r = pb[o.id], p = r.cost ? r.rev / r.cost : 0;
    return `<tr class="click" data-a="order" data-id="${esc(o.id)}"><td>${shortDate(o.date)} <span class="sub">${r.sold}/${r.units} vendidos</span></td><td class="n">${eur(r.cost)}</td><td class="n barcell">${pbar(p)}<span>${Math.round(p * 100)}%</span></td></tr>`;
  }).join('')}</tbody></table>` : empty('Nada pendiente. Al apuntar un pedido verás aquí cuánto te falta para recuperarlo.'), '<button class="lnk" data-a="goto-orders">Ver todos</button>');
  const rs = restockList();
  const restock = panel('Reponer', rs.length ? restockTable(rs) : empty('Ningún reloj que se vende se queda sin stock en 10 días.'));
  const gs = L('goals').slice().sort((a, b) => n0(a.order) - n0(b.order));
  const goals = gs.length ? panel('Metas', goalsTable(gs, true), '<button class="lnk" data-a="tab" data-v="metas">Ver</button>') : '';
  return `<div class="cols"><div class="col">${caja}${month}</div><div class="col">${orders}${restock}${goals}</div></div>`;
}
function restockList() {
  return L('models').map((m) => ({ m, r: restockInfo(m) })).filter((x) => x.r && x.r.need).sort((a, b) => a.r.cover - b.r.cover);
}
function restockTable(rs) {
  return `<table class="xl list"><thead><tr><th>Reloj</th><th class="n">14 días</th><th class="n">Quedan</th><th class="n">Pedir</th></tr></thead><tbody>${rs.map(({ m, r }) => `
    <tr><td>${esc(m.name)}</td><td class="n">${r.recent}</td><td class="n ${r.out ? 'neg' : ''}">${n0(m.home) + n0(m.transit)}</td>
    <td class="n"><button class="cellbtn" data-a="restock" data-id="${esc(m.id)}" data-q="${r.sug}">${r.sug} uds</button></td></tr>`).join('')}</tbody></table>
    <div class="foot">Ritmo de ventas de 14 días, para cubrir 30 días.${rs.some((x) => x.r.cost) ? ` Coste aprox.: ${eur(Math.round(sum(rs.map((x) => x.r.cost || 0))))}.` : ''}</div>`;
}
function orderBody(o, pb) {
  const cost = pb.cost, rec = pb.rev, pct = cost ? Math.min(1, rec / cost) : 0, gap = cost - rec;
  return `<table class="xl"><tbody>
    ${tr('Fecha', shortDate(o.date) + (o.note ? ' · ' + esc(o.note) : ''))}
    ${tr('Estado', o.status === 'recibido' ? `<span class="pos">Recibido ${shortDate(o.receivedDate)}</span>` : '<span class="warn">En camino</span>')}
    ${(o.lines || []).map((l) => { const m = model(l.modelId); return tr(esc(m ? m.name : l.name || 'Reloj'), `${n0(l.qty)} × ${eur(n0(l.unit))}`); }).join('')}
    ${o.pouches ? tr('Bolsitas', `${n0(o.pouches.qty)} × ${eur(n0(o.pouches.unit))}`) : ''}
    ${tr('Pagado al pedir', eur(n0(o.paid)))}
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
  return `<div class="toolbar">${mnav()}<div class="seg sm"><button data-a="calmode" data-v="profit" aria-pressed="${mode === 'profit'}">Beneficio</button><button data-a="calmode" data-v="cash" aria-pressed="${mode === 'cash'}">Caja</button></div></div>
    <div class="cols wide"><div class="col">${panel(mode === 'profit' ? 'Beneficio por día' : 'Dinero que entra − sale por día', calGrid(mk))}${panel('Total del mes', monthTable(mk))}</div>
    <div class="col">${dayPanel()}${mode === 'profit' ? panel('Acumulado', spark(mk)) : ''}</div></div>`;
}
function dayVal(k) { const p = parts(k); return st.calMode === 'profit' ? p.net : p.flow; }
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
        <span class="dn">${d}${no ? '<i class="od"></i>' : ''}</span><span class="dv">${v ? short(v) : ''}</span></button>`;
    }
    h += `<div class="wk"><span class="${cls(ws)}">${ws ? short(ws) : '·'}</span></div>`;
  }
  return h + '</div>';
}
function dayPanel() {
  const k = st.selDay, d = dateOf(k);
  const title = WD[d.getDay()].replace(/^./, (c) => c.toUpperCase()) + ' ' + d.getDate() + ' de ' + MONTHS[d.getMonth()];
  const rows = dayRows(k), v = dayVal(k);
  return panel(title, (rows ? `<table class="xl list"><tbody>${rows}${tr('Total del día', money(v, true), 'tot')}</tbody></table>` : empty('Nada este día.')) +
    `<div class="foot"><button class="lnk" data-a="add" data-date="${k}">+ Añadir a este día</button></div>`);
}
function line(label, sub, amount, col, id) {
  return `<tr><td>${label}${sub ? ` <span class="sub">${sub}</span>` : ''}</td><td class="n">${amount}</td><td class="x">${col ? xbtn(col, id) : ''}</td></tr>`;
}
function dayRows(k) {
  let h = '';
  const prof = st.calMode === 'profit';
  L('sales').filter((s) => s.date === k).forEach((s) => { h += line(esc(s.modelName || 'Venta'), 'vendido ' + eur(n0(s.price)) + (s.account ? ' · ' + esc(s.account) : ''), money(prof ? profitOf(s) : n0(s.price), true), 'sales', s.id); });
  L('orders').filter((o) => o.date === k).forEach((o) => { h += line('Pedido de stock', (o.lines || []).reduce((a, l) => a + n0(l.qty), 0) + ' relojes', prof ? '<span class="sub">no resta beneficio</span>' : money(-n0(o.paid)), null, o.id); });
  L('orders').filter((o) => o.receivedDate === k && n0(o.dhl)).forEach((o) => { h += line('Cobro DHL', 'pedido ' + shortDate(o.date), prof ? '<span class="sub">va en el coste</span>' : money(-n0(o.dhl)), null, o.id + 'd'); });
  L('spend').filter((x) => x.date === k).forEach((x) => { const biz = x.kind === 'negocio'; h += line(esc(x.cat) + (x.note ? ' · ' + esc(x.note) : ''), biz ? 'negocio' : 'personal', biz || !prof ? money(-n0(x.amount)) : `<span class="sub">${eur(-n0(x.amount))}</span>`, 'spend', x.id); });
  L('income').filter((x) => x.date === k).forEach((x) => { h += line(esc(x.note || 'Ingreso'), 'ingreso', money(n0(x.amount), true), 'income', x.id); });
  return h;
}

function viewStock() {
  const seg = `<div class="seg"><button data-a="seg" data-v="relojes" aria-pressed="${st.stockSeg === 'relojes'}">Relojes</button><button data-a="seg" data-v="pedidos" aria-pressed="${st.stockSeg === 'pedidos'}">Pedidos</button></div>`;
  if (st.stockSeg === 'pedidos') {
    const pb = payback();
    const os = L('orders').slice().sort((a, b) => b.date.localeCompare(a.date));
    const out = sum(os.map((o) => pb[o.id].cost)), back = sum(os.map((o) => Math.min(pb[o.id].rev, pb[o.id].cost)));
    const sumT = `<table class="xl"><tbody>${tr('Invertido en pedidos', eur(out))}${tr('Recuperado', money(back))}${tr('Por recuperar', money(-(out - back)), 'tot')}${tr('Relojes en camino', sum(L('models').map((m) => n0(m.transit))) + ' uds')}</tbody></table>`;
    const list = os.length ? `<table class="xl list"><thead><tr><th>Pedido</th><th class="n">Uds</th><th class="n">Coste</th><th class="n">Recuperado</th></tr></thead><tbody>${os.map((o) => {
      const r = pb[o.id], p = r.cost ? r.rev / r.cost : 0;
      return `<tr class="click" data-a="order" data-id="${esc(o.id)}"><td>${shortDate(o.date)} <span class="sub ${o.status === 'recibido' ? '' : 'warn'}">${o.status === 'recibido' ? 'recibido' : 'en camino'}</span></td><td class="n">${r.units}</td><td class="n">${eur(r.cost)}</td><td class="n barcell">${pbar(p)}<span>${Math.round(p * 100)}%</span></td></tr>`;
    }).join('')}</tbody></table><div class="foot">Toca un pedido para ver el detalle o marcar que ha llegado.</div>` : empty('Aún no hay pedidos. Al guardar uno se resta de la caja y los relojes pasan a "en camino".');
    return `<div class="toolbar">${seg}<button class="btn-g" data-a="add" data-mode="pedido">+ Pedido</button></div><div class="cols"><div class="col">${panel('Resumen', sumT)}</div><div class="col">${panel('Pedidos', list)}</div></div>`;
  }
  const ms = L('models').slice().sort((a, b) => (SORDER[a.status] ?? 9) - (SORDER[b.status] ?? 9) || n0(a.order) - n0(b.order) || String(a.name).localeCompare(b.name));
  const live = ms.filter((m) => m.status !== 'descartado');
  const home = sum(live.map((m) => n0(m.home))), trn = sum(live.map((m) => n0(m.transit)));
  const val = sum(live.map((m) => n0(m.home) * costOf(m))), pot = sum(live.map((m) => n0(m.home) * n0(m.listPrice)));
  const f = st.filter, shown = ms.filter((m) => (f === 'todos' ? true : f === 'activos' ? m.status !== 'descartado' : m.status === f));
  const chips = [['activos', 'Activos'], ['ganador', 'Ganadores'], ['test', 'Test'], ['espera', 'En espera'], ['descartado', 'Descartados'], ['todos', 'Todos']]
    .map(([v, l]) => `<button class="chip" data-a="filter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('');
  const rs = restockList();
  const sumT = `<table class="xl"><tbody>${tr('En casa', home + ' uds')}${tr('En camino', trn + ' uds')}${tr('Stock a coste', eur(val))}${tr('Stock a precio de venta', eur(pot), 'tot')}${tr('Bolsitas en casa', `<span class="${pouches() < 5 ? 'neg' : ''}">${pouches()}</span> <span class="sub" style="display:inline">· ${eur(pouchCost())}/ud</span>`)}</tbody></table><div class="foot"><button class="lnk" data-a="settings">Cambiar bolsitas</button></div>`;
  const table = `<div class="tscroll"><table class="xl list stock"><thead><tr><th>Reloj</th><th class="n">Casa</th><th class="n">Cam.</th><th class="n">Coste</th><th class="n">Precio</th><th class="n">Vend.</th></tr></thead><tbody>${shown.map((m) => {
    const sold = L('sales').filter((s) => s.modelId === m.id).length, r = restockInfo(m), est = isEst(m);
    const stt = STATUS[m.status] ? m.status : 'test';
    return `<tr class="click${m.status === 'descartado' ? ' off' : ''}" data-a="model" data-id="${esc(m.id)}"><td>${esc(m.name)}<span class="sub st-${stt}">${STATUS[stt]}${r && r.need ? ' · <b class="neg">reponer</b>' : ''}</span></td>
      <td class="n">${n0(m.home)}</td><td class="n">${n0(m.transit) || '·'}</td><td class="n ${est ? 'est' : ''}">${est ? '≈' : ''}${eur(costOf(m)).replace(/\s?€/, '')}</td><td class="n">${isNaN(num(m.listPrice)) ? '·' : eur(num(m.listPrice)).replace(/\s?€/, '')}</td><td class="n">${sold || '·'}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No hay relojes en este filtro.</td></tr>'}</tbody></table></div><div class="foot">Toca un reloj para cambiar stock, coste o precio. ≈ = coste estimado.</div>`;
  return `<div class="toolbar">${seg}<button class="btn-g" data-a="model">+ Reloj</button></div>
    <div class="cols wide"><div class="col">${panel('Relojes', `<div class="filters">${chips}</div>` + table)}</div>
    <div class="col">${panel('Resumen', sumT)}${rs.length ? panel('Reponer', restockTable(rs)) : ''}</div></div>`;
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
  return `<div class="toolbar"><span class="ttl">Metas</span><button class="btn-g" data-a="goal">+ Meta</button></div>${panel('Progreso', gs.length ? goalsTable(gs, false) : empty('Aún no hay metas.'))}`;
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
  if (kind === 'order') {
    const o = db.get(C.orders, ctx.id); if (!o) return head('PEDIDO') + empty('Este pedido ya no existe.');
    const pb = payback()[o.id], c = st.confirm === 'orders/' + o.id;
    return head('PEDIDO ' + shortDate(o.date).toUpperCase()) + orderBody(o, pb) +
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
      <div class="fields2">${fld('s-defcost', 'Coste por reloj si no sabes el exacto (€)', s.defaultCost)}<div></div></div>
      <div class="fields2">${fld('s-pouches', 'Bolsitas en casa', pouches(), 'inputmode="numeric"')}${fld('s-pouchcost', 'Coste por bolsita (€)', pouchCost())}</div>
      <div class="hint">Con un número aproximado basta. Cuando sepas el coste real de un reloj, ponlo en Stock → Editar y se usará ese.</div>
      ${fld('s-acc', 'Cuentas de venta (separadas por comas)', (s.accounts || []).join(', '), 'autocomplete="off"')}
      <div class="err" id="sh-err"></div><button class="primary" data-a="save-settings">Guardar</button>
      <button class="ghost" data-a="theme" style="justify-self:start">${document.documentElement.dataset.theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}</button>
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
    <div class="fields2">${fld('f-price', 'Vendido a (€)', '', 'inputmode="decimal" placeholder="30"')}${fld('f-cost', 'Coste del reloj (€)', '')}</div>
    <div class="hint" id="f-esthint"></div>
    <label class="check"><input type="checkbox" id="f-pouch"${lsGet('lg_pouch', '1') === '1' ? ' checked' : ''}> Va con bolsita (${eur(pouchCost())} · quedan ${pouches()})</label>
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
    <div class="fields2">${fld('o-pq', 'Bolsitas (uds)', ctx.pq || '', 'inputmode="numeric" placeholder="0"')}${fld('o-pu', '€/bolsita en 1688', ctx.pu || '', 'inputmode="decimal" placeholder="0,30"')}</div>
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
  c.ship = sv('o-ship'); c.date = sv('o-date'); c.note = sv('o-note'); c.pq = sv('o-pq'); c.pu = sv('o-pu');
  return c.lines;
}
function orderPreview() {
  const box = sheetEl.querySelector('#o-prev'); if (!box) return;
  const lines = readLines(), ship = n0(sv('o-ship')), pg = n0(sv('o-pq')) * n0(sv('o-pu'));
  const wgoods = sum(lines.map((l) => n0(l.qty) * n0(l.unit))), goods = wgoods + pg, units = sum(lines.map((l) => n0(l.qty)));
  const f = goods > 0 ? (goods + ship) / goods : 1;
  box.innerHTML = `<div class="kv"><span class="mut">Relojes</span><b>${units} uds · ${eur(wgoods)}</b></div>${pg ? `<div class="kv"><span class="mut">Bolsitas</span><b>${n0(sv('o-pq'))} uds · ${eur(pg)}</b></div>` : ''}<div class="kv"><span class="mut">Pagas hoy</span><b class="neg">${eur(goods + ship)}</b></div>
    <div class="kv"><span class="mut">Caja después</span><b class="${cashNow() - goods - ship < 0 ? 'neg' : ''}">${eur(cashNow() - goods - ship)}</b></div>
    ${goods ? lines.filter((l) => n0(l.unit)).map((l) => { const m = model(l.modelId); return `<div class="kv"><span class="mut">Coste/ud ${esc(m ? m.name : l.name || 'nuevo')}</span><b>≈ ${eur(n0(l.unit) * f)} + DHL</b></div>`; }).join('') : ''}`;
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
  const withPouch = $('#f-pouch', sheetEl).checked, extra = withPouch ? pouchCost() : 0, pouchFromStock = withPouch && pouches() > 0, est = isEst(m) && r2(cost) === r2(n0(S0().defaultCost));
  await db.put(C.sales, { date, at: nowISO(), modelId: m.id, modelName: m.name, price: r2(price), cost: r2(cost + extra), watchCost: r2(cost), extra: r2(extra), estimated: est, profit: r2(price - cost - extra), account: sv('f-acc'), fromStock: dec, pouch: withPouch, pouchFromStock });
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
  }
  const out = [];
  for (const l of lines) {
    let mid = l.modelId;
    if (mid === '__new') { const m = await db.put(C.models, { name: l.name, status: 'test', home: 0, transit: 0, order: L('models').length + 1 }); mid = m.id; }
    const m = model(mid);
    out.push({ modelId: mid, name: m ? m.name : l.name, qty: parseInt(l.qty, 10), unit: r2(num(l.unit)) });
  }
  const goods = r2(sum(out.map((l) => l.qty * l.unit)) + (pq ? pq * pu : 0)), sh = isNaN(ship) ? 0 : r2(ship), f = (goods + sh) / goods;
  await db.put(C.orders, { date, at: nowISO(), note: sv('o-note'), lines: out, pouches: pq ? { qty: pq, unit: r2(pu) } : null, goods, shipping: sh, paid: r2(goods + sh), dhl: 0, status: 'camino' });
  const byModel = {}; out.forEach((l) => { byModel[l.modelId] = byModel[l.modelId] || { qty: 0, unit: l.unit }; byModel[l.modelId].qty += l.qty; });
  for (const id in byModel) { const m = model(id); await db.patch(C.models, id, { transit: n0(m && m.transit) + byModel[id].qty, landed: r2(byModel[id].unit * f) }); }
  closeSheet(); st.tab = 'stock'; st.stockSeg = 'pedidos'; lsSet('lg_seg', 'pedidos'); location.hash = 'stock'; renderSoon(); toast('Pedido guardado · −' + eur(goods + sh) + ' de caja');
}
async function saveReceive() {
  const o = db.get(C.orders, st.sheet.ctx.id); if (!o) return closeSheet();
  const dhl = num(sv('r-dhl')), date = sv('r-date');
  if (!validDate(date)) return shErr('Pon una fecha válida.');
  const d = isNaN(dhl) ? 0 : r2(dhl), goods = n0(o.goods), f = goods > 0 ? (goods + n0(o.shipping) + d) / goods : 1;
  await db.patch(C.orders, o.id, { status: 'recibido', dhl: d, receivedDate: date, receivedAt: nowISO() });
  const byModel = {}; (o.lines || []).forEach((l) => { byModel[l.modelId] = byModel[l.modelId] || { qty: 0, unit: l.unit }; byModel[l.modelId].qty += n0(l.qty); });
  for (const id in byModel) { const m = model(id); if (!m) continue; await db.patch(C.models, id, { transit: Math.max(0, n0(m.transit) - byModel[id].qty), home: n0(m.home) + byModel[id].qty, landed: r2(n0(byModel[id].unit) * f) }); }
  if (o.pouches && o.pouches.qty) await patchSettings({ pouches: pouches() + n0(o.pouches.qty), pouchCost: r2(n0(o.pouches.unit) * f) });
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
  const dc = num(sv('s-defcost')), pc = num(sv('s-pouchcost')), pq = num(sv('s-pouches'));
  const cur = S0(), patch = { cushion: isNaN(cush) ? 0 : r2(cush), monthlyGoal: r2(g), defaultCost: isNaN(dc) ? 10 : r2(dc), pouchCost: isNaN(pc) ? 0 : r2(pc), pouches: isNaN(pq) ? 0 : Math.max(0, Math.round(pq)), accounts: accs.length ? accs : cur.accounts };
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
  if (a !== 'del' && a !== 'del-model' && a !== 'del-order' && st.confirm) { st.confirm = null; renderSoon(); }
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
  shell(); render();
  db.subscribe(() => renderSoon());
  sync.onStatus(updatePill);
  sync.start();
  setInterval(() => { if (document.visibilityState === 'visible') renderSoon(); }, 60000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch((e) => { console.error(e); app.innerHTML = `<div class="wrap login"><div class="card"><h1>ERROR</h1><p>${esc(e.message || e)}</p></div></div>`; });
