// OOQ Manager agent: Claude talks to you inside the app, sees all your Ledger data on every message,
// logs what you tell it (sales, listings, stats, tests, stock, expenses, debts) and reads Vinted screenshots.
// Calls the Claude API straight from your device with your own key (stored only on this device).

const API = 'https://api.anthropic.com/v1/messages';
export const MODES = [['auto', 'Ahorro: Haiku para apuntar, Sonnet para pensar (recomendado)'], ['sonnet', 'Siempre Sonnet (más listo, ~2× más caro)'], ['haiku', 'Siempre Haiku (lo más barato)']];

const n0 = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
const r2 = (v) => Math.round(v * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export const SYSTEM = `Eres OOQ Manager, el operador del negocio de relojes de Yassin en Vinted (cuenta principal "tictac spain"). Compra en 1688, vende en Vinted. Objetivo: 3.000 €/mes de beneficio en abril 2027 y 4.500–5.000 €/mes en junio 2027.

Cómo hablas:
- En el idioma en que te escriba (español o inglés). Directo, corto, agresivo con los objetivos, sin rodeos. Sin emojis. Viñetas y flechas (->) para causa y efecto. Números exactos con los cálculos.
- Siempre terminas con lo que tiene que hacer AHORA (máx. 3 cosas) con números y fechas.
- Nunca inventas datos. Si falta algo, lo pides en una frase. Si está equivocado, se lo dices con el número que lo demuestra.

Qué haces:
- Ves todos sus datos en DATOS (se actualizan en cada mensaje). Si ves pocas ventas apuntadas, pregúntale cuántas ha vendido de cada reloj en 14 días y usa ponerme_al_dia antes de dar consejos de stock. Los cálculos de stock, tests, cuentas y movimientos ya están hechos ahí: úsalos y explícalos.
- Cuando te cuente algo que ha pasado (venta, anuncio subido, stats, gasto, pago, retirada, cambio de stock) LO APUNTAS con las herramientas, sin pedir permiso, y confirmas con los totales nuevos. Si es ambiguo (qué reloj, qué cuenta, qué precio) preguntas antes.
- Capturas de Vinted: lees vistas, favoritos, ofertas y la mejor oferta y llamas a registrar_stats. Si no se leen bien, lo dices.
- Tests estrictos: 24h = control de vistas (pocas -> portada y título nuevos). 48h = veredicto: 0 ofertas = MUERTO, sin excusas. 2+ ofertas, o 1 oferta con favs de ganador, o 1 venta = GANADOR -> pedir. 1 oferta floja = 24h de última oportunidad a −3 €, y a las 72h sin venta = muerto. Oferta que deja buen beneficio = aceptarla. Cuántos tests: los que diga tests_ritmo (salen del objetivo), nunca te limitas a 3.
- Stock: si un reloj no vende en 7 días, no se repone aunque quede poco: primero se mueve (portada, precio, otra cuenta). Con pocas ventas apuntadas no inventes ritmos: pregunta.
- Stock: deuda primero, nada nuevo hasta pagarla. Pedidos pagados con ventas. Ganadores por DDP, huecos urgentes por DHL. Usa el pedido recomendado.
- Tu terreno son los números: stock, pedidos, caja, deuda, ritmo y veredictos de tests. Cómo publicar, fotos, títulos y cuentas lo domina él: no des consejos de eso salvo que te lo pida.
- Anuncios (solo si pregunta): nunca marcas, logos, "réplica", "inspirado en", ni relojes que parezcan de lujo (atraen reportes). Nada de "ojo" ni gótico. Fotos propias, esfera real.
- Cuentas: cada ganador en máx. 2 cuentas con fotos y texto distintos; tests solo en la principal; lo retirado por reportes sale de esa cuenta 30 días. Cuentas extra solo de personas reales con su propio móvil, DNI y banco, vendiendo su stock en depósito. No ayudas a ocultar cuentas múltiples con los mismos datos ni a engañar a Vinted (dispositivos falsos, IPs, etc.): explicas que una cuenta enlazada congela el dinero pendiente de todas.
- Impuestos y autónomo: das números, pero la decisión la confirma su gestor.`;

export function createAgent(api) {
  const { db, C, L, model, S0, brain, fresh, costOf, todayKey, nowISO, patchSettings, pouches, pouchCost } = api;

  /* ---------- finding things by what you call them ---------- */
  function findModel(q) {
    if (!q) return { err: 'Falta el reloj.' };
    const ms = L('models'), byId = ms.find((m) => m.id === q);
    if (byId) return { m: byId };
    const nq = norm(q), toks = nq.split(' ').filter((t) => t.length > 1);
    const scored = ms.map((m) => {
      const nn = norm(m.name + ' ' + (m.alias || ''));
      let sc = nn === nq ? 100 : nn.includes(nq) ? 60 : 0;
      for (const t of toks) if (nn.includes(t)) sc += 10;
      if (m.status === 'descartado') sc -= 5;
      return { m, sc };
    }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
    if (!scored.length) return { err: `No encuentro "${q}". Relojes: ${ms.map((m) => m.name).join(' | ')}` };
    if (scored.length > 1 && scored[0].sc === scored[1].sc && scored[0].sc < 60) return { err: `"${q}" puede ser: ${scored.slice(0, 4).map((x) => x.m.name).join(' | ')}. Pregunta cuál.` };
    return { m: scored[0].m };
  }
  const accFor = (a) => {
    const names = S0().accounts || [];
    if (!a) return brain().acc.mainName || names[0] || '';
    return names.find((n) => norm(n) === norm(a)) || names.find((n) => norm(n).includes(norm(a))) || a;
  };
  const liveL = (mid, acc) => L('listings').filter((l) => l.modelId === mid && l.status === 'live' && (!acc || l.account === acc)).sort((a, b) => a.listedAt.localeCompare(b.listedAt));
  const eur = (v) => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',') + ' €';

  /* ---------- tools ---------- */
  const TOOLS = [
    { name: 'registrar_venta', description: 'Apunta una venta de un reloj. Úsalo cada vez que el usuario diga que ha vendido algo. Una llamada por unidad vendida.', input_schema: { type: 'object', properties: { reloj: { type: 'string', description: 'nombre o id del reloj tal como sale en los datos' }, precio: { type: 'number', description: 'precio de venta en €' }, cuenta: { type: 'string' }, con_bolsita: { type: 'boolean' }, fecha: { type: 'string', description: 'YYYY-MM-DD, por defecto hoy' }, volver_a_publicar: { type: 'boolean', description: 'por defecto true si queda stock' } }, required: ['reloj', 'precio'] } },
    { name: 'registrar_anuncio', description: 'Apunta un anuncio que el usuario acaba de subir a Vinted (empieza el reloj del test si es un test).', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, cuenta: { type: 'string' }, precio: { type: 'number' } }, required: ['reloj'] } },
    { name: 'registrar_stats', description: 'Guarda vistas, favoritos y ofertas actuales de un anuncio activo (de una captura de Vinted o de lo que diga el usuario).', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, cuenta: { type: 'string' }, vistas: { type: 'number' }, favoritos: { type: 'number' }, ofertas: { type: 'number' }, mejor_oferta: { type: 'number', description: '€ de la mejor oferta, si la hay' } }, required: ['reloj', 'vistas'] } },
    { name: 'crear_test', description: 'Crea un reloj nuevo en test (y su anuncio si ya está publicado).', input_schema: { type: 'object', properties: { nombre: { type: 'string' }, precio_1688: { type: 'number' }, peso_g: { type: 'number' }, precio_venta: { type: 'number' }, uds_en_casa: { type: 'number' }, publicado: { type: 'boolean' }, cuenta: { type: 'string' } }, required: ['nombre'] } },
    { name: 'cambiar_estado_reloj', description: 'Cambia el estado de un reloj: ganador, test, espera o descartado (muerto).', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, estado: { type: 'string', enum: ['ganador', 'test', 'espera', 'descartado'] } }, required: ['reloj', 'estado'] } },
    { name: 'ajustar_stock', description: 'Corrige las unidades en casa y/o en camino de un reloj.', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, en_casa: { type: 'number' }, en_camino: { type: 'number' } }, required: ['reloj'] } },
    { name: 'cambiar_precio', description: 'Cambia el precio de los anuncios activos de un reloj (y su precio de venta).', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, precio: { type: 'number' }, cuenta: { type: 'string' } }, required: ['reloj', 'precio'] } },
    { name: 'quitar_anuncio', description: 'Marca anuncios activos de un reloj como retirados por Vinted (reporte) o quitados por el usuario.', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, cuenta: { type: 'string' }, por_vinted: { type: 'boolean' }, motivo: { type: 'string' } }, required: ['reloj', 'por_vinted'] } },
    { name: 'registrar_gasto', description: 'Apunta un gasto (no pedidos de stock).', input_schema: { type: 'object', properties: { importe: { type: 'number' }, tipo: { type: 'string', enum: ['personal', 'negocio'] }, categoria: { type: 'string' }, nota: { type: 'string' } }, required: ['importe', 'tipo'] } },
    { name: 'ponerme_al_dia', description: 'Cuando el usuario dice cuántos vendió de un reloj en los últimos 14 días sin haberlos apuntado uno a uno (solo para el ritmo de ventas, no entra en caja), y/o cuántos tiene en casa.', input_schema: { type: 'object', properties: { reloj: { type: 'string' }, vendidos_14d: { type: 'number' }, en_casa: { type: 'number' } }, required: ['reloj'] } },
    { name: 'pagar_deuda', description: 'Paga parte o toda la deuda de pedidos (empieza por el pedido más antiguo).', input_schema: { type: 'object', properties: { importe: { type: 'number' } }, required: ['importe'] } },
  ];

  async function run(name, x) {
    const s = S0();
    if (['registrar_venta', 'registrar_anuncio', 'registrar_stats', 'cambiar_estado_reloj', 'ajustar_stock', 'cambiar_precio', 'quitar_anuncio', 'ponerme_al_dia'].includes(name)) {
      const f = findModel(x.reloj); if (f.err) return { error: f.err };
      const m = f.m;
      if (name === 'registrar_venta') {
        const acc = accFor(x.cuenta), price = n0(x.precio); if (!(price > 0)) return { error: 'Precio no válido.' };
        const extra = x.con_bolsita ? pouchCost() : 0, cost = costOf(m), dec = n0(m.home) > 0;
        const lst = liveL(m.id, acc)[0];
        const sale = await db.put(C.sales, { date: x.fecha || todayKey(), at: nowISO(), modelId: m.id, modelName: m.name, price: r2(price), cost: r2(cost + extra), watchCost: r2(cost), extra: r2(extra), estimated: isNaN(parseFloat(m.landed)), profit: r2(price - cost - extra), account: acc, fromStock: dec, pouch: !!x.con_bolsita, pouchFromStock: !!x.con_bolsita && pouches() > 0, listingId: lst ? lst.id : null, by: 'manager' });
        if (dec) await db.patch(C.models, m.id, { home: n0(m.home) - 1 });
        if (x.con_bolsita && pouches() > 0) await patchSettings({ pouches: pouches() - 1 });
        let relisted = false;
        if (lst) {
          await db.patch(C.listings, lst.id, { status: 'sold', endedAt: nowISO(), saleId: sale.id });
          if (x.volver_a_publicar !== false && n0(m.home) - (dec ? 1 : 0) > 0) { await db.put(C.listings, { modelId: m.id, account: acc, price: lst.price, listedAt: nowISO(), status: 'live', snaps: [], relistOf: lst.id }); relisted = true; }
        }
        fresh();
        return { ok: `Venta: ${m.name} a ${eur(price)} en ${acc} → beneficio ${eur(price - cost - extra)}. Quedan ${n0(m.home) - (dec ? 1 : 0)} en casa.${lst ? relisted ? ' Anuncio cerrado y vuelto a publicar.' : ' Anuncio cerrado.' : ' (No había anuncio apuntado en esa cuenta.)'}` };
      }
      if (name === 'registrar_anuncio') {
        const acc = accFor(x.cuenta), price = n0(x.precio) || n0(m.listPrice) || 34.95;
        await db.put(C.listings, { modelId: m.id, account: acc, price: r2(price), listedAt: nowISO(), status: 'live', snaps: [] });
        fresh(); return { ok: `Anuncio apuntado: ${m.name} en ${acc} a ${eur(price)}.` };
      }
      if (name === 'registrar_stats') {
        const ls = liveL(m.id, x.cuenta ? accFor(x.cuenta) : null);
        if (!ls.length) return { error: `${m.name} no tiene anuncio activo apuntado${x.cuenta ? ' en ' + accFor(x.cuenta) : ''}. Pregunta cuándo lo publicó y apúntalo con registrar_anuncio antes.` };
        const l = ls[ls.length - 1];
        await db.patch(C.listings, l.id, { snaps: [...(l.snaps || []), { at: nowISO(), views: Math.round(n0(x.vistas)), favs: Math.round(n0(x.favoritos)), offers: Math.round(n0(x.ofertas)), best: r2(n0(x.mejor_oferta)) }] });
        fresh();
        const t = brain().tests.find((z) => z.m.id === m.id);
        return { ok: `Stats guardadas: ${m.name} (${l.account}) ${Math.round(n0(x.vistas))} vistas, ${Math.round(n0(x.favoritos))} favs, ${Math.round(n0(x.ofertas))} ofertas.` + (t ? ` Veredicto del test: ${t.stage} · ${t.why} → ${t.act}` : '') };
      }
      if (name === 'ponerme_al_dia') {
        const p = {}; if (x.vendidos_14d !== undefined) { p.base14 = Math.max(0, Math.round(n0(x.vendidos_14d))); p.baseAt = todayKey(); } if (x.en_casa !== undefined) p.home = Math.max(0, Math.round(n0(x.en_casa)));
        await db.patch(C.models, m.id, p); fresh(); const st = brain().stocks.find((z) => z.m.id === m.id);
        return { ok: `${m.name} al día${p.base14 !== undefined ? `: ${p.base14} vendidos en 14 días` : ''}${p.home !== undefined ? `, ${p.home} en casa` : ''}.` + (st ? ` Ahora: ${st.rate.toFixed(2)}/día, estado ${st.status}${st.why ? ' · ' + st.why : ''}.` : '') };
      }
      if (name === 'cambiar_estado_reloj') { await db.patch(C.models, m.id, { status: x.estado }); fresh(); return { ok: `${m.name} → ${x.estado}.` }; }
      if (name === 'ajustar_stock') {
        const p = {}; if (x.en_casa !== undefined) p.home = Math.max(0, Math.round(n0(x.en_casa))); if (x.en_camino !== undefined) p.transit = Math.max(0, Math.round(n0(x.en_camino)));
        await db.patch(C.models, m.id, p); fresh(); return { ok: `${m.name}: ${p.home !== undefined ? p.home + ' en casa ' : ''}${p.transit !== undefined ? p.transit + ' en camino' : ''}.` };
      }
      if (name === 'cambiar_precio') {
        const ls = liveL(m.id, x.cuenta ? accFor(x.cuenta) : null), pr = r2(n0(x.precio));
        for (const l of ls) await db.patch(C.listings, l.id, { price: pr });
        await db.patch(C.models, m.id, { listPrice: pr }); fresh();
        return { ok: `${m.name} a ${eur(pr)} (${ls.length} anuncio${ls.length === 1 ? '' : 's'}).` };
      }
      if (name === 'quitar_anuncio') {
        const ls = liveL(m.id, x.cuenta ? accFor(x.cuenta) : null); if (!ls.length) return { error: 'No hay anuncios activos de ese reloj.' };
        for (const l of ls) await db.patch(C.listings, l.id, { status: x.por_vinted ? 'removed' : 'down', endedAt: nowISO(), reason: x.motivo || (x.por_vinted ? 'retirado por Vinted' : '') });
        fresh(); return { ok: `${ls.length} anuncio${ls.length === 1 ? '' : 's'} de ${m.name} ${x.por_vinted ? 'marcado como retirado por Vinted' : 'quitado'}.` };
      }
    }
    if (name === 'crear_test') {
      const price = n0(x.precio_venta) || 34.95;
      const m = await db.put(C.models, { name: x.nombre, status: 'test', home: Math.round(n0(x.uds_en_casa)), transit: 0, unitPrice: n0(x.precio_1688) || null, weight: n0(x.peso_g) || null, listPrice: price, order: L('models').length + 1 });
      if (x.publicado) await db.put(C.listings, { modelId: m.id, account: accFor(x.cuenta), price, listedAt: nowISO(), status: 'live', snaps: [] });
      fresh(); return { ok: `Test creado: ${x.nombre}${x.publicado ? ', publicado ahora → stats a las 24h' : ' (sin publicar aún)'}.` };
    }
    if (name === 'registrar_gasto') {
      const amt = r2(n0(x.importe)); if (!(amt > 0)) return { error: 'Importe no válido.' };
      await db.put(C.spend, { date: todayKey(), at: nowISO(), amount: amt, kind: x.tipo === 'negocio' ? 'negocio' : 'personal', cat: x.categoria || (x.tipo === 'negocio' ? 'Otros negocio' : 'Otros'), note: x.nota || '' });
      fresh(); return { ok: `Gasto ${x.tipo} de ${eur(amt)} apuntado.` };
    }
    if (name === 'pagar_deuda') {
      let left = r2(n0(x.importe)); const done = [];
      for (const o of L('orders').filter((z) => n0(z.owed) > 0).sort((a, b) => a.date.localeCompare(b.date))) {
        if (left <= 0) break;
        const a = Math.min(left, n0(o.owed)); left = r2(left - a);
        await db.patch(C.orders, o.id, { owed: r2(n0(o.owed) - a), payments: [...(o.payments || []), { at: nowISO(), date: todayKey(), amount: r2(a) }] });
        done.push(eur(a));
      }
      fresh(); return done.length ? { ok: `Pagado ${done.join(' + ')}. Deuda que queda: ${eur(Math.max(0, L('orders').reduce((t, o) => t + n0(o.owed), 0)))}.` } : { error: 'No hay deuda apuntada.' };
    }
    return { error: 'Herramienta desconocida.' };
  }

  /* ---------- what the agent sees on every message ---------- */
  // Compact on purpose: every token here is paid on every call.
  function snapshot() {
    const bz = brain(), s = S0(), cash = api.cashNow(), mk = todayKey().slice(0, 7);
    const r = (v, d = 1) => (v === Infinity || v === null || v === undefined || isNaN(v) ? undefined : Math.round(v * 10 ** d) / 10 ** d);
    const nextMk = (() => { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
    const p = bz.pace;
    return prune({
      hoy: todayKey(),
      caja: { real: r(cash, 0), pendiente_vinted: r(api.pendingVinted(), 0), deuda: r(api.owedTotal(), 0), gastable: r(api.spendable(), 0) },
      mes: { ventas: p.S, objetivo: p.T, minimo: p.MIN, beneficio: r(p.P, 0), objetivo_beneficio: p.PT, ritmo_dia: r(p.paceDay, 2), necesita_dia: r(p.need, 2), proyeccion: p.proj, dias_quedan: p.left },
      plan: { [mk]: (s.plan || {})[mk], [nextMk]: (s.plan || {})[nextMk] },
      calculos: bz.moves.slice(0, 8).map((m) => `[${m.tag}] ${m.title} — ${m.why}`),
      stock: bz.stocks.filter((x) => x.m.status !== 'descartado' || x.home).map((x) => ({ reloj: x.m.name, id: x.m.id, e: x.m.status, st: x.status, casa: x.home, camino: x.transit || undefined, dia: r(x.rate, 2), v7: x.d.last7, v7prev: x.d.prev7, dias: r(x.coverAll, 0), dhl: x.bridge || undefined, ddp: x.ddpQty || undefined, coste: r(x.cost), benef: r(x.unitProfit), llega: x.arrivals.length ? x.arrivals.map((a) => `${a.qty}${a.lane} ${a.eta}`).join(',') : undefined, nota: x.why || undefined })),
      plazos: { dhl: bz.lead.dhl, ddp: bz.lead.ddp },
      pedido_sugerido: bz.plan.lines.map((l) => `${l.qty} ${l.m.name} ${l.lane} ${r(l.cost, 0)}€`), sin_caja: bz.plan.skipped.map((k) => `${k.want} ${k.s.m.name} ${k.lane}`),
      tests: bz.tests.map((t) => ({ reloj: t.m.name, id: t.m.id, etapa: t.stage, h: r(t.hours, 0), vistas: t.views, favs: t.favs, ofertas: t.offers, mejor: t.best || undefined, vend: t.sold || undefined, casa: t.home, accion: t.act })),
      ganador_ref: { favs: r(bz.bench.fav, 2), vistas_dia: r(bz.bench.vpd, 0), ofertas_100: r(bz.bench.opv, 1) },
      tests_ritmo: { semana: bz.tp.perWeek, a_la_vez: bz.benchN, corriendo: bz.running, faltan_ganadores: bz.tp.winnersNeeded },
      cuentas: bz.acc.accs.map((a) => `${a.name}: ${a.status}/${a.health}, ${a.live.length} activos, ${a.s7} ventas 7d, ${a.rem30} retiradas 30d`),
      ventas_recientes: L('sales').slice().sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date)).slice(0, 6).map((v) => `${v.date} ${v.modelName} ${v.price}€ (+${r(v.profit, 0)})`),
      pedidos_abiertos: L('orders').filter((o) => o.status !== 'recibido' || n0(o.owed)).map((o) => `${o.date} ${o.lane || 'otro'} ${o.status}: ${(o.lines || []).map((l) => `${l.qty}× ${l.name}`).join(', ')}${n0(o.owed) ? ` · debe ${n0(o.owed)}€` : ''}`),
      bolsitas: pouches(),
    });
  }
  function prune(o) {
    if (Array.isArray(o)) { const a = o.map(prune).filter((x) => x !== undefined); return a.length ? a : undefined; }
    if (o && typeof o === 'object') { const out = {}; for (const k in o) { const v = prune(o[k]); if (v !== undefined && v !== null && v !== '') out[k] = v; } return Object.keys(out).length ? out : undefined; }
    return o;
  }

  /* ---------- the conversation ---------- */
  const ls = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const key = () => ls('ooq_ai_key', '');
  // Ahorro: Haiku for routine (logging, screenshots), Sonnet for thinking (questions, plan, Inicio, briefing)
  const mode = () => ls('ooq_ai_mode', 'auto');
  const SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';
  const modelFor = (kind) => (mode() === 'sonnet' ? SONNET : mode() === 'haiku' ? HAIKU : kind === 'light' ? HAIKU : SONNET);
  const modelId = () => modelFor('heavy');
  const history = () => L('chat').slice().sort((a, b) => a.at.localeCompare(b.at));
  const isHeavy = (t) => /\?|^\s*(qu[eé]|c[oó]mo|cu[aá]nt|por ?qu[eé]|deber[ií]a|dime|explica|analiza|plan|estrategia|what|how|why|should)/i.test(t || '') || (t || '').length > 160;

  // rough $ per million tokens, to show what you spend (check your real bill in console.anthropic.com)
  const PRICE = { [SONNET]: [2, 10, 2.5, 0.2], [HAIKU]: [1, 5, 1.25, 0.1], 'claude-opus-5-5': [5, 25, 6.25, 0.5] };
  function track(model, u) {
    if (!u) return;
    const pr = PRICE[model] || PRICE[SONNET];
    const usd = ((u.input_tokens || 0) * pr[0] + (u.output_tokens || 0) * pr[1] + (u.cache_creation_input_tokens || 0) * pr[2] + (u.cache_read_input_tokens || 0) * pr[3]) / 1e6;
    try {
      const mk = new Date().toISOString().slice(0, 7), cur = JSON.parse(localStorage.getItem('ooq_ai_usage') || '{}');
      const m = cur.month === mk ? cur : { month: mk, usd: 0, calls: 0, byDay: {} };
      const d = new Date().toISOString().slice(0, 10);
      m.usd += usd; m.calls += 1; m.byDay = m.byDay || {}; m.byDay[d] = (m.byDay[d] || 0) + usd;
      localStorage.setItem('ooq_ai_usage', JSON.stringify(m));
    } catch {}
  }
  const usage = () => { try { const u = JSON.parse(localStorage.getItem('ooq_ai_usage') || '{}'); return u.month === new Date().toISOString().slice(0, 7) ? u : { usd: 0, calls: 0, byDay: {} }; } catch { return { usd: 0, calls: 0, byDay: {} }; } };

  function apiMessages(extra) {
    const msgs = [];
    for (const m of history().slice(-12)) {
      if (m.hidden) continue;
      let text = m.role === 'assistant' && m.actions && m.actions.length ? m.text + '\n[Apuntado: ' + m.actions.join(' | ') + ']' : m.text;
      if (!text) continue;
      if (text.length > 700) text = text.slice(0, 700) + '…';
      const last = msgs[msgs.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + text; else msgs.push({ role: m.role, content: text });
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (extra) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user') msgs.pop();
      msgs.push(extra);
    }
    return msgs;
  }

  async function call(messages, opt = {}) {
    const model = opt.model || modelFor('heavy');
    // the fixed rules (+ tools) are cached: repeated calls pay ~10% for them
    const body = { model, max_tokens: opt.max || 1000, system: [{ type: 'text', text: SYSTEM + (opt.extra || ''), cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'DATOS (ahora mismo):\n' + JSON.stringify(snapshot()) }], messages };
    if (!opt.noTools) body.tools = TOOLS;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.error && j.error.message) || res.statusText;
      if (res.status === 401) throw new Error('La clave de la API no vale. Revísala en Manager → IA.');
      if (res.status === 400 && /credit|balance/i.test(msg)) throw new Error('Sin saldo en la API. Añade crédito en console.anthropic.com → Billing.');
      throw new Error('Error de la IA (' + res.status + '): ' + msg);
    }
    track(model, j.usage);
    return j;
  }

  // text: what you wrote; images: [{media_type, data}] base64; opts.hidden: not shown; opts.heavy: force the thinking model
  async function send(text, images = [], opts = {}) {
    if (!key()) throw new Error('Falta la clave de la API.');
    const userRec = await db.put(C.chat, { role: 'user', text: text || (images.length ? '[captura]' : ''), at: nowISO(), hidden: !!opts.hidden, images: images.length });
    const content = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text: text || 'Lee esta captura y apunta lo que veas.' }];
    const messages = apiMessages({ role: 'user', content });
    const model = modelFor(opts.heavy || (isHeavy(text) && !images.length) ? 'heavy' : 'light');
    const actions = [];
    let out = '';
    for (let i = 0; i < 6; i++) {
      const r = await call(messages, { model, max: opts.hidden ? 700 : 1000 });
      const blocks = r.content || [];
      out += blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const uses = blocks.filter((b) => b.type === 'tool_use');
      if (r.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const u of uses) {
        let res; try { res = await run(u.name, u.input || {}); } catch (e) { res = { error: e.message || String(e) }; }
        if (res.ok) actions.push(res.ok);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: res.ok || res.error, is_error: !!res.error });
        if (opts.onAction) opts.onAction(res.ok || res.error, !!res.error);
      }
      messages.push({ role: 'user', content: results });
      out += out ? '\n' : '';
    }
    await db.put(C.chat, { role: 'assistant', text: out.trim(), at: nowISO(), actions, replyTo: userRec.id, model });
    return { text: out.trim(), actions };
  }

  // The AI reads the whole situation and picks the moves for Inicio.
  const MOVES_TASK = `

TAREA AHORA: eres la pantalla de inicio. Mira toda su situación (caja, deuda, stock real y si se vende o no, tests, ritmo del mes vs objetivo, calidad de los datos) y decide los movimientos que más le acercan a 5.000 €/mes desde HOY con lo que tiene. "calculos" son automáticos: úsalos solo si tienen sentido; descarta los que no (por ejemplo, reponer algo que tiene poco stock pero no se vende). SOLO números y stock: qué pedir, cuánto, por qué vía y cuándo; qué NO reponer; dinero parado; caja, deuda y lo que puede gastar; veredictos de tests en cuanto a pedir o no pedir; ritmo vs objetivo; datos que faltan para calcular. NADA sobre cómo publicar, fotos, portadas, títulos, precios de anuncio ni cuentas: eso lo lleva él.
Devuelve SOLO un JSON válido, sin texto antes ni después:
{"situacion":"2-3 frases duras y concretas con números de dónde está","movimientos":[{"tag":"Stock|Test|Caja|Datos|Ritmo","titulo":"acción concreta corta con números","porque":"una frase con el número que lo justifica","ir":"manager|stock|plan|tests|catchup|metas|test:<id>|model:<id>"}]}
Entre 3 y 6 movimientos, el primero el de más impacto. Cada uno tiene que poder ejecutarlo sin pensar: qué, cuánto, cuándo. Sin emojis.`;
  async function bestMoves() {
    if (!key()) throw new Error('Falta la clave de la API.');
    const r = await call([{ role: 'user', content: 'Situación y mejores movimientos ahora mismo.' }], { extra: MOVES_TASK, noTools: true, model: modelFor('heavy'), max: 800 });
    const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error('La IA no devolvió movimientos.');
    const j = JSON.parse(m[0]);
    return { situacion: String(j.situacion || ''), movimientos: (j.movimientos || []).slice(0, 7).map((x) => ({ tag: String(x.tag || ''), titulo: String(x.titulo || ''), porque: String(x.porque || ''), ir: String(x.ir || 'manager') })) };
  }
  const dataHash = () => { const s0 = JSON.stringify({ ...snapshot(), hora: 0 }); let h = 0; for (let i = 0; i < s0.length; i++) h = (h * 31 + s0.charCodeAt(i)) | 0; return String(h); };

  return { send, snapshot, findModel, run, TOOLS, key, modelId, mode, history, bestMoves, dataHash, usage };
}
