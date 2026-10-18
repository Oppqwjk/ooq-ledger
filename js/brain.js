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
  leadDHL: 7, leadDDP: 18,          // days from paying to having it at home
  fav: 0.15, vpd: 15, opv: 3,       // test benchmarks: favourites/views, views per day, offers per 100 views
  cycleDays: 30,                    // a DDP order covers this many days of sales
  serviceZ: 1.28,                   // safety stock for ~90% of demand swings
  bench: 3,                         // tests running at the same time
  maxAccPerModel: 2,
  pendingDays: 10,                  // days a sale stays pending in Vinted before it's in your money
};
export const STAGE = { espera: 'Esperando', datos: 'Faltan datos', portada: 'Cambia portada', sigue: 'Sigue', bajar: 'Baja precio', oferta: 'Oferta buena', ganador: 'Ganador', muerto: 'Muerto', nopub: 'Sin publicar' };

/* ---------------- demand ---------------- */
// Weighted sales per day over the last 28 days. Recent days weigh more (half-life 7 days),
// so a model that is heating up or cooling down shows it within days, not weeks.
export function demand(mid, sales, today) {
  const mine = sales.filter((s) => s.modelId === mid && s.date && s.date <= today);
  const base = { rate: 0, last7: 0, prev7: 0, last14: 0, total: mine.length, sd: 0, lastSale: null, first: null, trend: 0 };
  if (!mine.length) return base;
  const dates = mine.map((s) => s.date).sort();
  const first = dates[0], lastSale = dates[dates.length - 1];
  const from = addD(today, -27), start = first > from ? first : from, days = diffD(start, today) + 1;
  const counts = {}; for (const s of mine) if (s.date >= start) counts[s.date] = (counts[s.date] || 0) + 1;
  let ws = 0, wt = 0; const arr = [];
  for (let i = 0; i < days; i++) { const k = addD(start, i), c = counts[k] || 0, w = Math.pow(0.5, diffD(k, today) / 7); ws += w * c; wt += w; arr.push(c); }
  // a model that only started selling a few days ago: pad to 7 days so 3 sales on day 1 isn't read as 3/day forever
  for (let i = days; i < 7; i++) { wt += 1; arr.push(0); }
  const rate = ws / wt, mean = sum(arr) / arr.length;
  const sd = Math.sqrt(sum(arr.map((c) => (c - mean) ** 2)) / arr.length);
  const inR = (a, b) => mine.filter((s) => s.date >= addD(today, a) && s.date <= addD(today, b)).length;
  const last7 = inR(-6, 0), prev7 = inR(-13, -7);
  return { rate, last7, prev7, last14: last7 + prev7, total: mine.length, sd, lastSale, first, trend: prev7 ? last7 / prev7 - 1 : last7 ? 1 : 0 };
}

/* ---------------- lead times ---------------- */
// Learned from your own received orders per lane (last 3). Falls back until you have some.
export function leadTimes(orders, s) {
  const def = { dhl: n0(s.leadDHL) || FALLBACK.leadDHL, ddp: n0(s.leadDDP) || FALLBACK.leadDDP };
  def.otro = def.ddp;
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
  const up = unitProfit(m, sales, costOf), cost = costOf(m);
  const r = { m, rate, d, home, transit, stock, arrivals, unitProfit: up, cost, profitDay: rate * up, capital: home * cost, lead: L, leadDhl: Ld,
    coverHome: rate > 0 ? home / rate : Infinity, coverAll: rate > 0 ? stock / rate : Infinity, safety: 0, rop: 0, target: 0,
    qty: 0, bridge: 0, ddpQty: 0, gap: 0, outDate: null, status: 'sin datos', why: '' };
  if (m.status === 'descartado') { r.status = home > 0 ? 'liquidar' : 'fuera'; r.why = home > 0 ? `${home} uds de un reloj descartado: véndelas a precio de salida` : ''; return r; }
  const idle = d.lastSale ? diffD(d.lastSale, today) : null;
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
  const short = L - Math.max(r.coverAll, Ld);
  if (r.coverAll < L && short > 0) r.bridge = Math.max(5, ceil5(rate * short + r.safety));
  // home runs out before the box on the way lands: a DHL box can fill that hole only if it lands first
  r.dhlInTime = !next || addD(today, Ld) < next.eta;
  if (r.gap > 0 && next && r.dhlInTime) {
    const from = addD(today, Ld) > r.outDate ? addD(today, Ld) : r.outDate;
    r.bridge = Math.max(r.bridge, Math.max(5, ceil5(rate * diffD(from, next.eta))));
  }
  if (stock <= r.rop) r.ddpQty = Math.max(5, ceil5(r.target - stock - r.bridge));
  else if (r.bridge) r.ddpQty = Math.max(0, ceil5(r.target - stock - r.bridge));
  r.qty = r.bridge + r.ddpQty;
  if (home === 0) { r.status = 'rotura'; r.why = transit ? `0 en casa · llegan ${transit} el ${fd(next ? next.eta : '')}${r.bridge ? ` → DHL ${r.bridge} uds tapa el hueco` : ''}` : `0 en casa y nada en camino · pierdes ~${(rate * 7).toFixed(1)} ventas/semana`; }
  else if (r.gap > 0) { r.status = 'urgente'; r.why = `se acaba el ${fd(r.outDate)}, el pedido llega el ${fd(next.eta)} → ${r.gap} días sin stock` + (r.bridge ? ` → DHL ${r.bridge} uds ya` : ' → DHL tampoco llega antes: no aceptes ofertas bajas, vende a precio completo'); }
  else if (r.coverAll < L) { r.status = 'urgente'; r.why = `${Math.floor(r.coverAll)} días de stock y un DDP tarda ${L}`; }
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
  const cps = [24, 48, 72, 96], h = t.hours, cp = cps.filter((c) => h >= c).pop() || 0;
  t.next = cps.find((c) => c > h) || null;
  const snapH = t.lastSnap ? hrs(t.lastSnap, now) : Infinity; // hours since last stats
  const needData = cp && (snapH > h - cp + 6); // no stats taken after the current checkpoint
  const goodOffer = t.best && t.best - cost >= Math.max(12, 0.5 * (price - cost));
  if (t.sold && h <= 120) { t.stage = 'ganador'; t.why = `${t.sold} vendido${t.sold > 1 ? 's' : ''} en ${Math.round(h)}h`; t.act = `Ganador → pide ${t.firstQty}`; return t; }
  if (goodOffer) { t.stage = 'oferta'; t.why = `oferta de ${t.best} € = ${Math.round(t.best - cost)} € de beneficio`; t.act = 'Acéptala: una venta en el test vale más que esperar'; return t; }
  if (h < 24) { t.stage = t.views ? 'sigue' : 'espera'; t.why = `${Math.round(h)}h publicado`; t.act = `Stats a las 24h`; return t; }
  if (needData) { t.stage = 'datos'; t.why = `control de ${cp}h sin stats`; t.act = 'Manda captura o mete vistas, favoritos y ofertas'; return t; }
  const expViews = bench.vpd * Math.min(h, 48) / 24;
  if (cp >= 48 && (t.offers >= 2 || (t.favRate >= bench.fav && t.offers >= 1))) { t.stage = 'ganador'; t.why = `${Math.round(t.favRate * 100)}% favs · ${t.offers} ofertas en ${Math.round(h)}h`; t.act = `Ganador → pide ${t.firstQty}`; return t; }
  if (cp >= 96) { t.stage = 'muerto'; t.why = `${Math.round(h / 24)} días sin venta`; t.act = `Fuera → lo que quede a ${Math.max(Math.round(cost + 8), 20)},95 €`; return t; }
  if (cp >= 48 && t.views >= 10 && t.favRate < 0.5 * bench.fav && !t.offers) { t.stage = 'muerto'; t.why = `${Math.round(t.favRate * 100)}% favs (un ganador tuyo hace ${Math.round(bench.fav * 100)}%) y 0 ofertas`; t.act = 'Fuera → sube el siguiente test'; return t; }
  if (t.views < 0.5 * expViews) { t.stage = 'portada'; t.why = `${t.views} vistas, esperabas ~${Math.round(expViews)}`; t.act = 'Foto de portada nueva + título nuevo ya'; return t; }
  if (cp >= 72) {
    const np = Math.floor(Math.max(n0(m.minPrice) || 0, cost + 12, price - 5)) + 0.95;
    t.newPrice = np;
    t.stage = 'bajar'; t.why = `${Math.round(h)}h sin venta con ${t.favs} favs`; t.act = `Baja a ${np.toFixed(2).replace('.', ',')} € + manda oferta a los ${t.favs} favs`; return t;
  }
  t.stage = 'sigue'; t.why = `${Math.round(t.favRate * 100)}% favs · ${t.offers} ofertas`; t.act = `Siguiente control a las ${t.next}h`; return t;
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
      if (pick) out.push({ k: 'publicar', m, acc: pick.a.name, why: liveAcc.length ? `${st.home} en casa, solo en ${liveAcc.length} cuenta` : `${st.home} en casa y 0 anuncios activos`, p: liveAcc.length ? 70 : 84, home: st.home });
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

export function accountsNeeded(acc, pace) {
  const rates = acc.active.map((a) => a.rate).filter((r) => r > 0);
  const per = rates.length ? median(rates) : 0;
  if (!pace.T || !per) return { per, need: null };
  const perMonth = per * pace.dim;
  return { per, perMonth, need: Math.ceil(pace.T / perMonth), have: acc.active.length };
}

/* ---------------- everything + best moves ---------------- */
export function analyze(input) {
  const { models, sales, orders, listings, settings, now, costOf, cashFree, owed } = input;
  const today = input.today;
  const x = { ...input, today, z: FALLBACK.serviceZ, cycle: n0(settings.cycleDays) || FALLBACK.cycleDays };
  x.lead = leadTimes(orders, settings);
  x.bench = benchmarks(listings, models);
  const live = models.filter((m) => m.status !== 'descartado' || n0(m.home) > 0);
  const stocks = live.map((m) => stockFor(m, demand(m.id, sales, today), x));
  const tests = models.filter((m) => m.status === 'test').map((m) => testFor(m, x));
  const acc = accountsFor(x);
  const dist = distribution(x, acc, stocks);
  const stale = staleListings(x);
  const pace = paceFor(x);
  const need = accountsNeeded(acc, pace);
  const plan = orderPlan(stocks, cashFree, costOf);
  const benchN = n0(settings.testBench) || FALLBACK.bench;
  const moves = [];
  const add = (p, tag, title, why, act) => moves.push({ p, tag, title, why, act });
  if (owed > 0) add(95, 'Deuda', `Paga ${Math.round(owed)} € que debes`, 'deuda primero: nada nuevo se compra hasta pagarla', { a: 'goto-orders' });
  for (const s of stocks) {
    if (s.status === 'rotura' && !s.transit) add(94, 'Stock', `${s.m.name}: sin stock`, s.why, { a: 'goto-plan' });
    else if (s.status === 'rotura') add(80, 'Stock', `${s.m.name}: 0 en casa`, s.why, { a: 'model', id: s.m.id });
    else if (s.status === 'urgente') add(90, 'Stock', `${s.m.name}: ${s.bridge ? `DHL ${s.bridge} uds ya` : s.gap ? `${s.gap} días sin stock` : 'pide ya'}`, s.why, { a: s.qty ? 'goto-plan' : 'model', id: s.m.id });
    else if (s.status === 'pedir') add(72, 'Stock', `${s.m.name}: pide ${s.ddpQty} por DDP`, s.why, { a: 'goto-plan' });
    else if (s.status === 'parado' || s.status === 'liquidar') add(55, 'Stock', `${s.m.name}: stock parado`, s.why, { a: 'model', id: s.m.id });
  }
  for (const t of tests) {
    const P = { ganador: 89, oferta: 91, muerto: 87, portada: 86, datos: 85, bajar: 83, nopub: t.home ? 82 : 0 }[t.stage];
    if (P) add(P, 'Test', `${t.m.name}: ${STAGE[t.stage]}`, `${t.why} → ${t.act}`, { a: 'test', id: t.m.id });
  }
  const running = tests.filter((t) => t.ls.length && !['ganador', 'muerto'].includes(t.stage)).length;
  if (running < benchN) add(68, 'Test', `Sube ${benchN - running} test${benchN - running > 1 ? 's' : ''} nuevo${benchN - running > 1 ? 's' : ''}`, `${running} de ${benchN} tests corriendo → sin tests no hay ganadores nuevos`, { a: 'tab', v: 'tests' });
  for (const d of dist) add(d.p, 'Cuentas', `${d.k === 'publicar' ? 'Publica' : d.k === 'mover' ? 'Mueve' : 'Quita'} ${d.m.name} ${d.k === 'publicar' ? 'en' : 'de'} ${d.acc}`, d.why, { a: 'tab', v: 'cuentas' });
  for (const z of stale) add(62, 'Anuncio', `Renueva ${z.m.name} en ${z.l.account}`, `${z.days} días sin vender ese anuncio → portada nueva y vuelve a subirlo`, { a: 'listing', id: z.l.id });
  if (pace.T && pace.ok === false) add(60, 'Ritmo', `Necesitas ${pace.need.toFixed(1)} ventas/día`, `vas a ${pace.paceDay.toFixed(1)}/día → acabas en ~${pace.proj} de ${pace.T}`, { a: 'tab', v: 'metas' });
  for (const a of acc.accs) if (a.health === 'peligro' || a.health === 'riesgo') add(a.health === 'peligro' ? 84 : 64, 'Cuentas', `${a.name}: ${a.health}`, `${a.rem14} retirada${a.rem14 > 1 ? 's' : ''} en 14 días → solo ganadores seguros, nada que parezca de marca`, { a: 'tab', v: 'cuentas' });
  moves.sort((a, b) => b.p - a.p);
  return { x, lead: x.lead, bench: x.bench, stocks, tests, acc, dist, stale, pace, need, plan, moves, running, benchN };
}
