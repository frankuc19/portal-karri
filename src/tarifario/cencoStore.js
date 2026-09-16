const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

const ZONAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_zonas.json');
const TARIFAS_FILE    = path.join(DATA_DIR, 'tarifario_cenco_tarifas.json');
const ASEGURADOS_FILE = path.join(DATA_DIR, 'tarifario_cenco_asegurados.json');
const SALAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_salas.json'); // { grupoPoligono: sala }
const NOMBRES_FILE    = path.join(DATA_DIR, 'tarifario_cenco_nombres.json'); // { nombreNorm: nombreCanonico }
const CODIGOS_TIENDA_FILE = path.join(DATA_DIR, 'tarifario_cenco_codigos_tienda.json'); // { codigoTienda: sala }

// Mismo patrón de caché en memoria por archivo que turnosStore/altasStore —
// evita releer y re-parsear desde disco en cada consulta de tarifa.
const _jsonCache = new Map();
function readJson(file, fallback) {
  if (_jsonCache.has(file)) return _jsonCache.get(file);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let data = fallback;
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { data = fallback; }
  }
  _jsonCache.set(file, data);
  return data;
}
function writeJson(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  _jsonCache.set(file, data);
}

// Tolera acentos/mayúsculas al cruzar el nombre de una zona (polígono) con el
// "Destino" de la planilla de tarifas — igual que se hace en Altas Onboarding.
function normalizar(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

// ─── Nombre canónico por zona ───────────────────────────────────────────────
// Los archivos fuente traen la misma zona escrita de formas distintas (ej.
// "Calera de Tango" vs "Calera de tango") — nombreNorm ya las trata como una
// sola para cruzar tarifas, pero el texto que se muestra en pantalla también
// tiene que ser uno solo. Se elige automáticamente la variante con tildes/Ñ y
// mayúsculas de inicio de palabra correctas, y se recuerda para que una
// importación futura con peor ortografía no la reemplace.
function puntajeNombre(s) {
  let p = 0;
  if (/[áéíóúñÁÉÍÓÚÑ]/.test(s)) p += 10;
  const conectores = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y']);
  const palabras = s.trim().split(/\s+/);
  const bienCapitalizado = palabras.every((w, i) => {
    if (i > 0 && conectores.has(w.toLowerCase())) return w === w.toLowerCase();
    return w.length > 0 && w[0] === w[0].toUpperCase();
  });
  if (bienCapitalizado) p += 5;
  return p;
}
function mejorVariante(actual, candidata) {
  if (!actual) return candidata;
  if (actual === candidata) return actual;
  const pa = puntajeNombre(actual), pc = puntajeNombre(candidata);
  if (pc > pa) return candidata;
  if (pc === pa && candidata.localeCompare(actual) < 0) return candidata; // desempate estable
  return actual;
}
function getNombresCanonicos() { return readJson(NOMBRES_FILE, {}); }

// Recorre zonas y tarifas ya guardadas, homogeneiza el nombre visible de cada
// nombreNorm/destinoNorm a una sola forma (la mejor vista hasta ahora entre
// ambos archivos) y reescribe lo que haya quedado desalineado. Se corre al
// final de cada importación, sin importar el orden en que se suban los
// archivos.
function reconciliarNombres() {
  const canon = getNombresCanonicos();
  const zonas = getZonas();
  const tarifas = getTarifas();

  for (const z of zonas) canon[z.nombreNorm] = mejorVariante(canon[z.nombreNorm], z.nombre);
  for (const t of tarifas) canon[t.destinoNorm] = mejorVariante(canon[t.destinoNorm], t.destino);

  let zonasCambiaron = false, tarifasCambiaron = false;
  for (const z of zonas) {
    const mejor = canon[z.nombreNorm];
    if (mejor && z.nombre !== mejor) { z.nombre = mejor; zonasCambiaron = true; }
  }
  for (const t of tarifas) {
    const mejor = canon[t.destinoNorm];
    if (mejor && t.destino !== mejor) { t.destino = mejor; tarifasCambiaron = true; }
  }

  writeJson(NOMBRES_FILE, canon);
  if (zonasCambiaron) writeJson(ZONAS_FILE, zonas);
  if (tarifasCambiaron) writeJson(TARIFAS_FILE, tarifas);
  return canon;
}

// ─── WKT (Well-Known Text) ──────────────────────────────────────────────────
// Extrae todos los anillos "((...))" de un WKT, sea POLYGON simple o
// GEOMETRYCOLLECTION de varios POLYGON (zonas con más de un sector separado)
// — no hace falta distinguir el tipo, solo juntar todos los anillos.
function parseWKT(wkt) {
  const text = String(wkt || '').trim();
  const matches = text.match(/\(\(([^()]+)\)\)/g) || [];
  return matches
    .map(m => m.slice(2, -2).split(',').map(par => {
      const [lng, lat] = par.trim().split(/\s+/).map(Number);
      return [lng, lat];
    }))
    .filter(ring => ring.length >= 3 && ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
}

// Ray casting — punto (lng,lat) dentro de un anillo de vértices [lng,lat].
function puntoEnAnillo(lng, lat, ring) {
  let dentro = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cruza = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (cruza) dentro = !dentro;
  }
  return dentro;
}
function puntoEnPoligono(lng, lat, rings) {
  return rings.some(ring => puntoEnAnillo(lng, lat, ring));
}

// ─── Mapa Grupo de polígono → Sala/Estación ────────────────────────────────
// El archivo de polígonos agrupa por "Poligono" (ej. "Poligono Jumbo- Concha
// y Toro"), que no coincide textualmente con la "Sala" del archivo de
// tarifas (ej. "Puente Alto") — se guarda un mapa editable para poder
// corregirlo desde el panel si la inferencia automática se equivoca.
function getMapaSalas() { return readJson(SALAS_FILE, {}); }
function setSalaDeGrupo(grupo, sala) {
  const mapa = { ...getMapaSalas(), [grupo]: sala };
  writeJson(SALAS_FILE, mapa);
  // Re-aplica el mapa a las zonas ya importadas de ese grupo.
  const zonas = getZonas().map(z => z.grupo === grupo ? { ...z, sala } : z);
  writeJson(ZONAS_FILE, zonas);
  return mapa;
}
function inferirSala(grupo, salasConocidas) {
  const g = normalizar(grupo);
  return salasConocidas.find(s => g.includes(normalizar(s))) || null;
}

// ─── Mapa Código de tienda Cencosud → Sala ─────────────────────────────────
// Los pedidos que trae la API de Cencosud vienen con un código interno de
// tienda (ej. "J843", "E659", "N747") que no es ni el grupo de polígono ni la
// Sala — hay que traducirlo antes de poder resolver la tarifa. Se parte con
// los 7 códigos conocidos hoy, editable desde el panel por si Cenco agrega
// tiendas nuevas.
const CODIGOS_TIENDA_DEFAULT = {
  J843: 'San Bernardo', '101': 'San Bernardo', E843: 'San Bernardo',
  J659: 'Puente Alto',  '407': 'Puente Alto',   E659: 'Puente Alto',
  N747: 'Calera de Tango',
};
function getMapaCodigosTienda() {
  const guardado = readJson(CODIGOS_TIENDA_FILE, null);
  return guardado || { ...CODIGOS_TIENDA_DEFAULT };
}
function setCodigoTienda(codigo, sala) {
  const mapa = { ...getMapaCodigosTienda(), [String(codigo).trim()]: sala };
  writeJson(CODIGOS_TIENDA_FILE, mapa);
  return mapa;
}

// ─── Zonas (polígonos) ──────────────────────────────────────────────────────
function getZonas() { return readJson(ZONAS_FILE, []); }

// Reemplaza el set completo de zonas — cada importación representa "el
// estado actual" del archivo maestro, no un incremental. Conserva el mapa de
// salas ya configurado a mano. Si el archivo trae más de una fila para la
// misma zona dentro del mismo polígono (pasa seguido: la geocerca se dibujó
// en varios pedazos, o quedó una fila repetida a mano), se fusionan en una
// sola zona con todos sus anillos — nunca deben quedar dos filas separadas
// para lo mismo.
function importarPoligonos(rows) {
  const mapaSalas = getMapaSalas();
  const salasConocidas = [...new Set(getTarifas().map(t => t.sala))];
  const porGrupoNombre = new Map(); // "grupo|||nombreNorm" -> zona acumulada
  const errores = [];

  rows.forEach((row, i) => {
    const fila = i + 2; // fila 1 = encabezados
    const grupo = String(row['Poligono'] || '').trim();
    const nombre = String(row['Nombre'] || '').trim();
    if (!nombre) { errores.push({ fila, motivo: 'Falta el nombre de la zona' }); return; }

    const rings = parseWKT(row['WKT']);
    if (rings.length === 0) {
      errores.push({
        fila,
        motivo: `Geometría inválida o incompleta para "${nombre}" — probablemente truncada por el límite de 32.767 caracteres por celda de Excel. Hay que volver a exportar este polígono con menos precisión o partido en varias filas.`,
      });
      return;
    }

    const nombreNorm = normalizar(nombre);
    const key = `${grupo}|||${nombreNorm}`;
    let zona = porGrupoNombre.get(key);
    if (!zona) {
      const sala = mapaSalas[grupo] || inferirSala(grupo, salasConocidas) || null;
      zona = { id: crypto.randomUUID(), grupo, sala, nombre, nombreNorm, rings: [], observacion: row['Observación'] || '' };
      porGrupoNombre.set(key, zona);
    }
    // Solo agrega el anillo si no es idéntico a uno que ya tenía (evita que
    // una fila repetida con el mismo dibujo duplique el anillo dos veces).
    for (const ring of rings) {
      const repetido = zona.rings.some(r => JSON.stringify(r) === JSON.stringify(ring));
      if (!repetido) zona.rings.push(ring);
    }
  });

  const zonas = [...porGrupoNombre.values()];
  writeJson(ZONAS_FILE, zonas);
  // Registra en el mapa cualquier grupo nuevo que se haya podido inferir,
  // para que quede editable desde el panel aunque no se haya tocado a mano.
  const mapaActualizado = { ...mapaSalas };
  for (const z of zonas) if (z.sala && !mapaActualizado[z.grupo]) mapaActualizado[z.grupo] = z.sala;
  writeJson(SALAS_FILE, mapaActualizado);

  reconciliarNombres();

  const filasFusionadas = rows.length - errores.length - zonas.length;
  return {
    creadas: zonas.length,
    filasLeidas: rows.length,
    filasFusionadas: Math.max(0, filasFusionadas),
    errores,
    grupos: [...new Set(zonas.map(z => z.grupo))],
  };
}

// ─── Tarifas por zona + Asegurados por sala ────────────────────────────────
const DIA_ASEGURADO = 'Asegurado';
function esDiaDomingoFestivo(dias) {
  return /domingo/i.test(String(dias || ''));
}

// ID legible y correlativo por tarifa (CN-001, CN-002, ...) — independiente
// del orden de importación, para que se pueda referenciar una tarifa
// puntual (soporte, reportes) sin usar el UUID interno de cada zona.
function generarIdTarifa(n) { return 'CN-' + String(n).padStart(3, '0'); }
function numeroDeId(id) {
  const m = String(id || '').match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function getTarifas() { return readJson(TARIFAS_FILE, []); }
function getAsegurados() { return readJson(ASEGURADOS_FILE, []); }

// ─── Vigencia ───────────────────────────────────────────────────────────────
// Una zona puede tener más de una tarifa a la vez (ej. temporada alta vs.
// normal), siempre que sus rangos de vigencia no se toquen. null en
// vigenciaInicio/vigenciaFin significa "sin límite" en ese extremo.
function estaVigente(t, fecha) {
  return (!t.vigenciaInicio || t.vigenciaInicio <= fecha) && (!t.vigenciaFin || t.vigenciaFin >= fecha);
}
function seSuperponen(aIni, aFin, bIni, bFin) {
  const aI = aIni || '0000-01-01', aF = aFin || '9999-12-31';
  const bI = bIni || '0000-01-01', bF = bFin || '9999-12-31';
  return aI <= bF && bI <= aF;
}
function buscarSolapamiento(sala, destinoNorm, vigenciaInicio, vigenciaFin, idExcluir) {
  return getTarifas().find(t =>
    t.id !== idExcluir && t.sala === sala && t.destinoNorm === destinoNorm &&
    seSuperponen(vigenciaInicio, vigenciaFin, t.vigenciaInicio, t.vigenciaFin));
}

// Actualiza (no reemplaza) el set de tarifas. Una fila del Excel actualiza la
// tarifa de esa Sala+Destino que esté vigente hoy (o la única que exista, si
// todavía no hay historial); no toca otras tarifas de la misma zona con
// vigencia pasada o futura ya configuradas a mano. Si no hay ninguna vigente
// hoy y ya existe más de una para esa zona, crea una tarifa nueva desde hoy
// en vez de arriesgarse a pisar una tarifa futura ya programada. Los
// Asegurados sí se reemplazan completos (no tienen vigencia ni edición manual).
function importarTarifas(rows) {
  const previas = getTarifas();
  const porId = new Map(previas.map(t => [t.id, t]));
  const existentesPorClave = new Map(); // "sala|||destinoNorm" -> [tarifas previas]
  for (const t of previas) {
    const key = `${t.sala}|||${t.destinoNorm}`;
    if (!existentesPorClave.has(key)) existentesPorClave.set(key, []);
    existentesPorClave.get(key).push(t);
  }
  const resueltasEnEstaCorrida = new Map(); // key -> id (para que Lun-Sáb y Dom/Fest, en filas separadas, caigan en la misma tarifa)
  const porAsegurado = new Map(); // sala -> registro
  const errores = [];
  let siguienteNumero = Math.max(0, ...previas.map(t => numeroDeId(t.id))) + 1;
  const hoy = new Date().toISOString().slice(0, 10);

  rows.forEach((row, i) => {
    const fila = i + 2;
    const sala = String(row['Sala'] || '').trim();
    const destino = String(row['Destino'] || '').trim();
    const monto = Number(row['Tarifa Normal']);
    const dias = String(row['Dias'] || '').trim();
    if (!sala || !destino) { errores.push({ fila, motivo: 'Falta Sala o Destino' }); return; }
    if (!Number.isFinite(monto)) { errores.push({ fila, motivo: `Tarifa Normal inválida: "${row['Tarifa Normal']}"` }); return; }

    const esDomFestivo = esDiaDomingoFestivo(dias);
    if (destino === DIA_ASEGURADO) {
      const reg = porAsegurado.get(sala) || { sala, lunSab: null, domFestivo: null };
      if (esDomFestivo) reg.domFestivo = monto; else reg.lunSab = monto;
      porAsegurado.set(sala, reg);
      return;
    }

    const key = `${sala}|||${normalizar(destino)}`;
    let reg;
    const idYaResuelto = resueltasEnEstaCorrida.get(key);
    if (idYaResuelto) {
      reg = porId.get(idYaResuelto);
    } else {
      const candidatas = existentesPorClave.get(key) || [];
      let previo = candidatas.find(t => estaVigente(t, hoy));
      if (!previo && candidatas.length === 1) previo = candidatas[0];
      reg = previo
        ? { ...previo, destino } // conserva id + vigencia + montos previos, refresca el texto del destino
        : {
            id: generarIdTarifa(siguienteNumero++), sala, destino, destinoNorm: normalizar(destino),
            lunSab: null, domFestivo: null, vigenciaInicio: null, vigenciaFin: null,
          };
      resueltasEnEstaCorrida.set(key, reg.id);
      porId.set(reg.id, reg);
    }
    if (esDomFestivo) reg.domFestivo = monto; else reg.lunSab = monto;
  });

  const tarifas = [...porId.values()];
  const asegurados = [...porAsegurado.values()];
  writeJson(TARIFAS_FILE, tarifas);
  writeJson(ASEGURADOS_FILE, asegurados);

  reconciliarNombres();

  return { zonasConTarifa: resueltasEnEstaCorrida.size, salasConAsegurado: asegurados.length, filasLeidas: rows.length, errores };
}

function actualizarTarifa(id, { lunSab, domFestivo, vigenciaInicio, vigenciaFin }) {
  const tarifas = getTarifas();
  const idx = tarifas.findIndex(t => t.id === id);
  if (idx < 0) return { error: 'Tarifa no encontrada', noEncontrada: true };
  const actual = tarifas[idx];

  if (vigenciaInicio !== undefined || vigenciaFin !== undefined) {
    const nuevaInicio = vigenciaInicio !== undefined ? (vigenciaInicio || null) : actual.vigenciaInicio;
    const nuevaFin = vigenciaFin !== undefined ? (vigenciaFin || null) : actual.vigenciaFin;
    const choque = buscarSolapamiento(actual.sala, actual.destinoNorm, nuevaInicio, nuevaFin, id);
    if (choque) {
      return { error: `La vigencia se superpone con la tarifa ${choque.id} (${choque.vigenciaInicio || 'sin inicio'} → ${choque.vigenciaFin || 'indeterminado'})` };
    }
    actual.vigenciaInicio = nuevaInicio;
    actual.vigenciaFin = nuevaFin;
  }
  if (lunSab !== undefined) actual.lunSab = lunSab === null ? null : Number(lunSab);
  if (domFestivo !== undefined) actual.domFestivo = domFestivo === null ? null : Number(domFestivo);
  writeJson(TARIFAS_FILE, tarifas);
  return { tarifa: actual };
}

// Crea una tarifa adicional para una zona que ya tiene al menos un polígono
// cargado, con su propio rango de vigencia — para casos como "temporada alta
// desde el 1 de diciembre hasta el 28 de febrero" sin perder la tarifa normal
// que rige el resto del año.
function crearTarifa({ sala, destino, lunSab, domFestivo, vigenciaInicio, vigenciaFin }) {
  sala = String(sala || '').trim();
  destino = String(destino || '').trim();
  if (!sala || !destino) return { error: 'Falta Sala o Destino' };
  const destinoNorm = normalizar(destino);
  if (!getZonas().some(z => z.sala === sala && z.nombreNorm === destinoNorm)) {
    return { error: `No existe una zona "${destino}" para la sala "${sala}"` };
  }

  const inicio = vigenciaInicio || null;
  const fin = vigenciaFin || null;
  const choque = buscarSolapamiento(sala, destinoNorm, inicio, fin, null);
  if (choque) {
    return { error: `La vigencia se superpone con la tarifa ${choque.id} (${choque.vigenciaInicio || 'sin inicio'} → ${choque.vigenciaFin || 'indeterminado'})` };
  }

  const tarifas = getTarifas();
  const siguienteNumero = Math.max(0, ...tarifas.map(t => numeroDeId(t.id))) + 1;
  const nombreCanon = getNombresCanonicos()[destinoNorm] || destino;
  const nueva = {
    id: generarIdTarifa(siguienteNumero), sala, destino: nombreCanon, destinoNorm,
    lunSab: lunSab === undefined || lunSab === null || lunSab === '' ? null : Number(lunSab),
    domFestivo: domFestivo === undefined || domFestivo === null || domFestivo === '' ? null : Number(domFestivo),
    vigenciaInicio: inicio, vigenciaFin: fin,
  };
  tarifas.push(nueva);
  writeJson(TARIFAS_FILE, tarifas);
  return { tarifa: nueva };
}

function eliminarTarifa(id) {
  const tarifas = getTarifas();
  const idx = tarifas.findIndex(t => t.id === id);
  if (idx < 0) return false;
  tarifas.splice(idx, 1);
  writeJson(TARIFAS_FILE, tarifas);
  return true;
}

// ─── Resolución de tarifa por punto (lat/lng) ──────────────────────────────
// Núcleo del negocio: dado un despacho (sala + coordenada de destino), busca
// en qué zona cae y devuelve el valor a pagar según el día. Nota: solo se
// puede determinar domingo automáticamente — los festivos (además de
// domingo) no tienen calendario cargado, así que se documentan como
// limitación y se puede forzar con esDomFestivo=true a mano.
function resolverTarifa({ sala, lat, lng, fecha, esDomFestivo }) {
  if (!sala) return { ok: false, motivo: 'FALTA_SALA' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, motivo: 'COORDENADA_INVALIDA' };

  const fechaConsulta = fecha || new Date().toISOString().slice(0, 10);
  const zonas = getZonas().filter(z => z.sala === sala);
  const zona = zonas.find(z => puntoEnPoligono(lng, lat, z.rings));

  const domFestivo = esDomFestivo !== undefined
    ? !!esDomFestivo
    : new Date(fechaConsulta + 'T12:00:00').getDay() === 0;

  if (!zona) {
    const asegurado = getAsegurados().find(a => a.sala === sala);
    return {
      ok: true, sala, zona: null, dentroDePoligono: false, esDomFestivo: domFestivo,
      monto: null,
      asegurado: asegurado ? (domFestivo ? asegurado.domFestivo : asegurado.lunSab) : null,
      motivo: 'FUERA_DE_TODOS_LOS_POLIGONOS',
    };
  }

  const candidatas = getTarifas().filter(t => t.sala === sala && t.destinoNorm === zona.nombreNorm);
  const tarifaVigente = candidatas.find(t => estaVigente(t, fechaConsulta));

  let motivo = null;
  if (candidatas.length === 0) motivo = 'ZONA_SIN_TARIFA_CONFIGURADA';
  else if (!tarifaVigente) motivo = 'TARIFA_FUERA_DE_VIGENCIA';

  return {
    ok: true, sala, zona: zona.nombre, zonaId: zona.id, tarifaId: tarifaVigente?.id || null,
    dentroDePoligono: true, esDomFestivo: domFestivo,
    monto: tarifaVigente ? (domFestivo ? tarifaVigente.domFestivo : tarifaVigente.lunSab) : null,
    motivo,
  };
}

module.exports = {
  parseWKT, puntoEnPoligono, normalizar,
  getMapaSalas, setSalaDeGrupo,
  getMapaCodigosTienda, setCodigoTienda,
  getZonas, importarPoligonos,
  getTarifas, getAsegurados, importarTarifas, actualizarTarifa, crearTarifa, eliminarTarifa,
  resolverTarifa,
  getNombresCanonicos, reconciliarNombres,
};
