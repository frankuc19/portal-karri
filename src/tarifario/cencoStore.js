const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

const ZONAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_zonas.json');
const TARIFAS_FILE    = path.join(DATA_DIR, 'tarifario_cenco_tarifas.json');
const ASEGURADOS_FILE = path.join(DATA_DIR, 'tarifario_cenco_asegurados.json');
const SALAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_salas.json'); // { grupoPoligono: sala }
const NOMBRES_FILE    = path.join(DATA_DIR, 'tarifario_cenco_nombres.json'); // { nombreNorm: nombreCanonico }

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

// Actualiza (no reemplaza) el set de tarifas: una tarifa que ya existía para
// esa Sala+Destino conserva su ID y su vigencia configurada a mano — solo se
// actualizan los montos. Una combinación nueva recibe un ID nuevo. Los
// Asegurados sí se reemplazan completos (no tienen vigencia ni edición manual).
function importarTarifas(rows) {
  const existentes = new Map(getTarifas().map(t => [`${t.sala}|||${t.destinoNorm}`, t]));
  const porDestino = new Map(); // "sala|||destinoNorm" -> registro
  const porAsegurado = new Map(); // sala -> registro
  const errores = [];
  let siguienteNumero = Math.max(0, ...[...existentes.values()].map(t => numeroDeId(t.id))) + 1;

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
    let reg = porDestino.get(key);
    if (!reg) {
      const previo = existentes.get(key);
      reg = previo
        ? { ...previo, destino } // conserva id + vigencia + montos previos, refresca el texto del destino
        : {
            id: generarIdTarifa(siguienteNumero++), sala, destino, destinoNorm: normalizar(destino),
            lunSab: null, domFestivo: null, vigenciaInicio: null, vigenciaFin: null,
          };
      porDestino.set(key, reg);
    }
    if (esDomFestivo) reg.domFestivo = monto; else reg.lunSab = monto;
  });

  const tarifas = [...porDestino.values()];
  const asegurados = [...porAsegurado.values()];
  writeJson(TARIFAS_FILE, tarifas);
  writeJson(ASEGURADOS_FILE, asegurados);

  reconciliarNombres();

  return { zonasConTarifa: tarifas.length, salasConAsegurado: asegurados.length, filasLeidas: rows.length, errores };
}

function actualizarTarifa(id, { lunSab, domFestivo, vigenciaInicio, vigenciaFin }) {
  const tarifas = getTarifas();
  const idx = tarifas.findIndex(t => t.id === id);
  if (idx < 0) return null;
  if (lunSab !== undefined) tarifas[idx].lunSab = lunSab === null ? null : Number(lunSab);
  if (domFestivo !== undefined) tarifas[idx].domFestivo = domFestivo === null ? null : Number(domFestivo);
  if (vigenciaInicio !== undefined) tarifas[idx].vigenciaInicio = vigenciaInicio || null;
  if (vigenciaFin !== undefined) tarifas[idx].vigenciaFin = vigenciaFin || null; // vacío = indeterminado
  writeJson(TARIFAS_FILE, tarifas);
  return tarifas[idx];
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

  const tarifaExistente = getTarifas().find(t => t.sala === sala && t.destinoNorm === zona.nombreNorm);
  const vigente = tarifaExistente
    && (!tarifaExistente.vigenciaInicio || tarifaExistente.vigenciaInicio <= fechaConsulta)
    && (!tarifaExistente.vigenciaFin || tarifaExistente.vigenciaFin >= fechaConsulta);

  let motivo = null;
  if (!tarifaExistente) motivo = 'ZONA_SIN_TARIFA_CONFIGURADA';
  else if (!vigente) motivo = 'TARIFA_FUERA_DE_VIGENCIA';

  return {
    ok: true, sala, zona: zona.nombre, zonaId: zona.id, tarifaId: tarifaExistente?.id || null,
    dentroDePoligono: true, esDomFestivo: domFestivo,
    monto: vigente ? (domFestivo ? tarifaExistente.domFestivo : tarifaExistente.lunSab) : null,
    motivo,
  };
}

module.exports = {
  parseWKT, puntoEnPoligono, normalizar,
  getMapaSalas, setSalaDeGrupo,
  getZonas, importarPoligonos,
  getTarifas, getAsegurados, importarTarifas, actualizarTarifa,
  resolverTarifa,
  getNombresCanonicos, reconciliarNombres,
};
