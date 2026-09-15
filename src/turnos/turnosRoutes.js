const { Router } = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const store = require('./turnosStore');
const altasStore = require('../onboarding/altasStore');

const uploadCupos = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const WHATSAPP_INSCRIPCION = 'https://wa.me/56941114635';
function limpiarRutTurnos(rut) {
  return String(rut || '').toUpperCase().replace(/[^0-9K]/g, '');
}

// ─── Router público (sin login del panel) — lo usan los Karriers desde su celular ──
const publicRouter = Router();

// Solo puede identificarse/agendar quien ya es Karrier O aparece en Altas
// Onboarding con ese RUT — si no, se le redirige a inscribirse por WhatsApp.
publicRouter.get('/karrier/:rut', (req, res) => {
  const rut = req.params.rut.trim();
  const k = store.getKarrierByRut(rut);
  let alta = null;
  if (!k) alta = altasStore.getAltaByRutKey(limpiarRutTurnos(rut));
  res.json({
    ok: true,
    karrier: k,
    elegible: !!k || !!alta,
    alta: alta ? { nombre: alta.nombre, celular: alta.celular } : null,
    whatsapp: WHATSAPP_INSCRIPCION,
  });
});

// Registro rápido / identificación del Karrier (crea el registro si no existe)
publicRouter.post('/karrier', (req, res) => {
  const { rut, name, phone } = req.body || {};
  if (!rut || !name) return res.status(400).json({ ok: false, error: 'RUT y nombre son requeridos' });
  const rutTrim = rut.trim();
  const existente = store.getKarrierByRut(rutTrim);
  if (existente && existente.status !== 'ACTIVE') {
    return res.status(403).json({ ok: false, error: 'Tu cuenta está inactiva. Contacta a operaciones.' });
  }
  if (!existente) {
    const alta = altasStore.getAltaByRutKey(limpiarRutTurnos(rutTrim));
    if (!alta) {
      return res.status(403).json({
        ok: false,
        code: 'NOT_IN_ALTAS',
        error: 'Tu RUT no está registrado en Altas Onboarding. Escríbenos por WhatsApp para inscribirte.',
        whatsapp: WHATSAPP_INSCRIPCION,
      });
    }
  }
  const karrier = store.ensureKarrier(rutTrim, name.trim(), (phone || '').trim());
  res.json({ ok: true, karrier });
});

// Solo el subconjunto de settings que necesita el flujo del Karrier —
// nunca exponer la configuración completa por el router público.
publicRouter.get('/settings', (_req, res) => {
  const s = store.getSettings();
  res.json({
    ok: true,
    settings: {
      allowAmPmSameDay: s.allowAmPmSameDay,
      allowCancellation: s.allowCancellation,
      minimumCoverageWarning: s.minimumCoverageWarning,
      minimumCoverageTarget: s.minimumCoverageTarget,
    },
  });
});

// Cupos disponibles de cada tienda a través de TODAS las fechas planificadas
// a futuro (no solo la semana en curso) — Capacitación no tiene cupos, así
// que no se suma a este total.
publicRouter.get('/tiendas', (_req, res) => {
  const tiendas = store.getTiendas().filter(t => t.active);
  const withCounts = tiendas.map(t => {
    const slots = store.disponibilidadTiendaCompleta(t.id).filter(s => s.shiftType !== 'CAPACITACION');
    const disponibles = slots.reduce((s, x) => s + x.available, 0);
    return { ...t, turnosDisponibles: disponibles };
  });
  res.json({ ok: true, tiendas: withCounts });
});

publicRouter.get('/disponibilidad', (req, res) => {
  const { storeId, weekStart, rut } = req.query;
  if (!storeId || !weekStart) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  const tienda = store.getTiendaById(storeId);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });

  let slots = store.disponibilidadTienda(storeId, weekStart);
  // Si conocemos el RUT, mostramos cupos/disponibilidad de SU rol específico
  // (Picker/Shopper/Driver) en vez del agregado — evita que alguien vea
  // "cupos disponibles" que en realidad son de otro rol y no puede tomar.
  if (rut) {
    const { rol } = store.determinarRolKarrier(rut);
    if (rol) {
      // Capacitación no tiene cupos por rol (porRol es null) — se deja tal cual.
      slots = slots.map(s => !s.porRol ? s : ({
        ...s,
        role: rol,
        capacity: s.porRol[rol].capacity,
        taken: s.porRol[rol].taken,
        available: s.porRol[rol].available,
        coverage: s.porRol[rol].capacity > 0 ? Math.round((s.porRol[rol].taken / s.porRol[rol].capacity) * 100) : 0,
      }));
    }
  }
  res.json({ ok: true, tienda, slots });
});

publicRouter.post('/tomar', async (req, res) => {
  const { slotId, rut } = req.body || {};
  if (!slotId || !rut) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const asignacion = await store.tomarTurno(slotId, rut.trim());
    res.json({ ok: true, asignacion });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

publicRouter.post('/cancelar', async (req, res) => {
  const { assignmentId, rut } = req.body || {};
  if (!assignmentId || !rut) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const asignacion = await store.cancelarTurno(assignmentId, rut.trim());
    res.json({ ok: true, asignacion });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

publicRouter.get('/mis-turnos', (req, res) => {
  const { rut } = req.query;
  if (!rut) return res.status(400).json({ ok: false, error: 'Falta RUT' });
  res.json({ ok: true, turnos: store.misTurnos(rut.trim()) });
});

// ─── Router administrativo (OPS/Admin, requiere sesión del panel) ─────────────────
const adminRouter = Router();

adminRouter.get('/settings', (_req, res) => res.json({ ok: true, settings: store.getSettings() }));
adminRouter.put('/settings', (req, res) => res.json({ ok: true, settings: store.saveSettings(req.body || {}) }));

adminRouter.get('/tiendas', (_req, res) => res.json({ ok: true, tiendas: store.getTiendas() }));
adminRouter.post('/tiendas', (req, res) => {
  const { name, code, address, commune, region, capacity } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'El nombre es requerido' });
  const tienda = {
    id: require('crypto').randomUUID(),
    name, code: code || '', address: address || '', commune: commune || '', region: region || '',
    active: true,
    capacity: capacity || {}, // store.saveTienda normaliza { AM/PM/FULL: {Picker,Shopper,Driver} }
    createdAt: new Date().toISOString(),
  };
  store.saveTienda(tienda);
  res.json({ ok: true, tienda });
});
adminRouter.put('/tiendas/:id', (req, res) => {
  const tienda = store.getTiendaById(req.params.id);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });
  const { name, code, address, commune, region, active, capacity } = req.body || {};
  if (name !== undefined) tienda.name = name;
  if (code !== undefined) tienda.code = code;
  if (address !== undefined) tienda.address = address;
  if (commune !== undefined) tienda.commune = commune;
  if (region !== undefined) tienda.region = region;
  if (active !== undefined) tienda.active = !!active;
  if (capacity) tienda.capacity = capacity; // store.saveTienda normaliza y completa roles faltantes
  store.saveTienda(tienda);
  res.json({ ok: true, tienda });
});
adminRouter.delete('/tiendas/:id', (req, res) => {
  try {
    store.deleteTienda(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

// Planificación solo maneja AM/PM/FULL — Capacitación se administra aparte
// (ver /slots/capacitacion) para no mezclarse con la cobertura por cupos.
adminRouter.get('/slots', (req, res) => {
  const { storeId, weekStart } = req.query;
  if (!storeId || !weekStart) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  const slots = store.disponibilidadTienda(storeId, weekStart).filter(s => s.shiftType !== 'CAPACITACION');
  res.json({ ok: true, slots });
});

// ─── Capacitación: turnos sin cupos, independientes de la planificación ────────
adminRouter.get('/slots/capacitacion', (req, res) => {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ ok: false, error: 'Falta la tienda' });
  const slots = store.disponibilidadTiendaCompleta(storeId).filter(s => s.shiftType === 'CAPACITACION');
  res.json({ ok: true, slots });
});
adminRouter.post('/slots/capacitacion', (req, res) => {
  const { storeId, date } = req.body || {};
  if (!storeId || !date) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  const tienda = store.getTiendaById(storeId);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });
  const existente = store.getSlots().find(s => s.storeId === storeId && s.date === date && s.shiftType === 'CAPACITACION');
  if (existente) return res.json({ ok: true, slot: store.slotConInfo(existente) });
  try {
    const slot = store.createSlot({ storeId, shiftType: 'CAPACITACION', date, capacity: {} });
    res.json({ ok: true, slot: store.slotConInfo(slot) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
adminRouter.post('/slots', (req, res) => {
  const { storeId, shiftType, date, capacity } = req.body || {};
  if (!storeId || !shiftType || !date) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const slot = store.createSlot({ storeId, shiftType, date, capacity });
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
const TURNO_LABEL_XLSX = { AM: 'Mañana (AM)', PM: 'Tarde (PM)', FULL: 'Jornada completa', CAPACITACION: 'Capacitación' };
const DIA_LABEL_XLSX = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

adminRouter.get('/slots/export', (req, res) => {
  const { storeId, weekStart } = req.query;
  if (!storeId || !weekStart) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  const tienda = store.getTiendaById(storeId);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });

  const slots = store.disponibilidadTienda(storeId, weekStart).filter(s => s.shiftType !== 'CAPACITACION');
  const filas = slots.map(s => {
    const dia = new Date(s.date + 'T00:00:00').getDay();
    const fila = {
      Tienda: tienda.name,
      Fecha: s.date,
      Día: DIA_LABEL_XLSX[dia],
      Turno: TURNO_LABEL_XLSX[s.shiftType] || s.shiftType,
      Horario: `${s.startTime}-${s.endTime}`,
    };
    for (const rol of store.ROLES) {
      fila[`Cupos ${rol}`]      = s.porRol[rol].capacity;
      fila[`Tomados ${rol}`]    = s.porRol[rol].taken;
      fila[`Disponibles ${rol}`] = s.porRol[rol].available;
    }
    fila['Cupos Total'] = s.capacity;
    fila['Tomados Total'] = s.taken;
    fila['Cobertura %'] = s.coverage;
    fila['Estado'] = s.status;
    return fila;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  const headers = filas.length ? Object.keys(filas[0]) : [];
  ws['!cols'] = headers.map(h => ({ wch: Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Planificación');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `planificacion_${tienda.code || tienda.name}_${weekStart}.xlsx`.replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// Plantilla Excel prellenada con los turnos del rango pedido (o los cupos
// por defecto de la tienda si esa fecha/turno todavía no existe) — para
// editar los cupos por rol y volver a subirla en /slots/importar.
adminRouter.get('/slots/plantilla', (req, res) => {
  const { storeId, dateFrom, dateTo } = req.query;
  if (!storeId || !dateFrom || !dateTo) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
  const tienda = store.getTiendaById(storeId);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });

  const existentes = new Map(
    store.getSlots().filter(s => s.storeId === storeId).map(s => [`${s.date}|${s.shiftType}`, store.slotConInfo(s)])
  );

  const filas = [];
  const inicio = new Date(dateFrom + 'T00:00:00');
  const fin = new Date(dateTo + 'T00:00:00');
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;
  for (let i = 0; i < Math.min(dias, 120); i++) {
    const d = new Date(inicio); d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    for (const tipo of ['AM', 'PM', 'FULL']) {
      const existente = existentes.get(`${dateStr}|${tipo}`);
      const cap = existente ? existente.porRol : { Picker: {capacity: tienda.capacity?.[tipo]?.Picker ?? 0}, Shopper: {capacity: tienda.capacity?.[tipo]?.Shopper ?? 0}, Driver: {capacity: tienda.capacity?.[tipo]?.Driver ?? 0} };
      filas.push({
        Fecha: dateStr,
        Día: DIA_LABEL_XLSX[d.getDay()],
        Turno: tipo,
        'Cupos Picker': cap.Picker.capacity,
        'Cupos Shopper': cap.Shopper.capacity,
        'Cupos Driver': cap.Driver.capacity,
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 13 }, { wch: 13 }, { wch: 13 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Cupos');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    [`Plantilla de cupos — ${tienda.name}`],
    [''],
    ['1. No cambies las columnas Fecha ni Turno.'],
    ['2. Edita solo Cupos Picker / Cupos Shopper / Cupos Driver.'],
    ['3. Formato de Fecha: AAAA-MM-DD (ej: 2026-09-10).'],
    ['4. Turno debe ser exactamente: AM, PM o FULL.'],
    ['5. Si agregas una fila con Fecha/Turno que no existe todavía, se crea automáticamente al subirla.'],
    ['6. Vuelve a subir este mismo archivo (ya editado) con el botón "Cargar cupos (Excel)" en Planificación.'],
  ]);
  wsInfo['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instrucciones');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `plantilla_cupos_${tienda.code || tienda.name}.xlsx`.replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

function parsearFechaImport(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Carga masiva de cupos por rol desde un Excel (mismo formato que la
// plantilla). Actualiza los turnos que ya existan por Fecha+Turno, y crea
// los que falten. Nunca duplica.
adminRouter.post('/slots/importar', uploadCupos.single('file'), (req, res) => {
  const { storeId } = req.body || {};
  if (!storeId) return res.status(400).json({ ok: false, error: 'Falta la tienda' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
  const tienda = store.getTiendaById(storeId);
  if (!tienda) return res.status(404).json({ ok: false, error: 'Tienda no encontrada' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const hoja = wb.SheetNames.find(n => n.toLowerCase() !== 'instrucciones') || wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { defval: '' });
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'No se pudo leer el Excel: ' + e.message });
  }

  const existentes = store.getSlots().filter(s => s.storeId === storeId);
  let actualizados = 0, creados = 0;
  const errores = [];

  rows.forEach((row, i) => {
    const numFila = i + 2; // fila 1 = encabezados
    const fecha = parsearFechaImport(row['Fecha']);
    const turno = String(row['Turno'] || '').trim().toUpperCase();
    if (!fecha) { errores.push({ fila: numFila, motivo: `Fecha inválida: "${row['Fecha']}"` }); return; }
    if (!['AM', 'PM', 'FULL'].includes(turno)) { errores.push({ fila: numFila, motivo: `Turno inválido: "${row['Turno']}" (debe ser AM, PM o FULL)` }); return; }

    const capacity = {
      Picker: Number(row['Cupos Picker']) || 0,
      Shopper: Number(row['Cupos Shopper']) || 0,
      Driver: Number(row['Cupos Driver']) || 0,
    };

    const slot = existentes.find(s => s.date === fecha && s.shiftType === turno);
    if (slot) {
      slot.capacity = capacity;
      store.saveSlot(slot);
      actualizados++;
    } else {
      const nuevo = store.createSlot({ storeId, shiftType: turno, date: fecha, capacity });
      existentes.push(nuevo);
      creados++;
    }
  });

  res.json({ ok: true, actualizados, creados, filasLeidas: rows.length, errores });
});

adminRouter.post('/slots/generar-semana', (req, res) => {
  const { storeId, weekStart } = req.body || {};
  if (!storeId || !weekStart) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const creados = store.generarSemana(storeId, weekStart);
    res.json({ ok: true, creados: creados.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

adminRouter.post('/slots/generar-rango', (req, res) => {
  const { storeId, dateFrom, dateTo } = req.body || {};
  if (!storeId || !dateFrom || !dateTo) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  try {
    const creados = store.generarRango(storeId, dateFrom, dateTo);
    res.json({ ok: true, creados: creados.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
adminRouter.put('/slots/:id', (req, res) => {
  const slot = store.getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });
  const { capacity, status } = req.body || {};
  if (capacity !== undefined) slot.capacity = capacity; // { Picker, Shopper, Driver }
  if (status !== undefined) slot.status = status;
  store.saveSlot(slot);
  res.json({ ok: true, slot: store.slotConInfo(slot) });
});
adminRouter.delete('/slots/:id', (req, res) => {
  store.deleteSlot(req.params.id);
  res.json({ ok: true });
});

adminRouter.get('/karriers', (_req, res) => res.json({ ok: true, karriers: store.getKarriers() }));
adminRouter.post('/karriers', (req, res) => {
  const { rut, name, phone } = req.body || {};
  if (!rut || !name) return res.status(400).json({ ok: false, error: 'RUT y nombre son requeridos' });
  const karrier = { rut: rut.trim(), name: name.trim(), phone: (phone || '').trim(), status: 'ACTIVE', createdAt: new Date().toISOString() };
  store.saveKarrier(karrier);
  res.json({ ok: true, karrier });
});
adminRouter.put('/karriers/:rut', (req, res) => {
  const k = store.getKarrierByRut(req.params.rut);
  if (!k) return res.status(404).json({ ok: false, error: 'Karrier no encontrado' });
  const { name, phone, status } = req.body || {};
  if (name !== undefined) k.name = name;
  if (phone !== undefined) k.phone = phone;
  if (status !== undefined) k.status = status;
  store.saveKarrier(k);
  res.json({ ok: true, karrier: k });
});
adminRouter.delete('/karriers/:rut', (req, res) => {
  store.deleteKarrier(req.params.rut);
  res.json({ ok: true });
});

adminRouter.get('/cobertura', (req, res) => {
  const { weekStart, storeId, role } = req.query;
  if (!weekStart) return res.status(400).json({ ok: false, error: 'Falta weekStart' });
  res.json({ ok: true, cobertura: store.coberturaGeneral(weekStart, storeId || null, role || null) });
});

adminRouter.get('/dashboard', (req, res) => {
  const { weekStart, storeId, role } = req.query;
  if (!weekStart) return res.status(400).json({ ok: false, error: 'Falta weekStart' });
  res.json({ ok: true, kpis: store.dashboardKpis(weekStart, storeId || null, role || null) });
});

adminRouter.get('/asignaciones', (req, res) => {
  const { storeId, weekStart, status, role, date } = req.query;
  res.json({ ok: true, asignaciones: store.listAsignaciones({ storeId: storeId || null, weekStartDate: weekStart || null, status: status || null, role: role || null, date: date || null }) });
});

adminRouter.get('/asignaciones/export', (req, res) => {
  const { storeId, weekStart, status, role, date } = req.query;
  const asignaciones = store.listAsignaciones({ storeId: storeId || null, weekStartDate: weekStart || null, status: status || null, role: role || null, date: date || null });

  const ESTADO_LABEL = { ACTIVE: 'Activo', CANCELLED: 'Cancelado' };
  const filas = asignaciones.map(a => ({
    Karrier: a.karrierName,
    RUT: a.karrierRut,
    Rol: a.role || '—',
    Tienda: a.tienda?.name || '—',
    Fecha: a.slot.date,
    Turno: TURNO_LABEL_XLSX[a.slot.shiftType] || a.slot.shiftType,
    Horario: `${a.slot.startTime}-${a.slot.endTime}`,
    Estado: ESTADO_LABEL[a.status] || a.status,
    'Registrado el': new Date(a.createdAt).toLocaleString('es-CL'),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  const headers = filas.length ? Object.keys(filas[0]) : [];
  ws['!cols'] = headers.map(h => ({ wch: Math.max(12, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Asignaciones');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `asignaciones_${date || weekStart || 'todas'}.xlsx`.replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

adminRouter.post('/asignaciones/:id/cancelar', async (req, res) => {
  try {
    const asignacion = await store.cancelarTurno(req.params.id, null, { isAdmin: true, reason: req.body?.reason });
    res.json({ ok: true, asignacion });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

adminRouter.post('/asignaciones/:id/reasignar', async (req, res) => {
  const { newSlotId } = req.body || {};
  if (!newSlotId) return res.status(400).json({ ok: false, error: 'Falta el turno destino' });
  try {
    const asignacion = await store.reasignarTurno(req.params.id, newSlotId);
    res.json({ ok: true, asignacion });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

// ─── Asistencia ───────────────────────────────────────────────────────────────
adminRouter.get('/asistencia', (req, res) => {
  const { storeId, date } = req.query;
  if (!date) return res.status(400).json({ ok: false, error: 'Falta la fecha' });
  try {
    res.json({ ok: true, asistencia: store.listAsistenciaDia({ storeId: storeId || null, date }) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

adminRouter.put('/asistencia/:assignmentId', (req, res) => {
  const { asistio, hora } = req.body || {};
  try {
    const registro = store.setAsistencia(req.params.assignmentId, asistio === null ? null : !!asistio, hora);
    res.json({ ok: true, asistencia: registro });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

adminRouter.put('/asistencia/:assignmentId/hora', (req, res) => {
  const { hora } = req.body || {};
  try {
    const registro = store.setAsistenciaHora(req.params.assignmentId, hora);
    res.json({ ok: true, asistencia: registro });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

adminRouter.post('/observaciones', (req, res) => {
  const { assignmentId, texto } = req.body || {};
  if (!assignmentId) return res.status(400).json({ ok: false, error: 'Falta la asignación' });
  try {
    const entry = store.addObservacion(assignmentId, texto);
    res.json({ ok: true, observacion: entry });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

adminRouter.get('/bitacora/export', (req, res) => {
  const { storeId, dateFrom, dateTo } = req.query;
  const tienda = storeId ? store.getTiendaById(storeId) : null;

  const filas = store.listBitacora({ storeId: storeId || null, dateFrom: dateFrom || null, dateTo: dateTo || null })
    .map(o => ({
      Fecha: o.date,
      Turno: o.shiftType,
      Tienda: o.storeName,
      Karrier: o.karrierName,
      RUT: o.karrierRut,
      Asistencia: o.asistio === null || o.asistio === undefined ? 'Sin marcar' : (o.asistio ? 'Sí' : 'No'),
      Hora: o.hora || '—',
      Observación: o.texto,
      'Registrado el': new Date(o.createdAt).toLocaleString('es-CL'),
    }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  ws['!cols'] = [
    { wch: 12 }, { wch: 8 }, { wch: 18 }, { wch: 20 }, { wch: 13 },
    { wch: 11 }, { wch: 8 }, { wch: 40 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Bitácora');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `bitacora_asistencia_${tienda ? tienda.code || tienda.name : 'todas'}.xlsx`.replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=domingo
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

module.exports = { publicRouter, adminRouter };
