const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const csv     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'queue.json');
const AUTH_PATH = '/app/.wwebjs_auth';

function removeLocks(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) removeLocks(full);
      else if (['SingletonLock','SingletonCookie','SingletonSocket'].includes(e.name)) {
        fs.unlinkSync(full);
        console.log(`[INIT] Supprimé : ${full}`);
      }
    }
  } catch(e) { console.log('[INIT] removeLocks error:', e.message); }
}

removeLocks(AUTH_PATH);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: 'uploads/' });

let state = {
  qr: null, ready: false,
  queue: [], running: false, paused: false,
  log: [], stats: { sent: 0, failed: 0, skipped: 0 }
};

function loadQueue() {
  if (fs.existsSync(DATA_FILE)) {
    try { state.queue = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e) {}
  }
}
function saveQueue() {
  if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(state.queue, null, 2));
}
function addLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log = state.log.slice(0, 200);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}
loadQueue();

function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      timeout: 120000,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
      ]
    }
  });
}

let client = createClient();
let retryCount = 0;
const MAX_RETRIES = 10;

function bindClientEvents(c) {
  c.on('qr', async (qr) => {
    retryCount = 0;
    state.qr = await qrcode.toDataURL(qr);
    state.ready = false;
    addLog('QR Code généré — scannez-le sur le dashboard', 'warn');
  });
  c.on('ready', () => {
    retryCount = 0;
    state.ready = true; state.qr = null;
    addLog('WhatsApp connecté et prêt ✅', 'success');
  });
  c.on('disconnected', (reason) => {
    state.ready = false; state.running = false;
    addLog(`WhatsApp déconnecté : ${reason}`, 'error');
    scheduleRetry(8000);
  });
  c.on('auth_failure', (msg) => addLog(`Erreur auth : ${msg}`, 'error'));
}

function scheduleRetry(delay) {
  if (retryCount >= MAX_RETRIES) {
    addLog(`❌ Trop de tentatives (${MAX_RETRIES}), arrêt.`, 'error');
    return;
  }
  retryCount++;
  const wait = delay || Math.min(10000 * retryCount, 60000);
  addLog(`🔄 Nouvelle tentative dans ${wait/1000}s (${retryCount}/${MAX_RETRIES})`, 'warn');
  setTimeout(() => {
    removeLocks(AUTH_PATH);
    client = createClient();
    bindClientEvents(client);
    client.initialize().catch(err => {
      addLog(`Retry ${retryCount} échoué : ${err.message}`, 'error');
      scheduleRetry();
    });
  }, wait);
}

bindClientEvents(client);
client.initialize().catch(err => {
  addLog(`Erreur initialisation : ${err.message}`, 'error');
  console.error(err);
  scheduleRetry(15000);
});

const MIN_DELAY_S = parseInt(process.env.MIN_DELAY_S || '45');
const MAX_DELAY_S = parseInt(process.env.MAX_DELAY_S || '120');
function randomDelay() {
  const ms = (MIN_DELAY_S + Math.random() * (MAX_DELAY_S - MIN_DELAY_S)) * 1000;
  addLog(`⏳ Pause anti-ban : ${(ms/1000).toFixed(0)}s`, 'info');
  return new Promise(r => setTimeout(r, ms));
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  addLog('🚀 Bot démarré', 'success');
  while (state.queue.some(c => c.status === 'pending')) {
    if (state.paused) { await new Promise(r => setTimeout(r, 3000)); continue; }
    const contact = state.queue.find(c => c.status === 'pending');
    if (!contact) break;
    contact.status = 'processing';
    saveQueue();
    try {
      const number = contact.phone.replace(/\D/g, '');
      const chatId = `${number}@c.us`;
      const exists = await client.isRegisteredUser(chatId);
      if (!exists) {
        contact.status = 'skipped'; state.stats.skipped++;
        addLog(`⏭️ Non inscrit WhatsApp : +${number}`, 'warn');
      } else {
        const message = contact.message || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋';
        await client.sendMessage(chatId, message);
        contact.status = 'done'; state.stats.sent++;
        addLog(`✅ Envoyé à +${number}`, 'success');
        await randomDelay();
      }
    } catch (err) {
      contact.status = 'failed'; state.stats.failed++;
      addLog(`❌ Erreur ${contact.phone} : ${err.message}`, 'error');
    }
    saveQueue();
  }
  state.running = false;
  addLog('🏁 Queue terminée', 'success');
}

app.get('/api/status', (req, res) => res.json({
  ready: state.ready, qr: state.qr, running: state.running, paused: state.paused,
  stats: state.stats,
  pending: state.queue.filter(c => c.status === 'pending').length,
  total: state.queue.length,
  log: state.log.slice(0, 50)
}));

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const records = csv.parse(content, { columns: true, skip_empty_lines: true });
    let added = 0;
    for (const row of records) {
      const phone = (row.telephone || row.phone || row['Telephone'] || Object.values(row)[0] || '').replace(/\D/g,'');
      if (!phone || phone.length < 8) continue;
      if (state.queue.find(c => c.phone === phone)) continue;
      state.queue.push({ phone, status: 'pending', message: req.body.message || process.env.DEFAULT_MESSAGE || 'Bonjour ! 👋', addedAt: new Date().toISOString() });
      added++;
    }
    saveQueue();
    fs.unlinkSync(req.file.path);
    addLog(`📥 Import CSV : ${added} contacts ajoutés`, 'success');
    res.json({ ok: true, added });
  } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/export', (req, res) => {
  const rows = state.queue.map(c => ({ telephone: c.phone, statut: c.status, ajoute_le: c.addedAt }));
  const out = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="export_contacts.csv"');
  res.send(out);
});

app.post('/api/start', (req, res) => {
  if (!state.ready) return res.status(400).json({ ok: false, error: 'WhatsApp non connecté' });
  state.paused = false; runQueue();
  res.json({ ok: true });
});

app.post('/api/pause', (req, res) => {
  state.paused = !state.paused;
  addLog(state.paused ? '⏸️ Pause' : '▶️ Reprise', 'warn');
  res.json({ ok: true, paused: state.paused });
});

app.post('/api/reset', (req, res) => {
  state.queue.forEach(c => { if(c.status !== 'done') c.status = 'pending'; });
  state.stats = { sent: 0, failed: 0, skipped: 0 };
  saveQueue(); addLog('🔄 Queue réinitialisée', 'warn');
  res.json({ ok: true });
});

app.post('/api/clear', (req, res) => {
  state.queue = []; state.stats = { sent: 0, failed: 0, skipped: 0 };
  saveQueue(); addLog('🗑️ Queue vidée', 'warn');
  res.json({ ok: true });
});

app.post('/api/fix-locks', (req, res) => {
  removeLocks(AUTH_PATH);
  res.json({ ok: true, msg: 'Locks supprimés' });
});

app.get('/api/export-group/:name', async (req, res) => {
  if (!state.ready) return res.status(400).json({ ok: false, error: 'Non connecté' });
  const chats = await client.getChats();
  const group = chats.find(c => c.isGroup && c.name === req.params.name);
  if (!group) return res.status(404).json({ ok: false, error: 'Groupe introuvable' });
  const rows = group.participants.map(p => ({ telephone: `+${p.id.user}`, admin: p.isAdmin ? 'Oui' : 'Non' }));
  const out = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${group.name}.csv"`);
  res.send(out);
});

app.get('/api/groups', async (req, res) => {
  if (!state.ready) return res.json([]);
  const chats = await client.getChats();
  res.json(chats.filter(c => c.isGroup).map(c => ({ name: c.name, count: c.participants?.length || 0 })));
});

app.listen(PORT, () => console.log(`WhatsApp Manager → http://localhost:${PORT}`));
