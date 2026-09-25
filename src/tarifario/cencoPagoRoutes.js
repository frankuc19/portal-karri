const { Router } = require('express');
const XLSX = require('xlsx');
const {
  iniciarProcesoPago, obtenerEstadoJob, obtenerResultadoJob,
  obtenerHistorialCorridas, obtenerCorridaGuardada, eliminarCorridaGuardada,
} = require('./cencoPago');

const router = Router();

function filasParaExcel(detalle) {
  return detalle.map(f => ({
    'ID Orden': f.ordenId ?? f.orden_id, Fecha: f.fecha, Sala: f.sala || '', Zona: f.zona || '',
    'Tipo Día': f.tipoDia ?? f.tipo_dia ?? '', Estado: f.estado,
    'Tarifa Base': f.tarifaBase ?? f.tarifa_base, Bono: f.bono,
    Multiplicador: f.multiplicador, 'Pago Conductor': f.montoPagoConductor ?? f.monto_pago_conductor,
    Motivo: f.motivo || '',
  }));
}

router.post('/procesar', (req, res) => {
  const { fechaInicio, fechaFin, festivos } = req.body || {};
  if (!fechaInicio || !fechaFin) return res.status(400).json({ ok: false, error: 'Falta fechaInicio o fechaFin' });
  try {
    const jobId = iniciarProcesoPago({ fechaInicio, fechaFin, festivos: Array.isArray(festivos) ? festivos : [] });
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/estado/:jobId', (req, res) => {
  const estado = obtenerEstadoJob(req.params.jobId);
  if (!estado) return res.status(404).json({ ok: false, error: 'Proceso no encontrado (puede haber expirado).' });
  res.json({ ok: true, estado });
});

router.get('/resultado/:jobId', (req, res) => {
  const resultado = obtenerResultadoJob(req.params.jobId);
  if (!resultado) return res.status(404).json({ ok: false, error: 'Resultado no disponible todavía.' });

  if (req.query.formato === 'excel') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasParaExcel(resultado.detalle)), 'Estado de Pago');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="estado_pago_cenco.xlsx"');
    return res.send(buf);
  }

  res.json({ ok: true, ...resultado });
});

// ─── Historial guardado en Supabase ────────────────────────────────────────
router.get('/historial', async (req, res) => {
  const { desde, hasta } = req.query;
  const r = await obtenerHistorialCorridas({ desde, hasta });
  if (r.error) return res.status(r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 500).json({ ok: false, error: r.error });
  res.json({ ok: true, corridas: r.corridas });
});

router.get('/historial/:corridaId', async (req, res) => {
  const r = await obtenerCorridaGuardada(req.params.corridaId);
  if (r.error) return res.status(r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 404).json({ ok: false, error: r.error });

  if (req.query.formato === 'excel') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasParaExcel(r.detalle)), 'Estado de Pago');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="estado_pago_cenco_${r.corrida.fecha_inicio}_${r.corrida.fecha_fin}.xlsx"`);
    return res.send(buf);
  }

  res.json({ ok: true, corrida: r.corrida, detalle: r.detalle });
});

// Borrar es irreversible: el rol Beginner solo consulta.
router.delete('/historial/:corridaId', async (req, res) => {
  if (req.session?.role === 'beginner') return res.status(403).json({ ok: false, error: 'Tu perfil no puede borrar cálculos guardados.' });
  const r = await eliminarCorridaGuardada(req.params.corridaId);
  if (r.error) return res.status(r.noEncontrada ? 404 : (r.error === 'SUPABASE_NO_CONFIGURADO' ? 503 : 500)).json({ ok: false, error: r.error });
  res.json({ ok: true });
});

module.exports = router;
