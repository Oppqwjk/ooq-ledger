// OOQ Manager engine. Pure functions over the Ledger data: demand, stock, order plan,
// fast tests, accounts and the list of best moves. Thresholds come from your own data when
// there is enough of it; the fixed numbers below are only the fallbacks for day one.

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const dk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const dOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addD = (k, n) => { const d = dOf(k); d.setDate(d.getDate() + n); return dk(d); };
export const diffD = (a, b) => Math.round((dOf(b) - dOf(a)) / DAY);
const n0 = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ceil5 = (x) => Math.ceil(x / 5) * 5;
const floor5 = (x) => Math.floor(x / 5) * 5;
const hrs = (iso, now) => (now - Date.parse(iso)) / 3600000;
const MS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fd = (k) => (k ? Number(k.slice(8)) + ' ' + MS[Number(k.slice(5, 7)) - 1] : '?');

// Fallbacks used only until your own history replaces them.
export const FALLBACK = {
  leadDHL: 7, leadDDP: 12,          // days from paying to having it at home
  fav: 0.15, vpd: 15, opv: 3,       // test benchmarks: favourites/views, views per day, offers per 100 views
  cycleDays: 30,                    // a DDP order covers this many days of sales
  serviceZ: 1.28,                   // safety stock for ~90% of demand swings
  bench: 3,                         // tests running at the same time
  maxAccPerModel: 2,
  pendingDays: 10,                  // days a sale stays pending in Vinted before it's in your money
};
export const STAGE = { espera: 'Esperando', datos: 'Faltan datos', portada: 'Cambia portada', sigue: 'Sigue', bajar: 'Última oportunidad', oferta: 'Oferta buena', ganador: 'Ganador', muerto: 'Muerto', nopub: 'Sin publicar' };

/* ---------------- demand ---------------- */
// Weighted sales per day over the last 28 days. Recent days weigh more (half-life 7 days),
// so a model that is heating up or cooling down shows it within days, not weeks.
// Sales you told the app about without logging each one ("Ponerme al día"): spread over the 14 days before you said it.
function baseSales(m, today) {
  const n = Math.round(n0(m && m.base14)), at = m && m.baseAt;
  if (!n || !at || diffD(at, today) > 27) return [];
  return Array.from({ length: n }, (_, k) => ({ modelId: m.id, date: addD(at, -1 - Math.floor(k * 14 / n)), virtual: true }));
}
export function demand(mid, sales, today, m) {
  const mine = sales.filter((s) => s.modelId === mid && s.date && s.date <= today).concat(baseSales(m, today));
  const base = { rate: 0, last7: 0, prev7: 0, last14: 0, total: mine.length, n28: 0, sd: 0, lastSale: null, first: null, trend: 0 };
  if (!mine.length) return base;
  const dates = mine.map((s) => s.date).sort();
  const first = dates[0], lastSale = dates[dates.length - 1];
  // the clock starts when the watch was at home to sell: arrival date if it came before the first sale
  const open = m && m._arrived && m._arrived < first ? m._arrived : first;
  const from = addD(today, -27), start = open > from ? open : from, days = diffD(start, today) + 1;
  const counts = {}; for (const s of mine) if (s.date >= start) counts[s.date] = (counts[s.date] || 0) + 1;
  let ws = 0, wt = 0; const arr = [];
  for (let i = 0; i < days; i++) { const k = addD(start, i), c = counts[k] || 0, w = Math.pow(0.5, diffD(k, today) / 7); ws += w * c; wt += w; arr.push(c); }
  // a model that only started selling a few days ago: pad to 7 days so 3 sales on day 1 isn't read as 3/day forever
  for (let i = days; i < 7; i++) { wt += 1; arr.push(0); }
  const rate = ws / wt, mean = sum(arr) / arr.length;
  const sd = Math.sqrt(sum(arr.map((c) => (c - mean) ** 2)) / arr.length);
  const inR = (a, b) => mine.filter((s) => s.date >= addD(today, a) && s.date <= addD(today, b)).length;
  const last7 = inR(-6, 0), prev7 = inR(-13, -7);
  const n28 = mine.filter((s) => s.date >= from).length;
  return { rate, last7, prev7, last14: last7 + prev7, total: mine.length, n28, sd, lastSale, first, trend: prev7 ? last7 / prev7 - 1 : last7 ? 1 : 0 };
}

/* ---------------- lead times ---------------- */
// Learned from your own received orders per lane (last 3). Falls back until you have some.
export function leadTimes(orders, s) {
  const def = { dhl: n0(s.leadDHL) || FALLBACK.leadDHL, ddp: n0(s.leadDDP) || FALLBACK.leadDDP };
  def.otro = n0(s.leadOtro) || def.ddp; // old orders marked "otro": treated as DDP unless you set a plazo
  const out = {};
  for (const lane of ['dhl', 'ddp', 'otro']) {
    const got = orders.filter((o) => (o.lane || 'otro') === lane && o.status === 'recibido' && o.receivedDate && o.date)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map((o) => diffD(o.date, o.receivedDate)).filter((x) => x >= 0);
    out[lane] = got.length ? Math.max(1, Math.round(sum(got) / got.length)) : def[lane];
    out[lane + 'N'] = got.length;
  }
  return out;
}
export const etaOf = (o, lead) => o.eta || addD(o.date, lead[o.lane || 'otro'] || lead.ddp);

/* ---------------- stock ---------------- */
export function unitProfit(m, sales, costOf) {
  const ps = sales.filter((s) => s.modelId === m.id).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date)).slice(0, 10)
    .map((s) => (typeof s.profit === 'number' ? s.profit : n0(s.price) - n0(s.cost)));
  if (ps.length) return sum(ps) / ps.length;
  const p = n0(m.listPrice) || n0(m.minPrice);
  return p ? p - costOf(m) : 0;
}

export function stockFor(m, d, x) {
  const { today, lead, orders, sales, costOf } = x;
  const home = n0(m.home), transit = n0(m.transit), stock = home + transit, rate = d.rate;
  const L = lead.ddp, Ld = lead.dhl;
  const arrivals = orders.filter((o) => o.status !== 'recibido' && !o.draft && (o.lines || []).some((l) => l.modelId === m.id))
    .map((o) => ({ id: o.id, eta: etaOf(o, lead), lane: o.lane || 'otro', qty: sum((o.lines || []).filter((l) => l.modelId === m.id).map((l) => n0(l.qty))) }))
    .sort((a, b) => a.eta.localeCompare(b.eta));
  const up = unitProfit(m, sales, costOf), cost = costOf(m), nSold = sales.filter((s) => s.modelId === m.id && !s.cancelled).length;
  const r = { m, rate, d, home, transit, stock, arrivals, unitProfit: up, cost, profitDay: rate * up, capital: home * cost, lead: L, leadDhl: Ld,
    coverHome: rate > 0 ? home / rate : Infinity, coverAll: rate > 0 ? stock / rate : Infinity, safety: 0, rop: 0, target: 0,
    qty: 0, bridge: 0, ddpQty: 0, gap: 0, outDate: null, status: 'sin datos', why: '',
    upFrom: nSold ? 'ventas' : 'estimado', upPrice: nSold ? null : n0(m.listPrice) || n0(m.minPrice) || null, nSold, arrived: m._arrived || null };
  const r0 = stockCore(m, d, x, r);
  // only a proven winner gets restocked (1 sale or 2+ offers); a test or a watch on hold never triggers an order
  if (m.status !== 'ganador' && r0.qty > 0) {
    r0.qty = r0.bridge = r0.ddpQty = 0;
    if (['rotura', 'urgente', 'pedir'].includes(r0.status)) { r0.status = 'no repone'; r0.why = m.status === 'espera' ? 'en espera → no se repone hasta que lo marques ganador' : 'aún no es ganador (1 venta o 2 ofertas) → no se repone'; }
  }
  return r0;
}
function stockCore(m, d, x, r) {
  const { today } = x, { home, transit, stock, rate, arrivals, cost, lead: L, leadDhl: Ld } = r;
  if (m.status === 'descartado') { r.status = home > 0 ? 'liquidar' : 'fuera'; r.why = home > 0 ? `${home} uds de un reloj descartado: véndelas a precio de salida` : ''; return r; }
  const idle = d.lastSale ? diffD(d.lastSale, today) : null;
  // nothing at home yet and too few sales: it's on the way, 0 sales is expected, the 28-day clock starts when it lands
  if (home === 0 && transit > 0 && d.n28 < 4) { const nx = arrivals[0]; r.status = 'en camino'; r.why = `llegan ${transit} el ${fd(nx ? nx.eta : '')}${d.total ? ` · ${d.total} vendido${d.total === 1 ? '' : 's'} antes` : ''} → el ritmo se mide desde que lleguen`; return r; }
  const since = m._arrived && diffD(m._arrived, today) < 28 ? diffD(m._arrived, today) : null;
  // too few sales to trust a rate: no order advice, just say so (a winner at 0 stock still gets a small DDP)
  if (d.n28 < 4) {
    if (home === 0 && m.status === 'ganador' && !transit) { r.status = 'rotura'; r.ddpQty = 10; r.qty = 10; r.why = `0 en casa · solo ${d.n28} venta${d.n28 === 1 ? '' : 's'} apuntada${d.n28 === 1 ? '' : 's'} en 28 días → DDP de 10 y apunta las ventas`; return r; }
    if (home > 0 && d.total > 0 && idle >= 14) { r.status = 'parado'; r.why = `${home} uds, ${idle} días sin vender · ${Math.round(home * cost)} € parados`; return r; }
    r.status = d.total ? 'lento' : 'sin datos';
    r.why = since !== null ? `llegó hace ${since} día${since === 1 ? '' : 's'} · ${d.n28} venta${d.n28 === 1 ? '' : 's'} desde entonces: aún pronto para calcular` : `solo ${d.n28} venta${d.n28 === 1 ? '' : 's'} apuntada${d.n28 === 1 ? '' : 's'} en 28 días: no basta para calcular`;
    return r;
  }
  if (rate <= 0.02) {
    if (home > 0 && d.total > 0 && idle >= 14) { r.status = 'parado'; r.why = `${home} uds, ${idle} días sin vender · ${Math.round(home * cost)} € parados`; }
    else r.status = d.total ? 'lento' : 'sin datos';
    return r;
  }
  r.safety = Math.max(1, Math.ceil(x.z * d.sd * Math.sqrt(L)));
  r.rop = rate * L + r.safety;
  r.target = rate * (L + x.cycle) + r.safety;
  r.outDate = addD(today, Math.floor(r.coverHome));
  const next = arrivals[0];
  if (next && next.eta > r.outDate) r.gap = diffD(r.outDate, next.eta);
  // a new DDP order lands in L days; anything that runs out before that has to be bridged with DHL
  // DHL only for real sellers (2+ a week) that would actually run dry before a DDP lands; a slow watch just waits for DDP
  const fast = rate >= 0.3, short = L - Math.max(r.coverAll, Ld);
  if (fast && r.coverAll < L - 3 && short > 0) r.bridge = Math.max(5, ceil5(rate * short + r.safety));
  // home runs out before the box on the way lands: a DHL box can fill that hole only if it lands first
  r.dhlInTime = !next || addD(today, Ld) < next.eta;
  if (fast && r.gap > 3 && next && r.dhlInTime) {
    const from = addD(today, Ld) > r.outDate ? addD(today, Ld) : r.outDate;
    r.bridge = Math.max(r.bridge, Math.max(5, ceil5(rate * diffD(from, next.eta))));
  }
  if (stock <= r.rop) r.ddpQty = Math.max(5, ceil5(r.target - stock - r.bridge));
  else if (r.bridge) r.ddpQty = Math.max(0, ceil5(r.target - stock - r.bridge));
  r.qty = r.bridge + r.ddpQty;
  if (d.last7 === 0 && d.prev7 > 0 && home > 0) {
    r.status = 'enfria'; r.qty = r.bridge = r.ddpQty = 0;
    r.why = `0 ventas en 7 días (antes ${d.prev7}) → no repongas hasta que vuelva a vender · ${Math.round(home * cost)} € en stock`; return r;
  }
  if (home === 0) { r.status = 'rotura'; r.why = transit ? `0 en casa · llegan ${transit} el ${fd(next ? next.eta : '')}${r.bridge ? ` → DHL ${r.bridge} uds tapa el hueco` : ''}` : `0 en casa y nada en camino · pierdes ~${(rate * 7).toFixed(1)} ventas/semana`; }
  else if (r.gap > 0) { r.status = 'urgente'; r.why = `se acaba el ${fd(r.outDate)}, el pedido llega el ${fd(next.eta)} → ${r.gap} días sin stock` + (r.bridge ? ` → DHL ${r.bridge} uds ya` : ' → DHL tampoco llega antes: no aceptes ofertas bajas, vende a precio completo'); }
  else if (r.coverAll < L && r.bridge) { r.status = 'urgente'; r.why = `${Math.floor(r.coverAll)} días de stock y un DDP tarda ${L} → DHL ${r.bridge} para no parar`; }
  else if (r.coverAll < L) { r.status = 'pedir'; r.why = `${Math.floor(r.coverAll)} días de stock, vende ${rate < 0.15 ? '1 cada ' + Math.round(1 / rate) + ' días' : rate.toFixed(1).replace('.', ',') + '/día'} → DDP hoy y llega a tiempo de sobra`; }
  else if (stock <= r.rop) { r.status = 'pedir'; r.why = `${Math.floor(r.coverAll)} días de stock → pide ya para no quedarte sin`; }
  else if (r.coverAll > 60) { r.status = 'exceso'; r.why = `${Math.floor(r.coverAll)} días de stock · dinero parado`; }
  else r.status = 'ok';
  return r;
}

// Turns the stock list into an order you can afford: urgent DHL first, then DDP by profit per day.
export function orderPlan(stocks, cash, costOf) {
  const prio = { rotura: 0, urgente: 1, pedir: 2 };
  const cands = stocks.filter((s) => s.qty > 0 && prio[s.status] !== undefined)
    .sort((a, b) => prio[a.status] - prio[b.status] || a.coverAll - b.coverAll || b.profitDay - a.profitDay);
  let left = Math.max(0, cash);
  const lines = [], skipped = [];
  const take = (s, lane, want) => {
    if (!want) return;
    const unit = costOf(s.m);
    let q = want;
    if (q * unit > left) q = floor5(left / unit);
    if (q < 5) { skipped.push({ s, lane, want }); return; }
    left -= q * unit;
    lines.push({ s, m: s.m, lane, qty: q, want, unit, cost: q * unit, weight: n0(s.m.weight) * q });
  };
  for (const s of cands) take(s, 'dhl', s.bridge);
  for (const s of cands) take(s, 'ddp', s.ddpQty);
  const by = (lane) => lines.filter((l) => l.lane === lane);
  const tot = (ls) => ({ units: sum(ls.map((l) => l.qty)), cost: sum(ls.map((l) => l.cost)), kg: sum(ls.map((l) => l.weight)) / 1000, profit: sum(ls.map((l) => l.qty * l.s.unitProfit)) });
  return { lines, skipped, dhl: tot(by('dhl')), ddp: tot(by('ddp')), left, cash };
}

/* ---------------- tests ---------------- */
// What a winner looked like in its first days, from your own winners' listings.
export function benchmarks(listings, models) {
  const win = new Set(models.filter((m) => m.status === 'ganador').map((m) => m.id));
  const fav = [], vpd = [], opv = [];
  for (const l of listings) {
    if (!win.has(l.modelId) || !l.listedAt) continue;
    for (const s of l.snaps || []) {
      const h = (Date.parse(s.at) - Date.parse(l.listedAt)) / 3600000;
      if (h < 12 || h > 120 || !(n0(s.views) > 0)) continue;
      fav.push(n0(s.favs) / n0(s.views)); vpd.push(n0(s.views) / (h / 24)); opv.push(100 * n0(s.offers) / n0(s.views));
    }
  }
  const ok = fav.length >= 3;
  return { fav: ok ? clamp(median(fav), 0.05, 0.4) : FALLBACK.fav, vpd: ok ? Math.max(5, median(vpd)) : FALLBACK.vpd, opv: ok ? Math.max(1, median(opv)) : FALLBACK.opv, n: fav.length, learned: ok };
}
export function latestSnap(l) { const s = (l.snaps || []).slice().sort((a, b) => b.at.localeCompare(a.at)); return s[0] || null; }

export function testFor(m, x) {
  const { listings, sales, now, bench, costOf } = x;
  const ls = listings.filter((l) => l.modelId === m.id && l.listedAt).sort((a, b) => a.listedAt.localeCompare(b.listedAt));
  const cost = costOf(m), home = n0(m.home), transit = n0(m.transit);
  const t = { m, ls, live: ls.filter((l) => l.status === 'live'), cost, home, transit, stage: 'nopub', score: 0, views: 0, favs: 0, offers: 0, best: 0, sold: 0, hours: 0, next: null, act: '', why: '', firstQty: 0 };
  if (!ls.length) { t.why = home ? `${home} en casa sin publicar → publícalo hoy` : transit ? `${transit} en camino` : 'sin stock'; t.act = home ? 'Publica el test' : ''; return t; }
  const start = m.testStart || ls[0].listedAt; t.start = start; t.hours = hrs(start, now);
  const snaps = ls.map(latestSnap).filter(Boolean);
  t.views = sum(snaps.map((s) => n0(s.views))); t.favs = sum(snaps.map((s) => n0(s.favs))); t.offers = sum(snaps.map((s) => n0(s.offers)));
  t.best = Math.max(0, ...snaps.map((s) => n0(s.best)));
  t.lastSnap = snaps.map((s) => s.at).sort().pop() || null;
  t.sold = sales.filter((s) => s.modelId === m.id && (s.at || s.date) >= start).length;
  const price = n0((t.live[0] || ls[ls.length - 1]).price) || n0(m.listPrice);
  t.price = price;
  t.favRate = t.views ? t.favs / t.views : 0;
  t.vpd = t.hours > 0 ? t.views / Math.max(t.hours / 24, 0.5) : 0;
  t.opv = t.views ? 100 * t.offers / t.views : 0;
  const fs = clamp(t.favRate / bench.fav, 0, 1.5), vs = clamp(t.vpd / bench.vpd, 0, 1.5), os = clamp(t.opv / bench.opv, 0, 1.5);
  t.score = Math.round(clamp(40 * fs + 20 * vs + 40 * os, 0, 100));
  if (t.sold) t.score = Math.max(t.score, 85 + Math.min(15, (t.sold - 1) * 5));
  t.score = Math.min(100, t.score);
  // first bulk order: base 15, more when it already pulls sales or offers
  t.firstQty = Math.min(40, 15 + 5 * Math.max(0, t.sold - 1) + 5 * Math.max(0, t.offers - 1));
  // strict: 24h = photo check, 48h = verdict. No offer in 48h = dead. 1 weak offer = 24h last chance at −3 €.
  const cps = [24, 48, 72], h = t.hours, cp = cps.filter((c) => h >= c).pop() || 0;
  t.next = cps.find((c) => c > h && c <= 48) || (h < 72 && h >= 48 && t.offers === 1 ? 72 : null);
  const snapH = t.lastSnap ? hrs(t.lastSnap, now) : Infinity;
  const needData = cp && (snapH > h - cp + 6);
  const goodOffer = t.best && t.best - cost >= Math.max(12, 0.5 * (price - cost));
  const dead = `Fuera → sube el siguiente; lo que quede a ${Math.max(Math.round(cost + 8), 20)},95 €`;
  if (t.sold) { t.stage = 'ganador'; t.why = `${t.sold} vendido${t.sold > 1 ? 's' : ''} en ${Math.round(h)}h`; t.act = `Ganador → pide ${t.firstQty}`; return t; }
  if (goodOffer) { t.stage = 'oferta'; t.why = `oferta de ${t.best} € = ${Math.round(t.best - cost)} € de beneficio`; t.act = 'Acéptala ya: una venta en test = ganador'; return t; }
  if (h < 24) { t.stage = t.views ? 'sigue' : 'espera'; t.why = `${Math.round(h)}h publicado`; t.act = 'Stats a las 24h'; return t; }
  if (needData) { t.stage = 'datos'; t.why = `control de ${cp}h sin stats`; t.act = 'Manda la captura de stats ya'; return t; }
  const expViews = bench.vpd * Math.min(h, 48) / 24;
  if (t.offers >= 2 || (t.offers >= 1 && t.favRate >= 0.7 * bench.fav)) { t.stage = 'ganador'; t.why = `${t.offers} oferta${t.offers > 1 ? 's' : ''} · ${Math.round(t.favRate * 100)}% favs en ${Math.round(h)}h`; t.act = `Ganador → pide ${t.firstQty}`; return t; }
  if (cp >= 48 && !t.offers) { t.stage = 'muerto'; t.why = `48h y 0 ofertas (${t.views} vistas, ${Math.round(t.favRate * 100)}% favs)`; t.act = dead; return t; }
  if (cp >= 72) { t.stage = 'muerto'; t.why = `72h: 1 oferta y ninguna venta`; t.act = dead; return t; }
  if (cp >= 48) {
    const np = Math.floor(Math.max(n0(m.minPrice) || 0, cost + 12, price - 3)) + 0.95; t.newPrice = np;
    t.stage = 'bajar'; t.why = `48h: solo 1 oferta y favs flojos`; t.act = `Última oportunidad 24h: baja a ${np.toFixed(2).replace('.', ',')} € + oferta a los ${t.favs} favs`; return t;
  }
  if (t.views < 0.5 * expViews) { t.stage = 'portada'; t.why = `${t.views} vistas en 24h, un ganador hace ~${Math.round(expViews)}`; t.act = 'Portada y título nuevos ya: quedan 24h para el veredicto'; return t; }
  t.stage = 'sigue'; t.why = `${Math.round(t.favRate * 100)}% favs · ${t.offers} ofertas`; t.act = 'Veredicto a las 48h: sin oferta = fuera'; return t;
}

/* ---------------- accounts ---------------- */
export function accountsFor(x) {
  const { settings: s, listings, sales, today, now, models } = x;
  const names = s.accounts || [], meta = s.accMeta || {};
  const ago = (iso, d) => iso && (now - Date.parse(iso)) / DAY <= d;
  const mainName = names.find((n) => meta[n] && meta[n].main) || names.find((n) => !meta[n] || meta[n].status !== 'restringida') || names[0];
  const accs = names.map((name) => {
    const mt = meta[name] || {}, status = mt.status || 'activa';
    const mine = sales.filter((v) => v.account === name);
    const s7 = mine.filter((v) => v.date >= addD(today, -6)).length, s30 = mine.filter((v) => v.date >= addD(today, -29)).length;
    const first = mine.map((v) => v.date).sort()[0];
    const span = first ? clamp(diffD(first, today) + 1, 7, 30) : 30;
    const live = listings.filter((l) => l.account === name && l.status === 'live');
    const rem = listings.filter((l) => l.account === name && l.status === 'removed');
    const rem14 = rem.filter((l) => ago(l.endedAt, 14)).length, rem30 = rem.filter((l) => ago(l.endedAt, 30)).length;
    const health = status !== 'activa' ? status : rem14 >= 2 ? 'peligro' : rem14 ? 'riesgo' : 'ok';
    return { name, status, main: name === mainName, owner: mt.owner || '', s7, s30, rate: s30 / span, live, rem14, rem30, health };
  });
  const active = accs.filter((a) => a.status === 'activa');
  return { accs, active, mainName };
}

export function distribution(x, acc, stocks) {
  const { listings, sales, now, settings: s, models } = x;
  const maxAcc = n0(s.maxAccPerModel) || FALLBACK.maxAccPerModel;
  const ago = (iso, d) => iso && (now - Date.parse(iso)) / DAY <= d;
  const out = [];
  const remOf = (mid, a) => listings.filter((l) => l.modelId === mid && l.status === 'removed' && (!a || l.account === a));
  for (const st of stocks) {
    const m = st.m;
    if (m.status === 'test' || m.status === 'descartado') continue;
    const allRem = remOf(m.id).length;
    const liveL = listings.filter((l) => l.modelId === m.id && l.status === 'live');
    const liveAcc = [...new Set(liveL.map((l) => l.account))];
    if (allRem >= 2) {
      if (liveL.length) out.push({ k: 'quitar', m, acc: liveAcc.join(', '), why: `${allRem} retiradas por reportes → fuera de todas las cuentas`, p: 92 });
      continue;
    }
    for (const a of liveAcc) {
      if (remOf(m.id, a).some((l) => ago(l.endedAt, 30))) out.push({ k: 'quitar', m, acc: a, why: 'retirado en esta cuenta hace menos de 30 días', p: 88 });
      const aa = acc.accs.find((z) => z.name === a);
      if (aa && aa.status !== 'activa') out.push({ k: 'quitar', m, acc: a, why: `cuenta ${aa.status}`, p: 86 });
    }
    if (m.status !== 'ganador' || st.home <= 0) continue;
    const allowed = acc.active.filter((a) => a.health !== 'peligro' && !remOf(m.id, a.name).some((l) => ago(l.endedAt, 30)));
    const want = Math.min(maxAcc, allowed.length, Math.max(1, st.home));
    if (liveAcc.length < want) {
      const pick = allowed.filter((a) => !liveAcc.includes(a.name))
        .map((a) => ({ a, sold: sales.filter((v) => v.modelId === m.id && v.account === a.name).length }))
        .sort((p, q) => q.sold - p.sold || p.a.live.length - q.a.live.length)[0];
      if (pick) out.push({ k: 'publicar', m, acc: pick.a.name, why: liveAcc.length ? `${st.home} en casa, solo en ${liveAcc.length} cuenta` : `${st.home} en casa y ningún anuncio apuntado (si ya está subido, apúntalo)`, p: liveAcc.length ? 70 : 84, home: st.home });
    }
    if (liveAcc.length > maxAcc) out.push({ k: 'quitar', m, acc: liveAcc[liveAcc.length - 1], why: `en ${liveAcc.length} cuentas a la vez (máx. ${maxAcc}) → más reportes`, p: 66 });
  }
  // tests only on the main account
  for (const l of listings.filter((z) => z.status === 'live')) {
    const m = models.find((z) => z.id === l.modelId);
    if (m && m.status === 'test' && acc.mainName && l.account !== acc.mainName) out.push({ k: 'mover', m, acc: l.account, why: `los tests solo en ${acc.mainName}`, p: 60, lid: l.id });
  }
  return out;
}

// Stale live listings of winners: no sale on that listing for 4+ days.
export function staleListings(x) {
  const { listings, models, now } = x;
  return listings.filter((l) => l.status === 'live' && l.listedAt && (now - Date.parse(l.renewedAt || l.listedAt)) / DAY >= 4)
    .map((l) => ({ l, m: models.find((z) => z.id === l.modelId), days: Math.floor((now - Date.parse(l.renewedAt || l.listedAt)) / DAY) }))
    .filter((z) => z.m && z.m.status === 'ganador');
}

/* ---------------- pace vs plan ---------------- */
export function paceFor(x) {
  const { settings: s, sales, today } = x;
  const mk = today.slice(0, 7), plan = (s.plan || {})[mk] || null;
  const [y, mo] = mk.split('-').map(Number), dim = new Date(y, mo, 0).getDate(), day = Number(today.slice(8));
  const from = plan && plan.from && plan.from.startsWith(mk) ? plan.from : mk + '-01';
  const ms = sales.filter((v) => v.date && v.date.startsWith(mk) && v.date >= from);
  const S = ms.length, P = sum(ms.map((v) => (typeof v.profit === 'number' ? v.profit : n0(v.price) - n0(v.cost))));
  const firstDay = plan && plan.from && plan.from.startsWith(mk) ? Number(plan.from.slice(8)) : 1;
  const elapsed = Math.max(1, day - firstDay + 1), left = Math.max(1, dim - day + 1);
  const T = plan ? n0(plan.sales) : 0, MIN = plan ? n0(plan.min) : 0, PT = plan ? n0(plan.profit) : 0;
  const paceDay = S / elapsed, proj = Math.round(S + paceDay * (dim - day));
  return { mk, plan, S, P, T, MIN, PT, dim, day, left, paceDay, need: T ? Math.max(0, (T - S) / left) : 0, needMin: MIN ? Math.max(0, (MIN - S) / left) : 0, proj, ok: T ? proj >= T : null, minOk: MIN ? proj >= MIN : null };
}

// How many tests you need, from the goal: winners missing for this month's target ÷ how often a test becomes a winner.
export function testPace({ stocks, pace, settings, models }) {
  const live = stocks.filter((s) => s.m.status === 'ganador' && s.rate >= 0.1);
  const perWinner = live.length ? Math.max(8, median(live.map((s) => s.rate * 30))) : 20;
  const target = pace.T || n0(settings.monthlyGoal) / 20 || 50;
  const winnersNeeded = Math.max(0, Math.ceil(target / perWinner) - live.length);
  const hit = clamp(n0(settings.hitRate) || 0.25, 0.05, 0.8);
  // +1 winner a month to replace the one that tires out
  const perWeek = Math.max(n0(settings.testBench) || FALLBACK.bench, Math.ceil((winnersNeeded + 1) / hit / 4));
  const concurrent = Math.max(n0(settings.testBench) || FALLBACK.bench, Math.ceil(perWeek / 3));
  return { perWinner, winnersNeeded, hit, perWeek, concurrent, liveWinners: live.length, target };
}

export function accountsNeeded(acc, pace) {
  const rates = acc.active.map((a) => a.rate).filter((r) => r > 0);
  const per = rates.length ? median(rates) : 0;
  if (!pace.T || !per) return { per, need: null };
  const perMonth = per * pace.dim;
  return { per, perMonth, need: Math.ceil(pace.T / perMonth), have: acc.active.length };
}

/* ---------------- proof + data checks ---------------- */
// A watch is a winner only with proof: 1 real sale, or 2+ offers on one of its listings. Without it, "ganador" is treated as a test.
export function proofOf(m, sales, listings) {
  const sold = sales.filter((v) => v.modelId === m.id && !v.cancelled).length + Math.round(n0(m.base14));
  const offers = Math.max(0, ...listings.filter((l) => l.modelId === m.id).map((l) => n0((latestSnap(l) || {}).offers)));
  return { sold, offers, ok: sold >= 1 || offers >= 2 };
}
export function effStatus(m, sales, listings) {
  if (m.status !== 'ganador' && m.status !== 'test') return m.status;
  return proofOf(m, sales, listings).ok ? 'ganador' : 'test';
}
const normName = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/bronze/g, 'bronce').replace(/golden|gold|dorado/g, 'oro').replace(/silver|plateado/g, 'plata').replace(/[^a-z0-9 ]/g, ' ');
const STOP = new Set(['reloj', 'relojes', 'watch', 'correa', 'esfera', 'vestir', 'hombre', 'mujer', 'grande', 'retro', 'con', 'the', 'and', 'de', 'del', 'la', 'el', 'y']);
// Two active models that look like the same watch (shared key word): their sales should be merged into one.
export function possibleDupes(models, notDupes = []) {
  const ms = models.filter((m) => m.status !== 'descartado'), out = [], skip = new Set(notDupes);
  const toks = (m) => new Set(normName(m.name).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)));
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    if (skip.has(ms[i].id + '|' + ms[j].id) || skip.has(ms[j].id + '|' + ms[i].id)) continue;
    // same watch = every key word of the shorter name is in the other one ("Reloj bronze" ⊂ "Bronce vestir · correa marrón")
    let a = toks(ms[i]), b = toks(ms[j]); if (a.size > b.size) [a, b] = [b, a];
    if (a.size && [...a].every((w) => b.has(w))) out.push({ a: ms[i], b: ms[j], word: [...a][0] });
  }
  return out;
}

/* ---------------- everything + best moves ---------------- */
export function analyze(input) {
  const { sales, orders, listings, settings, now, costOf, cashFree, owed } = input;
  const today = input.today;
  // when each watch first landed at home (start of its sales clock)
  const arrivedOf = {};
  for (const o of orders) if (o.status === 'recibido' && o.receivedDate) for (const l of o.lines || []) if (!arrivedOf[l.modelId] || o.receivedDate < arrivedOf[l.modelId]) arrivedOf[l.modelId] = o.receivedDate;
  // engine works on the EFFECTIVE status: "ganador" without proof counts as a test
  const models = input.models.map((m) => ({ ...m, marked: m.status, status: effStatus(m, sales, listings), _arrived: arrivedOf[m.id] || null }));
  const x = { ...input, models, today, z: FALLBACK.serviceZ, cycle: n0(settings.cycleDays) || FALLBACK.cycleDays };
  x.lead = leadTimes(orders, settings);
  x.bench = benchmarks(listings, models);
  const live = models.filter((m) => m.status !== 'descartado' || n0(m.home) > 0);
  const stocks = live.map((m) => stockFor(m, demand(m.id, sales, today, m), x));
  const tests = models.filter((m) => m.status === 'test' || m.marked === 'test').map((m) => testFor(m, x));
  const acc = accountsFor(x);
  const dist = distribution(x, acc, stocks);
  const stale = staleListings(x);
  const pace = paceFor(x);
  // projection can't beat the stock you'll have: units at home + what lands before month end
  {
    const end = pace.mk + '-' + String(pace.dim).padStart(2, '0');
    const inHand = sum(stocks.map((s) => s.home)), landing = sum(stocks.flatMap((s) => s.arrivals.filter((a) => a.eta <= end).map((a) => a.qty)));
    const nextIn = stocks.flatMap((s) => s.arrivals).map((a) => a.eta).sort()[0] || null;
    pace.projDemand = pace.proj; pace.inHand = inHand; pace.landing = landing; pace.nextIn = nextIn; pace.cap = pace.S + inHand + landing;
    pace.limit = pace.cap < pace.proj ? 'stock' : 'ritmo';
    if (pace.limit === 'stock') { pace.proj = pace.cap; pace.ok = pace.T ? pace.proj >= pace.T : null; pace.minOk = pace.MIN ? pace.proj >= pace.MIN : null; }
    pace.biz = n0(input.bizMonth); pace.net = pace.P - pace.biz;
  }
  const need = accountsNeeded(acc, pace);
  const plan = orderPlan(stocks, cashFree, costOf);
  const tp = testPace({ stocks, pace, settings, models });
  const benchN = tp.concurrent;
  const moves = [];
  const add = (p, tag, title, why, act) => moves.push({ p, tag, title, why, act });
  const logged14 = sales.filter((v) => v.date >= addD(today, -13)).length;
  const based = models.some((m) => m.baseAt && diffD(m.baseAt, today) <= 27);
  if (logged14 < 10 && !based) add(99, 'Datos', `Solo veo ${logged14} venta${logged14 === 1 ? '' : 's'} en 14 días`, 'si vendes más, ponme al día (2 min) o todo lo que te digo sale de casi nada', { a: 'catchup' });
  for (const dp of possibleDupes(models, settings.notDupes || [])) add(97, 'Datos', `¿${dp.a.name} y ${dp.b.name} son el mismo reloj?`, 'las ventas de uno no cuentan para el stock del otro → si es el mismo, fusiónalos (Stock → reloj → Fusionar)', { a: 'model', id: dp.a.id });
  const orphan = sales.filter((v) => !v.cancelled && !input.models.some((m) => m.id === v.modelId)).length;
  if (orphan) add(96, 'Datos', `${orphan} venta${orphan === 1 ? '' : 's'} sin reloj`, 'su reloj ya no existe → no cuentan para ningún stock', { a: 'tab', v: 'calendario' });
  const noSpec = models.filter((m) => m.status !== 'descartado' && (n0(m.home) || n0(m.transit)) && (!(n0(m.unitPrice) > 0) || !(n0(m.weight) > 0)));
  if (noSpec.length) add(84, 'Datos', `Faltan precio 1688 o peso en ${noSpec.length} reloj${noSpec.length === 1 ? '' : 'es'}`, `${noSpec.map((m) => m.name).join(', ')} → sin peso el envío se reparte por valor y el coste real sale mal`, { a: 'model', id: noSpec[0].id });
  // bags: pouch sales of the last 14 days → how many days the pouches last
  const pRate = sales.filter((v) => v.pouch && v.date >= addD(today, -13) && v.date <= today).length / 14, pLeft = n0(input.pouches);
  const bags = { left: pLeft, perDay: pRate, days: pRate > 0 ? pLeft / pRate : null };
  if (pRate > 0 && pLeft / pRate < 7) add(pLeft ? 76 : 83, 'Stock', pLeft ? `Bolsitas: quedan ${pLeft} (${Math.floor(pLeft / pRate)} días)` : 'Bolsitas: 0', `gastas ${(pRate * 7).toFixed(1).replace('.', ',')} a la semana → mételas en el próximo pedido`, { a: 'settings' });
  if (owed > 0) add(95, 'Deuda', `Paga ${Math.round(owed)} € que debes`, 'deuda primero: nada nuevo se compra hasta pagarla', { a: 'goto-orders' });
  for (const s of stocks) {
    if (s.status === 'rotura' && !s.transit) add(94, 'Stock', `${s.m.name}: sin stock`, s.why, { a: 'goto-plan' });
    else if (s.status === 'rotura') add(80, 'Stock', `${s.m.name}: 0 en casa`, s.why, { a: 'model', id: s.m.id });
    else if (s.status === 'urgente') add(90, 'Stock', `${s.m.name}: ${s.bridge ? `DHL ${s.bridge} uds ya` : s.gap ? `${s.gap} días sin stock` : 'pide ya'}`, s.why, { a: s.qty ? 'goto-plan' : 'model', id: s.m.id });
    else if (s.status === 'pedir') add(72, 'Stock', `${s.m.name}: pide ${s.ddpQty} por DDP`, s.why, { a: 'goto-plan' });
    else if (s.status === 'parado' || s.status === 'liquidar') add(55, 'Stock', `${s.m.name}: stock parado`, s.why, { a: 'model', id: s.m.id });
    else if (s.status === 'enfria') add(74, 'Stock', `${s.m.name}: se ha parado`, s.why, { a: 'model', id: s.m.id });
  }
  for (const t of tests) {
    // only what changes stock: a winner means ordering, a dead test means never ordering it, missing stats block the verdict
    if (t.stage === 'ganador') add(89, 'Test', `${t.m.name}: ganador → pide ${t.firstQty}`, t.why, { a: 'test', id: t.m.id });
    else if (t.stage === 'muerto') add(87, 'Test', `${t.m.name}: muerto → no pedir más`, `${t.why}${t.home ? ` · quedan ${t.home} en casa` : ''}`, { a: 'test', id: t.m.id });
    else if (t.stage === 'datos') add(85, 'Datos', `${t.m.name}: faltan stats del test`, `${t.why} → sin vistas, favs y ofertas no hay veredicto`, { a: 'test', id: t.m.id });
  }
  const running = tests.filter((t) => t.ls.length && !['ganador', 'muerto'].includes(t.stage)).length;
  if (pace.T && pace.ok === false) add(60, 'Ritmo', `Necesitas ${pace.need.toFixed(1)} ventas/día`, pace.limit === 'stock' ? `el límite es el stock: ${pace.inHand} en casa + ${pace.landing} que llegan este mes → máx. ${pace.cap} de ${pace.T}` : `vas a ${pace.paceDay.toFixed(1)}/día → acabas en ~${pace.proj} de ${pace.T}`, { a: 'tab', v: 'metas' });
  moves.sort((a, b) => b.p - a.p);
  return { x, lead: x.lead, bench: x.bench, stocks, tests, acc, dist, stale, pace, need, plan, moves, running, benchN, tp, bags, models };
}
