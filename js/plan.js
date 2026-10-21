// Stock + cash planner. Automatic: for every winner family it simulates the next weeks day by day
// (stock at home, what lands and when, what sells at its in-stock pace) together with your money
// (bank + Vinted, pending sales released, sales still to come, fixed payments, debt, orders).
// Out of that it decides the next order: the date, how many of each colour, what it costs and whether the money is there.

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const dk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const dOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addD = (k, n) => { const d = dOf(k); d.setDate(d.getDate() + n); return dk(d); };
const diffD = (a, b) => Math.round((dOf(b) - dOf(a)) / DAY);
const n0 = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const ceil5 = (x) => Math.ceil(x / 5) * 5;
// Season: Black Friday week ×1.3 (from the Friday before to Cyber Monday), December up to the 22nd ×1.8, 7–31 January ×0.7.
// Christmas stock must be home by 12 December (last DDP/DUA in time); nothing that lands 13 Dec–6 Jan sells for Christmas.
const lastFriNov = (y) => { const d = new Date(y, 10, 30, 12); while (d.getDay() !== 5) d.setDate(d.getDate() - 1); return dk(d); };
export function season(k) {
  const y = Number(k.slice(0, 4)), md = k.slice(5), bf = lastFriNov(y);
  if (k >= addD(bf, -7) && k <= addD(bf, 3)) return 1.3;
  if (md >= '12-01' && md <= '12-22') return 1.8;
  if (md >= '01-07' && md <= '01-31') return 0.7;
  return 1;
}
export const xmasBy = (y) => y + '-12-12';

const nm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Watch 1 golden / silver / bronze are one watch in three colours: they share stock planning
export function familyOf(m) {
  if (m.family) return m.family;
  const n = nm(m.name);
  if (/^watch 1\b/.test(n)) return 'Watch 1';
  if (/^watch 2\b|world is yours|twiy/.test(n)) return 'Watch 2';
  return m.name;
}

export function planStock(x) {
  const { today, stocks, lead, settings: s, cash, priceOf } = x;
  const H = 90, L = lead.ddp, cycle = n0(s.cycleDays) || 30, z = 1.28, cushion = n0(s.cushion);
  const days = Array.from({ length: H + 1 }, (_, i) => addD(today, i));
  const idx = (k) => Math.max(0, Math.min(H, diffD(today, k)));

  // families of proven winners
  const fam = {};
  for (const st of stocks) {
    if (st.m.status !== 'ganador') continue;
    const f = familyOf(st.m);
    (fam[f] = fam[f] || { name: f, members: [] }).members.push(st);
  }
  const fams = Object.values(fam).map((F) => {
    const R = sum(F.members.map((m) => m.rate));
    const sd = Math.sqrt(sum(F.members.map((m) => (m.d.sd || 0) ** 2)));
    const safety = R > 0 ? Math.max(2, Math.ceil(z * sd * Math.sqrt(L))) : 0;
    const arrivals = F.members.flatMap((m) => m.arrivals.map((a) => ({ ...a, mid: m.m.id }))).sort((a, b) => a.eta.localeCompare(b.eta));
    const price = R > 0 ? sum(F.members.map((m) => m.rate * priceOf(m.m))) / R : 0;
    const unit = R > 0 ? sum(F.members.map((m) => m.rate * m.cost)) / R : sum(F.members.map((m) => m.cost)) / Math.max(1, F.members.length);
    const first = F.members.find((m) => m.firstOrder);
    return { ...F, R, sd, safety, arrivals, price, unit, home: sum(F.members.map((m) => m.home)), transit: sum(F.members.map((m) => m.transit)), reserved: sum(F.members.map((m) => m.reserved || 0)), first: first ? { qty: first.qty, m: first.m, cost: first.cost } : null, photo: (F.members.find((m) => m.m.photo) || {}).m?.photo || null };
  });

  // stock simulation for one family, with optional extra arrivals (a planned order)
  const simulate = (F, extra = []) => {
    const add = {}; for (const a of [...F.arrivals, ...extra]) { const i = Math.max(0, diffD(today, a.eta)); if (i <= H) add[i] = (add[i] || 0) + a.qty; }
    let home = F.home - (F.reserved || 0); const out = [], sold = []; // reserved units leave with the first box that lands
    for (let i = 0; i <= H; i++) { home += add[i] || 0; const sl = Math.min(Math.max(0, home), F.R * season(days[i])); home -= sl; out.push(Math.max(0, home)); sold.push(sl); }
    return { stock: out, sold };
  };

  // money day by day, before any new order
  const money = new Array(H + 1).fill(0);
  const put = (k, v) => { money[idx(k)] += v; };
  put(today, cash.now);
  for (const p of cash.pending) put(p.on < today ? addD(today, 1) : p.on, p.amount);
  for (const b of cash.bills) put(b.on < today ? today : b.on, -b.amount);
  for (const d of cash.debts) put(d.on < today ? today : d.on, -d.amount);
  for (let i = 1; i <= H; i++) money[i] -= cash.spendPerDay;

  // sales income from the simulated stock (credited when Vinted releases it)
  const income = (F, sim) => { const inc = new Array(H + 1).fill(0); sim.sold.forEach((q, i) => { const j = i + cash.releaseDays; if (j <= H) inc[j] += q * F.price; }); return inc; };
  for (const F of fams) { F.sim = simulate(F); F.sim0 = F.sim; F.inc = income(F, F.sim); F.inc.forEach((v, i) => { money[i] += v; }); }
  const balance = () => { let b = 0; return money.map((v) => (b += v)); };
  const money0 = balance(); // reality: what you have and what's already coming, no new orders
  const low0 = money0.reduce((m, v, i) => (v < m.v ? { v, i } : m), { v: Infinity, i: 0 });

  // next order per family, earliest first; each order's cost comes out of the money for the next ones
  const orders = [];
  // the family that runs out first gets first call on the money
  const firstOut = (F) => { const i = F.sim.stock.findIndex((v, j) => j >= (F.arrivals.length ? idx(F.arrivals[F.arrivals.length - 1].eta) : 0) && v < 0.5); return i < 0 ? H + 1 : i; };
  fams.sort((a, b) => firstOut(a) - firstOut(b));
  for (const F of fams) {
    if (!(F.R > 0)) {
      F.status = 'sin ritmo'; F.note = 'menos de 4 ventas en sus últimos 28 días con stock: no se calcula pedido';
      // a new winner you marked, with nothing at home or on the way: only the first-order rule (15 + 5 per extra sale/offer, max 40)
      if (F.first && F.home + F.transit <= 0) {
        const qty = F.first.qty, cost = qty * F.first.cost, bal = balance();
        let okIdx = -1; for (let i = 0; i <= H; i++) { let fit = true; for (let j = i; j <= H; j++) if (bal[j] - cost < cushion) { fit = false; break; } if (fit) { okIdx = i; break; } }
        const at = okIdx < 0 ? 0 : okIdx;
        const o = { family: F.name, date: days[at], due: days[0], arrives: days[Math.min(H, at + L)], qty, split: [{ m: F.first.m, qty, cost: F.first.cost, share: 1 }], cost, cashThen: bal[0], ok: okIdx === 0, cashDate: okIdx >= 0 ? days[okIdx] : null, affordable: 0, now: okIdx === 0, waitCash: okIdx !== 0, out: null, beyond: false, first: true };
        F.order = o; F.status = okIdx === 0 ? 'primer pedido' : okIdx > 0 ? `primer pedido el ${o.cashDate} cuando haya caja` : 'primer pedido: sin caja en 90 días';
        F.note = `ganador nuevo: primer pedido de ${qty} (15 + 5 por cada venta u oferta extra del test)`;
        if (okIdx >= 0) { put(o.date, -cost); orders.push(o); }
      }
      continue;
    }
    const lastIn = F.arrivals.length ? idx(F.arrivals[F.arrivals.length - 1].eta) : 0;
    // first day it runs dry now, and the hole until the next box lands
    const dryNow = F.sim.stock.findIndex((v) => v < 0.5);
    const gapFrom = dryNow >= 0 && dryNow < lastIn ? dryNow : -1;
    const backOn = gapFrom >= 0 ? F.arrivals.map((a) => idx(a.eta)).find((i) => i > gapFrom) : -1;
    // the stock-out that matters: after everything already on the way has landed
    let out = -1; for (let i = lastIn; i <= H; i++) if (F.sim.stock[i] < 0.5) { out = i; break; }
    const safetyDays = Math.ceil(F.safety / F.R);
    let orderIdx = out < 0 ? H : Math.max(0, out - L - safetyDays);
    // Christmas: if it would land 13 Dec–6 Jan, order so it's home by 12 Dec
    const landK = days[Math.min(H, orderIdx + L)], y0 = landK.slice(0, 4), xi = idx(xmasBy(y0)), lateXmas = landK > xmasBy(y0) && landK <= (Number(y0) + 1) + '-01-06';
    let xmas = null;
    if (!(out < 0) && lateXmas && xi - L >= 0) { orderIdx = Math.min(orderIdx, xi - L); xmas = 'adelantado para que llegue antes del 12 dic (Navidad)'; }
    else if (!(out < 0) && lateXmas) xmas = 'llega después del 12 dic: tarde para Navidad';
    const arriveIdx = Math.min(H, orderIdx + L);
    const atArrival = F.sim.stock[arriveIdx] || 0;
    let cover = 0; for (let i = arriveIdx; i < arriveIdx + cycle; i++) cover += F.R * season(addD(today, i)); // a month of sales after it lands, with the season
    const qty = Math.max(10, ceil5(cover + F.safety - atArrival));
    // split by colour: each colour's share of everything it ever sold (steadier than one month: Vinted goes in streaks)
    const tot = sum(F.members.map((m) => (m.d.total || 0) + 1));
    const split = F.members.map((m) => ({ m: m.m, share: ((m.d.total || 0) + 1) / tot, cost: m.cost }));
    let left = qty; split.forEach((p, i) => { p.qty = i === split.length - 1 ? left : Math.round(qty * p.share); left -= p.qty; });
    const cost = sum(split.map((p) => p.qty * p.cost));
    const bal = balance(), cashThen = bal[orderIdx];
    // the order has to leave the cushion untouched for the rest of the 90 days, not just on the day you pay
    // …counting the money that order brings back when its watches sell
    const fits = (i, q) => {
      const s2 = simulate(F, [{ eta: days[Math.min(H, i + L)], qty: q }]), inc2 = income(F, s2), c = q * cost / qty;
      let back = 0;
      for (let j = 0; j <= H; j++) { back += inc2[j] - F.inc[j]; if (j >= i && bal[j] - c + back < cushion) return false; }
      return true;
    };
    let okIdx = -1; for (let i = orderIdx; i <= H; i++) if (fits(i, qty)) { okIdx = i; break; }
    // not enough for the whole order in 90 days: the biggest multiple of 5 that fits, on the first day it fits
    let part = null;
    if (okIdx < 0) for (let q = qty - 5; q >= 5 && !part; q -= 5) for (let i = orderIdx; i <= H; i++) if (fits(i, q)) { part = { q, i }; break; }
    const ok = okIdx === orderIdx;
    const affordable = part ? part.q : 0;
    const at = ok ? orderIdx : okIdx >= 0 ? okIdx : part ? part.i : orderIdx; // no cash on the day it's due: it moves to the first day the cash is there
    const o = {
      family: F.name, date: days[at], due: days[orderIdx], arrives: days[Math.min(H, at + L)], qty, split: split.filter((p) => p.qty > 0), cost, cashThen, ok,
      cashDate: okIdx >= 0 ? days[okIdx] : part ? days[part.i] : null, affordable, partial: !!part, full: qty, now: ok && orderIdx <= 0, waitCash: !ok, out: out >= 0 ? days[out] : null, beyond: out < 0, xmas,
    };
    { const yy = o.arrives.slice(0, 4), late = o.arrives > xmasBy(yy) && o.arrives <= (Number(yy) + 1) + '-01-06'; if (late && (o.waitCash || !o.xmas)) o.xmas = `llega el ${o.arrives}: tarde para Navidad (tiene que estar en casa antes del 12 dic)`; else if (!late && o.waitCash) o.xmas = null; }
    if (part) { // only what the cash allows
      o.qty = part.q; o.cost = part.q * cost / qty; const k = part.q / qty; let left2 = part.q; o.split = o.split.map((p, i, arr) => { const q2 = i === arr.length - 1 ? left2 : Math.round(p.qty * k); left2 -= q2; return { ...p, qty: q2 }; }).filter((p) => p.qty > 0);
    }
    F.order = o; F.gap = gapFrom >= 0 ? { from: days[gapFrom], to: backOn > 0 ? days[backOn] : null, days: backOn > 0 ? backOn - gapFrom : null } : null;
    F.dry = out >= 0 ? days[out] : null; F.coverDays = out >= 0 ? out : H;
    F.status = o.beyond ? 'cubierto' : o.now ? 'pide hoy' : o.waitCash ? (o.partial ? `con tu caja: ${o.qty} de ${o.full} uds el ${o.cashDate}` : o.cashDate ? `pide el ${o.cashDate} cuando haya caja` : 'sin caja en 90 días') : 'pedido programado';
    F.note = o.beyond ? `lo que hay cubre más de ${H} días` : o.waitCash ? `tocaba el ${o.due} (se acaba el ${days[out]}), pero ${o.partial ? `las ${o.full} uds rompen el colchón de ${cushion} € (pagos fijos incluidos) → solo llega para ${o.qty}` : `pagarlo ese día rompe el colchón de ${cushion} €`}` : o.now ? `se acaba el ${days[out]} y un pedido tarda ${L} días` : `lo que tienes y lo que viene aguanta hasta el ${days[out]}`;
    if (!o.beyond && (o.ok || o.cashDate)) {
      // take the order out of the money and put its stock into the simulation (for the chart)
      put(o.date, -o.cost);
      F.sim = simulate(F, [{ eta: o.arrives, qty: o.qty }]);
      const inc2 = income(F, F.sim); inc2.forEach((v, i) => { money[i] += v - F.inc[i]; }); F.inc = inc2;
      orders.push(o);
    }
  }
  const bal = balance();
  const low = bal.reduce((m, v, i) => (v < m.v ? { v, i } : m), { v: Infinity, i: 0 });
  return {
    days, fams, orders: orders.sort((a, b) => a.date.localeCompare(b.date)), money: bal, money0, lead: L, cushion,
    low: { amount: low.v, date: days[low.i] }, low0: { amount: low0.v, date: days[low0.i] }, in30: bal[Math.min(H, 30)], in30real: money0[Math.min(H, 30)],
  };
}
