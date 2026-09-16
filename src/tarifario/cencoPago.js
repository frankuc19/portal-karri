const crypto = require('crypto');
const { descargarPedidosPorRango } = require('./cencoApi');
const cencoStore = require('./cencoStore');

// ─── Posiciones de columna en el CSV crudo de Cencosud ─────────────────────
// Mismas posiciones que usaba el script de Apps Script (0-indexado), leídas
// directamente del CSV en vez de desde columnas de un Sheet ya armado.
const COL = {
  ID: 0,
  FECHA_ENTREGA: 2,   // colC
  HORA_DESPACHO: 3,   // colD
  CODIGO_TIENDA: 6,   // colG
  LOCAL: 7,            // colH
  ESTADO: 9,           // colJ
  FECHA_PEDIDO: 10,    // colK
  LAT: 11,             // colL
  LNG: 12,             // colM
  COMUNA_DESTINO: 16,  // colQ
};

// Multiplicador por estado del pedido — igual que APLICAR_FORMULAS v6.
const ESTADOS_CERO = new Set([
  'RECOGIDO', 'MOTIVO TRANSPORTE (REINTENTABLE)', 'NOTIFICADO', 'EN RUTA A DESTINO',
  'CANCELADO', 'ASIGNADO EN VEHÍCULO', 'LISTO PARA RECOGER', 'LLEGÓ A DESTINO',
  'PROBLEMA PRODUCTO', 'REINTENTAR ENTREGA', 'NO RECOGIDO', 'CLIENTE NO ESTA DEFINITIVO',
  'NO ENTREGADO',
]);
const ESTADOS_MEDIO = new Set([
  'ENTREGADO PARCIAL', 'MOTIVO CLIENTE (REINTENTABLE)', 'PROBLEMAS EN LA DIRECCIÓN (REINTENTABLE)',
]);

// Ventana en la que el bono de $300 queda desactivado — heredado tal cual del
// script original (se apagó desde el 26-mar-2026 en adelante). Si Cenco
// reactiva el bono más adelante hay que avisar para ajustar esta fecha.
const BONO_DESDE_FECHA_APAGADO = Date.UTC(2026, 2, 26) / 86400000; // días desde epoch
const NAVIDAD_INICIO = Date.UTC(2025, 11, 26) / 86400000;
const NAVIDAD_FIN    = Date.UTC(2025, 11, 31) / 86400000;

function parseFechaCsv(valor) {
  if (!valor) return null;
  const f = new Date(valor);
  return Number.isNaN(f.getTime()) ? null : f;
}

function parseCoord(valor) {
  if (!valor) return NaN;
  return parseFloat(String(valor).trim().replace(',', '.'));
}

function fechaISO(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function parseFestivos(lista) {
  // Acepta 'YYYY-MM-DD' o 'DD/MM/YYYY'; devuelve un Set de 'YYYY-MM-DD'.
  const set = new Set();
  for (const raw of lista || []) {
    const s = String(raw).trim();
    if (!s) continue;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) { set.add(s); continue; }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) { set.add(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`); continue; }
  }
  return set;
}

function esFinDeSemanaOFestivo(fecha, festivosSet) {
  const dia = fecha.getDay(); // 0=Dom, 6=Sab
  return dia === 0 || dia === 6 || festivosSet.has(fechaISO(fecha));
}

// Bono de $300 por franja horaria de fin de semana / tarde en tiendas Jumbo —
// portado tal cual de APLICAR_FORMULAS (usa colK para las ventanas de
// excepción, colD/colC para las horas).
function calcularBono(fechaPedido, horaDespachoRaw, horaEntregaRaw, local) {
  if (!fechaPedido) return 0;
  const fechaKint = Math.floor(fechaPedido.getTime() / 86400000);
  const navidad = fechaKint >= NAVIDAD_INICIO && fechaKint <= NAVIDAD_FIN;
  const desde26 = fechaKint >= BONO_DESDE_FECHA_APAGADO;
  if (navidad || desde26) return 0;

  const diaSemK = fechaPedido.getDay();
  const horaD = parseFechaCsv(horaDespachoRaw);
  const horaC = parseFechaCsv(horaEntregaRaw);
  const minutosD = horaD ? horaD.getHours() * 60 + horaD.getMinutes() : 0;
  const minutosC = horaC ? horaC.getHours() * 60 + horaC.getMinutes() : 0;

  const esFinde = diaSemK === 0 || diaSemK === 6;
  const esFranjaManana = esFinde && minutosD >= 450 && minutosD <= 600;
  const esJumbo = String(local).toUpperCase() === 'JUMBO CONCHA Y TORO' || String(local).toUpperCase() === 'JUMBO SAN BERNARDO';
  const esFranjaTarde = esJumbo && minutosC >= 1110;

  if (esFranjaManana || esFranjaTarde) return 300;
  if (diaSemK === 6) return 300;
  return 0;
}

function multiplicadorPorEstado(estadoRaw) {
  const estado = String(estadoRaw || '').trim().toUpperCase();
  if (ESTADOS_CERO.has(estado)) return 0;
  if (ESTADOS_MEDIO.has(estado)) return 0.5;
  return 1;
}

/**
 * Calcula Pago Conductor por pedido usando el Tarifario configurado (zonas +
 * vigencias por Sala), adaptando la lógica de APLICAR_FORMULAS: clasifica
 * Sala por código de tienda, resuelve la zona/tarifa por punto dentro del
 * polígono vía cencoStore.resolverTarifa (que ya sabe elegir la vigencia
 * correcta para la fecha), y aplica el bono y el multiplicador por estado
 * igual que el script original.
 */
function calcularPagos(filas, { festivos = [] } = {}) {
  const mapaCodigos = cencoStore.getMapaCodigosTienda();
  const festivosSet = parseFestivos(festivos);

  const detalle = [];
  const resumen = {
    totalPedidos: filas.length,
    totalPago: 0,
    porSala: {}, // sala -> { pedidos, total }
    sinCodigoTienda: 0,
    sinSalaAsignada: 0,
    sinCoordenadas: 0,
    fueraDeTodosLosPoligonos: 0,
    sinTarifaConfigurada: 0,
    fueraDeVigencia: 0,
  };

  for (const row of filas) {
    const ordenId = row[COL.ID] || '';
    const codigoTienda = String(row[COL.CODIGO_TIENDA] || '').trim();
    const local = row[COL.LOCAL] || '';
    const estado = row[COL.ESTADO] || '';
    const comuna = row[COL.COMUNA_DESTINO] || '';
    const fechaPedido = parseFechaCsv(row[COL.FECHA_PEDIDO]);
    const lat = parseCoord(row[COL.LAT]);
    const lng = parseCoord(row[COL.LNG]);

    const sala = mapaCodigos[codigoTienda] || null;
    const mult = multiplicadorPorEstado(estado);

    const fila = {
      ordenId, codigoTienda, local, estado, comuna,
      fecha: fechaPedido ? fechaISO(fechaPedido) : null,
      sala, zona: null, tipoDia: null,
      tarifaBase: 0, bono: 0, multiplicador: mult, montoPagoConductor: 0,
      motivo: null,
    };

    if (!codigoTienda) { fila.motivo = 'SIN_CODIGO_TIENDA'; resumen.sinCodigoTienda++; detalle.push(fila); continue; }
    if (!sala) { fila.motivo = 'SIN_SALA_ASIGNADA'; resumen.sinSalaAsignada++; detalle.push(fila); continue; }
    if (!fechaPedido) { fila.motivo = 'SIN_FECHA_PEDIDO'; detalle.push(fila); continue; }

    fila.tipoDia = esFinDeSemanaOFestivo(fechaPedido, festivosSet) ? 'SDF' : 'LV';
    const bono = calcularBono(fechaPedido, row[COL.HORA_DESPACHO], row[COL.FECHA_ENTREGA], local);
    fila.bono = bono;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      fila.motivo = 'SIN_COORDENADAS';
      resumen.sinCoordenadas++;
    } else {
      const r = cencoStore.resolverTarifa({
        sala, lat, lng, fecha: fila.fecha, esDomFestivo: fila.tipoDia === 'SDF',
      });
      fila.zona = r.zona || null;
      if (!r.dentroDePoligono) {
        fila.motivo = 'FUERA_DE_TODOS_LOS_POLIGONOS';
        resumen.fueraDeTodosLosPoligonos++;
        fila.tarifaBase = r.asegurado != null ? Number(r.asegurado) : 0;
        if (r.asegurado == null) fila.motivo = 'FUERA_DE_TODOS_LOS_POLIGONOS_SIN_ASEGURADO';
      } else if (r.motivo === 'ZONA_SIN_TARIFA_CONFIGURADA') {
        fila.motivo = 'SIN_TARIFA_CONFIGURADA';
        resumen.sinTarifaConfigurada++;
      } else if (r.motivo === 'TARIFA_FUERA_DE_VIGENCIA') {
        fila.motivo = 'FUERA_DE_VIGENCIA';
        resumen.fueraDeVigencia++;
      } else {
        fila.tarifaBase = Number(r.monto || 0);
      }
    }

    fila.montoPagoConductor = (fila.tarifaBase + fila.bono) * mult;
    resumen.totalPago += fila.montoPagoConductor;

    if (!resumen.porSala[sala]) resumen.porSala[sala] = { pedidos: 0, total: 0 };
    resumen.porSala[sala].pedidos++;
    resumen.porSala[sala].total += fila.montoPagoConductor;

    detalle.push(fila);
  }

  return { detalle, resumen };
}

// ─── Orquestación de jobs (transitorio — solo en memoria del proceso) ──────
const JOBS = new Map(); // jobId -> { estado, resultado, creado }
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

function limpiarJobsViejos() {
  const ahora = Date.now();
  for (const [id, job] of JOBS) {
    if (ahora - job.creado > JOB_TTL_MS) JOBS.delete(id);
  }
}

function iniciarProcesoPago({ fechaInicio, fechaFin, festivos }) {
  if (!fechaInicio || !fechaFin) throw new Error('Falta fechaInicio o fechaFin');
  limpiarJobsViejos();

  const jobId = crypto.randomUUID();
  const job = {
    estado: { diaActual: 0, totalDias: 0, diaLabel: 'Iniciando...', filasAcumuladas: 0, errores: [], finalizado: false, errorFatal: null },
    resultado: null,
    creado: Date.now(),
  };
  JOBS.set(jobId, job);

  (async () => {
    try {
      const { filas, errores } = await descargarPedidosPorRango(fechaInicio, fechaFin, (progreso) => {
        job.estado = { ...progreso, errorFatal: null };
      });
      const { detalle, resumen } = calcularPagos(filas, { festivos });
      job.resultado = { detalle, resumen, errores };
      job.estado = { ...job.estado, finalizado: true };
    } catch (e) {
      job.estado = { ...job.estado, finalizado: true, errorFatal: e.message };
    }
  })();

  return jobId;
}

function obtenerEstadoJob(jobId) {
  const job = JOBS.get(jobId);
  return job ? job.estado : null;
}

function obtenerResultadoJob(jobId) {
  const job = JOBS.get(jobId);
  return job && job.resultado ? job.resultado : null;
}

module.exports = { calcularPagos, iniciarProcesoPago, obtenerEstadoJob, obtenerResultadoJob };
