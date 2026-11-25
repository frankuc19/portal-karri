const express = require('express');
const router = express.Router();
const produccionStore = require('./produccionStore');
const { construirDashboard } = require('./kpis');

// Tablero completo (altas vs producción), recomputado con los filtros de la
// query: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&tienda=...&rol=...
router.get('/dashboard', (req, res) => {
  try {
    const { desde, hasta, tienda, rol } = req.query;
    res.json(construirDashboard({ desde, hasta, tienda, rol }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Estado de la fuente de producción (sin el arreglo de operadores).
router.get('/produccion/estado', (req, res) => {
  res.json({ ...produccionStore.getEstado(), refrescando: produccionStore.estaRefrescando() });
});

// Fuerza descarga + reparseo del EDP desde Drive. Devuelve el estado nuevo.
router.post('/produccion/refrescar', async (req, res) => {
  try {
    await produccionStore.refrescar();
    res.json({ ok: true, ...produccionStore.getEstado() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
