const { Router } = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const store = require('./cencoStore');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

function leerExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

// ─── Zonas (polígonos) ──────────────────────────────────────────────────────
router.get('/zonas', (_req, res) => {
  res.json({ ok: true, zonas: store.getZonas() });
});

router.post('/zonas/importar', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
  let rows;
  try { rows = leerExcel(req.file.buffer); }
  catch (e) { return res.status(400).json({ ok: false, error: 'No se pudo leer el Excel: ' + e.message }); }
  const resultado = store.importarPoligonos(rows);
  res.json({ ok: true, ...resultado });
});

// ─── Mapa Grupo de polígono → Sala ──────────────────────────────────────────
router.get('/salas', (_req, res) => {
  res.json({ ok: true, mapa: store.getMapaSalas() });
});
router.put('/salas/:grupo', (req, res) => {
  const { sala } = req.body || {};
  if (!sala) return res.status(400).json({ ok: false, error: 'Falta la sala' });
  const mapa = store.setSalaDeGrupo(decodeURIComponent(req.params.grupo), sala);
  res.json({ ok: true, mapa });
});

// ─── Tarifas por zona + Asegurados ──────────────────────────────────────────
router.get('/tarifas', (_req, res) => {
  res.json({ ok: true, tarifas: store.getTarifas(), asegurados: store.getAsegurados() });
});

router.post('/tarifas/importar', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo' });
  let rows;
  try { rows = leerExcel(req.file.buffer); }
  catch (e) { return res.status(400).json({ ok: false, error: 'No se pudo leer el Excel: ' + e.message }); }
  const resultado = store.importarTarifas(rows);
  res.json({ ok: true, ...resultado });
});

router.put('/tarifas/:id', (req, res) => {
  const { lunSab, domFestivo, vigenciaInicio, vigenciaFin } = req.body || {};
  const tarifa = store.actualizarTarifa(req.params.id, { lunSab, domFestivo, vigenciaInicio, vigenciaFin });
  if (!tarifa) return res.status(404).json({ ok: false, error: 'Tarifa no encontrada' });
  res.json({ ok: true, tarifa });
});

// ─── Resolución de tarifa por punto (prueba de despacho) ───────────────────
router.get('/resolver', (req, res) => {
  const { sala, lat, lng, fecha, esDomFestivo } = req.query;
  const resultado = store.resolverTarifa({
    sala,
    lat: Number(lat),
    lng: Number(lng),
    fecha: fecha || null,
    esDomFestivo: esDomFestivo === undefined ? undefined : esDomFestivo === 'true',
  });
  res.json(resultado);
});

module.exports = router;
