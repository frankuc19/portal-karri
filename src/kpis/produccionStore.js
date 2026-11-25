// Orquesta la producción (EDP): descarga el xlsx desde Drive, lo parsea en un
// worker y cachea el AGREGADO por operador en disco. El dashboard lee el
// agregado cacheado (rápido); la descarga/parseo corre en segundo plano cada
// N horas y bajo demanda. Mismo patrón que onboarding/altasSync.
const fs   = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { descargarEdp } = require('./driveEdp');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '../../data');
const CACHE_FILE  = path.join(DATA_DIR, 'kpis_produccion.json');
const WORKER_PATH = path.join(__dirname, 'edpWorker.js');

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 h
const CHECK_MS            = 30 * 60 * 1000;       // revisa cada 30 min si toca

let _cache = undefined;      // agregado en memoria (undefined = no leído aún)
let _refrescando = false;    // candado anti-concurrencia

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function leerCache() {
  if (_cache !== undefined) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { _cache = null; }
  return _cache;
}

function guardarCache(data) {
  ensureDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  _cache = data;
}

// Parsea el buffer del xlsx en un worker; resuelve con el agregado.
function parsearEnWorker(buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, { workerData: { buffer } });
    worker.once('message', (msg) => {
      settled = true; worker.terminate();
      if (!msg || !msg.ok) return reject(new Error(msg && msg.__error ? msg.__error : 'Error parseando el EDP'));
      resolve(msg);
    });
    worker.once('error', (err) => { settled = true; reject(err); });
    worker.once('exit', (code) => { if (!settled) reject(new Error(`Worker EDP terminó sin resultado (código ${code})`)); });
  });
}

/**
 * Descarga + parsea el EDP y actualiza el caché. Devuelve el agregado nuevo.
 * Si ya hay un refresco en curso, espera a que termine en vez de duplicar.
 */
async function refrescar() {
  if (_refrescando) {
    // espera activa corta hasta que el otro refresco termine
    while (_refrescando) await new Promise(r => setTimeout(r, 300));
    return leerCache();
  }
  _refrescando = true;
  try {
    const { archivo, buffer } = await descargarEdp();
    const agg = await parsearEnWorker(buffer);
    const data = {
      ok: true,
      formato: 2,                     // v2: detalle pre-agregado (dims + grano) para filtros
      actualizadoAt: new Date().toISOString(),
      fuente: { id: archivo.id, nombre: archivo.name, modifiedTime: archivo.modifiedTime, bytes: Number(archivo.size) || null },
      hoja: agg.sheetName,
      filas: agg.filas,
      rango: agg.rango,
      clientes: agg.clientesStats,
      dims: agg.dims,
      grano: agg.grano,
    };
    guardarCache(data);
    return data;
  } finally {
    _refrescando = false;
  }
}

// Agregado actual (de memoria/disco). No descarga.
function getProduccion() { return leerCache(); }

// Estado liviano para la UI (sin dims/grano, que son grandes).
function getEstado() {
  const c = leerCache();
  if (!c) return { ok: false, actualizadoAt: null, mensaje: 'Aún no se ha cargado producción.' };
  const { dims, grano, operadores, ...resto } = c;
  const nOps = dims && Array.isArray(dims.operadores) ? dims.operadores.length
    : (Array.isArray(operadores) ? operadores.length : 0);
  return { ...resto, operadores: nOps };
}

function estaRefrescando() { return _refrescando; }

// Programa el refresco automático, resistente a reinicios (como altasSync).
function scheduleRefresh() {
  const tocaRefrescar = () => {
    const c = leerCache();
    const elapsed = c && c.actualizadoAt ? Date.now() - new Date(c.actualizadoAt).getTime() : Infinity;
    if (elapsed < REFRESH_INTERVAL_MS) return;
    refrescar().catch(e => console.error('[KPIs] Error en refresco programado de producción:', e.message));
  };
  tocaRefrescar();                 // por si el plazo venció mientras estaba caído
  setInterval(tocaRefrescar, CHECK_MS);
}

module.exports = { refrescar, getProduccion, getEstado, estaRefrescando, scheduleRefresh };
