const { Router } = require('express');
const XLSX = require('xlsx');
const { iniciarProcesoPago, obtenerEstadoJob, obtenerResultadoJob } = require('./cencoPago');

const router = Router();

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
    const filasExcel = resultado.detalle.map(f => ({
      'ID Orden': f.ordenId, Fecha: f.fecha, Sala: f.sala || '', Zona: f.zona || '',
      'Tipo Día': f.tipoDia || '', Estado: f.estado, 'Tarifa Base': f.tarifaBase,
      Bono: f.bono, Multiplicador: f.multiplicador, 'Pago Conductor': f.montoPagoConductor,
      Motivo: f.motivo || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasExcel), 'Estado de Pago');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="estado_pago_cenco.xlsx"');
    return res.send(buf);
  }

  res.json({ ok: true, ...resultado });
});

module.exports = router;
