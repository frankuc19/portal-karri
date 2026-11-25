// Worker: parsea el xlsx del Consolidado EDP FUERA del event loop (SheetJS es
// síncrono y pesado; bloquearía todo el panel). Devuelve un detalle COMPACTO
// pre-agregado por (operador × cliente × rol × tienda × fecha) con diccionarios
// internados, para que el hilo principal pueda recomputar el tablero según los
// filtros (tiempo/tienda/rol) sin volver a parsear el archivo.
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');
const { normNombre, normPatente, normCorreo, aEntero, fechaCelda } = require('./norm');

function idx(headers, alias) {
  const norm = h => String(h || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const H = headers.map(norm);
  const A = alias.map(norm);
  return H.findIndex(h => A.includes(h));
}

// Diccionario de internado: valor -> índice estable.
function interner() {
  const m = new Map(); const arr = [];
  return { idx(v) { let i = m.get(v); if (i === undefined) { i = arr.length; m.set(v, i); arr.push(v); } return i; }, arr };
}

try {
  const buf = Buffer.isBuffer(workerData.buffer) ? workerData.buffer : Buffer.from(workerData.buffer);
  // SIN cellDates: las fechas llegan como número de serie de Excel y fechaCelda
  // las convierte en UTC (cellDates:true corre un día según la zona del server).
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => /consolidado\s*edp/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) throw new Error('La hoja de producción está vacía.');

  const headers = rows[0].map(h => String(h || '').trim());
  const iCliente  = idx(headers, ['cliente']);
  const iFecha    = idx(headers, ['fecha']);
  const iRol      = idx(headers, ['rol']);
  const iOperador = idx(headers, ['nombre operador', 'operador']);
  const iResp     = idx(headers, ['nombre responsable a pago o flotista', 'nombre responsable', 'responsable']);
  const iPatente  = idx(headers, ['patente']);
  const iCorreo   = idx(headers, ['correo', 'email']);
  const iTienda   = idx(headers, ['tiendas', 'tienda']);
  const iPedidos  = idx(headers, ['pedidos']);
  const iMonto    = idx(headers, ['monto total pedido', 'monto total', 'total pedido']);

  const nombreCol = iOperador !== -1 ? iOperador : iResp;
  if (nombreCol === -1) throw new Error(`No se encontró la columna de nombre del operador. Encabezados: ${headers.join(', ')}`);
  const get = (row, i) => (i === -1 || row[i] === undefined ? '' : row[i]);

  // Operadores (identidad para el cruce): índice estable por nombre normalizado.
  const opIndex = new Map();
  const opList = [];
  function getOpIdx(key, nombre) {
    let i = opIndex.get(key);
    if (i === undefined) { i = opList.length; opIndex.set(key, i); opList.push({ key, nombre, patentes: new Set(), correos: new Set() }); }
    return i;
  }
  const cliD = interner(), rolD = interner(), tieD = interner(), fecD = interner();
  const clientesStats = new Map();
  const granoMap = new Map();      // "op|cli|rol|tie|fec" -> [pedidos, monto]

  let filas = 0;
  let fechaMin = null, fechaMax = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const nombre = String(get(row, nombreCol)).trim();
    const key = normNombre(nombre);
    if (!key) continue;
    filas++;

    const cliente = String(get(row, iCliente)).trim() || '—';
    clientesStats.set(cliente, (clientesStats.get(cliente) || 0) + 1);
    const rol = String(get(row, iRol)).trim() || '—';
    const tienda = String(get(row, iTienda)).trim() || '—';
    const fechaISO = fechaCelda(get(row, iFecha));
    if (fechaISO) {
      if (!fechaMin || fechaISO < fechaMin) fechaMin = fechaISO;
      if (!fechaMax || fechaISO > fechaMax) fechaMax = fechaISO;
    }

    const opIdx = getOpIdx(key, nombre);
    const op = opList[opIdx];
    const pat = normPatente(get(row, iPatente));  if (pat) op.patentes.add(pat);
    const cor = normCorreo(get(row, iCorreo));     if (cor) op.correos.add(cor);

    const cliIdx = cliD.idx(cliente);
    const rolIdx = rolD.idx(rol);
    const tieIdx = tieD.idx(tienda);
    const fecIdx = fecD.idx(fechaISO || '');
    const pedidos = iPedidos !== -1 ? Math.max(1, aEntero(get(row, iPedidos))) : 1;
    const monto = aEntero(get(row, iMonto));

    const gk = opIdx + '|' + cliIdx + '|' + rolIdx + '|' + tieIdx + '|' + fecIdx;
    const acc = granoMap.get(gk);
    if (acc) { acc[0] += pedidos; acc[1] += monto; }
    else granoMap.set(gk, [pedidos, monto]);
  }

  const grano = [];
  for (const [gk, v] of granoMap) {
    const p = gk.split('|');
    grano.push([+p[0], +p[1], +p[2], +p[3], +p[4], v[0], v[1]]);
  }

  parentPort.postMessage({
    ok: true,
    sheetName,
    filas,
    rango: { desde: fechaMin, hasta: fechaMax },
    clientesStats: [...clientesStats.entries()].map(([cliente, n]) => ({ cliente, filas: n })).sort((a, b) => b.filas - a.filas),
    dims: {
      operadores: opList.map(o => ({ key: o.key, nombre: o.nombre, patentes: [...o.patentes], correos: [...o.correos] })),
      clientes: cliD.arr,
      roles: rolD.arr,
      tiendas: tieD.arr,
      fechas: fecD.arr,
    },
    grano,
  });
} catch (e) {
  parentPort.postMessage({ ok: false, __error: e.message || String(e) });
}
