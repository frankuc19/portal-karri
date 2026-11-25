// Cruza Altas (onboarding) con Producción (EDP) y arma el payload del tablero,
// aplicando filtros de tiempo/tienda/rol sobre el detalle pre-agregado (grano).
// Llave principal del cruce: NOMBRE normalizado; respaldo: patente y correo.
const altasStore = require('../onboarding/altasStore');
const produccionStore = require('./produccionStore');
const { normNombre, normPatente, normCorreo, parseFechaDMY, diasEntre } = require('./norm');

function rolDeAlta(cliente, rolesProd) {
  const m = String(cliente || '').match(/picker|shopper|driver/i);
  if (m) { const r = m[0].toLowerCase(); return r === 'picker' ? 'Picker' : r === 'shopper' ? 'Shopper' : 'Driver'; }
  if (rolesProd && rolesProd.length) return rolesProd[0];
  return '—';
}

function indexar(operadores) {
  const porNombre = new Map(), porPatente = new Map(), porCorreo = new Map();
  const marcar = (map, k, op) => {
    if (!k) return;
    const prev = map.get(k);
    if (prev === undefined) map.set(k, op);
    else if (prev && prev.key !== op.key) map.set(k, null); // ambiguo
  };
  for (const op of operadores) {
    porNombre.set(op.key, op);
    for (const p of op.patentes || []) marcar(porPatente, p, op);
    for (const c of op.correos || []) marcar(porCorreo, c, op);
  }
  return { porNombre, porPatente, porCorreo };
}

function buscarMatch(alta, idx) {
  const nk = normNombre(alta.nombre);
  if (nk && idx.porNombre.has(nk)) return { op: idx.porNombre.get(nk), por: 'nombre' };
  const pk = normPatente(alta.patente);
  if (pk && idx.porPatente.get(pk)) return { op: idx.porPatente.get(pk), por: 'patente' };
  const ck = normCorreo(alta.correo);
  if (ck && idx.porCorreo.get(ck)) return { op: idx.porCorreo.get(ck), por: 'correo' };
  return null;
}

function mediana(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function bucketDias(d) {
  if (d < 0) return 'Antes del alta';
  if (d === 0) return 'Mismo día';
  if (d <= 3) return '1–3 días';
  if (d <= 7) return '4–7 días';
  if (d <= 14) return '8–14 días';
  if (d <= 30) return '15–30 días';
  return '31+ días';
}
const ORDEN_BUCKETS = ['Antes del alta', 'Mismo día', '1–3 días', '4–7 días', '8–14 días', '15–30 días', '31+ días'];

// Agrega el grano aplicando filtros → Map(opKey -> producción del operador).
function agregarProduccion(prod, filtros) {
  const { operadores, clientes, roles, tiendas, fechas } = prod.dims;
  const tieFilter = filtros.tienda ? tiendas.indexOf(filtros.tienda) : -1;
  const rolFilter = filtros.rol ? roles.indexOf(filtros.rol) : -1;
  const desde = filtros.desde || '', hasta = filtros.hasta || '';
  const hayFecha = !!(desde || hasta);
  // Si se pide un filtro cuya categoría no existe, no devuelve nada.
  if (filtros.tienda && tieFilter === -1) return { porKey: new Map(), clientesSet: new Set() };
  if (filtros.rol && rolFilter === -1) return { porKey: new Map(), clientesSet: new Set() };

  const porIdx = new Map();        // opIdx -> acumulado
  const clientesSet = new Set();
  for (const g of prod.grano) {
    const [opIdx, cliIdx, rolIdx, tieIdx, fecIdx, ped, mon] = g;
    if (tieFilter !== -1 && tieIdx !== tieFilter) continue;
    if (rolFilter !== -1 && rolIdx !== rolFilter) continue;
    const fecha = fechas[fecIdx] || '';
    if (hayFecha) {
      if (!fecha) continue;
      if (desde && fecha < desde) continue;
      if (hasta && fecha > hasta) continue;
    }
    let a = porIdx.get(opIdx);
    if (!a) { a = { pedidos: 0, monto: 0, dias: new Set(), tiendas: new Map(), roles: new Set(), primera: null, ultima: null }; porIdx.set(opIdx, a); }
    a.pedidos += ped; a.monto += mon;
    a.tiendas.set(tiendas[tieIdx], (a.tiendas.get(tiendas[tieIdx]) || 0) + ped);
    if (roles[rolIdx] && roles[rolIdx] !== '—') a.roles.add(roles[rolIdx]);
    clientesSet.add(clientes[cliIdx]);
    if (fecha) {
      a.dias.add(fecha);
      if (!a.primera || fecha < a.primera) a.primera = fecha;
      if (!a.ultima || fecha > a.ultima) a.ultima = fecha;
    }
  }

  const porKey = new Map();
  for (const [opIdx, a] of porIdx) {
    const meta = operadores[opIdx];
    // tienda principal = la de más pedidos
    let tiendaPrincipal = '—', maxPed = -1, nTiendas = 0;
    for (const [t, p] of a.tiendas) { if (t && t !== '—') { nTiendas++; if (p > maxPed) { maxPed = p; tiendaPrincipal = t; } } }
    porKey.set(meta.key, {
      key: meta.key, nombre: meta.nombre, patentes: meta.patentes, correos: meta.correos,
      pedidos: a.pedidos, montoTotal: a.monto,
      diasConProduccion: a.dias.size,
      primeraFecha: a.primera, ultimaFecha: a.ultima,
      roles: [...a.roles],
      tiendaPrincipal, tiendasExtra: Math.max(0, nTiendas - 1),
    });
  }
  return { porKey, clientesSet };
}

function construirDashboard(filtros = {}) {
  const prod = produccionStore.getProduccion();
  const altas = altasStore.getAltas();

  if (!prod || !prod.dims || !prod.grano) {
    const necesitaRefresco = !!(prod && !prod.dims);
    return {
      ok: false, sinProduccion: true,
      mensaje: necesitaRefresco
        ? 'La producción está en un formato antiguo. Usa "Actualizar producción" para habilitar los filtros.'
        : 'Aún no se ha cargado la producción (EDP). Usa "Actualizar producción" o verifica el acceso de Drive.',
      totalAltas: altas.length,
    };
  }

  const f = {
    desde: (filtros.desde || '').trim(),
    hasta: (filtros.hasta || '').trim(),
    tienda: (filtros.tienda || '').trim(),
    rol: (filtros.rol || '').trim(),
  };

  const { porKey, clientesSet } = agregarProduccion(prod, f);
  const idx = indexar([...porKey.values()]);
  const clientesProd = [...clientesSet].map(c => String(c || '').toUpperCase()).filter(Boolean);
  const enAlcanceCliente = (cliente) => {
    const up = String(cliente || '').toUpperCase();
    return clientesProd.some(cp => cp && up.includes(cp.split(' ')[0]));
  };

  const operadores = [];
  const cliMap = new Map(), rolMap = new Map(), tieMap = new Map();
  const diasArr = [];
  const opsReclamados = new Set();
  let altasEnAlcance = 0, produciendoEnAlcance = 0, fueraAlcance = 0;

  const bump = (map, k, prod0, ped, mon) => {
    const e = map.get(k) || { altas: 0, produciendo: 0, pedidos: 0, monto: 0 };
    e.altas++; if (prod0) e.produciendo++; e.pedidos += ped; e.monto += mon; map.set(k, e);
  };

  for (const a of altas) {
    const m = buscarMatch(a, idx);
    const op = m && m.op;
    if (op) opsReclamados.add(op.key);
    const produciendo = !!(op && op.pedidos > 0);
    const alcance = enAlcanceCliente(a.cliente);

    let estadoProd = produciendo ? 'produciendo' : (alcance ? 'sin_produccion' : 'otro_cliente');
    const dias = produciendo ? diasEntre(parseFechaDMY(a.fechaAlta), op.primeraFecha) : null;
    if (produciendo && alcance && dias !== null) diasArr.push(dias);

    const rol = rolDeAlta(a.cliente, op && op.roles);
    const sala = a.salaBodega || '—';
    const clienteLabel = a.cliente || '—';
    const tiendaProd = op ? op.tiendaPrincipal + (op.tiendasExtra ? ` +${op.tiendasExtra}` : '') : '—';

    if (alcance) { altasEnAlcance++; if (produciendo) produciendoEnAlcance++; } else fueraAlcance++;

    const ped = op ? op.pedidos : 0, mon = op ? op.montoTotal : 0;
    bump(cliMap, clienteLabel, produciendo, ped, mon);
    bump(rolMap, rol, produciendo, ped, mon);
    bump(tieMap, sala, produciendo, ped, mon);

    operadores.push({
      id: a.id, nombre: a.nombre, rut: a.rut,
      cliente: clienteLabel, rol, sala,
      tienda: tiendaProd,
      fechaAlta: a.fechaAlta || '', estadoAlta: a.estado || '',
      estadoProd, enAlcance: alcance,
      pedidos: ped, montoTotal: mon,
      diasConProduccion: op ? op.diasConProduccion : 0,
      primeraFecha: op ? op.primeraFecha : null, ultimaFecha: op ? op.ultimaFecha : null,
      diasHasta1er: dias, matchPor: m ? m.por : null,
    });
  }

  const produccionSinAlta = [...porKey.keys()].filter(k => !opsReclamados.has(k)).length;

  const aArr = (map) => [...map.entries()]
    .map(([k, v]) => ({ label: k, ...v, tasa: v.altas ? v.produciendo / v.altas : 0 }))
    .sort((a, b) => b.altas - a.altas);

  const distMap = new Map();
  for (const d of diasArr) distMap.set(bucketDias(d), (distMap.get(bucketDias(d)) || 0) + 1);
  const distribucion = ORDEN_BUCKETS.filter(b => distMap.has(b)).map(b => ({ rango: b, count: distMap.get(b) }));

  const tiendasOpc = (prod.dims.tiendas || []).filter(t => t && t !== '—').sort((a, b) => a.localeCompare(b));
  const rolesOpc = (prod.dims.roles || []).filter(r => r && r !== '—').sort();

  return {
    ok: true,
    generadoAt: new Date().toISOString(),
    filtros: f,
    opciones: { tiendas: tiendasOpc, roles: rolesOpc, rango: prod.rango },
    produccion: {
      fuente: prod.fuente ? prod.fuente.nombre : null,
      fileId: prod.fuente ? prod.fuente.id : null,
      actualizadoAt: prod.actualizadoAt,
      filas: prod.filas,
      rango: prod.rango,
      clientes: prod.clientes,
      operadores: prod.dims.operadores.length,
    },
    totalAltas: altas.length,
    clientesProduccion: [...clientesSet],
    funnel: {
      altasEnAlcance, produciendo: produciendoEnAlcance,
      sinProduccion: altasEnAlcance - produciendoEnAlcance,
      tasaActivacion: altasEnAlcance ? produciendoEnAlcance / altasEnAlcance : 0,
      fueraAlcance, produccionSinAlta,
    },
    diasHasta1er: {
      conDato: diasArr.length,
      promedio: diasArr.length ? Math.round(diasArr.reduce((s, d) => s + d, 0) / diasArr.length) : null,
      mediana: mediana(diasArr),
      distribucion,
    },
    cortes: {
      porCliente: aArr(cliMap),
      porRol: aArr(rolMap),
      porTienda: aArr(tieMap).slice(0, 60),
    },
    operadores,
  };
}

module.exports = { construirDashboard };
