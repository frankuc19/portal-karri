const { google } = require('googleapis');
const path = require('path');
const { toDateMs, isoDeMs } = require('./tarifasFalabella');

// Las pestañas "Pago Falabella" (tarifario), "AGP" (placa → tipo de vehículo),
// "Feriados CL" y "Accesos" viven en la planilla "EDP Karri Chile" — la misma
// que ya lee el token de Cencosud. Se leen en vivo en cada cálculo para que
// un cambio de tarifa se refleje sin volver a importar nada.
const SHEET_ID = process.env.FALABELLA_SHEET_ID || '17ij09IQ7uY9jcCpqhs3kgjQoJtD76RwTm-dRKl1bSng';

function getAuth() {
  const keyFile = path.resolve(
    process.env.GOOGLE_CREDENTIALS_PATH || path.join(__dirname, '..', '..', '..', 'config', 'google-credentials.json'));
  return new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
}

// Valores sin formato (números como número, fechas como serial) para no
// depender de cómo se ve la celda ni del idioma de la planilla.
async function leerPestana(nombre, rango) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${nombre}'!${rango}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    return res.data.values || [];
  } catch (e) {
    if (e.code === 403) throw new Error(`Sin permiso para leer la planilla "EDP Karri Chile". Compártela con la cuenta de servicio como Lector.`);
    if (e.code === 400 || /Unable to parse range/i.test(e.message || '')) throw new Error(`No existe la pestaña "${nombre}" en "EDP Karri Chile" (o tiene otro nombre).`);
    throw e;
  }
}

async function leerTarifarioCrudo() {
  const filas = await leerPestana('Pago Falabella', 'A:Z');
  if (filas.length < 2) throw new Error('La pestaña "Pago Falabella" está vacía.');
  return filas;
}

// Placa normalizada (sin guiones/espacios/puntos, mayúsculas) → tipo de vehículo.
async function leerMapaAGP() {
  const mapa = new Map();
  const filas = await leerPestana('AGP', 'A:B');
  if (filas.length < 2) return mapa;
  const h = filas[0].map((x) => String(x).trim().toLowerCase());
  const iPlaca = h.indexOf('placas') !== -1 ? h.indexOf('placas') : 0;
  const iTipo = h.indexOf('tipo') !== -1 ? h.indexOf('tipo') : 1;
  for (let r = 1; r < filas.length; r++) {
    const raw = filas[r][iPlaca];
    const tipo = filas[r][iTipo] != null ? String(filas[r][iTipo]).trim() : '';
    if (raw == null || raw === '') continue;
    const placa = (typeof raw === 'number' ? String(Math.round(raw)) : String(raw).trim()).replace(/[-\s.]+/g, '').toUpperCase();
    if (placa && tipo) mapa.set(placa, tipo);
  }
  return mapa;
}

// Set de fechas 'yyyy-mm-dd'. Si la pestaña no existe, el recargo aplica solo a domingos.
async function leerFeriados() {
  const set = new Set();
  let filas;
  try { filas = await leerPestana('Feriados CL', 'A:A'); } catch (e) { return { set, aviso: e.message }; }
  for (let r = 1; r < filas.length; r++) {
    const ms = toDateMs(filas[r][0]);
    if (ms !== null) set.add(isoDeMs(ms));
  }
  return { set, aviso: null };
}

// Credenciales de las fuentes (solo lectura, nunca se muestran ni se guardan).
async function leerAccesos() {
  const filas = await leerPestana('Accesos', 'A1:B20');
  const b = (n) => String((filas[n - 1] && filas[n - 1][1]) ?? '').trim();
  return { simpliUsuario: b(1), simpliClave: b(2), geosortToken: b(10), geosortCookie: b(12) };
}

module.exports = { leerTarifarioCrudo, leerMapaAGP, leerFeriados, leerAccesos };
