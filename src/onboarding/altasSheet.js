const { google } = require('googleapis');
const path = require('path');

// "Consolidado Altas OB" — valores por defecto tomados del link que se
// compartió; se pueden sobrescribir con ALTAS_OB_SHEET_ID / ALTAS_OB_SHEET_GID
// si algún día cambia de planilla.
const DEFAULT_SHEET_ID = '1pHVpNMirkUmjp4jHsAPsSOFRRMRbE2e9cY6xVSDM8jo';
const DEFAULT_SHEET_GID = '0';

function getAuth() {
  const keyFile = path.resolve(
    process.env.GOOGLE_CREDENTIALS_PATH ||
    path.join(__dirname, '..', '..', 'config', 'google-credentials.json')
  );
  return new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function obtenerNombreHoja(sheetId, gid) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  let res;
  try {
    res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  } catch (e) {
    if (e.code === 404 || e.message?.includes('not found'))
      throw new Error(`Sheet no encontrado (${sheetId}). Verifica el ID.`);
    if (e.code === 403)
      throw new Error(`Sin permiso para leer "Consolidado Altas OB" (${sheetId}). Comparte la planilla con el correo de la Service Account (el mismo que usan las otras hojas) como Lector.`);
    throw e;
  }
  const tabs = res.data.sheets.map(s => `${s.properties.title} (gid=${s.properties.sheetId})`);
  const hoja = res.data.sheets.find(s => s.properties.sheetId === parseInt(gid));
  if (!hoja) throw new Error(`Pestaña gid=${gid} no encontrada. Pestañas disponibles: ${tabs.join(', ')}`);
  return hoja.properties.title;
}

// Quita tildes/mayúsculas/símbolos para comparar encabezados con tolerancia
function normalizarClave(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function buscarColumna(headers, alias) {
  const headersNorm = headers.map(normalizarClave);
  const aliasNorm = alias.map(normalizarClave);
  return headersNorm.findIndex(h => aliasNorm.includes(h));
}

// "juan pérez soto" / "JUAN PEREZ SOTO" → "Juan Pérez Soto"
function normalizarNombre(nombre) {
  return String(nombre || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Solo dígitos + K, para comparar RUTs sin importar puntos/guión/mayúsculas
function limpiarRut(rut) {
  return String(rut || '').toUpperCase().replace(/[^0-9K]/g, '');
}

// Formato de presentación: 12345678-9
function formatearRut(rut) {
  const limpio = limpiarRut(rut);
  if (limpio.length < 2) return String(rut || '').trim();
  return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

/**
 * Lee "Consolidado Altas OB" y devuelve las filas normalizadas.
 * Las columnas se ubican por nombre de encabezado (tolerante a mayúsculas,
 * tildes y variantes como "Sala / Bodega"), no por posición fija.
 */
async function leerAltasOB() {
  const sheetId  = (process.env.ALTAS_OB_SHEET_ID  || DEFAULT_SHEET_ID).trim();
  const sheetGid = (process.env.ALTAS_OB_SHEET_GID || DEFAULT_SHEET_GID).trim();

  const tabName = await obtenerNombreHoja(sheetId, sheetGid);
  const sheets  = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A:Z`,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || '').trim());

  const iNombre    = buscarColumna(headers, ['nombre', 'nombres', 'conductor', 'nombre completo']);
  const iRut       = buscarColumna(headers, ['rut']);
  const iPatente   = buscarColumna(headers, ['patente', 'ppu']);
  const iCorreo    = buscarColumna(headers, ['correo', 'email', 'e-mail', 'mail']);
  const iCelular   = buscarColumna(headers, ['celular', 'telefono', 'fono', 'numero']);
  const iCliente   = buscarColumna(headers, ['cliente']);
  const iSala      = buscarColumna(headers, ['sala/bodega', 'sala / bodega', 'sala', 'bodega']);
  const iTipoAuto  = buscarColumna(headers, ['tipo de auto', 'tipo auto', 'tipo de vehiculo', 'tipo vehiculo']);
  const iFechaAlta = buscarColumna(headers, ['fecha de alta', 'fecha alta', 'fecha']);
  // La columna Estatus es la K (índice 10, 0-based) — se usa como respaldo
  // si el encabezado de esa columna no calza exactamente con "Estado"/"Estatus".
  const iEstadoPorNombre = buscarColumna(headers, ['estatus', 'estado']);
  const iEstado = iEstadoPorNombre !== -1 ? iEstadoPorNombre : 10;

  const faltantes = [];
  if (iNombre === -1) faltantes.push('Nombre');
  if (iRut === -1) faltantes.push('Rut');
  if (faltantes.length) {
    throw new Error(`No se encontraron las columnas ${faltantes.join(', ')} en "Consolidado Altas OB". Encabezados leídos: ${headers.join(', ')}`);
  }

  const get = (row, i) => (i === -1 || row[i] === undefined ? '' : String(row[i]).trim());

  return rows.slice(1)
    .map(row => ({
      nombre:     normalizarNombre(get(row, iNombre)),
      rut:        formatearRut(get(row, iRut)),
      rutKey:     limpiarRut(get(row, iRut)),
      patente:    get(row, iPatente),
      correo:     get(row, iCorreo),
      celular:    get(row, iCelular),
      cliente:    get(row, iCliente),
      salaBodega: get(row, iSala),
      tipoAuto:   get(row, iTipoAuto),
      fechaAlta:  get(row, iFechaAlta),
      estado:     get(row, iEstado),
    }))
    .filter(r => r.rutKey); // ignorar filas vacías
}

module.exports = { leerAltasOB, normalizarNombre, limpiarRut, formatearRut };
