const crypto = require('crypto');
const T = require('./tarifasFalabella');
const S = require('./falabellaSheets');
const F = require('./falabellaFuentes');
const { getSupabase } = require('../supabaseClient');

// ─── Cálculo completo de un período (sin efectos sobre la planilla) ────────
// dependencias inyectables para poder probarlo sin red.
async function calcularPeriodo({ fechaInicio, fechaFin, incluirSimpli = true }, onProgreso, deps = {}) {
  const sheets = deps.sheets || S;
  const fuentes = deps.fuentes || F;
  const avisos = [];
  const errores = [];

  onProgreso?.({ fase: 'Leyendo tarifario, AGP y feriados...', diaActual: 0, totalDias: 0, diaLabel: '', filasAcumuladas: 0 });
  const [accesos, tarifarioCrudo, agp, feriados] = await Promise.all([
    sheets.leerAccesos(), sheets.leerTarifarioCrudo(), sheets.leerMapaAGP(), sheets.leerFeriados(),
  ]);
  const tarifario = T.cargarTarifario(tarifarioCrudo);
  if (feriados.aviso) avisos.push(`No se pudo leer "Feriados CL": el recargo solo aplica a domingos (${feriados.aviso}).`);

  const geo = await fuentes.descargarGeosort(fechaInicio, fechaFin, accesos, onProgreso);
  errores.push(...geo.errores);
  if (!geo.header || geo.filas.length === 0) {
    if (geo.errores.length) throw new Error('No se pudo descargar Geosort: ' + geo.errores.map((e) => `${e.dia} (${e.motivo})`).join('; '));
    avisos.push('Geosort no devolvió filas en el rango elegido.');
  }
  const resGeo = geo.header ? fuentes.resumirGeosort(geo.header, geo.filas, agp) : { rows: [], sinFecha: 0 };
  if (resGeo.sinFecha > 0) avisos.push(`${resGeo.sinFecha} fila(s) de Geosort sin fecha legible (ejemplo recibido: "${resGeo.ejemploSinFecha}").`);

  let filasSimpli = [];
  if (incluirSimpli) {
    try {
      const sim = await fuentes.descargarSimpli(fechaInicio, fechaFin, accesos, onProgreso);
      errores.push(...sim.errores);
      const resSim = fuentes.resumirSimpli(sim.visitas, agp);
      filasSimpli = resSim.rows;
      if (resSim.sinFecha > 0) avisos.push(`${resSim.sinFecha} visita(s) de SimpliRoute sin fecha legible.`);
    } catch (e) {
      // Un problema con Simpli no debe tirar abajo el pago de Geosort.
      avisos.push('No se incluyeron las rutas de SimpliRoute: ' + e.message);
    }
  }

  onProgreso?.({ fase: 'Calculando pago...', diaActual: 0, totalDias: 0, diaLabel: '', filasAcumuladas: resGeo.rows.length + filasSimpli.length });
  const consolidado = fuentes.consolidar(resGeo.rows, filasSimpli);
  const salida = T.calcularPagoFalabella(consolidado, tarifario, feriados.set, agp);
  const resumen = T.resumirPagoFalabella(salida);

  const sinTipo = salida.filter((r) => r.estadoFila !== 'FUSIONADA' && r.estadoFila !== 'COMPLEMENTO' && !r.tipoVeh).length;
  if (sinTipo > 0) avisos.push(`${sinTipo} ruta(s) sin tipo de vehículo (su patente no está en la pestaña "AGP").`);

  const detalle = salida.filter((r) => r.estadoFila !== 'FUSIONADA' && r.estadoFila !== 'MOTO_REPETIDA');
  return { detalle, resumen, errores, avisos };
}

// ─── Guardado en Supabase (corridas_pago + detalle_pago_falabella) ─────────
async function guardarCorridaFalabella({ fechaInicio, fechaFin, incluirSimpli, detalle, resumen, errores }) {
  const supabase = getSupabase();
  if (!supabase) return { guardado: false, motivo: 'SUPABASE_NO_CONFIGURADO' };

  const { data: corrida, error } = await supabase.from('corridas_pago').insert({
    cliente: 'falabella', fecha_inicio: fechaInicio, fecha_fin: fechaFin, festivos: [],
    total_pedidos: resumen.filasProcesadas, total_pago: resumen.totalPago, resumen_por_sala: resumen.porCT,
    sin_tarifa_configurada: resumen.sinTarifa, errores_descarga: errores,
    resumen: { ...resumen, incluirSimpli },
  }).select().single();
  if (error) return { guardado: false, motivo: error.message };

  const filas = detalle.map((f) => ({
    corrida_id: corrida.id, origen: f.origen, fecha: f.iso, idruta: f.idruta, ct: f.ct, patente: f.patente, zona: f.zona,
    tipo_ruta: f.tipoRuta, terminados: f.terminado, total: f.total, nivel: f.nivel === '' ? null : f.nivel, vehiculo: f.tipoVeh,
    tarifa_base: f.tarifaBase, tarifa_variable: f.tarifaVariable, pago: f.pago, servicio: f.servicio,
    observacion: f.observacion, estado_fila: f.estadoFila,
  }));
  for (let i = 0; i < filas.length; i += 500) {
    const { error: e2 } = await supabase.from('detalle_pago_falabella').insert(filas.slice(i, i + 500));
    if (e2) return { guardado: false, corridaId: corrida.id, motivo: e2.message };
  }
  return { guardado: true, corridaId: corrida.id };
}

async function obtenerCorridaFalabella(corridaId) {
  const supabase = getSupabase();
  if (!supabase) return { error: 'SUPABASE_NO_CONFIGURADO' };
  const { data: corrida, error } = await supabase.from('corridas_pago').select('*').eq('id', corridaId).single();
  if (error) return { error: 'Corrida no encontrada.' };
  const { data: detalle, error: e2 } = await supabase.from('detalle_pago_falabella').select('*').eq('corrida_id', corridaId);
  if (e2) return { error: e2.message };
  return { corrida, detalle };
}

// ─── Jobs (transitorios en memoria, mismo esquema que Cenco) ───────────────
const JOBS = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function iniciarProcesoFalabella({ fechaInicio, fechaFin, incluirSimpli }, deps) {
  if (!fechaInicio || !fechaFin) throw new Error('Falta fechaInicio o fechaFin');
  for (const [id, j] of JOBS) if (Date.now() - j.creado > JOB_TTL_MS) JOBS.delete(id);

  const jobId = crypto.randomUUID();
  const job = {
    estado: { fase: 'Iniciando...', diaActual: 0, totalDias: 0, diaLabel: 'Iniciando...', filasAcumuladas: 0, errores: [], finalizado: false, errorFatal: null },
    resultado: null, creado: Date.now(),
  };
  JOBS.set(jobId, job);

  (async () => {
    try {
      const r = await calcularPeriodo({ fechaInicio, fechaFin, incluirSimpli }, (p) => {
        job.estado = { ...job.estado, ...p, finalizado: false, errorFatal: null };
      }, deps);
      job.estado = { ...job.estado, fase: 'Guardando...', diaLabel: 'Calculando y guardando...' };
      let guardado;
      try { guardado = await guardarCorridaFalabella({ fechaInicio, fechaFin, incluirSimpli, ...r }); }
      catch (e) { guardado = { guardado: false, motivo: e.message }; }
      if (!guardado.guardado) console.warn('[Estado de Pago Falabella] No quedó guardado en Supabase:', guardado.motivo);
      job.resultado = { ...r, guardado };
      job.estado = { ...job.estado, finalizado: true };
    } catch (e) {
      job.estado = { ...job.estado, finalizado: true, errorFatal: e.message };
    }
  })();
  return jobId;
}

const obtenerEstadoJob = (id) => (JOBS.get(id) ? JOBS.get(id).estado : null);
const obtenerResultadoJob = (id) => (JOBS.get(id) && JOBS.get(id).resultado) || null;

module.exports = {
  calcularPeriodo, iniciarProcesoFalabella, obtenerEstadoJob, obtenerResultadoJob,
  guardarCorridaFalabella, obtenerCorridaFalabella,
};
