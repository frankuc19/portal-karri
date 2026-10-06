const crypto = require('crypto');
const { leerAltasOB } = require('./altasSheet');
const store = require('./altasStore');

function esAlta(estado) {
  // \b evita falsos positivos con palabras que empiecen igual (p.ej. "Altamar"),
  // pero "Alta", "ALTA", "Alta " o "Alta - pendiente firma" sí califican.
  return /^\s*alta\b/i.test(estado || '');
}

/**
 * Sincroniza "Consolidado Altas OB" hacia la sección Altas Onboarding.
 * Solo crea personas con Estatus "Alta"; nunca duplica por RUT.
 *
 * Importante: la hoja sigue listando para siempre a todo el que alguna vez
 * tuvo Estatus "Alta", así que en CADA corrida se vuelve a encontrar a la
 * gente ya importada — eso es normal y no es una alerta ("yaExistian").
 * Lo que sí es una alerta real es que el mismo RUT aparezca MÁS DE UNA VEZ
 * dentro de la propia hoja en esta misma lectura ("duplicadosEnHoja"), lo
 * que indica un problema de datos que operaciones debería revisar ahí.
 *
 * `desdeCero: true` vacía la tabla de Altas Onboarding ANTES de volver a
 * crear todo desde la hoja — así cada persona que siga en la hoja con
 * Estatus "Alta" queda con sus datos tal cual están hoy ahí, en vez de
 * arrastrar valores viejos que el sync normal nunca pisa (es solo-aditivo).
 * Esto también borra cualquier edición manual hecha en el panel, porque la
 * hoja fuente no guarda esos campos y no hay de dónde recuperarlos — se
 * vacía recién después de poder leer la hoja, para no dejar la tabla vacía
 * si la lectura falla.
 */
async function sincronizarAltasOB({ desdeCero = false } = {}) {
  let filas;
  try {
    filas = await leerAltasOB();
  } catch (e) {
    const resultado = {
      id: crypto.randomUUID(),
      ejecutadoAt: new Date().toISOString(),
      ok: false,
      error: e.message,
    };
    store.addSyncLog(resultado);
    console.error('[Altas OB] Error al leer la planilla:', e.message);
    return resultado;
  }

  if (desdeCero) store.resetAltas();

  const altas = filas.filter(f => esAlta(f.estado));

  // RUTs que aparecen más de una vez dentro de la misma hoja (esta lectura)
  const conteoEnHoja = new Map();
  for (const f of altas) conteoEnHoja.set(f.rutKey, (conteoEnHoja.get(f.rutKey) || 0) + 1);
  const rutsRepetidosEnHoja = new Set([...conteoEnHoja.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  const duplicadosEnHoja = [];
  const vistosParaReporte = new Set();
  for (const f of altas) {
    if (rutsRepetidosEnHoja.has(f.rutKey) && !vistosParaReporte.has(f.rutKey)) {
      vistosParaReporte.add(f.rutKey);
      duplicadosEnHoja.push({ rut: f.rut, nombre: f.nombre, veces: conteoEnHoja.get(f.rutKey) });
    }
  }

  let creados = 0;
  let yaExistian = 0;
  const procesadosEnEstaCorrida = new Set();

  for (const fila of altas) {
    if (procesadosEnEstaCorrida.has(fila.rutKey)) continue; // ya se procesó (era repetido dentro de la hoja)
    procesadosEnEstaCorrida.add(fila.rutKey);

    const existente = store.getAltaByRutKey(fila.rutKey);
    if (existente) {
      yaExistian++;
      continue;
    }
    store.saveAlta({
      id: crypto.randomUUID(),
      nombre: fila.nombre,
      rut: fila.rut,
      rutKey: fila.rutKey,
      celular: fila.celular,
      cliente: fila.cliente,
      salaBodega: fila.salaBodega,
      tipoAuto: fila.tipoAuto,
      fechaAlta: fila.fechaAlta,
      estado: fila.estado,
      origen: 'sheet',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    creados++;
  }

  const resultado = {
    id: crypto.randomUUID(),
    ejecutadoAt: new Date().toISOString(),
    ok: true,
    desdeCero,
    totalFilasLeidas: filas.length,
    altas: altas.length,
    creados,
    yaExistian,
    duplicadosEnHoja,
    // Muestra de valores de Estado/Estatus tal como vienen en la hoja —
    // ayuda a diagnosticar cuando "altas" da 0.
    estadosEncontrados: [...new Set(filas.map(f => f.estado).filter(Boolean))].slice(0, 20),
  };
  store.addSyncLog(resultado);
  console.log(`[Altas OB] Sincronización${desdeCero ? ' (desde 0)' : ''}: ${creados} nuevo(s), ${yaExistian} ya existían, ${duplicadosEnHoja.length} RUT repetido(s) dentro de la hoja (de ${altas.length} con estatus "Alta" / ${filas.length} filas leídas)`);
  return resultado;
}

module.exports = { sincronizarAltasOB, esAlta };
