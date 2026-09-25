// Motor de cálculo del pago Falabella — port fiel del script de Apps Script
// (v4.1: NDS < 80% no se paga, rutas complemento no se pagan, ruta mixta,
// recargo domingo/feriados HUB XD). Es puro: recibe los datos ya leídos
// (tarifario, feriados) y devuelve el pago por ruta, sin tocar red ni disco.
//
// Las fechas se manejan como milisegundos UTC a mediodía (un "día" sin hora),
// así comparar rangos de vigencia nunca depende de la zona horaria del servidor.

const RECARGO_DOMINGO_PCT = 0.10;
const CT_RECARGO_DOMINGO = 'HUB XD';
const UMBRAL_NDS_MINIMO = 0.80;
const TARIFAS_SIMPLI_EXCLUSIVAS = true;
const DETECTAR_COMPLEMENTO = true;
const CTS_RUTA_MIXTA = ['HUB XD', 'LOF1', 'LOF2'];
const MULTA_NC_MENOR_95 = 53600;
const ZONAS_RM = new Set(['Urbana', 'Extra urbana']);

// ─── Fechas ─────────────────────────────────────────────────────────────────
const diaMs = (y, m, d) => Date.UTC(y, m, d, 12, 0, 0);

// Acepta serial de Excel/Sheets, 'dd/mm/yyyy', 'dd-mm-yyyy' o 'yyyy-mm-dd'.
function toDateMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return Date.UTC(1899, 11, 30, 12, 0, 0) + Math.floor(v) * 86400000;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return diaMs(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) return diaMs(+m[3], +m[2] - 1, +m[1]);
  return null;
}
const isoDeMs = (ms) => new Date(ms).toISOString().slice(0, 10);

// ─── Utilidades de texto y números ─────────────────────────────────────────
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const up = (v) => str(v).toUpperCase();
const fmt = (n) => Number(n).toLocaleString('es-CL');
const pct = (v) => (v * 100).toFixed(1) + '%';

function parseNumTarifa(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = String(v).replace(/[$\s]/g, '').replace(/\./g, '').replace(/,/g, '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// ─── Tarifario ──────────────────────────────────────────────────────────────
// filas2d: matriz tal cual la lee Google Sheets (primera fila = encabezados).
function cargarTarifario(filas2d) {
  if (!filas2d || filas2d.length < 2) return [];
  const idx = {};
  filas2d[0].forEach((h, i) => { idx[str(h).toLowerCase()] = i; });
  const col = (n) => idx[n.toLowerCase()];
  const rows = [];
  for (let r = 1; r < filas2d.length; r++) {
    const d = filas2d[r];
    rows.push({
      cliente: str(d[col('Cliente')]), servicio: str(d[col('servicio')]), geo: str(d[col('Geo')]),
      tipo: str(d[col('Tipo')]), ruta: str(d[col('Ruta')]),
      tarifa: parseNumTarifa(d[col('Tarifa')]), variable: parseNumTarifa(d[col('Variable')]),
      postura: parseNumTarifa(d[col('Postura')]), multa: parseNumTarifa(d[col('Multa')]),
      nds: str(d[col('NDS')]), puntos: str(d[col('Puntos')]),
      tipoAutoAGP: str(d[col('Tipo Auto AGP')]), obs: str(d[col('OBS')]),
      fechaInicio: toDateMs(d[col('Fecha inicio')]), fechaFin: toDateMs(d[col('Fecha Fin')]),
    });
  }
  return rows;
}

// Devuelve { rows, fallback }: fallback=true cuando la fecha no cae en ningún
// rango y se usa el último vigente. (El original marcaba las filas del
// tarifario con la bandera y se le quedaba pegada a rutas posteriores.)
function filtrarPorFecha(tarifario, fechaMs) {
  if (fechaMs === null) return { rows: tarifario, fallback: false };
  const sinFecha = tarifario.filter((t) => t.fechaInicio === null || t.fechaFin === null);
  const conFecha = tarifario.filter((t) => t.fechaInicio !== null && t.fechaFin !== null && fechaMs >= t.fechaInicio && fechaMs <= t.fechaFin);
  if (conFecha.length > 0) return { rows: [...conFecha, ...sinFecha], fallback: false };

  const conFechas = tarifario.filter((t) => t.fechaInicio !== null && t.fechaFin !== null);
  if (conFechas.length === 0) return { rows: sinFecha.length > 0 ? sinFecha : tarifario, fallback: false };

  const maxFin = Math.max(...conFechas.map((t) => t.fechaFin));
  const ultimo = conFechas.filter((t) => t.fechaFin === maxFin);
  return { rows: [...ultimo, ...sinFecha], fallback: true };
}

// ─── Búsquedas ──────────────────────────────────────────────────────────────
function buscar(tf, filtros, modo = 'exact') {
  return tf.filter((t) => {
    for (const [key, val] of Object.entries(filtros)) {
      if (!val && val !== 0) continue;
      const tVal = up(t[key]);
      const fVal = String(val).toUpperCase();
      if (modo === 'contains' ? !tVal.includes(fVal) : tVal !== fVal) return false;
    }
    return true;
  });
}

function esSimpli(origen, ct) {
  return up(origen) === 'SIMPLI' || up(ct).includes('COLECTA');
}
function sinSimpli(rows) {
  return TARIFAS_SIMPLI_EXCLUSIVAS ? rows.filter((r) => up(r.cliente) !== 'SIMPLI') : rows;
}

function porGeo(rows, ct) {
  const c = up(ct);
  if (!c) return rows;
  const exact = rows.filter((r) => up(r.geo) === c);
  if (exact.length > 0) return exact;
  const inc = rows.filter((r) => { const g = up(r.geo); return g && (g.includes(c) || c.includes(g)); });
  return inc.length > 0 ? inc : rows;
}

// ─── NDS (nivel de cumplimiento) ───────────────────────────────────────────
function numerosDe(nds) {
  const nums = String(nds || '').replace(/,/g, '.').match(/\d+(?:\.\d+)?/g);
  return nums ? nums.map(parseFloat).filter((n) => !Number.isNaN(n)) : [];
}
function bandaNDS(nds) {
  const v = numerosDe(nds).map((n) => n / 100);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}
function minNDS(nds) {
  const v = numerosDe(nds);
  return v.length ? Math.min(...v) / 100 : null;
}
function matchNDS(ndsRow, nivel) {
  const b = bandaNDS(ndsRow);
  return !!b && nivel >= b.min - 1e-9 && nivel <= b.max + 1e-9;
}
// Asunción: el script original llega cortado en la última línea de esta
// función; si ninguna banda aplica se toma la de piso más bajo.
function seleccionarPorNDS(rows, nivel) {
  const conRango = rows.map((r) => ({ r, min: minNDS(r.nds) })).filter((x) => x.min !== null);
  if (conRango.length === 0) return rows.length > 0 ? rows[0] : null;
  conRango.sort((a, b) => b.min - a.min);
  const match = conRango.find((x) => nivel >= x.min);
  return match ? match.r : conRango[conRango.length - 1].r;
}
function filtrarNDS(rows, nivel) {
  const conNds = rows.filter((r) => r.nds);
  const sinNds = rows.filter((r) => !r.nds);
  if (conNds.length === 0) return rows;
  let banda = conNds.filter((r) => matchNDS(r.nds, nivel));
  if (banda.length > 0) return banda.concat(sinNds);
  const best = seleccionarPorNDS(conNds, nivel);
  if (best) {
    const piso = minNDS(best.nds);
    banda = conNds.filter((r) => minNDS(r.nds) === piso);
    if (banda.length > 0) return banda.concat(sinNds);
  }
  return rows;
}

function extraerUmbral(puntos, def) {
  const nums = String(puntos || '').match(/\d+/g);
  return nums && nums.length ? Math.max(...nums.map((n) => parseInt(n, 10))) : def;
}

function resultado(tb, tv, serv, obs, dirxct, nivel) {
  let pago = null;
  if (tb !== null && tb !== undefined) pago = tb;
  else if (tv !== null && tv !== undefined) pago = tv * dirxct;
  if (pago !== null && nivel > 0 && nivel < 0.95) obs += ' | NC<95% – posible multa $53.600';
  return { tb: tb ?? null, tv: tv ?? null, pago, serv, obs };
}
const sinPago = (serv, obs) => ({ tb: null, tv: null, pago: null, serv, obs });

function buscarHub(tf, ct, tipoTarifa) {
  const base = porGeo(sinSimpli(buscar(tf, { servicio: 'HUB Y LOF2', tipo: tipoTarifa })), ct);
  const urb = base.filter((r) => { const ru = up(r.ruta); return ru === 'NORMAL' || ru === 'URBANO'; });
  return urb.length > 0 ? urb : base;
}

// ─── Cálculos por servicio ─────────────────────────────────────────────────
function calcHubUrbanoFromRows(rows, serv, veh, nivel, dirxct) {
  if (rows.length === 0) return sinPago(serv, '⚠ Sin filas en tarifario para ' + veh);
  const ndsRows = filtrarNDS(rows, nivel);
  const filaBase = ndsRows.find((r) => r.tarifa !== null && r.variable === null);
  const filaVar = ndsRows.find((r) => r.variable !== null);
  if (!filaBase && !filaVar) return sinPago(serv, '⚠ Sin tarifa/variable para NC:' + pct(nivel) + ' | Veh:' + veh);

  let umbral = 89;
  if (filaBase && filaBase.puntos) umbral = extraerUmbral(filaBase.puntos, 89);

  if (filaBase && dirxct <= umbral) return resultado(filaBase.tarifa, null, serv, 'NC:' + pct(nivel) + ' ≤' + umbral + 'pts | Veh:' + veh, dirxct, nivel);
  if (filaVar) return resultado(null, filaVar.variable, serv, 'NC:' + pct(nivel) + ' >' + umbral + 'pts (var) | Veh:' + veh, dirxct, nivel);
  if (filaBase) return resultado(filaBase.tarifa, null, serv, 'NC:' + pct(nivel) + ' (solo base) | Veh:' + veh, dirxct, nivel);
  return sinPago(serv, '⚠ Error lookup Hub Urbano | Veh:' + veh);
}

function calcHubExtraUrbano(tf, ct, zona, veh, cat, nivel, dirxct) {
  let rows = porGeo(sinSimpli(buscar(tf, { servicio: 'HUB Y LOF2', ruta: 'Extra-Urbano' })), ct);
  if (rows.length === 0) rows = porGeo(sinSimpli(buscar(tf, { servicio: 'HUB Y LOF2', ruta: 'Extra' }, 'contains')), ct);
  rows = rows.filter((r) => !/MIXTA/i.test(r.ruta));

  if (rows.length === 0) {
    if (dirxct <= 40) return resultado(83000, null, 'HUB Y LOF2', 'Extra-Urbano ≤40pts | Zona:' + zona + ' (fallback)', dirxct, nivel);
    return resultado(null, 2075, 'HUB Y LOF2', 'Extra-Urbano >40pts (var) | Zona:' + zona + ' (fallback)', dirxct, nivel);
  }

  const ndsRows = filtrarNDS(rows, nivel);
  const filaBase = ndsRows.find((r) => r.tarifa !== null && r.variable === null);
  const filaVar = ndsRows.find((r) => r.variable !== null);
  let umbral = 40;
  if (filaBase && filaBase.puntos) umbral = extraerUmbral(filaBase.puntos, 40);

  if (filaBase && dirxct <= umbral) return resultado(filaBase.tarifa, null, 'HUB Y LOF2', 'Extra-Urbano ≤' + umbral + 'pts | Zona:' + zona + ' | NC:' + pct(nivel), dirxct, nivel);
  if (filaVar) return resultado(null, filaVar.variable, 'HUB Y LOF2', 'Extra-Urbano >' + umbral + 'pts (var) | Zona:' + zona + ' | NC:' + pct(nivel), dirxct, nivel);
  if (filaBase) return resultado(filaBase.tarifa, null, 'HUB Y LOF2', 'Extra-Urbano (solo base) | Zona:' + zona, dirxct, nivel);
  return sinPago('HUB Y LOF2', '⚠ Sin tarifa Extra-Urbano | Zona:' + zona);
}

function calcPMTariff(rows, serv, veh, nivel, dirxct, ctName) {
  let ndsRows = rows.filter((r) => r.nds && matchNDS(r.nds, nivel));
  if (ndsRows.length === 0) ndsRows = rows;
  const filaBase = ndsRows.find((r) => r.tarifa !== null && r.variable === null);
  const filaVar = ndsRows.find((r) => r.variable !== null);
  if (!filaBase && !filaVar) return null;

  let umbral = 30;
  if (filaBase && filaBase.puntos) umbral = extraerUmbral(filaBase.puntos, 30);

  if (filaBase && dirxct <= umbral) return resultado(filaBase.tarifa, null, serv, 'PM Ruta (≤' + umbral + 'pts) | Geo:' + ctName, dirxct, nivel);
  if (filaVar) return resultado(null, filaVar.variable, serv, 'PM Ruta (>' + umbral + 'pts) | Geo:' + ctName, dirxct, nivel);
  if (filaBase) return resultado(filaBase.tarifa, null, serv, 'PM Ruta (solo base) | Geo:' + ctName, dirxct, nivel);
  return null;
}

function calcMotoHubXD(tf, dirxct) {
  const rows = buscar(tf, { servicio: 'Los Dominicos' });
  if (rows.length === 0) return { tb: null, tv: 1000, pago: 1000 * dirxct, serv: 'HUB XD - Moto', obs: 'Los Dominicos $1.000/pto × ' + dirxct + ' pts (fallback)' };

  const filaBase = rows.find((r) => r.tarifa !== null && r.variable === null);
  const filaVar = rows.find((r) => r.variable !== null);
  let umbral = 30;
  if (filaBase && filaBase.puntos) umbral = extraerUmbral(filaBase.puntos, 30);
  const tvUnit = filaVar ? filaVar.variable : 1000;
  const tbFijo = filaBase ? filaBase.tarifa : 32100;

  if (dirxct <= umbral) return { tb: tbFijo, tv: null, pago: tbFijo, serv: 'HUB XD - Moto', obs: 'Los Dominicos $' + fmt(tbFijo) + ' fijo (≤' + umbral + ' pts, total ' + dirxct + ' pts)' };
  return { tb: null, tv: tvUnit, pago: tvUnit * dirxct, serv: 'HUB XD - Moto', obs: 'Los Dominicos $' + fmt(tvUnit) + '/pto × ' + dirxct + ' pts' };
}

function calcEstancilla(tf, cat, zona, veh, nivel, dirxct) {
  const z = zona === 'Extra urbana' ? 'Extra urbana' : 'Urbana';
  let rows = buscar(tf, { servicio: 'Estancilla', tipo: cat, ruta: z });
  if (rows.length === 0 && cat === 'C1-10') rows = buscar(tf, { servicio: 'Estancilla', tipo: 'C1-10', ruta: 'Electrico' });
  if (rows.length === 0 || (cat === 'C21-35' && veh.includes('Rampla'))) {
    const rampla = z === 'Extra urbana' ? 'Extra urbana (Con rampla)' : 'Urbano (Con rampla)';
    const rRows = buscar(tf, { servicio: 'Estancilla', tipo: cat, ruta: rampla });
    if (rRows.length > 0) rows = rRows;
  }
  if (rows.length === 0) {
    const revRows = buscar(tf, { servicio: 'Estancilla', ruta: 'Reversa - HPU' });
    if (revRows.length > 0) return resultado(revRows[0].tarifa, null, 'Estancilla', 'Reversa HPU Estancilla | Cat:' + cat, dirxct, nivel);
  }
  if (rows.length === 0) return sinPago('Estancilla', '⚠ Sin tarifa cat=' + cat + ' zona=' + z + ' en tarifario');
  if (rows.length > 1) { const m = rows.filter((r) => r.nds && matchNDS(r.nds, nivel)); if (m.length > 0) rows = m; }
  const best = rows[0];
  return resultado(best.tarifa, null, 'Estancilla', 'Zona:' + z + ' | Cat:' + cat + (best.nds ? ' | NDS:' + best.nds : ''), dirxct, nivel);
}

function calcF3(tf, zona, nivel, dirxct) {
  const z = zona === 'Extra urbana' ? 'Extra urbana' : 'Urbana';
  const rows = buscar(tf, { servicio: 'F3', ruta: z });
  if (rows.length === 0) return sinPago('F3', '⚠ Sin tarifa F3 zona=' + z);
  const banda = filtrarNDS(rows, nivel);
  const best = banda.length > 0 ? banda[0] : rows[0];
  return resultado(best.tarifa, null, 'F3', 'F3 NC:' + pct(nivel) + ' Zona:' + z, dirxct, nivel);
}

function calcReversaHPU(tf, dirxct, nivel) {
  let rows = buscar(tf, { ruta: 'Reversa - HPU' });
  if (rows.length === 0) rows = buscar(tf, { ruta: 'Reversa' }, 'contains');
  if (rows.length > 0 && rows[0].tarifa !== null) return resultado(rows[0].tarifa, null, 'CD Fby Big Ticket Reverse', 'Reversa HPU $' + fmt(rows[0].tarifa), dirxct, nivel);
  return resultado(130000, null, 'CD Fby Big Ticket Reverse', 'Reversa HPU $130k (fallback)', dirxct, nivel);
}

function calcIKEA(tf, cat, zona, veh, dirxct, nivel) {
  const z = zona === 'Extra urbana' ? 'Extra urbana' : 'Urbana';
  const rows = buscar(tf, { servicio: 'IKEA', tipo: cat, ruta: z });
  if (rows.length > 0 && rows[0].tarifa !== null) return resultado(rows[0].tarifa, null, 'IKEA', 'Zona:' + z + ' | Cat:' + cat, dirxct, nivel);
  return sinPago('IKEA', '⚠ Sin tarifa cat=' + cat + ' zona=' + z + ' en tarifario');
}

function calcRegiones(tf, cat, zona, dirxct, nivel) {
  const esMoto = cat === 'Moto';
  const tipoStr = esMoto ? 'Moto' : 'Sedan-Suv';
  let rows = buscar(tf, { servicio: 'HUB', tipo: tipoStr });
  if (rows.length === 0) {
    rows = buscar(tf, { servicio: 'HUB', ruta: 'Regiones' });
    if (rows.length === 0) rows = buscar(tf, { servicio: 'HUB', ruta: 'PM' });
  }

  if (rows.length === 0) {
    const tbFija = esMoto ? 45000 : 40000;
    const tvUnit = esMoto ? 750 : 1290;
    if (dirxct <= 31) return { tb: tbFija, tv: null, pago: tbFija, serv: 'HUB', obs: tipoStr + ' $' + fmt(tbFija) + ' fijo (≤31 pts) | ' + zona + ' (fallback)' };
    let obs = tipoStr + ' $' + fmt(tvUnit) + '/pto × ' + dirxct + ' pts | ' + zona + ' (fallback)';
    if (nivel > 0 && nivel < 0.95) obs += ' | NC<95% – posible multa $53.600';
    return { tb: null, tv: tvUnit, pago: tvUnit * dirxct, serv: 'HUB', obs };
  }

  const filaBase = rows.find((r) => r.tarifa !== null && r.variable === null);
  const filaVar = rows.find((r) => r.variable !== null);
  const tbFija = filaBase ? filaBase.tarifa : (esMoto ? 45000 : 40000);
  const tvUnit = filaVar ? filaVar.variable : (esMoto ? 750 : 1290);
  let umbral = 31;
  if (filaBase && filaBase.puntos) umbral = extraerUmbral(filaBase.puntos, 31);

  let tb, tv, pago, obs;
  if (dirxct <= umbral) { tb = tbFija; tv = null; pago = tbFija; obs = tipoStr + ' $' + fmt(tbFija) + ' fijo (≤' + umbral + ' pts, total ' + dirxct + ' pts) | ' + zona; }
  else { tb = null; tv = tvUnit; pago = tvUnit * dirxct; obs = tipoStr + ' $' + fmt(tvUnit) + '/pto × ' + dirxct + ' pts | ' + zona; }
  if (nivel > 0 && nivel < 0.95) obs += ' | NC<95% – posible multa $53.600';
  return { tb, tv, pago, serv: 'HUB', obs };
}

// ─── Ruta AM de Simpli (servicio TREN AM) ──────────────────────────────────
const CAT_RUTA_AM = {
  'Sedan': 'C1-10', 'Suv': 'C1-10', 'Small Van o 700': 'C1-10', 'Small Van o 700 Eléctrica': 'C1-10',
  'Large Van o 1.5T': 'C1-10', 'Big Van': 'C1-10',
  'Camion 11-20 mts3': 'C11-20', 'Camion 11-20 mts3 Refrigerado': 'C11-20',
  'Camion 20-35 mts3': 'C21-35', 'Camion 20-35 mts3 Refrigerado': 'C21-35',
  'Camion 5000 kgs': 'C21-35', 'Camión 21 a 35 m3 - Rampla': 'C21-35',
};
function filasRutaAM(tf) {
  let rows = buscar(tf, { cliente: 'Simpli', servicio: 'TREN AM' });
  if (rows.length === 0) rows = buscar(tf, { servicio: 'TREN AM' });
  if (rows.length === 0) rows = buscar(tf, { ruta: 'TREN AM' });
  return rows;
}
function catRutaAM(tf, veh) {
  const v = str(veh);
  if (v === '') return '';
  if (CAT_RUTA_AM[v]) return CAT_RUTA_AM[v];
  const fila = filasRutaAM(tf).find((r) => up(r.tipoAutoAGP).includes(v.toUpperCase()));
  return fila ? fila.tipo : '';
}
function calcSimpliRutaAM(tf, veh, nivel, dirxct) {
  const rowsAM = filasRutaAM(tf);
  if (rowsAM.length === 0) return sinPago('TREN AM', '❌ Sin tarifas TREN AM en la hoja "Pago Falabella"');
  const cat = catRutaAM(tf, veh);
  if (!cat) return sinPago('TREN AM', '⚠ Veh sin mapeo RUTA AM: ' + (veh || '(vacío)'));
  const rows = rowsAM.filter((r) => up(r.tipo) === cat.toUpperCase());
  if (rows.length === 0) return sinPago('TREN AM', '⚠ Sin tarifa TREN AM para Cat:' + cat + ' | Veh:' + veh);
  const best = seleccionarPorNDS(rows, nivel);
  if (!best || best.tarifa === null) return sinPago('TREN AM', '⚠ Sin tarifa TREN AM Cat:' + cat + ' | NC:' + pct(nivel));
  return {
    tb: best.tarifa, tv: null, pago: best.tarifa, serv: 'TREN AM',
    obs: 'RUTA AM Simpli | Cat:' + cat + ' | Veh:' + veh + ' | NC:' + pct(nivel) + (best.nds ? ' | NDS:' + best.nds : '') + ' | ' + dirxct + ' pts',
  };
}

// ─── Ruta mixta (urbana + extra urbana bajo el mismo idruta) ───────────────
function calcRutaMixta(tf, ct, termUrb, termXu, nivel) {
  let rows = porGeo(sinSimpli(buscar(tf, { servicio: 'HUB Y LOF2' })), ct).filter((r) => /MIXTA/i.test(r.ruta));
  if (rows.length === 0) rows = sinSimpli(tf).filter((r) => /MIXTA/i.test(r.ruta));
  if (rows.length === 0) return null;

  const banda = filtrarNDS(rows, nivel);
  const esUrbRow = (r) => /URB/i.test(r.ruta) && !/EXTRA|XU/i.test(r.ruta);
  const esXuRow = (r) => /EXTRA|XU/i.test(r.ruta);
  const filaVarUrb = banda.find((r) => esUrbRow(r) && r.variable !== null) || banda.find((r) => r.variable !== null);
  const filaVarXu = banda.find((r) => esXuRow(r) && r.variable !== null) || filaVarUrb;
  const varUrb = filaVarUrb ? filaVarUrb.variable : null;
  const varXu = filaVarXu ? filaVarXu.variable : null;

  const filaAseg = banda.find((r) => r.tarifa !== null) || rows.find((r) => r.tarifa !== null);
  let asegurado = filaAseg ? filaAseg.tarifa : null;
  if (asegurado === null) {
    const fp = banda.find((r) => r.postura !== null) || rows.find((r) => r.postura !== null);
    if (fp) asegurado = fp.postura;
  }
  if (varUrb === null && varXu === null && asegurado === null) return null;

  const pagoVar = Math.round((varUrb !== null ? varUrb : 0) * termUrb + (varXu !== null ? varXu : 0) * termXu);
  let pago, tb = null, detalle;
  if (asegurado !== null && pagoVar < asegurado) {
    pago = asegurado; tb = asegurado;
    detalle = 'MIXTA: var $' + fmt(pagoVar) + ' < asegurado → paga asegurado $' + fmt(asegurado);
  } else {
    pago = pagoVar;
    detalle = 'MIXTA: URB ' + termUrb + '×$' + (varUrb !== null ? fmt(varUrb) : '0') + ' + XU ' + termXu + '×$' + (varXu !== null ? fmt(varXu) : '0');
  }
  let obs = detalle + ' | Term URB:' + termUrb + ' | Term XU:' + termXu + ' | NC:' + pct(nivel) + (filaVarUrb && filaVarUrb.nds ? ' | NDS:' + filaVarUrb.nds : '');
  if (nivel > 0 && nivel < 0.95) obs += ' | NC<95% – posible multa $53.600';
  return { tb, tv: null, pago, serv: 'HUB Y LOF2 - MIXTA', obs };
}

// ─── Enrutador principal por CT ────────────────────────────────────────────
const CAT = {
  'Camion 20-35 mts3': 'C21-35', 'Camion 11-20 mts3': 'C11-20', 'Large Van o 1.5T': 'C1-10',
  'Small Van o 700': 'C1-10', 'Small Van o 700 Eléctrica': 'Electrico', 'Suv': 'Sedan & Suv',
  'Sedan': 'Sedan & Suv', 'Moto': 'Moto',
};
function hubPorCategoria(tf, ct, cat, veh, nivel, dirxct) {
  const tipoPorCat = { 'Electrico': 'Electrico', 'C1-10': 'Furgon', 'Sedan & Suv': 'Sedan & Suv' };
  const tipo = tipoPorCat[cat];
  if (!tipo) return null;
  const rows = buscarHub(tf, ct, tipo);
  return rows.length > 0 ? calcHubUrbanoFromRows(rows, 'HUB Y LOF2', veh, nivel, dirxct) : null;
}

function calcularTarifa(tf, ct, zona, veh, nivel, dirxct, amPm, origen) {
  if (esSimpli(origen, ct)) return calcSimpliRutaAM(tf, veh, nivel, dirxct);

  if (amPm === 'PM') {
    const ctUpper = ct.toUpperCase();
    const pmRows = tf.filter((r) => up(r.ruta) === 'PM');
    if (pmRows.length > 0) {
      let matchRows = pmRows.filter((r) => up(r.geo) === ctUpper);
      if (matchRows.length === 0) {
        matchRows = pmRows.filter((r) => { const g = up(r.geo); return g && (g.includes(ctUpper) || ctUpper.includes(g)); });
      }
      if (matchRows.length > 0) {
        const pmRes = calcPMTariff(matchRows, matchRows[0].servicio || 'HUB Y LOF2', veh, nivel, dirxct, ct);
        if (pmRes) return pmRes;
      }
    }
  }

  const cat = CAT[veh] || ('Sin mapeo: ' + veh);

  if (ct.includes('MINI-MIDI') || ct.includes('CT FBY FALABELLA')) {
    const sdRows = buscar(tf, { geo: 'CT FBY FALABELLA CHILE MINI-MIDI (WMOS)', ruta: 'Same Day' }, 'contains');
    if (sdRows.length > 0 && sdRows[0].variable !== null) {
      const tv = sdRows[0].variable;
      return resultado(null, tv, 'HUB - MINI-MIDI', 'Same Day $' + tv + '/pto × ' + dirxct + ' pts', dirxct, nivel);
    }
    const urbRows = buscar(tf, { geo: 'CT FBY FALABELLA CHILE MINI-MIDI (WMOS)', ruta: 'Urbano' }, 'contains');
    if (urbRows.length > 0) return calcHubUrbanoFromRows(urbRows, 'HUB - MINI-MIDI', veh, nivel, dirxct);
    const fallback = buscar(tf, { servicio: 'HUB Y LOF2', tipo: 'Furgon' });
    if (fallback.length > 0) return calcHubUrbanoFromRows(fallback, 'HUB - MINI-MIDI', veh, nivel, dirxct);
    return sinPago('HUB - MINI-MIDI', '❌ Sin tarifa MINI-MIDI Urbana en tarifario');
  }

  if (ct.includes('BIG TICKET FBY') || ct.includes('BIG Ticket PM')) return calcEstancilla(tf, cat, zona, veh, nivel, dirxct);
  if (ct.includes('Reverse F3')) return calcF3(tf, zona, nivel, dirxct);
  if (ct.includes('Reverse') && !ct.includes('F3')) return calcReversaHPU(tf, dirxct, nivel);

  if (ct.includes('HUB XD')) {
    if (['C11-20', 'C21-35', 'C36-50', 'C1-10'].includes(cat)) {
      const trenRows = porGeo(sinSimpli(buscar(tf, { servicio: 'TREN AM', tipo: cat })), 'HUB XD');
      if (trenRows.length > 0 && trenRows[0].tarifa !== null) {
        return resultado(trenRows[0].tarifa, null, 'TREN AM', 'Camión HUB XD → TREN AM | Veh:' + veh + ' | Cat:' + cat, dirxct, nivel);
      }
    }
    if (zona !== 'Urbana') return calcHubExtraUrbano(tf, 'HUB XD', zona, veh, cat, nivel, dirxct);
    const r = hubPorCategoria(tf, 'HUB XD', cat, veh, nivel, dirxct);
    if (r) return r;
    return sinPago('HUB Y LOF2', '⚠ Veh no mapeado: ' + veh);
  }

  const ctU = ct.toUpperCase();
  if (ctU.includes('LOF1') || ctU.includes('LOF2')) {
    if (zona !== 'Urbana') return calcHubExtraUrbano(tf, ct, zona, veh, cat, nivel, dirxct);
    const r = hubPorCategoria(tf, ct, cat, veh, nivel, dirxct);
    if (r) return r;
    const rowsF = buscarHub(tf, ct, 'Furgon');
    if (rowsF.length > 0) return calcHubUrbanoFromRows(rowsF, 'HUB Y LOF2', veh, nivel, dirxct);
    return sinPago('HUB Y LOF2', '⚠ Sin tarifa LOF1/LOF2 | Veh:' + veh + ' | ' + ct);
  }

  if (ct.includes('LOF')) {
    const lofRows = buscar(tf, { servicio: 'LOF3' });
    if (lofRows.length > 0) {
      let rutaMatch = '';
      if (cat === 'Electrico') rutaMatch = 'Electrico';
      else if (['C1-10', 'C11-20', 'C21-35'].includes(cat)) rutaMatch = 'Urbana';
      const matchRows = buscar(tf, { servicio: 'LOF3', tipo: cat });
      if (matchRows.length === 0) {
        const matchByRuta = buscar(tf, { servicio: 'LOF3', ruta: rutaMatch });
        if (matchByRuta.length > 0) {
          let byTipo = matchByRuta;
          if (cat !== 'Electrico') byTipo = matchByRuta.filter((r) => up(r.tipo) === cat.toUpperCase());
          if (byTipo.length > 0 && byTipo[0].tarifa !== null) return resultado(byTipo[0].tarifa, null, 'LOF3', 'LOF3 Ruta:' + rutaMatch, dirxct, nivel);
        }
      } else if (matchRows[0].tarifa !== null) {
        return resultado(matchRows[0].tarifa, null, 'LOF3', 'LOF3 Cat:' + cat, dirxct, nivel);
      }
    }
    const r = hubPorCategoria(tf, 'HUB XD', cat, veh, nivel, dirxct);
    if (r) return r;
    return sinPago('HUB Y LOF2', '⚠ Veh no esperado en LOF: ' + veh);
  }

  if (ct.includes('IKEA')) return calcIKEA(tf, cat, zona, veh, dirxct, nivel);
  if (['VALPARAISO', 'LA SERENA', 'TEMUCO', 'RANCAGUA'].some((x) => ctU.includes(x))) return calcRegiones(tf, cat, zona, dirxct, nivel);

  return sinPago('', '❌ CT sin mapeo: ' + ct + ' | Veh:' + veh);
}

// ─── Recargo domingo / feriado (solo HUB XD) ───────────────────────────────
function aplicarRecargoDomingo(res, ct, fechaMs, dirxct, feriados) {
  if (!res || res.pago === null || res.pago === undefined) return res;
  if (!RECARGO_DOMINGO_PCT) return res;
  if (!str(ct).includes(CT_RECARGO_DOMINGO)) return res;
  if (fechaMs === null) return res;

  const esDom = new Date(fechaMs).getUTCDay() === 0;
  const esFer = !!feriados && feriados.has(isoDeMs(fechaMs));
  if (!esDom && !esFer) return res;

  const f = 1 + RECARGO_DOMINGO_PCT;
  if (res.tb !== null && res.tb !== undefined) res.tb = Math.round(res.tb * f);
  if (res.tv !== null && res.tv !== undefined) res.tv = Math.round(res.tv * f);
  if (res.tb !== null && res.tb !== undefined) res.pago = res.tb;
  else if (res.tv !== null && res.tv !== undefined) res.pago = Math.round(res.tv * dirxct);
  else res.pago = Math.round(res.pago * f);

  const motivo = esDom && esFer ? 'Domingo+Feriado' : (esDom ? 'Domingo' : 'Feriado');
  res.obs = '🗓️ ' + motivo + ' +' + Math.round(RECARGO_DOMINGO_PCT * 100) + '% ' + CT_RECARGO_DOMINGO + ' | ' + res.obs;
  return res;
}

// ─── Orquestación sobre el consolidado ─────────────────────────────────────
// filas: [{ origen, fecha ('dd/MM/yyyy'), idruta, ct, patente, zona, tipoRuta,
//           terminado, total, tipoVeh, nivel ('' | número) }] en el orden del
// consolidado. Devuelve una entrada por fila (las fusionadas se marcan).
function calcularPagoFalabella(filas, tarifario, feriados, agp) {
  const datos = filas.map((f) => ({ ...f }));
  const fechaDe = (f) => toDateMs(f.fecha);

  // Fusión: mismo idruta+ct+patente (solo Geosort) se junta en la primera fila.
  const porRuta = new Map();
  datos.forEach((r, i) => {
    if (esSimpli(r.origen, r.ct)) return;
    const k = str(r.idruta) + '|' + str(r.ct) + '|' + str(r.patente);
    if (!porRuta.has(k)) porRuta.set(k, []);
    porRuta.get(k).push(i);
  });

  const fusionadas = new Set();
  const infoMixta = new Map();
  for (const indices of porRuta.values()) {
    if (indices.length < 2) continue;
    const noRM = indices.filter((i) => !ZONAS_RM.has(str(datos[i].zona)));
    const principal = indices[0];
    let termUrb = 0, termXu = 0, termTot = 0, sumaTot = 0, hayUrb = false, hayXu = false;
    for (const i of indices) {
      const z = str(datos[i].zona);
      const t = parseFloat(datos[i].terminado) || 0;
      termTot += t; sumaTot += parseFloat(datos[i].total) || 0;
      if (z === 'Urbana') { termUrb += t; hayUrb = true; } else if (z === 'Extra urbana') { termXu += t; hayXu = true; }
    }
    let sumaPuntos = parseFloat(datos[principal].terminado) || 0;
    for (const i of indices.slice(1)) { sumaPuntos += parseFloat(datos[i].terminado) || 0; fusionadas.add(i); }
    datos[principal].terminado = sumaPuntos;
    if (sumaTot > 0) datos[principal].nivel = termTot / sumaTot;

    if (noRM.length > 0) datos[principal].zona = str(datos[noRM[0]].zona);
    else if (hayUrb && hayXu) {
      datos[principal].zona = 'Extra urbana';
      if (CTS_RUTA_MIXTA.some((c) => up(datos[principal].ct).includes(c))) infoMixta.set(principal, { termUrb, termXu, term: termTot, total: sumaTot });
    }
  }

  // Complemento: misma fecha+idruta con 2+ filas → se paga la de más terminados.
  const complementos = new Set();
  if (DETECTAR_COMPLEMENTO) {
    const grupos = new Map();
    datos.forEach((r, i) => {
      if (fusionadas.has(i) || esSimpli(r.origen, r.ct)) return;
      const idruta = str(r.idruta);
      if (!idruta) return;
      const k = str(r.fecha) + '|' + idruta;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(i);
    });
    for (const indices of grupos.values()) {
      if (indices.length < 2) continue;
      let orig = indices[0];
      let max = parseFloat(datos[orig].terminado) || 0;
      for (const i of indices) { const t = parseFloat(datos[i].terminado) || 0; if (t > max) { max = t; orig = i; } }
      for (const i of indices) if (i !== orig) complementos.add(i);
    }
  }

  const motosCalculadas = new Set();
  const salida = [];

  datos.forEach((r, i) => {
    const base = { ...r, tarifaBase: null, tarifaVariable: null, pago: null, servicio: '', observacion: '', estadoFila: '', fallbackFecha: false };
    if (fusionadas.has(i)) { salida.push({ ...base, estadoFila: 'FUSIONADA' }); return; }
    if (complementos.has(i)) {
      salida.push({ ...base, estadoFila: 'COMPLEMENTO', observacion: '🔁 Complemento de otra ruta – no se paga (el pago va en la ruta original)' });
      return;
    }

    const ct = str(r.ct);
    const nivelRaw = r.nivel;
    const nivel = parseFloat(nivelRaw) || 0;
    const dirxct = parseFloat(r.terminado) || 0;
    let veh = str(r.tipoVeh);
    if (!veh && r.patente) {
      veh = agp.get(str(r.patente).replace(/[-\s.]+/g, '').toUpperCase()) || '';
      base.tipoVeh = veh;
    }

    const sinPatente = !str(r.patente) && !veh && !esSimpli(r.origen, ct);

    const hayNivel = nivelRaw !== '' && nivelRaw !== null && nivelRaw !== undefined;
    if (hayNivel && nivel < UMBRAL_NDS_MINIMO) {
      salida.push({ ...base, estadoFila: 'NDS_BAJO', observacion: '🚫 NDS ' + pct(nivel) + ' < ' + Math.round(UMBRAL_NDS_MINIMO * 100) + '% – ruta no considerada a pago' });
      return;
    }

    const fechaMs = fechaDe(r);
    const { rows: tarifasFecha, fallback } = filtrarPorFecha(tarifario, fechaMs);
    if (tarifasFecha.length === 0) {
      salida.push({ ...base, estadoFila: 'SIN_TARIFA', observacion: '❌ Sin tarifas para fecha: ' + str(r.fecha) });
      return;
    }

    let res;
    if (!esSimpli(r.origen, ct) && ct.includes('HUB XD') && veh === 'Moto') {
      const clave = str(r.idruta) + '|' + ct + '|' + str(r.patente);
      if (motosCalculadas.has(clave)) { salida.push({ ...base, estadoFila: 'MOTO_REPETIDA' }); return; }
      motosCalculadas.add(clave);
      res = calcMotoHubXD(tarifasFecha, dirxct);
      aplicarRecargoDomingo(res, ct, fechaMs, dirxct, feriados);
      if (fallback) res.obs = '⚠️ TARIFA FALLBACK (última vigente) | ' + res.obs;
    } else {
      let mixta = null;
      if (infoMixta.has(i)) {
        const mx = infoMixta.get(i);
        const nivelMix = mx.total > 0 ? mx.term / mx.total : nivel;
        mixta = calcRutaMixta(tarifasFecha, ct, mx.termUrb, mx.termXu, nivelMix);
      }
      if (mixta) {
        res = mixta;
        aplicarRecargoDomingo(res, ct, fechaMs, dirxct, feriados);
        if (fallback) res.obs = '⚠️ TARIFA FALLBACK | ' + res.obs;
      } else {
        res = calcularTarifa(tarifasFecha, ct, str(r.zona), veh, nivel, dirxct, str(r.tipoRuta).toUpperCase(), r.origen);
        aplicarRecargoDomingo(res, ct, fechaMs, dirxct, feriados);
        if (fallback && res.tb !== null) res.obs = '⚠️ TARIFA FALLBACK | ' + res.obs;
      }
    }

    salida.push({
      ...base, tarifaBase: res.tb, tarifaVariable: res.tv, pago: res.pago, servicio: res.serv, observacion: (sinPatente ? '⚠️ Sin patente (tipo de vehículo desconocido) | ' : '') + res.obs,
      estadoFila: res.pago === null ? 'SIN_TARIFA' : 'PAGADA', fallbackFecha: fallback, mixta: infoMixta.has(i),
    });
  });

  return salida;
}

function resumirPagoFalabella(salida) {
  const r = {
    filasProcesadas: salida.length, rutasGeosort: 0, rutasSimpli: 0, totalGeosort: 0, totalSimpli: 0,
    rutasMixta: 0, rutasComplemento: 0, rutasNdsBajo: 0, sinTarifa: 0, conMultaNC: 0, multaTotal: 0,
    totalPago: 0, pagoNeto: 0, porCT: {},
  };
  for (const f of salida) {
    if (f.estadoFila === 'FUSIONADA' || f.estadoFila === 'MOTO_REPETIDA') continue;
    if (f.estadoFila === 'COMPLEMENTO') { r.rutasComplemento++; continue; }
    if (f.estadoFila === 'NDS_BAJO') { r.rutasNdsBajo++; }
    const simpli = esSimpli(f.origen, f.ct);
    const pago = typeof f.pago === 'number' ? f.pago : 0;
    if (simpli) { r.totalSimpli += pago; r.rutasSimpli++; } else { r.totalGeosort += pago; r.rutasGeosort++; }
    if (f.mixta) r.rutasMixta++;
    if (f.estadoFila === 'SIN_TARIFA') r.sinTarifa++;
    if (String(f.observacion).includes('NC<95%')) r.conMultaNC++;
    const k = f.ct || '(sin CT)';
    if (!r.porCT[k]) r.porCT[k] = { rutas: 0, total: 0 };
    r.porCT[k].rutas++; r.porCT[k].total += pago;
  }
  r.totalPago = r.totalGeosort + r.totalSimpli;
  r.multaTotal = r.conMultaNC * MULTA_NC_MENOR_95;
  r.pagoNeto = r.totalPago - r.multaTotal;
  return r;
}

module.exports = {
  cargarTarifario, filtrarPorFecha, calcularTarifa, calcularPagoFalabella, resumirPagoFalabella,
  toDateMs, isoDeMs, esSimpli, calcMotoHubXD, calcRutaMixta, seleccionarPorNDS, UMBRAL_NDS_MINIMO,
};
