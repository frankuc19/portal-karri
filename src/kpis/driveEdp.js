// Acceso de Drive para traer el "Consolidado EDP" (producción). El archivo es
// un xlsx subido a un Shared Drive, no una hoja nativa, así que se lee con la
// Drive API (no con Sheets). La misma Service Account de las otras hojas debe
// tener acceso de LECTOR al Shared Drive / archivo, y el proyecto debe tener
// habilitada la Drive API.
const { google } = require('googleapis');
const path = require('path');

// Shared Drive donde viven los Consolidado_EDP (override con EDP_DRIVE_ID).
const DEFAULT_DRIVE_ID = '0AHTyQqizJKr9Uk9PVA';
// Prefijo de nombre de los consolidados.
const NAME_PREFIX = 'Consolidado_EDP';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getAuth() {
  const keyFile = path.resolve(
    process.env.GOOGLE_CREDENTIALS_PATH ||
    path.join(__dirname, '..', '..', 'config', 'google-credentials.json')
  );
  return new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

function drive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// Fecha fin del rango embebida en el nombre: "..._a_2026-11-19" → "2026-11-19"
function fechaFinDeNombre(name) {
  const m = String(name || '').match(/_a_(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// Fecha inicio: "Consolidado_EDP_2026-07-01_a_..." → "2026-07-01"
function fechaInicioDeNombre(name) {
  const m = String(name || '').match(/_(\d{4}-\d{2}-\d{2})_a_/);
  return m ? m[1] : '';
}

// Variantes que NO son el consolidado "oficial" más reciente.
function esVariante(name) {
  return /OLD|sin_?walmart|\(\d+\)|Operaciones/i.test(String(name || ''));
}

/**
 * Elige el archivo EDP a usar:
 *  - EDP_FILE_ID fija un archivo exacto (salta la búsqueda).
 *  - Si no, lista los "Consolidado_EDP_*.xlsx" del Shared Drive, descarta
 *    variantes, y toma el de mayor fecha-fin (desempate por modifiedTime).
 * Devuelve { id, name, modifiedTime, size }.
 */
async function elegirArchivoEdp() {
  const pin = (process.env.EDP_FILE_ID || '').trim();
  const d = drive();

  if (pin) {
    const res = await d.files.get({
      fileId: pin,
      fields: 'id, name, modifiedTime, size',
      supportsAllDrives: true,
    });
    return res.data;
  }

  const driveId = (process.env.EDP_DRIVE_ID || DEFAULT_DRIVE_ID).trim();
  const q = `name contains '${NAME_PREFIX}' and mimeType = '${XLSX_MIME}' and trashed = false`;
  const res = await d.files.list({
    q,
    corpora: 'drive',
    driveId,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    orderBy: 'modifiedTime desc',
    pageSize: 100,
    fields: 'files(id, name, modifiedTime, size)',
  });

  const candidatos = (res.data.files || []).filter(f => !esVariante(f.name));
  if (!candidatos.length) {
    throw new Error(`No se encontró ningún archivo "${NAME_PREFIX}_*.xlsx" en el Shared Drive (${driveId}). Verifica que la Service Account tenga acceso.`);
  }
  candidatos.sort((a, b) => {
    const fa = fechaFinDeNombre(a.name), fb = fechaFinDeNombre(b.name);
    if (fa !== fb) return fb.localeCompare(fa);                // 1) fecha-fin más reciente
    const ia = fechaInicioDeNombre(a.name), ib = fechaInicioDeNombre(b.name);
    if (ia !== ib) return ia.localeCompare(ib);               // 2) rango más amplio (inicio más antiguo)
    return String(b.modifiedTime).localeCompare(String(a.modifiedTime)); // 3) modificado más reciente
  });
  return candidatos[0];
}

// Descarga el xlsx elegido como Buffer.
async function descargarEdp() {
  let archivo;
  try {
    archivo = await elegirArchivoEdp();
  } catch (e) {
    if (e.code === 403) throw new Error('Sin permiso de Drive para leer el Consolidado EDP. Comparte el Shared Drive (o el archivo) con el correo de la Service Account como Lector, y habilita la Drive API.');
    if (e.code === 404) throw new Error('No se encontró el archivo EDP indicado (EDP_FILE_ID). Verifica el ID.');
    throw e;
  }

  const d = drive();
  const res = await d.files.get(
    { fileId: archivo.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return { archivo, buffer: Buffer.from(res.data) };
}

module.exports = { elegirArchivoEdp, descargarEdp };
