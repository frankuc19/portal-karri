const { Router } = require('express');
const XLSX = require('xlsx');
const P = require('./falabellaPago');
const { obtenerHistorialCorridas, eliminarCorridaGuardada } = require('../cencoPago');

const T = require('./tarifasFalabella');
const S = require('./falabellaSheets');

const router = Router();

function excelDe(detalle) {
  const filas = detalle.map((f) => ({
    Origen: f.origen, Fecha: f.iso ?? f.fecha, 'ID Ruta': f.idruta ?? f.idruta, CT: f.ct, Patente: f.patente, Zona: f.zona,
    'Tipo Ruta': f.tipoRuta ?? f.tipo_ruta, Terminados: f.terminado ?? f.terminados, Total: f.total,
    'Nivel Cumplimiento': f.nivel === '' || f.nivel === null || f.nivel === undefined ? '' : Number(f.nivel),
    Vehículo: f.tipoVeh ?? f.vehiculo, 'Tarifa Base': f.tarifaBase ?? f.tarifa_base, 'Tarifa Variable': f.tarifaVariable ?? f.tarifa_variable,
    'Pago Estimado': f.pago, Servicio: f.servicio, Observación: f.observacion, Estado: f.estadoFila ?? f.estado_fila,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Pago Falabella');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function enviarExcel(res, detalle, nombre) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(excelDe(detalle));
}

router.post('/procesar', (req, res) => {
  const { fechaInicio, fechaFin, incluirSimpli } = req.body || {};
  if (!fechaInicio || !fechaFin) return res.status(400).json({ ok: false, error: 'Falta fechaInicio o fechaFin' });
  try { res.json({ ok: true, jobId: P.iniciarProcesoFalabella({ fechaInicio, fechaFin, incluirSimpli: incluirSimpli !== false }) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.get('/estado/:jobId', (req, res) => {
  const estado = P.obtenerEstadoJob(req.params.jobId);
  if (!estado) return res.status(404).json({ ok: false, error: 'Proceso no encontrado (puede haber expirado).' });
  res.json({ ok: true, estado });
});

router.get('/resultado/:jobId', (req, res) => {
  const r = P.obtenerResultadoJob(req.params.jobId);
  if (!r) return res.status(404).json({ ok: false, error: 'Resultado no disponible todavía.' });
  if (req.query.formato === 'excel') return enviarExcel(res, r.detalle, 'estado_pago_falabella.xlsx');
  res.json({ ok: true, ...r });
});

router.get('/historial', async (req, res) => {
  const r = await obtenerHistorialCorridas({ desde: req.query.desde, hasta: req.query.hasta, cliente: 'falabella' });
  if (r.error) return res.status(r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 500).json({ ok: false, error: r.error });
  res.json({ ok: true, corridas: r.corridas });
});

router.get('/historial/:corridaId', async (req, res) => {
  const r = await P.obtenerCorridaFalabella(req.params.corridaId);
  if (r.error) return res.status(r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 404).json({ ok: false, error: r.error });
  if (req.query.formato === 'excel') return enviarExcel(res, r.detalle, `estado_pago_falabella_${r.corrida.fecha_inicio}_${r.corrida.fecha_fin}.xlsx`);
  res.json({ ok: true, corrida: r.corrida, detalle: r.detalle });
});

router.delete('/historial/:corridaId', async (req, res) => {
  if (req.session?.role === 'beginner') return res.status(403).json({ ok: false, error: 'Tu perfil no puede borrar cálculos guardados.' });
  const r = await eliminarCorridaGuardada(req.params.corridaId);
  if (r.error) return res.status(r.noEncontrada ? 404 : (r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 500)).json({ ok: false, error: r.error });
  res.json({ ok: true });
});

// ─── Tarifario (se lee en vivo de la pestaña "Pago Falabella") ─────────────
router.get('/tarifario', async (_req, res) => {
  try {
    const tarifario = T.cargarTarifario(await S.leerTarifarioCrudo());
    const filas = tarifario.map((t) => ({ ...t, fechaInicio: t.fechaInicio === null ? null : T.isoDeMs(t.fechaInicio), fechaFin: t.fechaFin === null ? null : T.isoDeMs(t.fechaFin) }));
    res.json({ ok: true, tarifas: filas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Prueba de tarifa: qué se pagaría por una ruta con estos datos (misma lógica del Estado de Pago).
router.post('/tarifario/probar', async (req, res) => {
  const { ct, zona, tipoRuta, patente, vehiculo, terminados, total, fecha, origen } = req.body || {};
  if (!ct || !fecha) return res.status(400).json({ ok: false, error: 'Falta el CT o la fecha' });
  try {
    const [crudo, agp, fer] = await Promise.all([S.leerTarifarioCrudo(), S.leerMapaAGP(), S.leerFeriados()]);
    const tarifario = T.cargarTarifario(crudo);
    const term = Number(terminados) || 0, tot = Number(total) || term;
    let veh = vehiculo || '';
    if (!veh && patente) veh = agp.get(String(patente).replace(/[-\s.]+/g, '').toUpperCase()) || '';
    const salida = T.calcularPagoFalabella([{
      origen: origen || 'Geosort', fecha, iso: fecha, idruta: 'PRUEBA', ct, patente: patente || '', zona: zona || 'Urbana',
      tipoRuta: tipoRuta || 'AM', terminado: term, total: tot, tipoVeh: veh, nivel: tot > 0 ? term / tot : '',
    }], tarifario, fer.set, agp);
    res.json({ ok: true, vehiculo: veh, resultado: salida[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
