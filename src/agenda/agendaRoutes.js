// Karri Agenda ↔ Turnos
// Cada turno que un Karrier toma en el link público /turnos ES una reserva de
// Agenda. No se guarda una copia: las reservas se arman en vivo desde los
// archivos de Turnos (asignaciones + slots + tiendas + asistencia +
// observaciones) y se enriquecen con la ficha del Karrier y su alta en
// Onboarding. Así Agenda y Turnos nunca se desincronizan.
const { Router } = require('express');
const store = require('../turnos/turnosStore');
const altasStore = require('../onboarding/altasStore');

const router = Router();

const TZ = 'America/Santiago';
const TURNO_LABEL = { AM: 'Turno mañana (AM)', PM: 'Turno tarde (PM)', FULL: 'Jornada completa', CAPACITACION: 'Capacitación' };
const TURNO_DESC = {
  AM: 'Turno de la mañana en tienda.',
  PM: 'Turno de la tarde en tienda.',
  FULL: 'Jornada completa en tienda (mañana y tarde).',
  CAPACITACION: 'Capacitación presencial para Karriers.',
};
const DIAS_ATRAS_DEFAULT = 60;

const soloDigitos = (rut) => String(rut || '').toUpperCase().replace(/[^0-9K]/g, '');
const aMinutos = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// Formateadores reutilizables: crear uno por llamada (toLocale…) es lento con miles de reservas.
const FMT_FECHA = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const FMT_HORA = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fechaChile = (d = new Date()) => FMT_FECHA.format(d);
const horaChile = (d = new Date()) => FMT_HORA.format(d).replace(/^24/, '00');
const minutosChile = (d = new Date()) => {
  const [h, m] = horaChile(d).split(':').map(Number);
  return (h % 24) * 60 + m;
};
// "dd-mm-yyyy HH:MM" en hora de Chile, el formato del historial de Agenda.
function cuando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const [y, mo, da] = fechaChile(d).split('-');
  return `${da}-${mo}-${y} ${horaChile(d)}`;
}
// Fechas de Altas vienen de una planilla (dd/mm/aaaa, aaaa-mm-dd o serial Excel).
function fechaIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}
const limpio = (v) => (v === null || v === undefined ? '' : String(v).trim());
// Celulares chilenos a +569XXXXXXXX (Altas los trae como 912345678, 56912345678, etc.).
function celular(v) {
  const s = limpio(v); const d = s.replace(/\D/g, '');
  if (/^569\d{8}$/.test(d)) return '+' + d;
  if (/^9\d{8}$/.test(d)) return '+56' + d;
  return s;
}

function estadoReserva(asig, slot, asistencia, hoy, ahora) {
  if (asig.status === 'CANCELLED') return 'CANCELLED';
  if (asistencia?.asistio === false) return 'NO_SHOW';
  if (asistencia?.asistio === true) {
    const fin = aMinutos(slot.endTime) ?? 1440;
    const termino = slot.date < hoy || (slot.date === hoy && fin <= ahora);
    return termino ? 'COMPLETED' : 'CHECKED_IN';
  }
  return 'CONFIRMED';
}

function clienteDesde(rutNorm, karrier, alta, rolCliente) {
  const nombre = limpio(alta?.nombre) || limpio(karrier?.name) || rutNorm;
  const ficha = [
    ['RUT', rutNorm],
    ['Nombre', nombre],
    ['Celular', celular(karrier?.phone) || celular(alta?.celular)],
    ['Correo', limpio(alta?.correo)],
    ['Rol', rolCliente.rol || ''],
    ['Cliente (Altas)', limpio(alta?.cliente) || rolCliente.cliente || ''],
    ['Sala / bodega', limpio(alta?.salaBodega)],
    ['Patente', limpio(alta?.patente)],
    ['Tipo de auto', limpio(alta?.tipoAuto)],
    ['Fecha de alta', limpio(alta?.fechaAlta)],
    ['Estado en Altas', limpio(alta?.estado)],
    ['Estado en Turnos', karrier ? (karrier.status === 'ACTIVE' ? 'Activo' : 'Inactivo') : 'Sin ficha en Turnos'],
    ['Registrado en /turnos', karrier?.createdAt ? cuando(karrier.createdAt) : ''],
  ].filter(([, v]) => v).map(([k, v]) => ({ k, v }));
  const tags = [rolCliente.rol, limpio(alta?.cliente)].filter(Boolean);
  return {
    id: 'k:' + soloDigitos(rutNorm),
    type: 'PERSON',
    name: nombre,
    rutTxt: rutNorm,
    phone: celular(karrier?.phone) || celular(alta?.celular),
    email: limpio(alta?.correo),
    plate: limpio(alta?.patente),
    license: null,
    since: fechaIso(alta?.fechaAlta) || (karrier?.createdAt ? fechaChile(new Date(karrier.createdAt)) : null),
    source: 'TURNOS',
    status: karrier && karrier.status !== 'ACTIVE' ? 'BLOCKED' : 'ACTIVE',
    consent: null,
    tags,
    docs: {},
    notes: '',
    ficha,
    enAltas: !!alta,
  };
}

// Arma todo lo que Agenda necesita: tiendas, servicios (tipos de turno),
// clientes (Karriers) y reservas (turnos tomados).
function construirDatos({ desde } = {}) {
  const hoy = fechaChile();
  const ahora = minutosChile();
  const limite = desde || (() => {
    const d = new Date(hoy + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - DIAS_ATRAS_DEFAULT);
    return d.toISOString().slice(0, 10);
  })();

  const tiendas = store.getTiendas();
  const tiendasPorId = new Map(tiendas.map(t => [t.id, t]));
  const slotsPorId = new Map(store.getSlots().map(s => [s.id, s]));
  const asistencias = new Map(store.getAsistencias().map(a => [a.assignmentId, a]));
  const observaciones = new Map();
  for (const o of store.getObservaciones()) {
    if (!observaciones.has(o.assignmentId)) observaciones.set(o.assignmentId, []);
    observaciones.get(o.assignmentId).push(o);
  }
  const karriers = new Map(store.getKarriers().map(k => [soloDigitos(k.rut), k]));
  // Índice por RUT (una pasada): buscar alta por alta en cada Karrier escala mal.
  // Igual que getAltaByRutKey, si un RUT se repite gana la primera ficha.
  const altasPorRut = new Map();
  for (const al of altasStore.getAltas()) if (al.rutKey && !altasPorRut.has(al.rutKey)) altasPorRut.set(al.rutKey, al);
  const altaDe = (key) => altasPorRut.get(key) || null;

  const clientes = new Map();
  const asegurarCliente = (rut, nombreAsig, rolSnapshot, clienteSnapshot) => {
    const key = soloDigitos(rut);
    if (clientes.has(key)) return clientes.get(key);
    const karrier = karriers.get(key) || null;
    const alta = altaDe(key);
    // Mismo criterio que Turnos (determinarRolKarrier), pero con el índice.
    const rolAlta = alta ? store.normalizarRolPorCliente(alta.cliente) : null;
    const c = clienteDesde(store.normalizarRut(rut), karrier || { name: nombreAsig }, alta, {
      rol: rolAlta || rolSnapshot || null,
      cliente: (alta && alta.cliente) || clienteSnapshot || null,
    });
    clientes.set(key, c);
    return c;
  };

  // Todos los Karriers que se identificaron en /turnos son clientes de Agenda.
  for (const k of karriers.values()) asegurarCliente(k.rut, k.name);

  // Horario visible del calendario por tienda: desde el turno más temprano
  // hasta el más tarde que tenga (los horarios cambian por cadena).
  const horario = new Map();
  const reservas = [];
  for (const a of store.getAsignaciones()) {
    const slot = slotsPorId.get(a.slotId);
    if (!slot || slot.date < limite) continue;
    const tienda = tiendasPorId.get(slot.storeId);
    if (!tienda) continue;
    const ini = aMinutos(slot.startTime) ?? 480;
    const fin = Math.max(aMinutos(slot.endTime) ?? ini + 60, ini + 15);
    const h = horario.get(tienda.id) || { ini: 1440, fin: 0 };
    horario.set(tienda.id, { ini: Math.min(h.ini, ini), fin: Math.max(h.fin, fin) });

    const cliente = asegurarCliente(a.karrierRut, a.karrierName, a.role, a.cliente);
    const asistencia = asistencias.get(a.id) || null;
    const obs = observaciones.get(a.id) || [];
    const estado = estadoReserva(a, slot, asistencia, hoy, ahora);

    const historial = [{ when: cuando(a.createdAt), who: `${cliente.name} (link /turnos)`, what: `Tomó el turno ${TURNO_LABEL[slot.shiftType] || slot.shiftType} como ${a.role || 'Karrier'}` }];
    if (asistencia && asistencia.asistio !== null && asistencia.asistio !== undefined) {
      historial.push({ when: cuando(asistencia.updatedAt), who: 'Asistencia (Turnos)', what: asistencia.asistio ? `Asistió${asistencia.hora ? ' · llegó ' + asistencia.hora : ''}` : 'No asistió' });
    }
    for (const o of obs) historial.push({ when: cuando(o.createdAt), who: 'Bitácora (Turnos)', what: o.texto });
    if (a.status === 'CANCELLED') {
      historial.push({ when: cuando(a.cancelledAt), who: a.canceladoPor || 'Turnos', what: `Canceló la reserva${a.cancellationReason ? ' — ' + a.cancellationReason : ''}` });
    }
    historial.sort((x, y) => {
      const k = (s) => s.when ? s.when.slice(6, 10) + s.when.slice(3, 5) + s.when.slice(0, 2) + s.when.slice(11) : '';
      return k(x).localeCompare(k(y));
    });

    const detalle = [
      ['Rol', a.role || ''],
      ['Cliente (Altas)', a.cliente || ''],
      ['Turno', `${TURNO_LABEL[slot.shiftType] || slot.shiftType} · ${slot.startTime}–${slot.endTime}`],
      ['Tienda', `${tienda.name}${tienda.code ? ' (cód. ' + tienda.code + ')' : ''}${tienda.commune ? ' · ' + tienda.commune : ''}`],
      ['Correo', cliente.email],
      ['Tipo de auto', (cliente.ficha.find(f => f.k === 'Tipo de auto') || {}).v || ''],
      ['Sala / bodega', (cliente.ficha.find(f => f.k === 'Sala / bodega') || {}).v || ''],
      ['Fecha de alta', (cliente.ficha.find(f => f.k === 'Fecha de alta') || {}).v || ''],
      ['Asistencia', asistencia?.asistio === true ? `Sí${asistencia.hora ? ' · ' + asistencia.hora : ''}` : asistencia?.asistio === false ? 'No' : 'Sin marcar'],
      ['Tomado el', cuando(a.createdAt)],
      ...(a.status === 'CANCELLED' ? [['Cancelado por', a.canceladoPor || '—'], ['Motivo', a.cancellationReason || '—']] : []),
    ].filter(([, v]) => v).map(([k, v]) => ({ k, v }));

    reservas.push({
      id: a.id,
      code: 'KT-' + a.id.replace(/-/g, '').slice(-6).toUpperCase(),
      date: slot.date,
      start: ini,
      end: fin,
      service: slot.shiftType,
      branch: tienda.id,
      customer: cliente.id,
      status: estado,
      origin: 'TURNOS',
      plate: null,
      notes: obs.length ? obs[obs.length - 1].texto : '',
      history: historial,
      detalle,
      real: true,
    });
  }

  const tiendasOut = tiendas.filter(t => t.active || horario.has(t.id)).map(t => {
    const h = horario.get(t.id);
    const def = ['AM', 'PM', 'FULL'].map(x => store.horarioDeTurno(x, t.name)).filter(Boolean);
    const ini = h ? h.ini : Math.min(...def.map(x => aMinutos(x.startTime)));
    const fin = h ? h.fin : Math.max(...def.map(x => aMinutos(x.endTime)));
    const capTurnos = ['AM', 'PM', 'FULL'].map(x => ['Picker', 'Shopper', 'Driver'].reduce((s, r) => s + (Number(t.capacity?.[x]?.[r]) || 0), 0));
    return {
      id: t.id,
      name: t.name,
      code: t.code || '',
      city: t.commune || t.region || '',
      address: t.address || t.commune || '',
      active: !!t.active,
      startHour: Math.floor(ini / 60),
      endHour: Math.ceil(fin / 60),
      cap: Math.max(1, ...capTurnos),
    };
  });

  const servicios = ['AM', 'PM', 'FULL', 'CAPACITACION'].map(id => {
    const h = store.horarioDeTurno(id, '');
    const dur = (aMinutos(h.endTime) - aMinutos(h.startTime)) || 60;
    return { id, name: TURNO_LABEL[id], dur, buffer: 0, cap: 1, rtype: 'PERSON', pub: true, plate: false, desc: TURNO_DESC[id], fields: ['RUT', 'Rol (desde Altas)'] };
  });

  return {
    ok: true,
    hoy,
    ahora,
    desde: limite,
    tiendas: tiendasOut,
    servicios,
    clientes: [...clientes.values()],
    reservas,
  };
}

router.get('/datos', (req, res) => {
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
  try {
    res.json(construirDatos({ desde }));
  } catch (e) {
    console.error('[Agenda] Error armando datos:', e);
    res.status(500).json({ ok: false, error: 'No se pudieron cargar las reservas de Turnos' });
  }
});

function actorDeSesion(req) {
  const s = req.session || {};
  const nombre = s.name || s.username || 'usuario';
  return `${nombre} (Agenda)`;
}

// Cambios de estado hechos desde Agenda se guardan en Turnos (misma fuente):
// llegada / no asistió → Asistencia; cancelar → cancela la asignación.
router.post('/reservas/:id/estado', async (req, res) => {
  const { to, reason } = req.body || {};
  const id = req.params.id;
  try {
    if (!store.getAsignacionById(id)) return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });
    if (to === 'CANCELLED') {
      await store.cancelarTurno(id, null, { isAdmin: true, reason: reason || 'Cancelada desde Agenda', actor: actorDeSesion(req) });
    } else if (to === 'CHECKED_IN' || to === 'COMPLETED') {
      store.setAsistencia(id, true);
    } else if (to === 'NO_SHOW') {
      store.setAsistencia(id, false);
    } else if (to === 'CONFIRMED') {
      store.setAsistencia(id, null);
    } else {
      return res.status(400).json({ ok: false, error: 'Estado no válido' });
    }
    const datos = construirDatos({});
    const reserva = datos.reservas.find(r => r.id === id) || null;
    res.json({ ok: true, reserva });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
  }
});

module.exports = { router, construirDatos };
