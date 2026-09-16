require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const QRCode     = require('qrcode');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const ENV_PATH = path.join(__dirname, '..', '.env');

const { leerArchivo }                              = require('../src/leerArchivo');
const { agruparPorPatente }                        = require('../src/agruparPorPatente');
const { generarMensaje }                           = require('../src/generarMensaje');
const { cargarContactos, cargarNombres, limpiarCache, cargarDesdeEnv } = require('../config/contactos');
const { leerDevoluciones, marcarFilas,
        asegurarEncabezados, leerConsolidado,
        escribirTelefonos }                        = require('../src/googleSheets');
const { leerConciliaciones, leerGeosort,
        buscarFechaRuta }                          = require('../src/googleSheetsConciliaciones');
const { generarMensajeConciliacion }               = require('../src/generarMensajeConciliacion');

const emailRoutes     = require('../src/onboarding/emailRoutes');
const whatsappRoutes  = require('../src/onboarding/whatsappRoutes');
const campaignsRoutes = require('../src/onboarding/campaignsRoutes');
const templatesRoutes = require('../src/onboarding/templatesRoutes');

const { publicRouter: turnosPublicRoutes, adminRouter: turnosAdminRoutes } = require('../src/turnos/turnosRoutes');

const altasRoutes = require('../src/onboarding/altasRoutes');
const altasStore  = require('../src/onboarding/altasStore');
const { sincronizarAltasOB } = require('../src/onboarding/altasSync');

const cencoRoutes = require('../src/tarifario/cencoRoutes');
const cencoPagoRoutes = require('../src/tarifario/cencoPagoRoutes');

const DELAY_MS   = 5000;
const PORT       = process.env.PORT || 3000;
const USA_SHEETS = !!process.env.GOOGLE_SHEET_ID;
const DATA_DIR    = process.env.DATA_DIR   || path.join(__dirname, '..', 'data');
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, '..', '.wwebjs_auth');
const MANUAL_PATH = path.join(DATA_DIR, 'contactos_manual.json');

// Cargar overrides manuales desde disco persistente al arrancar
function loadManualContacts() {
  try {
    const data = JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf8'));
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
      process.env[k] = v;
      n++;
    }
    if (n) console.log(`[Manual] ${n} número(s) cargados desde ${MANUAL_PATH}`);
  } catch {}
}
loadManualContacts();

// Escribir google-credentials.json desde variable de entorno (para Render/cloud)
if (process.env.GOOGLE_CREDENTIALS_B64) {
  const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH ||
    path.join(__dirname, '..', 'config', 'google-credentials.json'));
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  if (!fs.existsSync(credPath)) {
    fs.writeFileSync(credPath, Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8'));
    console.log('Credenciales de Google escritas desde variable de entorno');
  }
}

// ─── Cache consolidado ────────────────────────────────────────────────────────
let _consolidadoCache  = null;
let _consolidadoCacheTs = 0;
const CONSOLIDADO_TTL  = 5 * 60 * 1000; // 5 minutos

async function obtenerContactos() {
  const ahora = Date.now();
  if (_consolidadoCache && (ahora - _consolidadoCacheTs) < CONSOLIDADO_TTL) {
    return _consolidadoCache;
  }
  try {
    const deSheet      = await leerConsolidado(); // sheet nuevo — fuente de verdad
    const csvContactos = cargarContactos();       // CSV (base, menor prioridad)
    const envOverrides = cargarDesdeEnv();        // .env manual (mayor prioridad)
    // Prioridad: .env > sheet > CSV
    _consolidadoCache  = { ...csvContactos, ...deSheet, ...envOverrides };
    _consolidadoCacheTs = ahora;
    console.log(`Contactos actualizados: ${Object.keys(_consolidadoCache).length} patentes`);
  } catch (e) {
    console.error('No se pudo leer consolidado, usando cache anterior:', e.message);
    if (!_consolidadoCache) _consolidadoCache = cargarContactos();
  }
  return _consolidadoCache;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const PANEL_USER = process.env.PANEL_USER     || 'admin';
const PANEL_PASS = process.env.PANEL_PASSWORD || 'changeme';
const USERS_PATH = path.join(DATA_DIR, 'users.json');

function hashPwd(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// Sesiones del panel — persistidas en disco para sobrevivir reinicios
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
function loadSessions() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))); }
  catch { return new Map(); }
}
function saveSessions(map) {
  try {
    const obj = {};
    map.forEach((v, k) => { obj[k] = v; });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch {}
}
const sessions = loadSessions();

function readUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return Array.isArray(raw.users) ? raw.users : [];
  } catch { return []; }
}

function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify({ users }, null, 2), 'utf8');
}

function migrateLegacyPwd(pwd) {
  // Si no es un hash SHA-256 (64 hex), es plaintext legado — hashearlo
  return /^[a-f0-9]{64}$/.test(pwd) ? pwd : hashPwd(pwd);
}

const ALL_SECTIONS = ['finanzas', 'onboarding', 'operaciones', 'capacitacion', 'turnos', 'perfiles'];

function loginUser(username, password) {
  const users = readUsers();
  const hashed = hashPwd(password);
  const u = users.find(x => x.username === username && migrateLegacyPwd(x.password) === hashed);
  if (u) {
    // Migrar contraseña legacy a hash si es necesario
    if (!/^[a-f0-9]{64}$/.test(u.password)) {
      u.password = hashed;
      writeUsers(users);
    }
    return { id: u.id, username: u.username, name: u.name, role: u.role, sections: u.sections || [] };
  }
  if (username === PANEL_USER && password === PANEL_PASS)
    return { id: '0', username: PANEL_USER, name: 'Admin', role: 'admin', sections: [] };
  return null;
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const idx = c.indexOf('=');
    if (idx > 0) cookies[c.slice(0, idx).trim()] = decodeURIComponent(c.slice(idx + 1).trim());
  });
  return cookies;
}

function getSession(req) { return sessions.get(parseCookies(req).token); }

function requireAuth(req, res, next) {
  if (getSession(req)) return next();
  res.redirect('/login');
}

function requireAuthApi(req, res, next) {
  const session = getSession(req);
  if (session) { req.session = session; return next(); }
  res.status(401).json({ ok: false, error: 'No autenticado' });
}

function requireAdmin(req, res, next) {
  if (getSession(req)?.role === 'admin') return next();
  res.status(403).json({ ok: false, error: 'Acceso restringido' });
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.set('io', io);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// Manejador de JSON malformado — evita que Express devuelva HTML en errores de parseo
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ ok: false, error: 'JSON inválido' });
  next(err);
});

// ─── Login (rutas publicas) ───────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Diagnóstico de datos — verifica que DATA_DIR y los archivos LMS existan
app.get('/api/lms/health', (req, res) => {
  const files = ['lms_conductores.json','lms_contenido.json','lms_progreso.json','lms_logs.json','sessions.json'];
  const info = {
    DATA_DIR,
    disk_mounted: fs.existsSync(DATA_DIR),
    files: {},
    uptime_minutes: Math.floor(process.uptime() / 60),
    node_env: process.env.NODE_ENV || 'development',
  };
  files.forEach(f => {
    const p = path.join(DATA_DIR, f);
    try {
      const stat = fs.statSync(p);
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
      info.files[f] = { exists: true, bytes: stat.size, entries: count };
    } catch {
      info.files[f] = { exists: false };
    }
  });
  res.json(info);
});

// ─── LMS público (conductores acceden sin login del panel) ───────────────────
app.get('/lms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'capacitacion', 'lms.html'));
});

// Auth del admin del LMS — token determinístico derivado del password (sobrevive reinicios)
const LMS_AP = process.env.LMS_AP || 'karri2026';
const lmsAdminToken = crypto.createHash('sha256').update('lms_admin:' + LMS_AP).digest('hex');
app.post('/api/lms/admin-login', (req, res) => {
  if (req.body?.password !== LMS_AP) return res.json({ ok: false, error: 'Contraseña incorrecta' });
  // Cookie válida 8h; el token es siempre el mismo para este password
  res.setHeader('Set-Cookie', `lms_admin=${lmsAdminToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${8*3600}`);
  res.json({ ok: true });
});
function requireLmsAdmin(req, res, next) {
  if (getSession(req)) return next();
  // Usar parseCookies (no req.cookies — no hay cookie-parser instalado)
  if (parseCookies(req).lms_admin === lmsAdminToken) return next();
  res.status(401).json({ ok: false, error: 'No autorizado' });
}

const LMS_FILE = path.join(DATA_DIR, 'lms_conductores.json');
const LMS_DEFAULT = { "12345678-9":"falabella","98765432-1":"mercadolibre","11111111-1":"tottus","22222222-2":"jumbo" };

function readLmsCond() {
  try { return JSON.parse(fs.readFileSync(LMS_FILE, 'utf8')); } catch { return LMS_DEFAULT; }
}
function writeLmsCond(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LMS_FILE, JSON.stringify(data));
}

// Público: el celular del conductor lo consume para saber a qué convenio pertenece su RUT
app.get('/api/lms/conductores', (req, res) => {
  res.json(readLmsCond());
});

// ─── Turnos: Karriers acceden sin login del panel (identificación por RUT) ────
app.get('/turnos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'turnos', 'tomar.html'));
});
app.use('/api/turnos/public', turnosPublicRoutes);

// Protegido: requiere sesión del panel O cookie lms_admin
app.post('/api/lms/conductores', requireLmsAdmin, (req, res) => {
  if (typeof req.body !== 'object' || Array.isArray(req.body))
    return res.json({ ok: false, error: 'Formato inválido' });
  writeLmsCond(req.body);
  res.json({ ok: true });
});

// Contenido LMS: estructura de módulos + videos + preguntas
const LMS_CONTENT_FILE = path.join(DATA_DIR, 'lms_contenido.json');
app.get('/api/lms/contenido', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(LMS_CONTENT_FILE, 'utf8'))); }
  catch { res.json({}); }
});
app.post('/api/lms/contenido', requireLmsAdmin, (req, res) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LMS_CONTENT_FILE, JSON.stringify(req.body));
  res.json({ ok: true });
});

// Progreso por conductor — público (el celular lee y escribe)
const LMS_PROG_FILE = path.join(DATA_DIR, 'lms_progreso.json');
function readLmsProg() {
  try { return JSON.parse(fs.readFileSync(LMS_PROG_FILE, 'utf8')); } catch { return {}; }
}
app.get('/api/lms/progreso', requireLmsAdmin, (req, res) => res.json(readLmsProg()));
app.get('/api/lms/progreso/:rut', (req, res) => {
  res.json(readLmsProg()[req.params.rut] || {});
});
app.post('/api/lms/progreso/:rut', (req, res) => {
  const prog = readLmsProg();
  prog[req.params.rut] = req.body;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LMS_PROG_FILE, JSON.stringify(prog));
  res.json({ ok: true });
});

// Logs de quizzes — público (conductor escribe desde su celular, admin lee)
const LMS_LOGS_FILE = path.join(DATA_DIR, 'lms_logs.json');
function readLmsLogs() {
  try { return JSON.parse(fs.readFileSync(LMS_LOGS_FILE, 'utf8')); } catch { return []; }
}
app.get('/api/lms/logs', requireLmsAdmin, (req, res) => {
  res.json(readLmsLogs());
});
app.post('/api/lms/logs', (req, res) => {
  const logs = readLmsLogs();
  logs.unshift(req.body);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LMS_LOGS_FILE, JSON.stringify(logs.slice(0, 2000)));
  res.json({ ok: true });
});

const SECTION_HOME = {
  finanzas:    '/',
  onboarding:  '/onboarding/resumen.html',
  operaciones: '/operaciones/tarifario.html',
  capacitacion: '/capacitacion/index.html',
  turnos:      '/turnos/dashboard.html',
  perfiles:    '/perfiles.html',
};

const PAGE_SECTION = {
  '/':                            'finanzas',
  '/index.html':                  'finanzas',
  '/conciliaciones.html':         'finanzas',
  '/onboarding/resumen.html':     'onboarding',
  '/onboarding/email.html':       'onboarding',
  '/onboarding/whatsapp.html':    'onboarding',
  '/onboarding/altas.html':            'onboarding',
  '/onboarding/kpi.html':              'onboarding',
  '/operaciones/tarifario.html':       'operaciones',
  '/operaciones/estado-pago.html':     'operaciones',
  '/capacitacion/index.html':          'capacitacion',
  '/capacitacion/lms.html':            'capacitacion',
  '/turnos/dashboard.html':            'turnos',
  '/turnos/tiendas.html':              'turnos',
  '/turnos/planificacion.html':        'turnos',
  '/turnos/karriers.html':             'turnos',
  '/turnos/asignaciones.html':         'turnos',
  '/turnos/asistencia.html':           'turnos',
  '/turnos/configuracion.html':        'turnos',
  '/perfiles.html':                    'perfiles',
};

app.post('/login', (req, res) => {
  const { user, password } = req.body;
  const session = loginUser(user, password);
  if (session) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, session);
    saveSessions(sessions);
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict`);
    const sections = session.role === 'admin' ? ALL_SECTIONS : (session.sections || []);
    return res.redirect(SECTION_HOME[sections[0]] || '/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  const token = parseCookies(req).token;
  if (token) { sessions.delete(token); saveSessions(sessions); }
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

// Proxy de imagen para el logo (sin auth, permite canvas sin CORS)
app.get('/api/logo-proxy', async (req, res) => {
  try {
    const r = await fetch('https://res.cloudinary.com/dkkab5dea/image/upload/v1780809949/Karri_2.1_ng9gss.png');
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch { res.status(502).end(); }
});

// ─── Rutas protegidas ─────────────────────────────────────────────────────────
app.use(requireAuth);

// Redirige si el usuario no tiene acceso a la sección de la página pedida
app.use((req, res, next) => {
  const section = PAGE_SECTION[req.path];
  if (!section) return next();
  const s = getSession(req);
  if (!s) return next();
  const sections = s.role === 'admin' ? ALL_SECTIONS : (s.sections || []);
  if (!sections.includes(section)) {
    return res.redirect(SECTION_HOME[sections[0]] || '/');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── API: sesión actual ───────────────────────────────────────────────────────
app.get('/api/me', requireAuthApi, (req, res) => {
  const s = getSession(req);
  const sections = s.role === 'admin' ? ALL_SECTIONS : (s.sections || []);
  res.json({ ok: true, id: s.id, username: s.username, name: s.name, role: s.role, sections });
});

// ─── API: gestión de usuarios (solo admin) ────────────────────────────────────
app.get('/api/perfiles/usuarios', requireAuthApi, requireAdmin, (req, res) => {
  const users = readUsers().map(({ password: _, ...u }) => u);
  res.json(users);
});

app.post('/api/perfiles/usuarios', requireAuthApi, requireAdmin, (req, res) => {
  const { name, username, password, role, sections = [] } = req.body;
  if (!name || !username || !password) return res.json({ ok: false, error: 'Faltan campos requeridos' });
  if (!['admin', 'advanced', 'beginner'].includes(role)) return res.json({ ok: false, error: 'Rol inválido' });
  if (role === 'beginner' && sections.length !== 1)
    return res.json({ ok: false, error: 'Beginner debe tener exactamente 1 sección' });
  if (role === 'advanced' && sections.length < 2)
    return res.json({ ok: false, error: 'Advanced debe tener al menos 2 secciones' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.json({ ok: false, error: 'El usuario ya existe' });
  const newUser = { id: Date.now().toString(), name, username, password: hashPwd(password), role, sections: role === 'admin' ? [] : sections };
  users.push(newUser);
  writeUsers(users);
  const { password: _, ...safe } = newUser;
  res.json({ ok: true, user: safe });
});

app.put('/api/perfiles/usuarios/:id', requireAuthApi, requireAdmin, (req, res) => {
  const { name, username, password, role, sections } = req.body;
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.json({ ok: false, error: 'Usuario no encontrado' });
  if (role && !['admin', 'advanced', 'beginner'].includes(role)) return res.json({ ok: false, error: 'Rol inválido' });
  if (username && username !== users[idx].username && users.find(u => u.username === username))
    return res.json({ ok: false, error: 'El nombre de usuario ya está en uso' });
  const newRole = role || users[idx].role;
  const newSections = sections !== undefined ? sections : (users[idx].sections || []);
  if (newRole === 'beginner' && newSections.length !== 1)
    return res.json({ ok: false, error: 'Beginner debe tener exactamente 1 sección' });
  if (newRole === 'advanced' && newSections.length < 2)
    return res.json({ ok: false, error: 'Advanced debe tener al menos 2 secciones' });
  if (name)     users[idx].name     = name;
  if (username) users[idx].username = username;
  if (password) users[idx].password = hashPwd(password);
  if (role)     users[idx].role     = role;
  users[idx].sections = newRole === 'admin' ? [] : newSections;
  writeUsers(users);
  res.json({ ok: true });
});

app.delete('/api/perfiles/usuarios/:id', requireAuthApi, requireAdmin, (req, res) => {
  if (req.params.id === '1') return res.json({ ok: false, error: 'No puedes eliminar el usuario principal' });
  const users    = readUsers();
  const filtered = users.filter(u => u.id !== req.params.id);
  if (filtered.length === users.length) return res.json({ ok: false, error: 'Usuario no encontrado' });
  writeUsers(filtered);
  res.json({ ok: true });
});

// ─── API: onboarding ─────────────────────────────────────────────────────────
app.use('/api/ob/email',     requireAuthApi, emailRoutes);
app.use('/api/ob/whatsapp',  requireAuthApi, whatsappRoutes);
app.use('/api/ob/campaigns', requireAuthApi, campaignsRoutes);
app.use('/api/ob/templates', requireAuthApi, templatesRoutes);
app.use('/api/ob/altas',     requireAuthApi, altasRoutes);

// ─── API: turnos (administración, solo panel) ─────────────────────────────────
app.use('/api/turnos/admin', requireAuthApi, turnosAdminRoutes);

// ─── API: tarifario Cenco (por polígono) ──────────────────────────────────────
app.use('/api/tarifario/cenco', requireAuthApi, cencoRoutes);
app.use('/api/tarifario/cenco/pago', requireAuthApi, cencoPagoRoutes);

// ─── Estado global ────────────────────────────────────────────────────────────
let waClient           = null;
let waEstado           = 'desconectado';
let mensajes           = [];
let _reconectarAuto    = true;
let _reconectarTimer   = null;

// ─── Cargar datos (Google Sheets o CSV local) ─────────────────────────────────
async function cargarDatos() {
  const contactos = await obtenerContactos();
  const nombres   = cargarNombres();
  let filas, rowMap = {};

  if (USA_SHEETS) {
    const registros = await leerDevoluciones();
    filas = registros.map(r => r.data);

    const { normalizarPatente } = require('../config/contactos');
    for (const r of registros) {
      const p = normalizarPatente(r.data['PATENTE']);
      if (!rowMap[p]) rowMap[p] = { indices: [], tabName: r.tabName };
      rowMap[p].indices.push(r.rowIndex);
    }

    const tabName = registros[0]?.tabName;
    if (tabName) await asegurarEncabezados(tabName).catch(() => {});

    console.log(`Datos leidos desde Google Sheets (${filas.length} filas)`);
  } else {
    filas = await leerArchivo();
    console.log(`Datos leidos desde archivo local`);
  }

  const grupos = agruparPorPatente(filas);
  mensajes = [];
  const telefonosAEscribir = [];

  for (const [patente, filasPatente] of grupos.entries()) {
    const primera         = filasPatente[0];
    const telefonoSheet    = (primera['TELEFONO'] || '').trim();
    const telefonoContacto = contactos[patente] || null;
    // Consolidado siempre tiene prioridad sobre columna P
    const numero           = telefonoContacto || telefonoSheet || null;

    // Si el consolidado tiene teléfono y difiere de col. P → sobrescribir en el Sheet
    if (USA_SHEETS && telefonoContacto && telefonoContacto !== telefonoSheet && rowMap[patente]) {
      for (const rowIndex of rowMap[patente].indices) {
        telefonosAEscribir.push({ rowIndex, tabName: rowMap[patente].tabName, telefono: telefonoContacto });
      }
    }

    mensajes.push({
      patente,
      numero,
      nombre:     nombres[patente] || null,
      folios:     filasPatente.length,
      monto:      Number(String(primera['MONTO MULTA (CLP)'] || '0').replace(/[^0-9.-]/g, '')),
      mensaje:    generarMensaje(patente, filasPatente),
      rowIndices: rowMap[patente]?.indices || [],
      tabName:    rowMap[patente]?.tabName || null,
      estadoSheet: primera['ESTADO_WHATSAPP'] || null,
      fechaSheet:  primera['FECHA_ENVIO']     || null,
    });
  }

  // Escribir teléfonos cruzados en columna P del Sheet (sin bloquear la respuesta)
  if (telefonosAEscribir.length > 0) {
    escribirTelefonos(telefonosAEscribir).catch(e =>
      console.error('No se pudo escribir teléfonos en Sheet:', e.message));
  }

  return mensajes;
}

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get('/api/datos', requireAuthApi, async (req, res) => {
  try {
    const datos = await cargarDatos();
    res.json({ ok: true, datos, waEstado, usaSheets: USA_SHEETS });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/mensaje/:patente', requireAuthApi, (req, res) => {
  const item = mensajes.find(m => m.patente === req.params.patente);
  if (!item) return res.json({ ok: false, error: 'Patente no encontrada' });
  res.json({ ok: true, mensaje: item.mensaje, patente: item.patente, numero: item.numero });
});

app.post('/api/whatsapp/conectar', requireAuthApi, (req, res) => {
  if (waEstado === 'listo') return res.json({ ok: true, estado: 'ya conectado' });
  iniciarWhatsApp();
  res.json({ ok: true, estado: 'iniciando' });
});

app.post('/api/whatsapp/desconectar', requireAuthApi, async (req, res) => {
  _reconectarAuto = false;
  if (_reconectarTimer) { clearTimeout(_reconectarTimer); _reconectarTimer = null; }
  if (waClient) {
    await waClient.logout().catch(() => {});
    waClient = null;
  }
  // Borrar archivos de sesión para que el próximo "Conectar WA" muestre QR fresco
  fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
  waEstado = 'desconectado';
  io.emit('wa_estado', { estado: 'desconectado' });
  res.json({ ok: true });
});

function readManualContacts() {
  try { return JSON.parse(fs.readFileSync(MANUAL_PATH, 'utf8')); } catch { return {}; }
}
function writeManualContacts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANUAL_PATH, JSON.stringify(data, null, 2), 'utf8');
}

app.post('/api/contactos/manual', requireAuthApi, async (req, res) => {
  const { patente, telefono } = req.body || {};
  if (!patente) return res.json({ ok: false, error: 'Patente requerida' });
  const tel = String(telefono || '').replace(/[+\s\-]/g, '');
  if (!/^\d{10,15}$/.test(tel))
    return res.json({ ok: false, error: 'Número inválido — usa formato 56912345678' });
  const clave = `PATENTE_${patente.toUpperCase()}`;
  // Guardar en disco persistente
  const data = readManualContacts();
  data[clave] = tel;
  writeManualContacts(data);
  // Mantener en process.env para sesión actual
  process.env[clave] = tel;
  const datos = await cargarDatos();
  io.emit('datos_actualizados', { datos });
  res.json({ ok: true, patente, telefono: tel });
});

app.delete('/api/contactos/manual/:patente', requireAuthApi, async (req, res) => {
  const clave = `PATENTE_${req.params.patente.toUpperCase()}`;
  const data = readManualContacts();
  delete data[clave];
  writeManualContacts(data);
  delete process.env[clave];
  const datos = await cargarDatos();
  io.emit('datos_actualizados', { datos });
  res.json({ ok: true });
});

app.post('/api/upload/contactos', requireAuthApi, (req, res) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = path.join(DATA_DIR, 'contactos_conductores.csv');
  const ws   = fs.createWriteStream(dest);
  req.pipe(ws);
  ws.on('finish', async () => {
    limpiarCache();
    const datos = await cargarDatos();
    io.emit('datos_actualizados', { datos });
    res.json({ ok: true });
  });
  ws.on('error', (e) => res.status(500).json({ ok: false, error: e.message }));
});

app.post('/api/enviar', requireAuthApi, async (req, res) => {
  const { patentes } = req.body;
  if (waEstado !== 'listo') return res.json({ ok: false, error: 'WhatsApp no conectado' });
  const lista = patentes?.length > 0
    ? mensajes.filter(m => patentes.includes(m.patente))
    : mensajes;
  res.json({ ok: true, total: lista.length });
  enviarConProgreso(lista);
});

// ─── Conciliaciones ───────────────────────────────────────────────────────────
let _geosortCache   = null;
let _geosortCacheTs = 0;
const GEOSORT_TTL   = 10 * 60 * 1000;

async function obtenerGeosort() {
  const ahora = Date.now();
  if (_geosortCache && (ahora - _geosortCacheTs) < GEOSORT_TTL) return _geosortCache;
  try {
    _geosortCache   = await leerGeosort();
    _geosortCacheTs = ahora;
  } catch (e) {
    console.error('Error leyendo geosort:', e.message);
    if (!_geosortCache) _geosortCache = {};
  }
  return _geosortCache;
}

let mensajesConciliaciones = [];

async function cargarDatosConciliaciones() {
  const contactos = await obtenerContactos();
  const nombres   = cargarNombres();
  const geosort   = await obtenerGeosort();
  const registros = await leerConciliaciones();

  const grupos = new Map();
  for (const r of registros) {
    const ppuNorm = r.data.PPU; // ya normalizado en leerConciliaciones
    if (!ppuNorm) continue;
    if (!grupos.has(ppuNorm)) {
      grupos.set(ppuNorm, { filas: [], rowIndices: [], tabName: r.tabName });
    }
    const g = grupos.get(ppuNorm);
    g.filas.push(r.data);
    g.rowIndices.push(r.rowIndex);
  }

  mensajesConciliaciones = [];
  for (const [ppuNorm, { filas, rowIndices, tabName }] of grupos.entries()) {
    const numero      = contactos[ppuNorm] || null;
    const fechasRuta  = filas.map(f => buscarFechaRuta(f, geosort, ppuNorm));
    mensajesConciliaciones.push({
      patente:    ppuNorm,
      numero,
      nombre:     nombres[ppuNorm] || null,
      items:      filas.length,
      mensaje:    generarMensajeConciliacion(ppuNorm, filas, fechasRuta),
      rowIndices,
      tabName,
    });
  }
  return mensajesConciliaciones;
}

app.get('/api/conciliaciones/datos', requireAuthApi, async (req, res) => {
  try {
    const datos = await cargarDatosConciliaciones();
    res.json({ ok: true, datos, waEstado });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/conciliaciones/mensaje/:patente', requireAuthApi, (req, res) => {
  const item = mensajesConciliaciones.find(m => m.patente === decodeURIComponent(req.params.patente));
  if (!item) return res.json({ ok: false, error: 'Patente no encontrada' });
  res.json({ ok: true, mensaje: item.mensaje, patente: item.patente, numero: item.numero });
});

app.post('/api/conciliaciones/enviar', requireAuthApi, async (req, res) => {
  if (waEstado !== 'listo') return res.json({ ok: false, error: 'WhatsApp no conectado' });
  const { patentes } = req.body;
  const lista = patentes?.length > 0
    ? mensajesConciliaciones.filter(m => patentes.includes(m.patente))
    : mensajesConciliaciones;
  res.json({ ok: true, total: lista.length });
  enviarConciliacionesConProgreso(lista);
});

async function enviarConciliacionesConProgreso(lista) {
  io.emit('envio_inicio', { total: lista.length });
  let enviados = 0;
  for (let i = 0; i < lista.length; i++) {
    const { patente, numero, mensaje } = lista[i];
    if (!numero) {
      io.emit('envio_log', { patente, ok: false, msg: 'Sin numero — no enviado', i: i + 1, total: lista.length });
      continue;
    }
    try {
      await waClient.sendMessage(`${numero}@s.whatsapp.net`, { text: mensaje });
      io.emit('envio_log', { patente, ok: true, numero, msg: 'Enviado', i: i + 1, total: lista.length });
      enviados++;
    } catch (err) {
      io.emit('envio_log', { patente, ok: false, numero, msg: `Error: ${err.message}`, i: i + 1, total: lista.length });
    }
    if (i < lista.length - 1) await sleep(DELAY_MS);
  }
  io.emit('envio_fin', { total: lista.length, enviados });
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function iniciarWhatsApp() {
  if (waEstado !== 'desconectado') return;
  _reconectarAuto = true;
  waEstado = 'conectando';
  io.emit('wa_estado', { estado: 'conectando' });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth:               state,
      printQRInTerminal:  false,
      logger:             pino({ level: 'silent' }),
    });

    waClient = sock;
    app.set('waClient', sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        waEstado = 'qr';
        io.emit('wa_estado', { estado: 'qr', qr: await QRCode.toDataURL(qr) });
      }
      if (connection === 'open') {
        waEstado = 'listo';
        io.emit('wa_estado', { estado: 'listo' });
        console.log('WhatsApp listo');
      }
      if (connection === 'close') {
        const code      = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        waClient  = null;
        app.set('waClient', null);
        waEstado  = 'desconectado';
        io.emit('wa_estado', { estado: 'desconectado' });
        if (loggedOut) {
          // Sesión revocada desde el teléfono — limpiar credenciales para que el próximo QR sea fresco
          fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
          console.log('WhatsApp: sesión cerrada remotamente, credenciales eliminadas');
        } else if (_reconectarAuto) {
          console.log('Reconectando WhatsApp...');
          if (_reconectarTimer) clearTimeout(_reconectarTimer);
          _reconectarTimer = setTimeout(() => { _reconectarTimer = null; iniciarWhatsApp(); }, 3000);
        }
      }
    });
  } catch (err) {
    console.error('Error iniciando WhatsApp:', err.message);
    waEstado = 'desconectado';
    waClient = null;
    io.emit('wa_estado', { estado: 'error', msg: err.message });
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function limpiarArchivosLocales() {
  const archivos = ['devoluciones.csv', 'devoluciones.xlsx'];
  const eliminados = [];

  for (const nombre of archivos) {
    const ruta = path.join(DATA_DIR, nombre);
    if (fs.existsSync(ruta)) {
      fs.unlinkSync(ruta);
      eliminados.push(nombre);
    }
  }

  if (eliminados.length > 0) {
    console.log(`Archivos locales eliminados: ${eliminados.join(', ')}`);
    io.emit('envio_log', { patente: '—', ok: true, msg: `Archivos locales eliminados: ${eliminados.join(', ')}` });
  }
}

async function enviarConProgreso(lista) {
  io.emit('envio_inicio', { total: lista.length });

  let enviados = 0;
  let esEnvioTotal = lista.length === mensajes.length;

  for (let i = 0; i < lista.length; i++) {
    const { patente, numero, mensaje, rowIndices, tabName } = lista[i];

    if (!numero) {
      io.emit('envio_log', { patente, ok: false, msg: 'Sin numero — no enviado', i: i + 1, total: lista.length });
      if (USA_SHEETS && rowIndices.length && tabName) {
        marcarFilas(tabName, rowIndices, 'SIN NÚMERO').catch(e =>
          console.error(`No se pudo marcar Sheet para ${patente}:`, e.message));
      }
      continue;
    }

    try {
      await waClient.sendMessage(`${numero}@s.whatsapp.net`, { text: mensaje });
      io.emit('envio_log', { patente, ok: true, numero, msg: 'Enviado', i: i + 1, total: lista.length });
      enviados++;

      if (USA_SHEETS && rowIndices.length && tabName) {
        marcarFilas(tabName, rowIndices, 'ENVIADO').catch(e =>
          console.error(`No se pudo marcar Sheet para ${patente}:`, e.message));
      }
    } catch (err) {
      io.emit('envio_log', { patente, ok: false, numero, msg: `Error: ${err.message}`, i: i + 1, total: lista.length });
    }

    if (i < lista.length - 1) await sleep(DELAY_MS);
  }

  io.emit('envio_fin', { total: lista.length, enviados });

  if (esEnvioTotal && enviados > 0) {
    limpiarArchivosLocales();
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';
  const token  = parseCookies({ headers: { cookie } }).token;
  if (token && sessions.has(token)) return next();
  next(new Error('No autenticado'));
});

io.on('connection', (socket) => socket.emit('wa_estado', { estado: waEstado }));

// ─── Start ────────────────────────────────────────────────────────────────────
// ─── Limpieza automática ──────────────────────────────────────────────────────
const CLEANUP_META      = path.join(DATA_DIR, 'cleanup_meta.json');
const TWELVE_MONTHS_MS  = 12 * 30 * 24 * 60 * 60 * 1000;
const TWO_MONTHS_MS     = 2  * 30 * 24 * 60 * 60 * 1000;
const CLEANUP_CYCLE_MS  = TWELVE_MONTHS_MS; // revisar cada 12 meses

function runCleanup() {
  const now = Date.now();
  const cutoff12 = new Date(now - TWELVE_MONTHS_MS);
  const cutoff2  = new Date(now - TWO_MONTHS_MS);
  const results = [];

  // 1. Campañas completadas/fallidas con más de 12 meses
  const campFile = path.join(DATA_DIR, 'campaigns.json');
  try {
    const db = JSON.parse(fs.readFileSync(campFile, 'utf8'));
    const before = db.campaigns.length;
    db.campaigns = db.campaigns.filter(c =>
      !['completed','failed'].includes(c.status) || new Date(c.createdAt) >= cutoff12
    );
    fs.writeFileSync(campFile, JSON.stringify(db, null, 2));
    results.push(`campaigns: ${before - db.campaigns.length} eliminadas`);
  } catch {}

  // 2. Logs LMS con más de 12 meses
  const logsFile = path.join(DATA_DIR, 'lms_logs.json');
  try {
    const logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
    const before = logs.length;
    const filtered = logs.filter(l => new Date(l.ts || l.fecha || 0) >= cutoff12);
    fs.writeFileSync(logsFile, JSON.stringify(filtered, null, 2));
    results.push(`lms_logs: ${before - filtered.length} eliminados`);
  } catch {}

  // 3. Sesiones expiradas del panel (más de 8 horas)
  const SESSION_TTL = 8 * 60 * 60 * 1000;
  try {
    const sessObj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const before = Object.keys(sessObj).length;
    const filtered = {};
    for (const [k, v] of Object.entries(sessObj)) {
      if (now - (v.createdAt || 0) < SESSION_TTL) filtered[k] = v;
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(filtered));
    results.push(`sessions: ${before - Object.keys(filtered).length} expiradas eliminadas`);
  } catch {}

  // 4. Archivos temporales de uploads con más de 2 meses
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  try {
    let uCount = 0;
    for (const f of fs.readdirSync(uploadsDir)) {
      const fp = path.join(uploadsDir, f);
      if (fs.statSync(fp).mtimeMs < now - TWO_MONTHS_MS) {
        fs.unlinkSync(fp);
        uCount++;
      }
    }
    results.push(`uploads: ${uCount} archivos eliminados`);
  } catch {}

  // Guardar timestamp de última limpieza
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CLEANUP_META, JSON.stringify({ lastCleanup: new Date().toISOString(), results }));
  console.log(`[Cleanup] Limpieza completada: ${results.join(' · ')}`);
}

function scheduleCleanup() {
  try {
    const meta = JSON.parse(fs.readFileSync(CLEANUP_META, 'utf8'));
    const elapsed = Date.now() - new Date(meta.lastCleanup).getTime();
    if (elapsed >= CLEANUP_CYCLE_MS) {
      console.log('[Cleanup] Han pasado 12 meses — ejecutando limpieza...');
      runCleanup();
    } else {
      const days = Math.floor((CLEANUP_CYCLE_MS - elapsed) / (24 * 60 * 60 * 1000));
      console.log(`[Cleanup] Próxima limpieza en ~${days} día(s)`);
    }
  } catch {
    console.log('[Cleanup] Primera ejecución — guardando fecha de inicio para ciclo de 12 meses');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLEANUP_META, JSON.stringify({ lastCleanup: new Date().toISOString(), results: ['inicio'] }));
  }
  // Revisar cada 24h si ya tocó limpiar
  setInterval(() => {
    try {
      const meta = JSON.parse(fs.readFileSync(CLEANUP_META, 'utf8'));
      if (Date.now() - new Date(meta.lastCleanup).getTime() >= CLEANUP_CYCLE_MS) {
        console.log('[Cleanup] 12 meses cumplidos — ejecutando limpieza...');
        runCleanup();
      }
    } catch { runCleanup(); }
  }, 24 * 60 * 60 * 1000);
}

// ─── Sincronización "Consolidado Altas OB" (cada 12h, resistente a reinicios) ──
const ALTAS_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 horas
const ALTAS_SYNC_CHECK_MS    = 10 * 60 * 1000;       // revisa cada 10 min si ya toca

function scheduleAltasSync() {
  const ejecutarSiCorresponde = () => {
    const ultima = altasStore.getSyncLog()[0];
    const elapsed = ultima ? Date.now() - new Date(ultima.ejecutadoAt).getTime() : Infinity;
    if (elapsed < ALTAS_SYNC_INTERVAL_MS) return;
    console.log('[Altas OB] Ejecutando sincronización programada...');
    sincronizarAltasOB().catch(e => console.error('[Altas OB] Error en sincronización programada:', e.message));
  };
  ejecutarSiCorresponde(); // por si el plazo se cumplió mientras el server estaba caído
  setInterval(ejecutarSiCorresponde, ALTAS_SYNC_CHECK_MS);
}

server.listen(PORT, () => {
  console.log(`\nPanel de control: http://localhost:${PORT}`);
  console.log(`Fuente de datos: ${USA_SHEETS ? 'Google Sheets' : 'archivo local CSV'}`);
  console.log(`Usuario del panel: ${PANEL_USER}`);
  // Diagnóstico de disco — visible en los logs de Render al arrancar
  console.log(`\n[LMS] DATA_DIR: ${DATA_DIR}`);
  const diskOk = fs.existsSync(DATA_DIR);
  console.log(`[LMS] Disco montado en ${DATA_DIR}: ${diskOk ? 'SÍ ✓' : 'NO ✗ — los datos son efímeros'}`);
  if (diskOk) {
    const lmsFiles = ['lms_conductores.json','lms_contenido.json','lms_progreso.json','lms_logs.json'];
    lmsFiles.forEach(f => {
      const p = path.join(DATA_DIR, f);
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      console.log(`[LMS]   ${f}: ${exists ? `${size} bytes` : 'no existe (se creará al primer guardado)'}`);
    });
  }
  console.log('');
  scheduleCleanup();
  scheduleAltasSync();
});
