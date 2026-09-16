const { google } = require('googleapis');
const path = require('path');

// ─── Token de Cencosud ──────────────────────────────────────────────────────
// Un flujo de n8n (Schedule Trigger, corre solo ~2 veces al día) inicia
// sesión en el portal de Cencosud vía Browserless y guarda el access_token +
// refresh_token vigentes en la pestaña "Tokens" de la planilla "EDP Karri
// Chile" — la misma que ya usaba el script de Apps Script original
// (DESTINATION_SS_ID). No hay un webhook de n8n al que llamar: simplemente
// leemos de ahí el token más reciente en vez de gestionar el login nosotros.
const TOKENS_SHEET_ID  = '17ij09IQ7uY9jcCpqhs3kgjQoJtD76RwTm-dRKl1bSng'; // "EDP Karri Chile"
const TOKENS_SHEET_GID = '1489419787'; // pestaña "Tokens"
const ID_SERVICIO_CENCO = 'Cencosud';

const API_KEY_CENCO      = process.env.CENCO_API_KEY || '12-drf-n3f56oui-1xwg-0942-p391-y54926376vk3';
const DOWNLOAD_URL_CENCO = 'https://daas.ecomm.cencosud.com/daas-bff/v1/fulfillment/orders/list-download';
const COGNITO_CLIENT_ID  = process.env.CENCO_COGNITO_CLIENT_ID || '3pokk4rc8m28t1489h8bp6f4iv';

const STORE_CODES  = ['J843', 'E659', 'E843', '101', '407', 'J659', 'N747'];
const RETAIL_CHAIN = ['EASY_CL', 'JUMBO_CL', 'PARIS_CL', 'SISA_CL'];
const COURIER_ID   = ['270'];
const STATUS_TUPLE = [
  '10', '1002', '01', '02', '17', '04', '998',
  ['08', '9005'], ['08', '9006'],
  '03', '12', '1004', '1005', '999',
  ['08', null], ['08', '9000'], ['08', '9007'],
  ['08', '80'], ['08', '9001'], ['08', '9002'],
  ['08', '9003'], ['08', '9004'],
  '14', '09', '16', '15',
];

function getAuth() {
  const keyFile = path.resolve(
    process.env.GOOGLE_CREDENTIALS_PATH ||
    path.join(__dirname, '..', '..', 'config', 'google-credentials.json'));
  return new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
}

async function obtenerNombreHoja(sheetId, gid) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  let res;
  try { res = await sheets.spreadsheets.get({ spreadsheetId: sheetId }); }
  catch (e) {
    if (e.code === 404 || e.message?.includes('not found')) throw new Error(`Sheet de Tokens no encontrado (${sheetId}).`);
    if (e.code === 403) throw new Error(`Sin permiso para leer el Sheet de Tokens ("EDP Karri Chile"). Comparte la planilla con la Service Account (la misma que usa Altas OB / Devoluciones) como Lector.`);
    throw e;
  }
  const hoja = res.data.sheets.find(s => s.properties.sheetId === parseInt(gid, 10));
  if (!hoja) throw new Error(`Pestaña de Tokens (gid=${gid}) no encontrada en "EDP Karri Chile".`);
  return hoja.properties.title;
}

// Lee { accessToken, refreshToken } vigentes para Cencosud desde el Sheet que
// mantiene actualizado el flujo de n8n.
async function leerTokenCenco() {
  const tabName = await obtenerNombreHoja(TOKENS_SHEET_ID, TOKENS_SHEET_GID);
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: TOKENS_SHEET_ID, range: `${tabName}!A:D` });
  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error('La pestaña Tokens está vacía.');

  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const iServicio = headers.indexOf('id_servicio');
  const iAccess   = headers.indexOf('nuevo_access');
  const iRefresh  = headers.indexOf('nuevo_refresh');
  if (iServicio === -1 || iAccess === -1) {
    throw new Error(`No se encontraron las columnas id_servicio/nuevo_access en Tokens. Encabezados: ${headers.join(', ')}`);
  }

  const fila = rows.slice(1).find(r => String(r[iServicio] || '').trim().toLowerCase() === ID_SERVICIO_CENCO.toLowerCase());
  if (!fila) throw new Error(`No hay una fila "${ID_SERVICIO_CENCO}" en la pestaña Tokens.`);

  const accessToken = String(fila[iAccess] || '').trim();
  const refreshToken = iRefresh !== -1 ? String(fila[iRefresh] || '').trim() : '';
  if (!accessToken) throw new Error('El token de Cencosud en el Sheet está vacío — revisa que el flujo de n8n haya corrido.');

  return { accessToken, refreshToken };
}

// Intercambia el refresh_token por un access_token nuevo directo contra
// Cognito (igual que hacía el script de Apps Script original) — solo se usa
// en memoria para esta corrida; no se escribe de vuelta al Sheet, eso lo
// mantiene al día el flujo de n8n en su propio horario.
async function renovarTokenCognito(refreshToken) {
  if (!refreshToken) return null;
  const resp = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      ClientId: COGNITO_CLIENT_ID,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data?.AuthenticationResult?.IdToken || null;
}

// ─── Descarga de pedidos ────────────────────────────────────────────────────
const CHILE_OFFSET_HOURS = 3; // Verano (oct-mar): UTC-3 | Invierno (abr-sep): UTC-4

function fechaChileAUtcMs(fecha, esInicio) {
  const y = fecha.getUTCFullYear(), m = fecha.getUTCMonth(), d = fecha.getUTCDate();
  return esInicio
    ? Date.UTC(y, m, d, CHILE_OFFSET_HOURS, 0, 0, 0)
    : Date.UTC(y, m, d + 1, CHILE_OFFSET_HOURS, 0, 0, 0) - 1;
}

async function llamarAPICencoCsv(startMillis, endMillis, tokens) {
  const buildOptions = (t) => ({
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + t,
      apikey: API_KEY_CENCO,
      'Content-Type': 'application/json',
      Accept: 'text/csv',
      Origin: 'https://login-microfrontend.ecomm.cencosud.com',
      Referer: 'https://login-microfrontend.ecomm.cencosud.com/',
    },
    body: JSON.stringify({
      storeCodes: STORE_CODES,
      dates: { eta: { startDate: startMillis, endDate: endMillis } },
      courierId: COURIER_ID,
      retailChain: RETAIL_CHAIN,
      statusSubStatusTuple: STATUS_TUPLE,
      sort: { field: 'etas', value: 'DESC' },
    }),
  });

  let resp = await fetch(DOWNLOAD_URL_CENCO, buildOptions(tokens.accessToken));

  if ((resp.status === 401 || resp.status === 502) && tokens.refreshToken) {
    const nuevoToken = await renovarTokenCognito(tokens.refreshToken);
    if (nuevoToken) {
      tokens.accessToken = nuevoToken;
      resp = await fetch(DOWNLOAD_URL_CENCO, buildOptions(nuevoToken));
    }
  }

  if (resp.status === 200 || resp.status === 201) return await resp.text();
  return null;
}

// Regex tolerante a comas dentro de campos (ej. direcciones) — mismo
// algoritmo que el script de Apps Script, sin el swap de '.' a ',' que ahí
// era solo para mostrar bien los decimales en un Sheet en español.
function parsearCsv(csvText) {
  if (!csvText) return [];
  const re_value = /(?!\s*$)\s*(?:'([^']*(?:''[^']*)*)'|"([^"]*(?:""[^"]*)*)"|([^,\r\n\t]*))\s*(?:,|$)/g;
  const rows = [];
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const row = [];
    let match;
    re_value.lastIndex = 0;
    while ((match = re_value.exec(line)) !== null) {
      let value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[1]);
      if (value !== undefined) row.push(value.replace(/""/g, '"').trim());
      if (match.index === re_value.lastIndex) re_value.lastIndex++;
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
}

function normalizarOrdenId(rawId) {
  if (!rawId) return '';
  return String(rawId).trim().toLowerCase();
}

/**
 * Descarga pedidos día por día para el rango [fechaInicioISO, fechaFinISO]
 * (strings 'YYYY-MM-DD', hora Chile), deduplicando por ID de orden. Llama a
 * onProgreso(estado) después de cada día para poder informar avance.
 * Devuelve { header, filas, errores } — filas es un array de arrays (sin el
 * header), únicas por ID de orden.
 */
async function descargarPedidosPorRango(fechaInicioISO, fechaFinISO, onProgreso) {
  const tokens = await leerTokenCenco();

  const [y1, m1, d1] = fechaInicioISO.split('-').map(Number);
  const [y2, m2, d2] = fechaFinISO.split('-').map(Number);
  const startDate = new Date(Date.UTC(y1, m1 - 1, d1));
  const endDate   = new Date(Date.UTC(y2, m2 - 1, d2));
  const totalDias = Math.round((endDate - startDate) / 86400000) + 1;
  if (totalDias < 1) throw new Error('El rango de fechas es inválido.');

  const seen = new Set();
  let header = null;
  const filas = [];
  const errores = [];

  for (let d = 0; d < totalDias; d++) {
    const diaBase = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() + d));
    const diaLabel = diaBase.getUTCFullYear() + '-' + String(diaBase.getUTCMonth() + 1).padStart(2, '0') + '-' + String(diaBase.getUTCDate()).padStart(2, '0');
    const startMs = fechaChileAUtcMs(diaBase, true);
    const endMs   = fechaChileAUtcMs(diaBase, false);

    if (onProgreso) onProgreso({ diaActual: d + 1, totalDias, diaLabel, filasAcumuladas: filas.length, errores, finalizado: false });

    try {
      const csvText = await llamarAPICencoCsv(startMs, endMs, tokens);
      if (!csvText) { errores.push({ dia: diaLabel, motivo: 'La API de Cencosud no respondió con datos (revisa el token).' }); continue; }

      const rows = parsearCsv(csvText);
      if (rows.length <= 1) continue;
      if (!header) header = rows[0];

      for (const row of rows.slice(1)) {
        const norm = normalizarOrdenId(row[0]);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        filas.push(row);
      }
    } catch (e) {
      errores.push({ dia: diaLabel, motivo: e.message });
    }
  }

  if (onProgreso) onProgreso({ diaActual: totalDias, totalDias, diaLabel: 'Completado', filasAcumuladas: filas.length, errores, finalizado: true });

  return { header, filas, errores };
}

module.exports = { descargarPedidosPorRango, leerTokenCenco, parsearCsv, normalizarOrdenId };
