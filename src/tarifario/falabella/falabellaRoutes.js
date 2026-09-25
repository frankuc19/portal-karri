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

// ─── Tarifario: editable en el panel (si aún no se importó, se muestra la hoja) ───
const Store = require('./tarifarioStore');
const sinPermiso = (req, res) => {
  if (req.session?.role === 'beginner') { res.status(403).json({ ok: false, error: 'Tu perfil no puede editar el tarifario.' }); return true; }
  return false;
};

// Primera vez: el tarifario del panel se siembra solo con la hoja, para que quede editable de inmediato.
async function sembrarSiVacio() {
  if (Store.hayTarifarioPropio()) return;
  Store.reemplazarDesdeFilasMotor(T.cargarTarifario(await S.leerTarifarioCrudo()));
}

router.get('/tarifario', async (_req, res) => {
  try {
    await sembrarSiVacio();
    if (Store.hayTarifarioPropio()) return res.json({ ok: true, origen: 'panel', info: Store.getInfo(), tarifas: Store.getTarifas() });
    const tarifario = T.cargarTarifario(await S.leerTarifarioCrudo());
    const tarifas = tarifario.map((t, i) => ({ ...t, id: 'HOJA-' + (i + 1), fechaInicio: t.fechaInicio === null ? null : T.isoDeMs(t.fechaInicio), fechaFin: t.fechaFin === null ? null : T.isoDeMs(t.fechaFin) }));
    res.json({ ok: true, origen: 'hoja', info: Store.getInfo(), tarifas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Copia la hoja al panel (reemplaza todo el tarifario del panel).
router.post('/tarifario/importar-hoja', async (req, res) => {
  if (sinPermiso(req, res)) return;
  try {
    const n = Store.reemplazarDesdeFilasMotor(T.cargarTarifario(await S.leerTarifarioCrudo()));
    res.json({ ok: true, total: n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const exigirPropio = async (req, res, next) => {
  if (sinPermiso(req, res)) return;
  try { await sembrarSiVacio(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  next();
};
router.post('/tarifario/tarifas', exigirPropio, (req, res) => {
  try { res.json({ ok: true, tarifa: Store.crear(req.body || {}) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.put('/tarifario/tarifas/:id', exigirPropio, (req, res) => {
  try {
    const t = Store.actualizar(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ ok: false, error: 'Tarifa no encontrada' });
    res.json({ ok: true, tarifa: t });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.delete('/tarifario/tarifas/:id', exigirPropio, (req, res) => {
  if (!Store.eliminar(req.params.id)) return res.status(404).json({ ok: false, error: 'Tarifa no encontrada' });
  res.json({ ok: true });
});

// Prueba de tarifa: qué se pagaría por una ruta con estos datos (misma lógica del Estado de Pago).
router.post('/tarifario/probar', async (req, res) => {
  const { ct, zona, tipoRuta, patente, vehiculo, terminados, total, fecha, origen } = req.body || {};
  if (!ct || !fecha) return res.status(400).json({ ok: false, error: 'Falta el CT o la fecha' });
  try {
    const [crudo, agp, fer] = await Promise.all([Store.hayTarifarioPropio() ? null : S.leerTarifarioCrudo(), S.leerMapaAGP(), S.leerFeriados()]);
    const tarifario = Store.hayTarifarioPropio() ? Store.paraMotor() : T.cargarTarifario(crudo);
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
