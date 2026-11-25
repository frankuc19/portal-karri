const http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),XLSX=require('xlsx'),url=require('url');
const {Worker}=require('worker_threads');
const DD=fs.mkdtempSync(path.join(os.tmpdir(),'km2-')); process.env.DATA_DIR=DD;
const H=['Cliente','Fecha','N° Pedido','Rol','Nombre Responsable a Pago o Flotista','Nombre Operador','Patente','Correo','Tiendas','Pedidos','Formato','Tipo de pedido','Base ($)','SKUs','Monto SKU ($)','Km','Monto Km ($)','Monto Total Pedido','Cálculo'];
const tiendas=['Valparaíso','La Florida','Linares','Talca - 79'];
const roles=['Picker','Shopper','Driver'];
const aoa=[H]; const altas=[];
for(let i=0;i<30;i++){
  const nom='OPERADOR PRUEBA '+String(i+1).padStart(2,'0');
  const rol=roles[i%3], tie=tiendas[i%4];
  const produce=i%4!==0;
  if(produce){ const nd=2+(i%6); for(let d=0;d<nd;d++){ const dt=new Date(Date.UTC(2026,6+(d%5),1+((i*3+d*7)%27))); aoa.push(['Walmart',dt,'40'+i+''+d,rol,nom,nom,'PK'+(2800+i),nom.toLowerCase().replace(/ /g,'')+'@g.com',tie,1,'semana','Single',1800,10,700,0,0,2000+i*100,'Base']); } }
  altas.push({id:'a'+i,nombre:nom,rut:(10000000+i)+'-'+(i%10),patente:'PK'+(2800+i),cliente:'Walmart '+rol,salaBodega:tie,fechaAlta:'0'+(1+i%9)+'/07/2026',estado:'Alta'});
}
// un alta de otro cliente
altas.push({id:'ax',nombre:'LUIS TOTTUS',rut:'9-9',patente:'ZZ1',cliente:'Drivers Tottus',salaBodega:'Colina',fechaAlta:'01/08/2026',estado:'Alta'});
const ws=XLSX.utils.aoa_to_sheet(aoa,{cellDates:true});
const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Consolidado EDP');
const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx',cellDates:true});
const w=new Worker(path.join(__dirname,'src/kpis/edpWorker.js'),{workerData:{buffer}});
w.once('message',agg=>{ w.terminate();
  fs.writeFileSync(path.join(DD,'kpis_produccion.json'),JSON.stringify({ok:true,formato:2,actualizadoAt:new Date().toISOString(),fuente:{id:'T',nombre:'Consolidado_EDP_2026-07-01_a_2026-11-25.xlsx'},hoja:agg.sheetName,filas:agg.filas,rango:agg.rango,clientes:agg.clientesStats,dims:agg.dims,grano:agg.grano}));
  fs.writeFileSync(path.join(DD,'onboarding_altas.json'),JSON.stringify(altas));
  const {construirDashboard}=require('./src/kpis/kpis');
  const ME={ok:true,role:'admin',username:'admin',name:'Admin',sections:['onboarding','operaciones','kpis','capacitacion','turnos','perfiles']};
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
  http.createServer((req,res)=>{
    const u=url.parse(req.url,true); const p=u.pathname;
    if(p==='/api/me'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(ME));}
    if(p==='/api/kpis/dashboard'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(construirDashboard(u.query)));}
    if(p==='/api/logo-proxy'){res.statusCode=502;return res.end();}
    let fp=path.join('panel/public',p==='/'?'index.html':p);
    if(!fs.existsSync(fp)){res.statusCode=404;return res.end('nf');}
    res.setHeader('content-type',types[path.extname(fp)]||'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
  }).listen(8792,()=>console.log('mock2 8792 ready'));
});
w.once('error',e=>{console.error(e);process.exit(1);});
