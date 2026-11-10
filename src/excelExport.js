const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'excelExportWorker.js');

// Genera un .xlsx en un hilo aparte y devuelve el Buffer listo para enviar.
// Mueve el trabajo pesado (json_to_sheet + XLSX.write, síncronos) fuera del
// event loop principal, para que una exportación grande no deje colgado al
// resto del panel. Uso:
//   const buffer = await construirXlsx([
//     { name: 'Hoja', rows: [{ Col: 'valor' }], cols: [{ wch: 20 }] },
//     { name: 'Instrucciones', aoa: [['línea 1'], ['línea 2']] },
//   ]);
function construirXlsx(sheets) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER, { workerData: { sheets } });

    worker.once('message', (msg) => {
      settled = true;
      worker.terminate();
      if (msg && msg.__error) return reject(new Error(msg.__error));
      resolve(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
    });
    worker.once('error', (err) => { settled = true; reject(err); });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Worker de Excel terminó sin resultado (código ${code})`));
    });
  });
}

module.exports = { construirXlsx };
