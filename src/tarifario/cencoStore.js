const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

const ZONAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_zonas.json');
const TARIFAS_FILE    = path.join(DATA_DIR, 'tarifario_cenco_tarifas.json');
const ASEGURADOS_FILE = path.join(DATA_DIR, 'tarifario_cenco_asegurados.json');
const SALAS_FILE      = path.join(DATA_DIR, 'tarifario_cenco_salas.json'); // { grupoPoligono: sala }

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
// salas ya configurado a mano.
function importarPoligonos(rows) {
  const mapaSalas = getMapaSalas();
  const salasConocidas = [...new Set(getTarifas().map(t => t.sala))];
  const zonas = [];
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

    const sala = mapaSalas[grupo] || inferirSala(grupo, salasConocidas) || null;
    zonas.push({
      id: crypto.randomUUID(),
      grupo, sala, nombre, nombreNorm: normalizar(nombre),
      rings, observacion: row['Observación'] || '',
    });
  });

  writeJson(ZONAS_FILE, zonas);
  // Registra en el mapa cualquier grupo nuevo que se haya podido inferir,
  // para que quede editable desde el panel aunque no se haya tocado a mano.
  const mapaActualizado = { ...mapaSalas };
  for (const z of zonas) if (z.sala && !mapaActualizado[z.grupo]) mapaActualizado[z.grupo] = z.sala;
  writeJson(SALAS_FILE, mapaActualizado);

  return {
    creadas: zonas.length,
    filasLeidas: rows.length,
    errores,
    grupos: [...new Set(zonas.map(z => z.grupo))],
  };
}

// ─── Tarifas por zona + Asegurados por sala ────────────────────────────────
const DIA_ASEGURADO = 'Asegurado';
function esDiaDomingoFestivo(dias) {
  return /domingo/i.test(String(dias || ''));
}

function getTarifas() { return readJson(TARIFAS_FILE, []); }
function getAsegurados() { return readJson(ASEGURADOS_FILE, []); }

// Reemplaza el set completo de tarifas y de asegurados por sala. Cada
// Sala+Destino trae normalmente 2 filas (Lunes a Sábado / Domingo y
// festivos) que se consolidan en un solo registro con ambos montos.
function importarTarifas(rows) {
  const porDestino = new Map(); // "sala|||destinoNorm" -> registro
  const porAsegurado = new Map(); // sala -> registro
  const errores = [];

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
    const reg = porDestino.get(key) || {
      id: crypto.randomUUID(), sala, destino, destinoNorm: normalizar(destino),
      lunSab: null, domFestivo: null,
    };
    if (esDomFestivo) reg.domFestivo = monto; else reg.lunSab = monto;
    porDestino.set(key, reg);
  });

  const tarifas = [...porDestino.values()];
  const asegurados = [...porAsegurado.values()];
  writeJson(TARIFAS_FILE, tarifas);
  writeJson(ASEGURADOS_FILE, asegurados);

  return { zonasConTarifa: tarifas.length, salasConAsegurado: asegurados.length, filasLeidas: rows.length, errores };
}

function actualizarTarifa(id, { lunSab, domFestivo }) {
  const tarifas = getTarifas();
  const idx = tarifas.findIndex(t => t.id === id);
  if (idx < 0) return null;
  if (lunSab !== undefined) tarifas[idx].lunSab = lunSab === null ? null : Number(lunSab);
  if (domFestivo !== undefined) tarifas[idx].domFestivo = domFestivo === null ? null : Number(domFestivo);
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

  const zonas = getZonas().filter(z => z.sala === sala);
  const zona = zonas.find(z => puntoEnPoligono(lng, lat, z.rings));

  const domFestivo = esDomFestivo !== undefined
    ? !!esDomFestivo
    : new Date((fecha || new Date().toISOString().slice(0, 10)) + 'T12:00:00').getDay() === 0;

  if (!zona) {
    const asegurado = getAsegurados().find(a => a.sala === sala);
    return {
      ok: true, sala, zona: null, dentroDePoligono: false, esDomFestivo: domFestivo,
      monto: null,
      asegurado: asegurado ? (domFestivo ? asegurado.domFestivo : asegurado.lunSab) : null,
      motivo: 'FUERA_DE_TODOS_LOS_POLIGONOS',
    };
  }

  const tarifa = getTarifas().find(t => t.sala === sala && t.destinoNorm === zona.nombreNorm);
  return {
    ok: true, sala, zona: zona.nombre, dentroDePoligono: true, esDomFestivo: domFestivo,
    monto: tarifa ? (domFestivo ? tarifa.domFestivo : tarifa.lunSab) : null,
    motivo: tarifa ? null : 'ZONA_SIN_TARIFA_CONFIGURADA',
  };
}

module.exports = {
  parseWKT, puntoEnPoligono, normalizar,
  getMapaSalas, setSalaDeGrupo,
  getZonas, importarPoligonos,
  getTarifas, getAsegurados, importarTarifas, actualizarTarifa,
  resolverTarifa,
};
