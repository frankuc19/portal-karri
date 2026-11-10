// Hilo aparte que arma el .xlsx. XLSX.write es síncrono y, con planillas
// grandes (ej: Estado de Pago de todo un periodo), puede tardar segundos;
// si corriera en el hilo principal congelaría TODO el panel para todos los
// usuarios a la vez (y, si el bloqueo pasa el health check, Render mata la
// instancia). Acá ese costo vive fuera del event loop principal.
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');

try {
  const wb = XLSX.utils.book_new();
  for (const hoja of workerData.sheets) {
    const ws = hoja.aoa
      ? XLSX.utils.aoa_to_sheet(hoja.aoa)
      : XLSX.utils.json_to_sheet(hoja.rows || []);
    if (hoja.cols) ws['!cols'] = hoja.cols;
    XLSX.utils.book_append_sheet(wb, ws, hoja.name || 'Hoja1');
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  parentPort.postMessage(buffer);
} catch (e) {
  parentPort.postMessage({ __error: e.message || String(e) });
}
