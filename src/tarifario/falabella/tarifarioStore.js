const fs = require('fs');
const path = require('path');
const { toDateMs, isoDeMs } = require('./tarifasFalabella');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../../data');
const FILE = path.join(DATA_DIR, 'tarifario_falabella.json');

// Una fila por línea del tarifario: mismos campos que la pestaña "Pago Falabella".
// Fechas como 'yyyy-mm-dd' (o null = sin límite).
const CAMPOS_TEXTO = ['servicio', 'geo', 'tipo', 'ruta', 'nds', 'puntos', 'tipoAutoAGP', 'obs'];
const CAMPOS_NUM = ['tarifa', 'variable', 'postura', 'multa'];

let cache = null;
function leer() {
  if (cache) return cache;
  cache = { tarifas: [], importadoEn: null };
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* archivo dañado: parte vacío */ }
  return cache;
}
function guardar(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  cache = data;
}

const hayTarifarioPropio = () => leer().tarifas.length > 0;
const getTarifas = () => leer().tarifas;
const getInfo = () => ({ total: leer().tarifas.length, importadoEn: leer().importadoEn });

function limpiar(d) {
  const t = { cliente: 'Falabella' };
  for (const c of CAMPOS_TEXTO) t[c] = d[c] === null || d[c] === undefined ? '' : String(d[c]).trim();
  for (const c of CAMPOS_NUM) {
    const v = d[c];
    if (v === '' || v === null || v === undefined) { t[c] = null; continue; }
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$\s.]/g, '').replace(',', '.'));
    if (Number.isNaN(n)) throw new Error(`"${c}" no es un número válido`);
    t[c] = n;
  }
  for (const c of ['fechaInicio', 'fechaFin']) {
    if (!d[c]) { t[c] = null; continue; }
    const ms = toDateMs(d[c]);
    if (ms === null) throw new Error(`Fecha no válida en "${c}"`);
    t[c] = isoDeMs(ms);
  }
  if (t.fechaInicio && t.fechaFin && t.fechaInicio > t.fechaFin) throw new Error('La vigencia termina antes de empezar');
  if (!t.servicio && !t.geo) throw new Error('Indica al menos el servicio o el Geo/CT');
  return t;
}

// Filas del tarifario en el formato que espera el motor (fechas en ms).
function paraMotor() {
  return getTarifas().map((t) => ({
    ...t, fechaInicio: t.fechaInicio ? toDateMs(t.fechaInicio) : null, fechaFin: t.fechaFin ? toDateMs(t.fechaFin) : null,
  }));
}

// Reemplaza todo el tarifario con las filas ya parseadas de la hoja (motor: fechas en ms).
function reemplazarDesdeFilasMotor(filasMotor) {
  const tarifas = filasMotor.map((t, i) => ({
    id: 'FA-' + String(i + 1).padStart(4, '0'),
    ...Object.fromEntries([...CAMPOS_TEXTO, ...CAMPOS_NUM].map((c) => [c, t[c] ?? (CAMPOS_NUM.includes(c) ? null : '')])),
    cliente: 'Falabella',
    fechaInicio: t.fechaInicio === null ? null : isoDeMs(t.fechaInicio),
    fechaFin: t.fechaFin === null ? null : isoDeMs(t.fechaFin),
  }));
  guardar({ tarifas, importadoEn: new Date().toISOString() });
  return tarifas.length;
}

function siguienteId() {
  const max = getTarifas().reduce((m, t) => Math.max(m, parseInt(String(t.id).replace(/\D/g, ''), 10) || 0), 0);
  return 'FA-' + String(max + 1).padStart(4, '0');
}

function crear(d) {
  const t = { id: siguienteId(), ...limpiar(d) };
  const data = leer();
  guardar({ ...data, tarifas: [...data.tarifas, t] });
  return t;
}
function actualizar(id, d) {
  const data = leer();
  const i = data.tarifas.findIndex((t) => t.id === id);
  if (i === -1) return null;
  const t = { id, ...limpiar({ ...data.tarifas[i], ...d }) };
  const tarifas = data.tarifas.slice(); tarifas[i] = t;
  guardar({ ...data, tarifas });
  return t;
}
function eliminar(id) {
  const data = leer();
  if (!data.tarifas.some((t) => t.id === id)) return false;
  guardar({ ...data, tarifas: data.tarifas.filter((t) => t.id !== id) });
  return true;
}

module.exports = { hayTarifarioPropio, getTarifas, getInfo, paraMotor, reemplazarDesdeFilasMotor, crear, actualizar, eliminar };
