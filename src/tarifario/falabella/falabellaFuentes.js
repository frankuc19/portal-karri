// Descarga de Geosort (Falabella) y SimpliRoute, y armado del "Resumen
// consolidado" que el script de Apps Script dejaba en hojas intermedias
// (Falabella → Resumen_Falabella, Simpli → Resumen_Simpli → Resumen_Consolidado).
// Acá todo es transitorio y en memoria: nada de eso se vuelve a escribir en la planilla.

const BASE_URL_GEOSORT = 'https://geosort.falabella.com/api/tracing-service/v1/reporter/download';
const BASE_URL_SIMPLI = 'https://api-gateway.simpliroute.com/v1/routes/visits/paginated/';
const BASE_URL_VEHICULOS = 'https://api-gateway.simpliroute.com/v1/routes/vehicles/';
const LOGIN_URL_SIMPLI = 'https://api.simpliroute.com/v2/auth/login/';
const DIAS_POR_BLOQUE_SIMPLI = 7;

const COMUNAS_EXTRA_URBANAS = new Set([
  'LAMPA', 'CALERA DE TANGO', 'POMAIRE', 'PEÑAFLOR', 'MELIPILLA', 'PAINE', 'ISLA DE MAIPO',
  'SANTA ROSA DE CHENA', 'MALLOCO', 'TALAGANTE', 'LINDEROS', 'MAIPO', 'VALDIVIA DE PAINE',
  'BATUCO', 'TIL TIL', 'CHAMPA', 'CULIPRAN', 'HOSPITAL', 'HUELQUEN', 'LAGUNA DE ACULEO',
  'CAJON DEL MAIPO', 'SAN JOSE DE MAIPO', 'CHOCALAN', 'LONQUEN', 'PIRQUE', 'EL MONTE',
  'FARELLONES', 'ALHUE', 'SAN PEDRO', 'CURACAVI', 'MARIA PINTO', 'BOLLENAR', 'VALLE NEVADO',
  'CARMEN BAJO', 'PUANGUE',
]);
const FECHAS_ERROR = new Set(['31/12/2001', '31-12-2001']);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const p2 = (n) => String(n).padStart(2, '0');

// ─── CSV con separador (Geosort usa ';') ───────────────────────────────────
function parsearCsv(texto, sep = ';') {
  const filas = [];
  let fila = [], campo = '', enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((x) => x !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x !== '')) filas.push(fila);
  return filas;
}

// ─── Fechas ─────────────────────────────────────────────────────────────────
// Devuelve { texto: 'dd/MM/yyyy', iso: 'yyyy-MM-dd', hora: 0-23|null } o null.
function parseFechaHora(raw) {
  const s = str(raw);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
  let y, mo, d, h = null;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; h = m[4] !== undefined ? +m[4] : null; }
  else if ((m = s.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/))) {
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && m[4] !== undefined) {
      // Instante con zona horaria: se lleva a hora de Chile (el servidor corre en UTC).
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric',
      }).formatToParts(new Date(s)).map((x) => [x.type, x.value]));
      y = +p.year; mo = +p.month; d = +p.day; h = +p.hour;
    } else { y = +m[1]; mo = +m[2]; d = +m[3]; h = m[4] !== undefined ? +m[4] : null; }
  } else return null;
  return { texto: `${p2(d)}/${p2(mo)}/${y}`, iso: `${y}-${p2(mo)}-${p2(d)}`, hora: h };
}

// ─── Geosort ────────────────────────────────────────────────────────────────
function diasEntre(iniISO, finISO) {
  const dias = [];
  const [y1, m1, d1] = iniISO.split('-').map(Number);
  const [y2, m2, d2] = finISO.split('-').map(Number);
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += 86400000) dias.push(new Date(t).toISOString().slice(0, 10));
  return dias;
}

async function descargarGeosort(iniISO, finISO, accesos, onProgreso) {
  if (!accesos.geosortToken || !accesos.geosortCookie) {
    throw new Error('Falta el token o la cookie de Geosort en la pestaña "Accesos" (celdas B10 y B12).');
  }
  const headers = {
    authorization: 'Bearer ' + accesos.geosortToken, cookie: accesos.geosortCookie, accept: '*/*',
    referer: 'https://geosort.falabella.com/app/reporterSupOnly', 'user-agent': 'Mozilla/5.0', 'x-country': 'CL',
  };
  const dias = diasEntre(iniISO, finISO);
  let header = null;
  const filas = [];
  const errores = [];
  const diasSinDatos = [];

  for (let i = 0; i < dias.length; i++) {
    const dia = dias[i];
    if (onProgreso) onProgreso({ fase: 'Geosort', diaActual: i + 1, totalDias: dias.length, diaLabel: dia, filasAcumuladas: filas.length });
    const resp = await fetch(`${BASE_URL_GEOSORT}?dateFrom=${dia}&dateUp=${dia}`, { method: 'GET', headers });
    if (resp.status === 200) {
      const texto = await resp.text();
      if (texto && texto.length > 50) {
        const csv = parsearCsv(texto, ';');
        if (csv.length > 0) { if (!header) header = csv[0]; filas.push(...csv.slice(1)); }
        if (csv.length <= 1) diasSinDatos.push(dia);
      } else diasSinDatos.push(dia);
    } else {
      const cuerpo = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        errores.push({ dia, motivo: `El token de Geosort venció (HTTP ${resp.status}). Actualiza el token y la cookie en la pestaña "Accesos" de la planilla "EDP Karri Chile" (celdas B10 y B12) y vuelve a procesar.`, tokenVencido: true });
        break;
      }
      errores.push({ dia, motivo: `HTTP ${resp.status}${cuerpo ? ': ' + cuerpo.slice(0, 160) : ''}` });
    }
    await dormir(200);
  }
  return { header, filas, errores, diasSinDatos };
}

// Resumen por ruta (fecha + idruta + CT + patente + zona), igual que Resumen_Falabella.
function resumirGeosort(header, filas, agp) {
  const h = header.map((x) => str(x).toLowerCase());
  const COL = {
    fecha: h.indexOf('fechainicioruta'), idruta: h.indexOf('idruta'), ct: h.indexOf('ct'), patente: h.indexOf('patente'),
    driverrut: h.indexOf('driverrut'), drivername: h.indexOf('drivername'),
    estado: h.indexOf('estado'), direccion: h.indexOf('direccion'), comuna: h.indexOf('localidad'), region: h.indexOf('region'),
  };
  if (COL.region === -1) COL.region = h.indexOf('nombreregion');
  if (COL.region === -1) COL.region = h.indexOf('nombre_region');
  const faltan = ['fecha', 'idruta', 'ct', 'patente', 'estado', 'direccion'].filter((k) => COL[k] === -1);
  if (faltan.length) throw new Error('El reporte de Geosort no trae las columnas: ' + faltan.join(', ') + '. Columnas recibidas: ' + header.join(', '));

  const ESTADO_IDX = { 'en ruta': 0, pendiente: 1, terminado: 2 };
  const mapa = new Map();
  const orden = [];
  let sinFecha = 0;
  let ejemploSinFecha = null;

  // Filas sin patente: se completa con la patente que otra fila de la MISMA ruta
  // (mismo idruta + ct + fecha) sí trae, para no partir la ruta en dos ni perder
  // el tipo de vehículo. Si ninguna la trae, queda sin patente y se avisa.
  const patenteDeRuta = new Map();
  for (const row of filas) {
    const p = str(row[COL.patente]);
    if (!p) continue;
    const f = parseFechaHora(row[COL.fecha]);
    if (!f) continue;
    const k = [f.texto, str(row[COL.idruta]), str(row[COL.ct])].join('|');
    if (!patenteDeRuta.has(k)) patenteDeRuta.set(k, p);
  }
  let patentesCompletadas = 0;

  // Segundo respaldo: la patente que ese conductor (Driverrut, o Drivername si no
  // hay RUT) usó ese mismo día en otra ruta y, si no, la que más usó en el período.
  const iConductor = COL.driverrut !== -1 ? COL.driverrut : COL.drivername;
  const conductorDe = (row) => (iConductor === -1 ? '' : str(row[iConductor]).toUpperCase().replace(/[.\s]/g, ''));
  const usoDia = new Map(); // rut|fecha → Map(patente → n)
  const usoTotal = new Map(); // rut → Map(patente → n)
  const sumar = (m, k, p) => { if (!m.has(k)) m.set(k, new Map()); m.get(k).set(p, (m.get(k).get(p) || 0) + 1); };
  const masUsada = (m) => { let best = '', n = 0; for (const [p, c] of m || []) if (c > n) { best = p; n = c; } return best; };
  if (iConductor !== -1) {
    for (const row of filas) {
      const p = str(row[COL.patente]), c = conductorDe(row);
      if (!p || !c) continue;
      const f = parseFechaHora(row[COL.fecha]);
      if (!f) continue;
      sumar(usoDia, c + '|' + f.texto, p); sumar(usoTotal, c, p);
    }
  }
  let patentesPorConductor = 0;
  const inferidas = new Set();

  for (const row of filas) {
    const f = parseFechaHora(row[COL.fecha]);
    if (!f) { sinFecha++; if (ejemploSinFecha === null) ejemploSinFecha = str(row[COL.fecha]); continue; }
    if (FECHAS_ERROR.has(f.texto)) continue;

    const idruta = str(row[COL.idruta]), ct = str(row[COL.ct]);
    let patente = str(row[COL.patente]);
    if (!patente) {
      const alt = patenteDeRuta.get([f.texto, idruta, ct].join('|'));
      if (alt) { patente = alt; patentesCompletadas++; }
    }
    let inferida = false;
    if (!patente && iConductor !== -1) {
      const c = conductorDe(row);
      const alt = c ? (masUsada(usoDia.get(c + '|' + f.texto)) || masUsada(usoTotal.get(c))) : '';
      if (alt) { patente = alt; inferida = true; patentesPorConductor++; }
    }
    const comuna = COL.comuna !== -1 ? str(row[COL.comuna]).toUpperCase() : '';
    const region = COL.region !== -1 ? str(row[COL.region]) : '';
    const esRM = region === '' || region.toUpperCase().includes('METROPOLITANA');
    const zona = esRM ? (COMUNAS_EXTRA_URBANAS.has(comuna) ? 'Extra urbana' : 'Urbana') : (comuna !== '' ? comuna : region.toUpperCase());

    let tipoRuta = '';
    if (f.hora !== null) tipoRuta = f.hora < 12 ? 'AM' : 'PM';

    const clave = [f.texto, idruta, ct, patente, zona].join('|');
    if (inferida) inferidas.add(clave);
    if (!mapa.has(clave)) {
      mapa.set(clave, { f, idruta, ct, patente, zona, tipoRuta, sets: [new Set(), new Set(), new Set()], dirCt: new Set() });
      orden.push(clave);
    }
    const e = mapa.get(clave);
    const direccion = str(row[COL.direccion]);
    const idx = ESTADO_IDX[str(row[COL.estado]).toLowerCase()];
    if (idx !== undefined && direccion !== '') e.sets[idx].add(direccion);
    if (direccion !== '') e.dirCt.add(direccion);
  }

  orden.sort((a, b) => {
    const x = mapa.get(a), y = mapa.get(b);
    return x.f.iso.localeCompare(y.f.iso) || x.idruta.localeCompare(y.idruta) || x.ct.localeCompare(y.ct) || x.patente.localeCompare(y.patente);
  });

  const rows = orden.map((k) => {
    const e = mapa.get(k);
    const [enRuta, pendiente, terminado] = e.sets.map((s) => s.size);
    return {
      origen: 'Geosort', fecha: e.f.texto, iso: e.f.iso, idruta: e.idruta, ct: e.ct, patente: e.patente, zona: e.zona,
      tipoRuta: e.tipoRuta, enRuta, pendiente, terminado, total: enRuta + pendiente + terminado, dirXCt: e.dirCt.size,
      patenteInferida: inferidas.has(k),
      tipoVeh: agp.get(e.patente.replace(/[-\s.]+/g, '').toUpperCase()) || '',
    };
  });
  return { rows, sinFecha, ejemploSinFecha, patentesCompletadas, patentesPorConductor, sinPatente: rows.filter((r) => !r.patente).length };
}

// ─── SimpliRoute ────────────────────────────────────────────────────────────
async function loginSimpli(usuario, clave) {
  if (!usuario || !clave) throw new Error('Faltan el usuario o la clave de SimpliRoute en la pestaña "Accesos" (B1 y B2).');
  const resp = await fetch(LOGIN_URL_SIMPLI, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: usuario, password: clave }),
  });
  if (resp.status !== 200) throw new Error('SimpliRoute rechazó el usuario/clave de la pestaña "Accesos" (HTTP ' + resp.status + ').');
  const body = await resp.json();
  const token = body.token || body.auth_token;
  if (!token) throw new Error('SimpliRoute no devolvió un token.');
  return token;
}

function planoDe(obj, prefijo = '', out = {}) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const key = prefijo ? prefijo + '.' + k : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) planoDe(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

async function descargarSimpli(iniISO, finISO, accesos, onProgreso) {
  let token = await loginSimpli(accesos.simpliUsuario, accesos.simpliClave);
  const headers = () => ({ authorization: 'Token ' + token, accept: 'application/json' });
  const pedir = async (url) => {
    let resp = await fetch(url, { headers: headers() });
    if (resp.status === 401) { token = await loginSimpli(accesos.simpliUsuario, accesos.simpliClave); resp = await fetch(url, { headers: headers() }); }
    return resp;
  };

  const vehiculos = {};
  try {
    const rv = await pedir(BASE_URL_VEHICULOS);
    if (rv.status === 200) {
      const arr = await rv.json();
      (Array.isArray(arr) ? arr : arr.results || []).forEach((v) => { vehiculos[String(v.id)] = v; });
    }
  } catch { /* sin mapa de vehículos: la patente queda vacía y se avisa más abajo */ }

  const visitas = [];
  const errores = [];
  const dias = diasEntre(iniISO, finISO);
  for (let i = 0; i < dias.length; i += DIAS_POR_BLOQUE_SIMPLI) {
    const bIni = dias[i];
    const bFin = dias[Math.min(i + DIAS_POR_BLOQUE_SIMPLI - 1, dias.length - 1)];
    if (onProgreso) onProgreso({ fase: 'SimpliRoute', diaActual: i + 1, totalDias: dias.length, diaLabel: `${bIni} a ${bFin}`, filasAcumuladas: visitas.length });

    for (let page = 1; ; page++) {
      const resp = await pedir(`${BASE_URL_SIMPLI}?page=${page}&page_size=100&start_date=${bIni}&end_date=${bFin}`);
      if (resp.status !== 200) { errores.push({ dia: `${bIni} a ${bFin}`, motivo: `SimpliRoute HTTP ${resp.status} (página ${page})` }); break; }
      const json = await resp.json();
      const lote = json.results || [];
      if (!lote.length) break;
      for (const v of lote) {
        const vId = v.vehicle_id || v.vehicle;
        if (vId && vehiculos[String(vId)]) v.INFO_VEHICULO = vehiculos[String(vId)];
        const p = planoDe(v);
        visitas.push({
          planned_date: p.planned_date, driver: p.driver, vehiculo: p['INFO_VEHICULO.name'], title: p.title,
          route_status: p.route_status, status: p.status, tracking_id: p.tracking_id,
        });
      }
      if (!json.next) break;
    }
  }
  return { visitas, errores };
}

// Resumen por conductor+vehículo+fecha, igual que Resumen_Simpli.
function resumirSimpli(visitas, agp) {
  const ESTADO_IDX = { in_progress: 0, pending: 1, completed: 2 };
  const mapa = new Map();
  const orden = [];
  let sinFecha = 0;

  for (const v of visitas) {
    if (str(v.title) === 'Descarga FBS - 7100') continue;
    if (str(v.route_status).toLowerCase() !== 'finished') continue;

    const f = parseFechaHora(v.planned_date);
    if (!f) { sinFecha++; continue; }
    const driver = str(v.driver);
    // "STKY-45/Karri" → "STKY45" → "STKY-45"
    const limpio = str(v.vehiculo).replace(/\/Karri/gi, '').replace(/-/g, '').trim();
    const patente = limpio.length > 2 ? limpio.slice(0, -2) + '-' + limpio.slice(-2) : limpio;
    const clave = [f.texto, driver, patente].join('|');
    if (!mapa.has(clave)) { mapa.set(clave, { f, driver, patente, sets: [new Set(), new Set(), new Set()], todo: new Set() }); orden.push(clave); }
    const e = mapa.get(clave);
    const tracking = str(v.tracking_id);
    const idx = ESTADO_IDX[str(v.status).toLowerCase()];
    if (idx !== undefined && tracking !== '') e.sets[idx].add(tracking);
    if (tracking !== '') e.todo.add(tracking);
  }

  orden.sort((a, b) => {
    const x = mapa.get(a), y = mapa.get(b);
    return x.f.iso.localeCompare(y.f.iso) || x.driver.localeCompare(y.driver) || x.patente.localeCompare(y.patente);
  });

  const rows = orden.map((k) => {
    const e = mapa.get(k);
    const [enRuta, pendiente, terminado] = e.sets.map((s) => s.size);
    return {
      origen: 'Simpli', fecha: e.f.texto, iso: e.f.iso, idruta: e.driver, ct: 'Ruta Colecta Simpli', patente: e.patente,
      zona: 'Urbana', tipoRuta: 'AM', enRuta, pendiente, terminado, total: enRuta + pendiente + terminado, dirXCt: e.todo.size,
      tipoVeh: agp.get(e.patente.replace(/[-\s]+/g, '').toUpperCase()) || '',
    };
  });
  return { rows, sinFecha };
}

// Une Geosort y Simpli como Resumen_Consolidado: orden por fecha, CT y patente
// (estable, así dentro de un empate se conserva Geosort antes que Simpli) y
// nivel de cumplimiento = terminados / total.
function consolidar(filasGeosort, filasSimpli) {
  const todas = [...filasGeosort, ...filasSimpli];
  todas.sort((a, b) => a.iso.localeCompare(b.iso) || a.ct.localeCompare(b.ct) || a.patente.localeCompare(b.patente));
  return todas.map((r) => ({ ...r, nivel: r.total > 0 ? r.terminado / r.total : '' }));
}

module.exports = { descargarGeosort, descargarSimpli, resumirGeosort, resumirSimpli, consolidar, parsearCsv, parseFechaHora };
