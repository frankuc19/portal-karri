const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const altasStore = require('../onboarding/altasStore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

const TIENDAS_FILE  = path.join(DATA_DIR, 'turnos_tiendas.json');
const SLOTS_FILE     = path.join(DATA_DIR, 'turnos_slots.json');
const ASIG_FILE       = path.join(DATA_DIR, 'turnos_asignaciones.json');
const KARRIERS_FILE  = path.join(DATA_DIR, 'turnos_karriers.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'turnos_settings.json');
const SEED_MARKER_FILE = path.join(DATA_DIR, 'turnos_seed_v1.json');
const ASISTENCIA_FILE   = path.join(DATA_DIR, 'turnos_asistencia.json');
const OBSERVACIONES_FILE = path.join(DATA_DIR, 'turnos_observaciones.json');

const SHIFT_TYPES = {
  AM:   { code: 'AM',   name: 'Mañana',   startTime: '08:00', endTime: '14:00' },
  PM:   { code: 'PM',   name: 'Tarde',    startTime: '14:00', endTime: '20:00' },
  FULL: { code: 'FULL', name: 'Jornada completa', startTime: '08:00', endTime: '20:00' },
  CAPACITACION: { code: 'CAPACITACION', name: 'Capacitación', startTime: '10:30', endTime: '11:30' },
};

// Tipos que participan en la planificación de cupos (Picker/Shopper/Driver) —
// Capacitación queda afuera a propósito: no tiene cupos limitados y no debe
// sumar ni afectar la cobertura/planificación de AM/PM/FULL.
const TIPOS_PLANIFICABLES = ['AM', 'PM', 'FULL'];

// Cupos y tomados se segmentan por rol operativo — el rol de cada Karrier se
// detecta automáticamente a partir del campo "Cliente" de su ficha en Altas
// Onboarding (p.ej. "Walmart Picker", "SMU Picker Rancagua", "Drivers Tottus").
const ROLES = ['Picker', 'Shopper', 'Driver'];

// Objeto de cupos "vacío" segmentado por rol — base para migrar formatos
// viejos (un solo número) y para completar roles faltantes.
function capacidadVacia() {
  return { Picker: 0, Shopper: 0, Driver: 0 };
}

// Tolera el formato viejo (capacity: 30, un solo número) migrándolo a un
// reparto parejo entre los 3 roles, y completa roles que falten en objetos
// ya segmentados. Nunca modifica el original.
function normalizarCapacidadRol(valor) {
  if (typeof valor === 'number') {
    const base = Math.floor(valor / ROLES.length);
    const resto = valor - base * ROLES.length;
    const obj = capacidadVacia();
    ROLES.forEach((r, i) => { obj[r] = base + (i < resto ? 1 : 0); });
    return obj;
  }
  const obj = capacidadVacia();
  ROLES.forEach(r => { obj[r] = Number(valor?.[r]) || 0; });
  return obj;
}

// Normaliza el objeto de capacidad de una tienda/turno completo: { AM, PM, FULL }
function normalizarCapacidadTurnos(capacity) {
  const out = {};
  for (const tipo of TIPOS_PLANIFICABLES) out[tipo] = normalizarCapacidadRol(capacity?.[tipo]);
  return out;
}

function sumaCapacidad(capacityPorRol) {
  return ROLES.reduce((acc, r) => acc + (Number(capacityPorRol?.[r]) || 0), 0);
}

// Detecta Picker/Shopper/Driver a partir del texto libre de "Cliente" en
// Altas Onboarding — tolera mayúsculas, plural ("Drivers") y texto extra
// alrededor (p.ej. "SMU Picker Rancagua", "Walmart Driver").
function normalizarRolPorCliente(cliente) {
  const c = String(cliente || '').toLowerCase();
  if (c.includes('picker'))  return 'Picker';
  if (c.includes('shopper')) return 'Shopper';
  if (c.includes('driver'))  return 'Driver';
  return null;
}

// Determina el rol operativo de un Karrier a partir de su ficha en Altas
// Onboarding (por RUT). Devuelve null si no está en Altas o si su Cliente no
// menciona ninguno de los 3 roles.
function determinarRolKarrier(rut) {
  const rutKey = String(rut || '').toUpperCase().replace(/[^0-9K]/g, '');
  const alta = altasStore.getAltaByRutKey(rutKey);
  if (!alta) return { rol: null, cliente: null };
  return { rol: normalizarRolPorCliente(alta.cliente), cliente: alta.cliente || null };
}

const DEFAULT_SETTINGS = {
  weekStartsMonday:        true,
  allowAmPmSameDay:        true,
  allowCancellation:       true,
  minimumCoverageWarning:  80,
  minimumCoverageTarget:   95,
};

// Tiendas reales (código, nombre, comuna) — se reconcilian UNA SOLA VEZ (la
// primera vez que corre esta versión del código): si el código no existe
// todavía en turnos_tiendas.json se agrega, sin tocar ni duplicar tiendas que
// el usuario ya haya creado o editado. Después de esa primera vez queda
// marcado como aplicado (turnos_seed_v1.json) y nunca se vuelve a repetir —
// si el admin borra una de estas tiendas más adelante, se queda borrada.
const SEED_TIENDAS = [
  { code: '35',  name: 'Walmart Rancagua',        commune: 'Rancagua' },
  { code: '54',  name: 'LIDER Vicuña Mackenna',   commune: 'La Florida' },
  { code: '79',  name: 'Walmart Talca',           commune: 'Talca' },
  { code: '127', name: 'Walmart Linares',         commune: 'Linares' },
  { code: '518', name: 'Walmart Valparaiso',      commune: 'Valparaíso' },
  { code: '612', name: 'Walmart Chillan',         commune: 'Chillán' },
  { code: '632', name: 'Walmart Viña Centro',     commune: 'Viña del Mar' },
];

function tiendaDesdeSeed(seed) {
  return {
    id: crypto.randomUUID(),
    name: seed.name,
    code: seed.code,
    address: '',
    commune: seed.commune,
    region: '',
    active: true,
    capacity: {
      AM:   { Picker: 10, Shopper: 10, Driver: 10 },
      PM:   { Picker: 10, Shopper: 10, Driver: 10 },
      FULL: { Picker: 7,  Shopper: 7,  Driver: 6  },
    },
    createdAt: new Date().toISOString(),
  };
}

function ensureSeedTiendas(list) {
  if (readJson(SEED_MARKER_FILE, null) !== null) return list; // ya se aplicó — no repetir

  const codigosExistentes = new Set(list.map(t => t.code));
  const faltantes = SEED_TIENDAS.filter(s => !codigosExistentes.has(s.code)).map(tiendaDesdeSeed);
  const actualizada = faltantes.length ? [...list, ...faltantes] : list;
  if (faltantes.length) writeJson(TIENDAS_FILE, actualizada);
  writeJson(SEED_MARKER_FILE, { appliedAt: new Date().toISOString() });
  return actualizada;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Cache en memoria de cada archivo — evita releer y re-parsear el mismo JSON
// desde disco en cada llamada. Antes, calcular los cupos de un turno releía
// el archivo completo de asignaciones una vez por rol (3x por turno), y eso
// se multiplicaba por cada turno de cada tienda al listar disponibilidad —
// de ahí la demora al cargar tiendas justo después de ingresar el RUT.
// writeJson mantiene el caché al día, así que nunca queda desactualizado.
const _jsonCache = new Map();

function readJson(file, fallback) {
  if (_jsonCache.has(file)) return _jsonCache.get(file);
  ensureDir();
  let data = fallback;
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { data = fallback; }
  }
  _jsonCache.set(file, data);
  return data;
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  _jsonCache.set(file, data);
}

// ─── Tiendas ──────────────────────────────────────────────────────────────────
function getTiendas() {
  const list = readJson(TIENDAS_FILE, null);
  const conSeed = list === null ? (() => {
    const seeded = SEED_TIENDAS.map(tiendaDesdeSeed);
    writeJson(TIENDAS_FILE, seeded);
    writeJson(SEED_MARKER_FILE, { appliedAt: new Date().toISOString() });
    return seeded;
  })() : ensureSeedTiendas(list);
  // Tolera tiendas guardadas con el formato viejo de cupos (un solo número
  // por turno) migrándolas en memoria a cupos segmentados por rol.
  return conSeed.map(t => ({ ...t, capacity: normalizarCapacidadTurnos(t.capacity) }));
}
function getTiendaById(id) { return getTiendas().find(t => t.id === id) || null; }
function saveTienda(tienda) {
  const normalizada = { ...tienda, capacity: normalizarCapacidadTurnos(tienda.capacity) };
  const list = getTiendas();
  const idx = list.findIndex(t => t.id === normalizada.id);
  if (idx >= 0) list[idx] = normalizada; else list.push(normalizada);
  writeJson(TIENDAS_FILE, list);
  return normalizada;
}
// Elimina la tienda y sus turnos planificados. Se niega si hay Karriers con
// una asignación ACTIVA en esa tienda, para no borrarles el turno sin avisar
// — hay que cancelarlos primero (o desactivar la tienda en vez de eliminarla).
function deleteTienda(id) {
  const slotsTienda = getSlots().filter(s => s.storeId === id);
  const slotIds = new Set(slotsTienda.map(s => s.id));
  const tieneActivas = getAsignaciones().some(a => a.status === 'ACTIVE' && slotIds.has(a.slotId));
  if (tieneActivas) throw err('STORE_HAS_ACTIVE_ASSIGNMENTS');

  writeJson(TIENDAS_FILE, getTiendas().filter(t => t.id !== id));
  writeJson(SLOTS_FILE, getSlots().filter(s => s.storeId !== id));
  writeJson(ASIG_FILE, getAsignaciones().filter(a => !slotIds.has(a.slotId)));
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function getSettings() {
  const s = readJson(SETTINGS_FILE, null);
  if (s === null) { writeJson(SETTINGS_FILE, DEFAULT_SETTINGS); return DEFAULT_SETTINGS; }
  return { ...DEFAULT_SETTINGS, ...s };
}
function saveSettings(partial) {
  const merged = { ...getSettings(), ...partial };
  writeJson(SETTINGS_FILE, merged);
  return merged;
}

// ─── Karriers (registro de prestadores) ────────────────────────────────────────
function getKarriers() { return readJson(KARRIERS_FILE, []); }
function getKarrierByRut(rut) { return getKarriers().find(k => k.rut === rut) || null; }
function saveKarrier(karrier) {
  const list = getKarriers();
  const idx = list.findIndex(k => k.rut === karrier.rut);
  if (idx >= 0) list[idx] = karrier; else list.push(karrier);
  writeJson(KARRIERS_FILE, list);
  return karrier;
}
function deleteKarrier(rut) {
  writeJson(KARRIERS_FILE, getKarriers().filter(k => k.rut !== rut));
}
function ensureKarrier(rut, name, phone) {
  let k = getKarrierByRut(rut);
  if (!k) {
    k = { rut, name: name || rut, phone: phone || '', status: 'ACTIVE', createdAt: new Date().toISOString() };
    saveKarrier(k);
  }
  return k;
}

// ─── Slots (disponibilidad de turnos) ──────────────────────────────────────────
// El horario de Capacitación siempre se toma de SHIFT_TYPES (no de lo
// guardado en el slot al crearlo) para que un cambio de horario aplique
// también a los turnos de Capacitación ya creados, sin recrearlos uno a uno.
function getSlots() {
  return readJson(SLOTS_FILE, []).map(s => s.shiftType === 'CAPACITACION'
    ? { ...s, startTime: SHIFT_TYPES.CAPACITACION.startTime, endTime: SHIFT_TYPES.CAPACITACION.endTime }
    : s);
}
function getSlotById(id) { return getSlots().find(s => s.id === id) || null; }
function saveSlot(slot) {
  const list = getSlots();
  const idx = list.findIndex(s => s.id === slot.id);
  if (idx >= 0) list[idx] = slot; else list.push(slot);
  writeJson(SLOTS_FILE, list);
  return slot;
}
function deleteSlot(id) {
  writeJson(SLOTS_FILE, getSlots().filter(s => s.id !== id));
  writeJson(ASIG_FILE, getAsignaciones().filter(a => a.slotId !== id));
}

function createSlot({ storeId, shiftType, date, capacity }) {
  const tipo = SHIFT_TYPES[shiftType];
  if (!tipo) throw new Error('Tipo de turno inválido');
  const slot = {
    id: crypto.randomUUID(),
    storeId,
    shiftType,
    date, // YYYY-MM-DD
    startTime: tipo.startTime,
    endTime: tipo.endTime,
    capacity: normalizarCapacidadRol(capacity), // { Picker, Shopper, Driver }
    status: 'OPEN',
    createdAt: new Date().toISOString(),
  };
  return saveSlot(slot);
}

// Crea (o completa) los 7 días x 3 turnos de una tienda para la semana que contiene weekStartDate
const RANGO_MAX_DIAS = 120; // tope de seguridad para no crear miles de turnos por error

// Crea (o completa) AM/PM/FULL para cada día entre dateFrom y dateTo (ambos
// incluidos), usando los cupos por defecto de la tienda. Nunca duplica un
// turno que ya exista para esa fecha+tipo.
function generarRango(storeId, dateFrom, dateTo) {
  const tienda = getTiendaById(storeId);
  if (!tienda) throw new Error('Tienda no encontrada');
  if (!dateFrom || !dateTo) throw new Error('Faltan fechas');
  if (dateTo < dateFrom) throw new Error('La fecha "hasta" no puede ser anterior a "desde"');

  const inicio = new Date(dateFrom + 'T00:00:00');
  const fin = new Date(dateTo + 'T00:00:00');
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;
  if (dias > RANGO_MAX_DIAS) throw new Error(`El rango es muy largo (${dias} días). El máximo permitido es ${RANGO_MAX_DIAS} días.`);

  const existentes = getSlots().filter(s => s.storeId === storeId);
  const creados = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    for (const tipo of ['AM', 'PM', 'FULL']) {
      const ya = existentes.find(s => s.date === dateStr && s.shiftType === tipo);
      if (ya) continue;
      creados.push(createSlot({ storeId, shiftType: tipo, date: dateStr, capacity: tienda.capacity?.[tipo] ?? 0 }));
    }
  }
  return creados;
}

// Atajo: genera los 7 días de la semana que empieza en weekStartDate.
function generarSemana(storeId, weekStartDate) {
  const fin = new Date(weekStartDate + 'T00:00:00');
  fin.setDate(fin.getDate() + 6);
  return generarRango(storeId, weekStartDate, fin.toISOString().slice(0, 10));
}

// ─── Asignaciones (toma de turnos) ─────────────────────────────────────────────
function getAsignaciones() { return readJson(ASIG_FILE, []); }
function getAsignacionById(id) { return getAsignaciones().find(a => a.id === id) || null; }
function saveAsignacion(a) {
  const list = getAsignaciones();
  const idx = list.findIndex(x => x.id === a.id);
  if (idx >= 0) list[idx] = a; else list.push(a);
  writeJson(ASIG_FILE, list);
  return a;
}

function asignacionesActivasDeSlot(slotId, role) {
  return getAsignaciones().filter(a => a.slotId === slotId && a.status === 'ACTIVE' && (!role || a.role === role));
}

// Cupos disponibles para un rol específico dentro de un slot. Normaliza la
// capacidad primero por si el slot quedó guardado con el formato viejo
// (un solo número, sin segmentar por rol).
function cuposDisponibles(slot, role) {
  if (slot.shiftType === 'CAPACITACION') return Infinity; // sin límite de cupos
  const cap = normalizarCapacidadRol(slot.capacity)[role] || 0;
  return Math.max(0, cap - asignacionesActivasDeSlot(slot.id, role).length);
}

// Serializa las tomas de turno para evitar sobreasignación por condiciones de carrera
let colaEscritura = Promise.resolve();
function conBloqueo(fn) {
  const resultado = colaEscritura.then(fn, fn);
  colaEscritura = resultado.catch(() => {});
  return resultado;
}

const ERRORES = {
  SHIFT_FULL:            'Este turno ya no tiene cupos disponibles.',
  SHIFT_NOT_FOUND:       'El turno no existe.',
  SHIFT_CLOSED:          'Este turno no está disponible.',
  SHIFT_ALREADY_TAKEN:   'Ya tienes este turno tomado.',
  INVALID_STORE:         'Tienda inválida.',
  USER_INACTIVE:         'Tu cuenta de Karrier está inactiva. Contacta a operaciones.',
  INVALID_DATE:          'No puedes tomar turnos de fechas pasadas.',
  CONFLICT_AM_FULL:      'Ya tienes un turno AM ese día: no puedes tomar también FULL.',
  CONFLICT_PM_FULL:      'Ya tienes un turno PM ese día: no puedes tomar también FULL.',
  CONFLICT_FULL:         'Ya tienes un turno FULL ese día: no puedes tomar otro turno.',
  CONFLICT_AM_PM:        'No está permitido tomar AM y PM el mismo día.',
  ASSIGNMENT_NOT_FOUND:  'La asignación no existe.',
  NOT_YOUR_SHIFT:        'Este turno no te pertenece.',
  ALREADY_CANCELLED:     'Este turno ya estaba cancelado.',
  CANCELLATION_DISABLED: 'Las cancelaciones están deshabilitadas. Contacta a operaciones para cancelar tu turno.',
  EMPTY_OBSERVATION:     'La observación no puede estar vacía.',
  STORE_HAS_ACTIVE_ASSIGNMENTS: 'Esta tienda tiene Karriers con turnos activos. Cancela esas asignaciones o desactiva la tienda en vez de eliminarla.',
  ROLE_NOT_DETERMINED:  'No pudimos determinar tu rol (Picker/Shopper/Driver) a partir de tu ficha en Altas Onboarding. Contacta a operaciones.',
};

function err(code) {
  const e = new Error(ERRORES[code] || code);
  e.code = code;
  return e;
}

// Valida las reglas de negocio y crea la asignación. `excludeAssignmentId` se
// usa al reasignar: ignora la asignación que se está moviendo al revisar
// conflictos del propio Karrier ese día (si no, chocaría consigo misma).
function _validarYCrearAsignacion(slotId, rut, excludeAssignmentId) {
  const karrier = getKarrierByRut(rut);
  if (!karrier) throw err('INVALID_STORE'); // no debería pasar: el caller registra antes
  if (karrier.status !== 'ACTIVE') throw err('USER_INACTIVE');

  const { rol, cliente } = determinarRolKarrier(rut);
  if (!rol) throw err('ROLE_NOT_DETERMINED');

  const slot = getSlotById(slotId);
  if (!slot) throw err('SHIFT_NOT_FOUND');
  if (slot.status !== 'OPEN') throw err('SHIFT_CLOSED');
  if (slot.date < new Date().toISOString().slice(0, 10)) throw err('INVALID_DATE');
  if (cuposDisponibles(slot, rol) <= 0) throw err('SHIFT_FULL');

  const misAsignaciones = getAsignaciones()
    .filter(a => a.karrierRut === rut && a.status === 'ACTIVE' && a.id !== excludeAssignmentId);
  if (misAsignaciones.some(a => a.slotId === slotId)) throw err('SHIFT_ALREADY_TAKEN');

  const misSlotsHoy = misAsignaciones
    .map(a => getSlotById(a.slotId))
    .filter(s => s && s.date === slot.date);
  const tiposHoy = new Set(misSlotsHoy.map(s => s.shiftType));

  // Capacitación es independiente de las reglas de exclusividad de AM/PM/FULL:
  // se puede tomar el mismo día sin generar conflicto ni ser bloqueada por ellas.
  const settings = getSettings();
  if (slot.shiftType !== 'CAPACITACION') {
    if (slot.shiftType === 'FULL' && (tiposHoy.has('AM') || tiposHoy.has('PM') || tiposHoy.has('FULL'))) {
      if (tiposHoy.has('AM')) throw err('CONFLICT_AM_FULL');
      if (tiposHoy.has('PM')) throw err('CONFLICT_PM_FULL');
      throw err('CONFLICT_FULL');
    }
    if (tiposHoy.has('FULL')) throw err('CONFLICT_FULL');
    if (slot.shiftType === 'AM' && tiposHoy.has('PM') && !settings.allowAmPmSameDay) throw err('CONFLICT_AM_PM');
    if (slot.shiftType === 'PM' && tiposHoy.has('AM') && !settings.allowAmPmSameDay) throw err('CONFLICT_AM_PM');
  }

  const asignacion = {
    id: crypto.randomUUID(),
    slotId,
    karrierRut: rut,
    karrierName: karrier.name,
    role: rol, // Picker/Shopper/Driver, determinado desde Altas Onboarding
    cliente: cliente || null, // snapshot del Cliente al momento de tomar el turno
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    cancellationReason: null,
  };
  saveAsignacion(asignacion);
  return asignacion;
}

function tomarTurno(slotId, rut) {
  return conBloqueo(async () => _validarYCrearAsignacion(slotId, rut));
}

function cancelarTurno(assignmentId, rut, { isAdmin = false, reason = '' } = {}) {
  return conBloqueo(async () => {
    const asignacion = getAsignacionById(assignmentId);
    if (!asignacion) throw err('ASSIGNMENT_NOT_FOUND');
    if (!isAdmin && asignacion.karrierRut !== rut) throw err('NOT_YOUR_SHIFT');
    // La restricción de "permitir cancelación" es para que el Karrier cancele
    // su propio turno; operaciones (isAdmin) siempre puede, desde Asignaciones.
    if (!isAdmin && !getSettings().allowCancellation) throw err('CANCELLATION_DISABLED');
    if (asignacion.status === 'CANCELLED') throw err('ALREADY_CANCELLED');
    asignacion.status = 'CANCELLED';
    asignacion.cancelledAt = new Date().toISOString();
    asignacion.cancellationReason = reason || null;
    saveAsignacion(asignacion);
    return asignacion;
  });
}

// Mueve a un Karrier de su turno actual a otro turno (mismo u otro día/tienda),
// validando las mismas reglas de negocio que tomarTurno. Uso administrativo.
function reasignarTurno(assignmentId, newSlotId) {
  return conBloqueo(async () => {
    const actual = getAsignacionById(assignmentId);
    if (!actual) throw err('ASSIGNMENT_NOT_FOUND');
    if (actual.status !== 'ACTIVE') throw err('ALREADY_CANCELLED');
    if (actual.slotId === newSlotId) return actual;

    const nueva = _validarYCrearAsignacion(newSlotId, actual.karrierRut, actual.id);

    actual.status = 'CANCELLED';
    actual.cancelledAt = new Date().toISOString();
    actual.cancellationReason = 'Reasignado por operaciones';
    saveAsignacion(actual);

    return nueva;
  });
}

// ─── Consultas agregadas ────────────────────────────────────────────────────────
// Agrega el desglose por rol (porRol) y también totales agregados (capacity/
// taken/available/coverage sumados entre los 3 roles) para no romper las
// pantallas que solo necesitan el número global (Dashboard, Asignaciones...).
function slotConInfo(slot) {
  // Capacitación no tiene cupos: siempre disponible, no participa en la
  // cobertura/planificación de AM/PM/FULL.
  if (slot.shiftType === 'CAPACITACION') {
    const taken = asignacionesActivasDeSlot(slot.id).length;
    return {
      ...slot,
      capacity: null, capacityPorRol: null, porRol: null,
      taken, available: null, coverage: null, sinCupo: true,
    };
  }
  const capacityPorRol = normalizarCapacidadRol(slot.capacity);
  const porRol = {};
  let taken = 0, capacityTotal = 0;
  for (const rol of ROLES) {
    const tomadosRol = asignacionesActivasDeSlot(slot.id, rol).length;
    const capRol = capacityPorRol[rol];
    porRol[rol] = { capacity: capRol, taken: tomadosRol, available: Math.max(0, capRol - tomadosRol) };
    taken += tomadosRol;
    capacityTotal += capRol;
  }
  return {
    ...slot,
    capacity: capacityTotal,      // agregado — mantiene compatibilidad con pantallas que ya sumaban un número
    capacityPorRol,
    porRol,
    taken,
    available: Math.max(0, capacityTotal - taken),
    coverage: capacityTotal > 0 ? Math.round((taken / capacityTotal) * 100) : 0,
  };
}

function disponibilidadTienda(storeId, weekStartDate) {
  const weekEnd = (() => {
    const d = new Date(weekStartDate + 'T00:00:00');
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  return getSlots()
    .filter(s => s.storeId === storeId && s.date >= weekStartDate && s.date <= weekEnd)
    .map(slotConInfo)
    .sort((a, b) => (a.date + a.shiftType).localeCompare(b.date + b.shiftType));
}

// Todos los turnos de una tienda desde hoy en adelante, sin acotar a una
// semana — lo usa la toma de turnos pública para mostrar disponibilidad
// completa (no solo la semana en curso).
function disponibilidadTiendaCompleta(storeId) {
  const hoy = new Date().toISOString().slice(0, 10);
  return getSlots()
    .filter(s => s.storeId === storeId && s.date >= hoy)
    .map(slotConInfo)
    .sort((a, b) => (a.date + a.shiftType).localeCompare(b.date + b.shiftType));
}

function misTurnos(rut) {
  const asigs = getAsignaciones().filter(a => a.karrierRut === rut);
  return asigs
    .map(a => {
      const slot = getSlotById(a.slotId);
      if (!slot) return null;
      const tienda = getTiendaById(slot.storeId);
      return { ...a, slot, tienda };
    })
    .filter(Boolean)
    .sort((a, b) => a.slot.date.localeCompare(b.slot.date));
}

// Lista asignaciones (tomas de turno) con datos de tienda/slot embebidos,
// para la pantalla administrativa de "Asignaciones".
function listAsignaciones({ storeId, weekStartDate, status, role, date } = {}) {
  const weekEnd = weekStartDate ? (() => {
    const d = new Date(weekStartDate + 'T00:00:00');
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  })() : null;

  return getAsignaciones()
    .map(a => {
      const slot = getSlotById(a.slotId);
      if (!slot) return null;
      const tienda = getTiendaById(slot.storeId);
      return { ...a, slot, tienda };
    })
    .filter(Boolean)
    .filter(a => !storeId || a.slot.storeId === storeId)
    .filter(a => !weekStartDate || (a.slot.date >= weekStartDate && a.slot.date <= weekEnd))
    .filter(a => !status || a.status === status)
    .filter(a => !role || a.role === role)
    .filter(a => !date || a.slot.date === date)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function coberturaTienda(storeId, weekStartDate) {
  return disponibilidadTienda(storeId, weekStartDate);
}

function coberturaGeneral(weekStartDate, storeIdFiltro) {
  const tiendas = getTiendas().filter(t => !storeIdFiltro || t.id === storeIdFiltro);
  const filas = [];
  for (const tienda of tiendas) {
    // Capacitación no tiene cupos y no debe sumar a la cobertura/planificación.
    const slots = disponibilidadTienda(tienda.id, weekStartDate).filter(s => s.shiftType !== 'CAPACITACION');
    for (const s of slots) filas.push({ ...s, storeName: tienda.name });
  }
  const totales = filas.reduce((acc, f) => {
    acc.requeridos += f.capacity;
    acc.tomados += f.taken;
    acc.disponibles += f.available;
    return acc;
  }, { requeridos: 0, tomados: 0, disponibles: 0 });
  const coberturaGlobal = totales.requeridos > 0 ? Math.round((totales.tomados / totales.requeridos) * 100) : 0;
  return { filas, totales: { ...totales, coberturaGlobal } };
}

function dashboardKpis(weekStartDate) {
  const karriersActivos = getKarriers().filter(k => k.status === 'ACTIVE').length;
  const asignacionesActivas = getAsignaciones().filter(a => a.status === 'ACTIVE').length;
  const { totales } = coberturaGeneral(weekStartDate);
  const tiendasActivas = getTiendas().filter(t => t.active).length;
  return {
    karriersActivos,
    turnosTomados: asignacionesActivas,
    cobertura: totales.coberturaGlobal,
    deficit: Math.max(0, totales.requeridos - totales.tomados),
    tiendasActivas,
  };
}

// ─── Asistencia ─────────────────────────────────────────────────────────────
// Un registro de asistencia por asignación (una asignación ya identifica
// unívocamente Karrier + tienda + fecha + turno, así que no hace falta más).
function getAsistencias() { return readJson(ASISTENCIA_FILE, []); }
function getAsistenciaByAssignment(assignmentId) {
  return getAsistencias().find(a => a.assignmentId === assignmentId) || null;
}
function horaActualChile() {
  return new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' });
}

function setAsistencia(assignmentId, asistio, hora) {
  if (!getAsignacionById(assignmentId)) throw err('ASSIGNMENT_NOT_FOUND');
  const list = getAsistencias();
  const idx = list.findIndex(a => a.assignmentId === assignmentId);
  const horaFinal = hora !== undefined ? (hora || null) : (asistio === null ? null : horaActualChile());
  const registro = { assignmentId, asistio, hora: horaFinal, updatedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = registro; else list.push(registro);
  writeJson(ASISTENCIA_FILE, list);
  return registro;
}

// Permite editar manualmente la hora de asistencia sin tocar el estado Sí/No.
function setAsistenciaHora(assignmentId, hora) {
  if (!getAsignacionById(assignmentId)) throw err('ASSIGNMENT_NOT_FOUND');
  const list = getAsistencias();
  const idx = list.findIndex(a => a.assignmentId === assignmentId);
  const anterior = idx >= 0 ? list[idx] : { assignmentId, asistio: null };
  const registro = { ...anterior, hora: hora || null, updatedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = registro; else list.push(registro);
  writeJson(ASISTENCIA_FILE, list);
  return registro;
}

// ─── Observaciones (bitácora) ───────────────────────────────────────────────
// Log de solo agregar: cada nota queda registrada con fecha, nunca se
// sobrescribe la anterior — así se arma la bitácora completa.
function getObservaciones() { return readJson(OBSERVACIONES_FILE, []); }
function observacionesDeAsignacion(assignmentId) {
  return getObservaciones()
    .filter(o => o.assignmentId === assignmentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function addObservacion(assignmentId, texto) {
  if (!getAsignacionById(assignmentId)) throw err('ASSIGNMENT_NOT_FOUND');
  if (!texto || !texto.trim()) throw err('EMPTY_OBSERVATION');
  const entry = { id: crypto.randomUUID(), assignmentId, texto: texto.trim(), createdAt: new Date().toISOString() };
  const list = getObservaciones();
  list.push(entry);
  writeJson(OBSERVACIONES_FILE, list);
  return entry;
}

// Lista de asistencia de un día (y opcionalmente una tienda): solo turnos
// ACTIVOS de esa fecha, con su estado de asistencia y su bitácora.
function listAsistenciaDia({ storeId, date }) {
  if (!date) throw err('INVALID_DATE');
  return getAsignaciones()
    .filter(a => a.status === 'ACTIVE')
    .map(a => {
      const slot = getSlotById(a.slotId);
      if (!slot || slot.date !== date) return null;
      if (storeId && slot.storeId !== storeId) return null;
      const tienda = getTiendaById(slot.storeId);
      const asistencia = getAsistenciaByAssignment(a.id);
      return {
        assignmentId: a.id,
        karrierRut: a.karrierRut,
        karrierName: a.karrierName,
        storeId: slot.storeId,
        storeName: tienda?.name || '—',
        date: slot.date,
        shiftType: slot.shiftType,
        startTime: slot.startTime,
        endTime: slot.endTime,
        asistio: asistencia ? asistencia.asistio : null,
        hora: asistencia ? (asistencia.hora || null) : null,
        observaciones: observacionesDeAsignacion(a.id),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.storeName + a.shiftType + a.karrierName).localeCompare(b.storeName + b.shiftType + b.karrierName));
}

// Bitácora completa para exportar: una fila por cada turno agendado (activo)
// dentro del rango, con su estado de asistencia, hora y observaciones —
// opcionalmente filtrada por tienda y/o rango de fechas. No se limita a los
// turnos que tengan alguna observación, para que la asistencia y la hora
// queden siempre reflejadas en el archivo.
function listBitacora({ storeId, dateFrom, dateTo } = {}) {
  return getAsignaciones()
    .filter(a => a.status === 'ACTIVE')
    .map(a => {
      const slot = getSlotById(a.slotId);
      if (!slot) return null;
      if (storeId && slot.storeId !== storeId) return null;
      if (dateFrom && slot.date < dateFrom) return null;
      if (dateTo && slot.date > dateTo) return null;
      const tienda = getTiendaById(slot.storeId);
      const asistencia = getAsistenciaByAssignment(a.id);
      const observaciones = observacionesDeAsignacion(a.id);
      return {
        assignmentId: a.id,
        karrierName: a.karrierName,
        karrierRut: a.karrierRut,
        storeName: tienda?.name || '—',
        date: slot.date,
        shiftType: slot.shiftType,
        asistio: asistencia ? asistencia.asistio : null,
        hora: asistencia ? (asistencia.hora || null) : null,
        texto: observaciones.map(o => o.texto).join(' | '),
        createdAt: asistencia?.updatedAt || a.createdAt,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date + a.storeName + a.karrierName).localeCompare(b.date + b.storeName + b.karrierName));
}

module.exports = {
  SHIFT_TYPES, ROLES,
  normalizarRolPorCliente, determinarRolKarrier, cuposDisponibles,
  getSettings, saveSettings,
  getTiendas, getTiendaById, saveTienda, deleteTienda,
  getKarriers, getKarrierByRut, saveKarrier, deleteKarrier, ensureKarrier,
  getSlots, getSlotById, saveSlot, deleteSlot, createSlot, generarSemana, generarRango,
  getAsignaciones, getAsignacionById, listAsignaciones,
  tomarTurno, cancelarTurno, reasignarTurno,
  disponibilidadTienda, disponibilidadTiendaCompleta, misTurnos, coberturaTienda, coberturaGeneral, dashboardKpis,
  slotConInfo,
  getAsistenciaByAssignment, setAsistencia, setAsistenciaHora,
  observacionesDeAsignacion, addObservacion,
  listAsistenciaDia, listBitacora,
  ERRORES,
};
