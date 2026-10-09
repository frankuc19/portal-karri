const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE  = path.join(DATA_DIR, 'campaigns.json');
const TPL_FILE = path.join(DATA_DIR, 'templates.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Caché en memoria — cada campaña guarda su lista de contactos completa (el
// Excel subido, fila por fila), así que el archivo crece con cada envío.
// Sin caché, listar campañas o consultar una sola releía y re-parseaba TODO
// el archivo en cada request (mismo patrón ya corregido en turnosStore/
// altasStore/LMS). writeDb mantiene el caché al día.
let _dbCache = null;
function readDb() {
  if (_dbCache) return _dbCache;
  ensureDir();
  _dbCache = { campaigns: [] };
  if (fs.existsSync(DB_FILE)) {
    try { _dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  }
  return _dbCache;
}

function writeDb(data) {
  ensureDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  _dbCache = data;
}

function getCampaigns() { return readDb().campaigns; }
function getCampaignById(id) { return readDb().campaigns.find(c => c.id === id) || null; }

function saveCampaign(campaign) {
  const db = readDb();
  const idx = db.campaigns.findIndex(c => c.id === campaign.id);
  if (idx >= 0) db.campaigns[idx] = campaign;
  else db.campaigns.unshift(campaign);
  writeDb(db);
  return campaign;
}

function trackEmailEvent(campaignId, email, eventType) {
  const db = readDb();
  const idx = db.campaigns.findIndex(c => c.id === campaignId);
  if (idx < 0) return false;
  const listField  = eventType === 'open' ? 'openedEmails'  : 'clickedEmails';
  const countField = eventType === 'open' ? 'opened'        : 'clicked';
  if (!Array.isArray(db.campaigns[idx][listField])) db.campaigns[idx][listField] = [];
  if (!db.campaigns[idx][listField].includes(email)) {
    db.campaigns[idx][listField].push(email);
    db.campaigns[idx].stats[countField] = db.campaigns[idx][listField].length;
    writeDb(db);
  }
  return true;
}

function findCampaignByEmail(email) {
  return readDb().campaigns
    .filter(c => c.type === 'email' && Array.isArray(c.contactEmails) && c.contactEmails.includes(email))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function getOverallStats() {
  const campaigns = getCampaigns().filter(c => c.status === 'completed' || c.status === 'sending');
  const email = campaigns.filter(c => c.type === 'email');
  const wa    = campaigns.filter(c => c.type === 'whatsapp');
  const emailSent    = email.reduce((s, c) => s + (c.stats?.sent    || 0), 0);
  const emailOpened  = email.reduce((s, c) => s + (c.stats?.opened  || 0), 0);
  const emailClicked = email.reduce((s, c) => s + (c.stats?.clicked || 0), 0);
  const waSent       = wa.reduce((s, c) => s + (c.stats?.sent || 0), 0);
  const waRead       = wa.reduce((s, c) => s + (c.stats?.read || 0), 0);
  return {
    totalSent:  emailSent + waSent,
    openRate:   emailSent > 0 ? Math.round((emailOpened  / emailSent) * 100) : 0,
    clickRate:  emailSent > 0 ? Math.round((emailClicked / emailSent) * 100) : 0,
    readRate:   waSent    > 0 ? Math.round((waRead       / waSent)   * 100) : 0,
  };
}

// ── Templates ────────────────────────────────────────────────────────────────
function readTpls() {
  if (!fs.existsSync(TPL_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TPL_FILE, 'utf8')); } catch { return []; }
}
function writeTpls(list) { ensureDir(); fs.writeFileSync(TPL_FILE, JSON.stringify(list, null, 2)); }
function getTemplates() { return readTpls(); }
function saveTemplate(tpl) { const l = readTpls(); l.unshift(tpl); writeTpls(l); }
function deleteTemplate(id) { writeTpls(readTpls().filter(t => t.id !== id)); }
function getTemplateById(id) { return readTpls().find(t => t.id === id) || null; }

// ── Users ────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, '../../config/users.json');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []; }
  catch { return []; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

module.exports = {
  getCampaigns, getCampaignById, saveCampaign, trackEmailEvent,
  findCampaignByEmail, getOverallStats,
  getTemplates, saveTemplate, deleteTemplate, getTemplateById,
  readUsers, writeUsers,
};
