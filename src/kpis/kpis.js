// Cruza Altas (onboarding) con Producción (EDP) y arma el payload del tablero.
// Llave principal: NOMBRE normalizado (presente en ambos lados y consistente).
// Respaldo: patente y correo (cuando el alta los trae y no son ambiguos).
const altasStore = require('../onboarding/altasStore');
const produccionStore = require('./produccionStore');
const { normNombre, normPatente, normCorreo, parseFechaDMY, diasEntre } = require('./norm');

// Rol embebido en el "cliente" del alta ("Walmart Picker", "Drivers Tottus"…)
function rolDeAlta(cliente, rolesProd) {
  const m = String(cliente || '').match(/picker|shopper|driver/i);
  if (m) {
    const r = m[0].toLowerCase();
    return r === 'picker' ? 'Picker' : r === 'shopper' ? 'Shopper' : 'Driver';
  }
  if (rolesProd && rolesProd.length) return rolesProd[0];
  return '—';
}

// Construye índices de producción para el cruce.
function indexar(operadores) {
  const porNombre = new Map();
  const porPatente = new Map();
  const porCorreo = new Map();
  const marcar = (map, k, op) => {
    if (!k) return;
    const prev = map.get(k);
    if (prev === undefined) map.set(k, op);
    else if (prev && prev.key !== op.key) map.set(k, null); // ambiguo → inutilizable
  };
  for (const op of operadores) {
    porNombre.set(op.key, op); // el nombre ya es la clave del operador
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
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
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

function construirDashboard() {
  const prod = produccionStore.getProduccion();
  const altas = altasStore.getAltas();

  if (!prod || !prod.operadores) {
    return {
      ok: false,
      sinProduccion: true,
      mensaje: 'Aún no se ha cargado la producción (EDP). Usa "Actualizar producción" o verifica el acceso de Drive.',
      totalAltas: altas.length,
    };
  }

  const idx = indexar(prod.operadores);
  const clientesProd = (prod.clientes || []).map(c => String(c.cliente || '').toUpperCase()).filter(Boolean);
  const enAlcanceCliente = (cliente) => {
    const up = String(cliente || '').toUpperCase();
    return clientesProd.some(cp => cp && up.includes(cp.split(' ')[0])); // ej. "WALMART"
  };

  const operadores = [];
  const cliMap = new Map();   // cliente(label alta) -> {altas, produciendo, pedidos, monto}
  const rolMap = new Map();
  const tieMap = new Map();
  const diasArr = [];

  let altasEnAlcance = 0, produciendoEnAlcance = 0, fueraAlcance = 0;
  const opsReclamados = new Set();   // operadores de producción ya ligados a un alta (por cualquier llave)

  const bump = (map, k, prod0, ped, mon) => {
    const e = map.get(k) || { altas: 0, produciendo: 0, pedidos: 0, monto: 0 };
    e.altas++; if (prod0) e.produciendo++; e.pedidos += ped; e.monto += mon;
    map.set(k, e);
  };

  for (const a of altas) {
    const m = buscarMatch(a, idx);
    const op = m && m.op;
    if (op) opsReclamados.add(op.key);
    const produciendo = !!(op && op.pedidos > 0);
    const alcance = enAlcanceCliente(a.cliente);

    let estadoProd;
    if (produciendo) estadoProd = 'produciendo';
    else if (alcance) estadoProd = 'sin_produccion';
    else estadoProd = 'otro_cliente';

    const dias = produciendo ? diasEntre(parseFechaDMY(a.fechaAlta), op.primeraFecha) : null;
    if (produciendo && alcance && dias !== null) diasArr.push(dias);

    const rol = rolDeAlta(a.cliente, op && op.roles);
    const tienda = a.salaBodega || '—';
    const clienteLabel = a.cliente || '—';

    if (alcance) { altasEnAlcance++; if (produciendo) produciendoEnAlcance++; }
    else fueraAlcance++;

    const ped = op ? op.pedidos : 0;
    const mon = op ? op.montoTotal : 0;
    bump(cliMap, clienteLabel, produciendo, ped, mon);
    bump(rolMap, rol, produciendo, ped, mon);
    bump(tieMap, tienda, produciendo, ped, mon);

    operadores.push({
      id: a.id,
      nombre: a.nombre,
      rut: a.rut,
      cliente: clienteLabel,
      rol,
      tienda,
      fechaAlta: a.fechaAlta || '',
      estadoAlta: a.estado || '',
      estadoProd,
      enAlcance: alcance,
      pedidos: ped,
      montoTotal: mon,
      primeraFecha: op ? op.primeraFecha : null,
      ultimaFecha: op ? op.ultimaFecha : null,
      diasActivos: op ? op.diasActivos : 0,
      diasHasta1er: dias,
      matchPor: m ? m.por : null,
    });
  }

  // Producción sin alta: operadores de producción que ningún alta reclamó
  // (por cualquier llave: nombre, patente o correo).
  const produccionSinAlta = prod.operadores.filter(op => !opsReclamados.has(op.key)).length;

  const aArr = (map) => [...map.entries()]
    .map(([k, v]) => ({ label: k, ...v, tasa: v.altas ? v.produciendo / v.altas : 0 }))
    .sort((a, b) => b.altas - a.altas);

  const distMap = new Map();
  for (const d of diasArr) distMap.set(bucketDias(d), (distMap.get(bucketDias(d)) || 0) + 1);
  const distribucion = ORDEN_BUCKETS
    .filter(b => distMap.has(b))
    .map(b => ({ rango: b, count: distMap.get(b) }));

  return {
    ok: true,
    generadoAt: new Date().toISOString(),
    produccion: {
      fuente: prod.fuente ? prod.fuente.nombre : null,
      fileId: prod.fuente ? prod.fuente.id : null,
      actualizadoAt: prod.actualizadoAt,
      filas: prod.filas,
      rango: prod.rango,
      clientes: prod.clientes,
      operadores: prod.operadores.length,
    },
    totalAltas: altas.length,
    clientesProduccion: (prod.clientes || []).map(c => c.cliente),
    funnel: {
      altasEnAlcance,
      produciendo: produciendoEnAlcance,
      sinProduccion: altasEnAlcance - produciendoEnAlcance,
      tasaActivacion: altasEnAlcance ? produciendoEnAlcance / altasEnAlcance : 0,
      fueraAlcance,
      produccionSinAlta,
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
      porTienda: aArr(tieMap).slice(0, 40),
    },
    operadores,
  };
}

module.exports = { construirDashboard };
