// Normalización compartida para cruzar Altas ↔ Producción (EDP).
// Debe ser idéntica en el worker (nombres de producción) y en el join
// (nombres de altas), por eso vive en un solo módulo sin dependencias.

// "JUAN  Pérez-Soto" → "JUAN PEREZ SOTO" (sin tildes, A-Z0-9 y espacios)
function normNombre(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "LGGS-53 " → "LGGS53"; "pk1773" → "PK1773"
function normPatente(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Extrae el primer correo válido de un texto sucio:
// "eacanto@transvip.cl 13664312-6" → "eacanto@transvip.cl"
function normCorreo(s) {
  const m = String(s || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

// Convierte montos en pesos a entero, tolerando separadores de miles y
// comillas/espacios: "14861" → 14861, "8,193" → 8193. (Los montos del EDP
// son pesos enteros; se descartan todos los no-dígitos salvo el signo.)
function aEntero(v) {
  if (typeof v === 'number') return Math.round(v);
  const limpio = String(v == null ? '' : v).replace(/[^0-9-]/g, '');
  const n = parseInt(limpio, 10);
  return Number.isFinite(n) ? n : 0;
}

// Parsea fechas del EDP ("01/11/2026") y de Altas ("4/09/2025", "01-04-2025")
// en formato D/M/Y o D-M-Y. Devuelve 'YYYY-MM-DD' o null si no es válida.
function parseFechaDMY(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  d = parseInt(d, 10); mo = parseInt(mo, 10); y = parseInt(y, 10);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// Días entre dos 'YYYY-MM-DD' (b - a). null si alguna es inválida.
function diasEntre(aISO, bISO) {
  if (!aISO || !bISO) return null;
  const a = Date.parse(aISO + 'T00:00:00Z');
  const b = Date.parse(bISO + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

module.exports = { normNombre, normPatente, normCorreo, aEntero, parseFechaDMY, diasEntre };
