// Worker: parsea el xlsx del Consolidado EDP y agrega la producción por
// operador FUERA del event loop. El parseo de un xlsx de 6-10 MB con SheetJS
// es síncrono y pesado; si corriera en el hilo principal bloquearía TODO el
// panel (mismo motivo por el que las exportaciones usan worker_threads).
// El worker devuelve SOLO el agregado compacto, nunca las ~decenas de miles
// de filas, para que el hilo principal no cargue todo en memoria.
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');
const { normNombre, normPatente, normCorreo, aEntero, parseFechaDMY } = require('./norm');

// Encuentra el índice de una columna por nombre tolerante (sin tildes/símbolos)
function idx(headers, alias) {
  const norm = h => String(h || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const H = headers.map(norm);
  const A = alias.map(norm);
  return H.findIndex(h => A.includes(h));
}

try {
  const buf = Buffer.isBuffer(workerData.buffer) ? workerData.buffer : Buffer.from(workerData.buffer);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false, cellText: true });

  // Pestaña de datos: "Consolidado EDP" si existe, si no la primera.
  const sheetName = wb.SheetNames.find(n => /consolidado\s*edp/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) throw new Error('La hoja de producción está vacía.');

  const headers = rows[0].map(h => String(h || '').trim());
  const iCliente = idx(headers, ['cliente']);
  const iFecha   = idx(headers, ['fecha']);
  const iPedido  = idx(headers, ['n pedido', 'numero pedido', 'npedido', 'pedido id']);
  const iRol     = idx(headers, ['rol']);
  const iOperador = idx(headers, ['nombre operador', 'operador']);
  const iResp    = idx(headers, ['nombre responsable a pago o flotista', 'nombre responsable', 'responsable']);
  const iPatente = idx(headers, ['patente']);
  const iCorreo  = idx(headers, ['correo', 'email']);
  const iTienda  = idx(headers, ['tiendas', 'tienda']);
  const iPedidos = idx(headers, ['pedidos']);
  const iMonto   = idx(headers, ['monto total pedido', 'monto total', 'total pedido']);

  const nombreCol = iOperador !== -1 ? iOperador : iResp;
  if (nombreCol === -1) throw new Error(`No se encontró la columna de nombre del operador. Encabezados: ${headers.join(', ')}`);

  const get = (row, i) => (i === -1 || row[i] === undefined ? '' : row[i]);

  const ops = new Map();            // nombreKey -> agregado
  const clientes = new Map();       // cliente -> # filas
  let filas = 0;
  let fechaMin = null, fechaMax = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const nombre = String(get(row, nombreCol)).trim();
    const key = normNombre(nombre);
    if (!key) continue;
    filas++;

    const cliente = String(get(row, iCliente)).trim() || '—';
    clientes.set(cliente, (clientes.get(cliente) || 0) + 1);

    const fechaISO = parseFechaDMY(get(row, iFecha));
    if (fechaISO) {
      if (!fechaMin || fechaISO < fechaMin) fechaMin = fechaISO;
      if (!fechaMax || fechaISO > fechaMax) fechaMax = fechaISO;
    }

    let o = ops.get(key);
    if (!o) {
      o = {
        key, nombre,
        patentes: new Set(), correos: new Set(), clientes: new Set(),
        roles: new Set(), tiendas: new Set(), dias: new Set(),
        pedidos: 0, montoTotal: 0, primeraFecha: null, ultimaFecha: null,
      };
      ops.set(key, o);
    }
    const pat = normPatente(get(row, iPatente));     if (pat) o.patentes.add(pat);
    const cor = normCorreo(get(row, iCorreo));       if (cor) o.correos.add(cor);
    if (cliente !== '—') o.clientes.add(cliente);
    const rol = String(get(row, iRol)).trim();       if (rol) o.roles.add(rol);
    const tie = String(get(row, iTienda)).trim();    if (tie) o.tiendas.add(tie);
    o.pedidos += iPedidos !== -1 ? Math.max(1, aEntero(get(row, iPedidos))) : 1;
    o.montoTotal += aEntero(get(row, iMonto));
    if (fechaISO) {
      o.dias.add(fechaISO);
      if (!o.primeraFecha || fechaISO < o.primeraFecha) o.primeraFecha = fechaISO;
      if (!o.ultimaFecha || fechaISO > o.ultimaFecha) o.ultimaFecha = fechaISO;
    }
  }

  const operadores = [...ops.values()].map(o => ({
    key: o.key, nombre: o.nombre,
    patentes: [...o.patentes], correos: [...o.correos], clientes: [...o.clientes],
    roles: [...o.roles], tiendas: [...o.tiendas],
    pedidos: o.pedidos, montoTotal: o.montoTotal,
    diasActivos: o.dias.size,
    primeraFecha: o.primeraFecha, ultimaFecha: o.ultimaFecha,
  }));

  parentPort.postMessage({
    ok: true,
    sheetName,
    filas,
    rango: { desde: fechaMin, hasta: fechaMax },
    clientes: [...clientes.entries()].map(([cliente, filas]) => ({ cliente, filas })).sort((a, b) => b.filas - a.filas),
    operadores,
  });
} catch (e) {
  parentPort.postMessage({ ok: false, __error: e.message || String(e) });
}
