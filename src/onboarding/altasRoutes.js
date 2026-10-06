const { Router } = require('express');
const XLSX = require('xlsx');
const store = require('./altasStore');
const { sincronizarAltasOB } = require('./altasSync');

const router = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, altas: store.getAltas() });
});

router.get('/sync-log', (_req, res) => {
  res.json({ ok: true, log: store.getSyncLog() });
});

router.post('/sync', async (req, res) => {
  const desdeCero = req.body?.desdeCero === true;
  // Reiniciar y resincronizar borra toda la tabla (incluidas las ediciones
  // manuales hechas en el panel) antes de reconstruirla desde la hoja —
  // mismo nivel de permiso que las demás acciones destructivas del panel.
  if (desdeCero && req.session?.role === 'beginner') {
    return res.status(403).json({ ok: false, error: 'Tu perfil no puede reiniciar la tabla de Altas.' });
  }
  const resultado = await sincronizarAltasOB({ desdeCero });
  res.json(resultado);
});

// Excel con todas las Altas Onboarding registradas (mismas columnas que el CSV).
router.get('/export', (_req, res) => {
  const altas = store.getAltas();
  const filas = altas.map(a => ({
    Nombre: a.nombre, RUT: a.rut, Celular: a.celular, Cliente: a.cliente,
    'Sala/Bodega': a.salaBodega, 'Tipo de auto': a.tipoAuto,
    'Fecha de alta': a.fechaAlta, Estado: a.estado,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(filas);
  ws['!cols'] = [{ wch: 26 }, { wch: 13 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Altas Onboarding');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="altas_onboarding.xlsx"');
  res.send(buffer);
});

// Excel de los RUT que aparecen más de una vez dentro de la misma hoja en la
// última sincronización — problema de datos para que operaciones revise.
router.get('/sync-log/duplicados/export', (_req, res) => {
  const ultima = store.getSyncLog()[0];
  const duplicados = ultima?.duplicadosEnHoja || [];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(duplicados.map(d => ({ Nombre: d.nombre, RUT: d.rut, 'Veces en la hoja': d.veces })));
  ws['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Duplicados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="altas_duplicados.xlsx"');
  res.send(buffer);
});

router.put('/:id', (req, res) => {
  const alta = store.getAltaById(req.params.id);
  if (!alta) return res.status(404).json({ ok: false, error: 'No encontrado' });
  const { nombre, rut, celular, cliente, salaBodega, tipoAuto, fechaAlta, estado } = req.body || {};
  if (nombre !== undefined)     alta.nombre = nombre;
  if (rut !== undefined)        alta.rut = rut;
  if (celular !== undefined)    alta.celular = celular;
  if (cliente !== undefined)    alta.cliente = cliente;
  if (salaBodega !== undefined) alta.salaBodega = salaBodega;
  if (tipoAuto !== undefined)   alta.tipoAuto = tipoAuto;
  if (fechaAlta !== undefined)  alta.fechaAlta = fechaAlta;
  if (estado !== undefined)     alta.estado = estado;
  alta.updatedAt = new Date().toISOString();
  store.saveAlta(alta);
  res.json({ ok: true, alta });
});

router.delete('/:id', (req, res) => {
  store.deleteAlta(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
