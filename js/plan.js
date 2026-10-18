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
    return { ...F, R, sd, safety, arrivals, price, unit, home: sum(F.members.map((m) => m.home)), transit: sum(F.members.map((m) => m.transit)), photo: (F.members.find((m) => m.m.photo) || {}).m?.photo || null };
  });

  // stock simulation for one family, with optional extra arrivals (a planned order)
  const simulate = (F, extra = []) => {
    const add = {}; for (const a of [...F.arrivals, ...extra]) { const i = Math.max(0, diffD(today, a.eta)); if (i <= H) add[i] = (add[i] || 0) + a.qty; }
    let home = F.home; const out = [], sold = [];
    for (let i = 0; i <= H; i++) { home += add[i] || 0; const sl = Math.min(home, F.R); home -= sl; out.push(home); sold.push(sl); }
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

  // next order per family, earliest first; each order's cost comes out of the money for the next ones
  const orders = [];
  // the family that runs out first gets first call on the money
  const firstOut = (F) => { const i = F.sim.stock.findIndex((v, j) => j >= (F.arrivals.length ? idx(F.arrivals[F.arrivals.length - 1].eta) : 0) && v < 0.5); return i < 0 ? H + 1 : i; };
  fams.sort((a, b) => firstOut(a) - firstOut(b));
  for (const F of fams) {
    if (!(F.R > 0)) { F.status = 'sin ritmo'; F.note = 'aún no hay ventas con stock para calcular'; continue; }
    const lastIn = F.arrivals.length ? idx(F.arrivals[F.arrivals.length - 1].eta) : 0;
    // first day it runs dry now, and the hole until the next box lands
    const dryNow = F.sim.stock.findIndex((v) => v < 0.5);
    const gapFrom = dryNow >= 0 && dryNow < lastIn ? dryNow : -1;
    const backOn = gapFrom >= 0 ? F.arrivals.map((a) => idx(a.eta)).find((i) => i > gapFrom) : -1;
    // the stock-out that matters: after everything already on the way has landed
    let out = -1; for (let i = lastIn; i <= H; i++) if (F.sim.stock[i] < 0.5) { out = i; break; }
    const safetyDays = Math.ceil(F.safety / F.R);
    const orderIdx = out < 0 ? H : Math.max(0, out - L - safetyDays);
    const arriveIdx = Math.min(H, orderIdx + L);
    const atArrival = F.sim.stock[arriveIdx] || 0;
    const qty = Math.max(10, ceil5(F.R * cycle + F.safety - atArrival));
    // split by colour: each colour's share of everything it ever sold (steadier than one month: Vinted goes in streaks)
    const tot = sum(F.members.map((m) => (m.d.total || 0) + 1));
    const split = F.members.map((m) => ({ m: m.m, share: ((m.d.total || 0) + 1) / tot, cost: m.cost }));
    let left = qty; split.forEach((p, i) => { p.qty = i === split.length - 1 ? left : Math.round(qty * p.share); left -= p.qty; });
    const cost = sum(split.map((p) => p.qty * p.cost));
    const bal = balance(), cashThen = bal[orderIdx];
    let okIdx = -1; for (let i = orderIdx; i <= H; i++) if (bal[i] - cushion >= cost) { okIdx = i; break; }
    const affordable = Math.max(0, Math.floor(Math.max(0, cashThen - cushion) / (cost / qty) / 5) * 5);
    const o = {
      family: F.name, date: days[orderIdx], arrives: days[arriveIdx], qty, split: split.filter((p) => p.qty > 0), cost, cashThen, ok: cashThen - cushion >= cost,
      cashDate: okIdx >= 0 ? days[okIdx] : null, affordable, now: orderIdx <= 0, out: out >= 0 ? days[out] : null, beyond: out < 0,
    };
    F.order = o; F.gap = gapFrom >= 0 ? { from: days[gapFrom], to: backOn > 0 ? days[backOn] : null, days: backOn > 0 ? backOn - gapFrom : null } : null;
    F.dry = out >= 0 ? days[out] : null; F.coverDays = out >= 0 ? out : H;
    F.status = o.beyond ? 'cubierto' : o.now ? 'pide hoy' : 'pedido programado';
    F.note = o.beyond ? `lo que hay cubre más de ${H} días` : o.now ? `se acaba el ${days[out]} y un pedido tarda ${L} días` : `lo que tienes y lo que viene aguanta hasta el ${days[out]}`;
    if (!o.beyond) {
      // take the order out of the money and put its stock into the simulation (for the chart)
      put(o.date, -cost);
      F.sim = simulate(F, [{ eta: o.arrives, qty }]);
      const inc2 = income(F, F.sim); inc2.forEach((v, i) => { money[i] += v - F.inc[i]; }); F.inc = inc2;
      orders.push(o);
    }
  }
  const bal = balance();
  const low = bal.reduce((m, v, i) => (v < m.v ? { v, i } : m), { v: Infinity, i: 0 });
  return {
    days, fams, orders: orders.sort((a, b) => a.date.localeCompare(b.date)), money: bal, money0, lead: L, cushion,
    low: { amount: low.v, date: days[low.i] }, in30: bal[Math.min(H, 30)],
  };
}
