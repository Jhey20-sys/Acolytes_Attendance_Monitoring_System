/* Altar Servers — Attendance Monitoring System (server)
 *
 * Two kinds of accounts:
 *  - Admin / secretary  → the admin website (/)          e.g. altarservers / altarservers123
 *  - Mass leader (user) → the mobile check-in app (/app)  e.g. 1stmass / 1stmass123
 *
 * Every server (acolyte) has a personal QR card. The leader of a Mass scans the cards of the
 * servers who came. Servers who are not on that Mass's team need a reason and stay PENDING until
 * an admin/secretary approves them. Leaders also record excuses, then submit the whole Mass report
 * at once — anyone on the team who wasn't scanned or excused is marked Absent.
 * Servers with 3 absences in a row become Inactive automatically, and Active again when scanned.
 *
 * Run:  npm install   then   npm start
 * Env:  PORT (default 3000), DATA_DIR (default ./data)
 *       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  → sync data to Supabase (see supabase/schema.sql)
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

// Settings such as SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY can live in a .env file next to this one.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* no .env file — fine */ }

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const massName = i => `${ORDINAL[i] || `#${i + 1}`} Mass`;
const ROLES = ['Elders', 'Seniors', 'Juniors'];

/* ---------------- Storage ---------------- */
function defaultSettings() {
  let timezone = 'Asia/Manila';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone; } catch (e) { /* keep default */ }
  return {
    ministry: 'Altar Servers Ministry',
    timezone,
    publicUrl: '',
    roles: ROLES.slice(),
    parishes: [
      { id: 'agusan', name: 'Agusan', masses: [{ id: 'm1', day: 0, time: '06:00' }, { id: 'm2', day: 0, time: '08:00' }, { id: 'm3', day: 0, time: '16:00' }] },
      { id: 'tablon', name: 'Tablon', masses: [{ id: 'm1', day: 0, time: '07:00' }] },
      { id: 'puerto', name: 'Puerto', masses: [{ id: 'm1', day: 0, time: '07:00' }] },
    ],
    allowManualPick: false, // "Multiple choices" — off so servers must bring their QR card
    inactiveAfter: 3,       // consecutive absences before a server becomes inactive
    meetingDay: 0,          // teams are reshuffled after the 2nd meeting (this weekday) of the month
  };
}

function normalizeSettings(s) {
  const def = defaultSettings();
  const out = { ...def, ...(s || {}) };
  if (!Array.isArray(out.roles) || !out.roles.length) out.roles = def.roles;
  if (!Array.isArray(out.parishes) || !out.parishes.length) out.parishes = def.parishes;
  out.parishes = out.parishes.filter(p => p && p.id && p.name).map(p => ({
    id: String(p.id).slice(0, 40),
    name: String(p.name).trim().slice(0, 60),
    masses: (Array.isArray(p.masses) ? p.masses : []).map((m, i) => ({
      id: /^[\w-]{1,20}$/.test(m.id || '') ? m.id : `m${i + 1}${crypto.randomBytes(2).toString('hex')}`,
      day: Math.min(6, Math.max(0, Number(m.day) || 0)),
      time: /^\d{2}:\d{2}$/.test(m.time) ? m.time : '06:00',
    })).slice(0, 8),
  }));
  out.allowManualPick = !!out.allowManualPick;
  out.inactiveAfter = Math.max(1, Math.min(20, Number(out.inactiveAfter) || 3));
  out.meetingDay = Math.max(0, Math.min(6, Number(out.meetingDay) || 0));
  return out;
}

const newCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join('');
};

function freshDb() {
  return {
    secret: crypto.randomBytes(32).toString('hex'),
    admins: [],
    leaders: [],
    sessions: {},
    version: 1,
    servers: [],
    settings: defaultSettings(),
    schedules: {},   // { parishId: [ { id, from: 'YYYY-MM-DD', generatedAt, teams: [[serverIds] per Mass] } ] }
    attendance: {},  // { 'YYYY-MM-DD#parishId#massIndex': { serverId: record } }
    submissions: {}, // { massKey: { by, at, present, excused, absent, pending } }
    notifications: [],
  };
}

function cleanServer(a, old) {
  return {
    id: String(a.id).slice(0, 40),
    name: String(a.name).trim().slice(0, 100),
    parish: String(a.parish || '').slice(0, 40),
    role: String(a.role || '').slice(0, 40),
    contact: String(a.contact || '').trim().slice(0, 100),
    active: a.active !== false,
    inactiveReason: a.active === false ? String(a.inactiveReason || 'Set by admin').slice(0, 120) : '',
    since: typeof a.since === 'string' ? a.since.slice(0, 10) : '',
    code: (old && old.code) || (/^[A-Z0-9]{6,12}$/.test(a.code || '') ? a.code : newCode()),
    created: a.created || new Date().toISOString(),
  };
}

function readLocalFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE) || !fs.statSync(DB_FILE).size) return null;
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function loadDb() { return hydrate(readLocalFile()); }

function hydrate(raw) {
  if (!raw) return freshDb();
  const db = { ...freshDb(), ...raw };
  // Upgrade from version 2 (weekly schedule + PIN check-in).
  if (Array.isArray(raw.acolytes) && !raw.servers) {
    db.servers = raw.acolytes.map(a => cleanServer({ ...a, parish: 'agusan', role: 'Juniors' }));
    db.schedules = {};
    db.attendance = {};
    delete db.acolytes; delete db.devices; delete db.permanentKey;
  }
  db.settings = normalizeSettings(raw.servers ? raw.settings : null);
  if (!Array.isArray(db.leaders)) db.leaders = [];
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[t];
  return db;
}

const db = loadDb();
function persist() {
  const json = JSON.stringify(db);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);          // local copy: instant, and a backup if Supabase is unreachable
  fs.renameSync(tmp, DB_FILE);
  supabase.queue(json);
}

/* ---------------- Supabase sync ----------------
 * The whole database is kept as one JSON row in table public.app_state (see supabase/schema.sql).
 * Uses the service_role key, so it must only ever live on this server (.env), never in the browser.
 */
const supabase = (() => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const ROW = process.env.SUPABASE_ROW_ID || 'main';
  const enabled = !!(url && key);
  const endpoint = `${url}/rest/v1/app_state`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  let pending = null, timer = null, inFlight = null, lastError = '', lastSync = null;

  async function load() {
    const res = await fetch(`${endpoint}?id=eq.${encodeURIComponent(ROW)}&select=data`, { headers });
    if (!res.ok) throw new Error(`Supabase load failed (${res.status}): ${await res.text()}`);
    const rows = await res.json();
    return rows.length ? rows[0].data : null;
  }

  async function push(json) {
    const res = await fetch(`${endpoint}?on_conflict=id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: `{"id":${JSON.stringify(ROW)},"data":${json},"updated_at":${JSON.stringify(new Date().toISOString())}}`,
    });
    if (!res.ok) throw new Error(`Supabase save failed (${res.status}): ${await res.text()}`);
  }

  async function flush() {
    if (inFlight || pending == null) return;
    const json = pending; pending = null;
    inFlight = push(json)
      .then(() => { lastSync = new Date(); if (lastError) console.log('  Supabase: back in sync.'); lastError = ''; })
      .catch(e => {
        if (pending == null) pending = json;            // keep the newest unsent copy
        if (e.message !== lastError) console.error('  ' + e.message);
        lastError = e.message;
        clearTimeout(timer); timer = setTimeout(flush, 5000); // retry
      })
      .finally(() => { inFlight = null; if (pending != null && !lastError) flush(); });
  }

  function queue(json) {
    if (!enabled) return;
    pending = json;
    clearTimeout(timer); timer = setTimeout(flush, 250);  // batch bursts of changes
  }

  async function drain() { clearTimeout(timer); await flush(); if (inFlight) await inFlight; }

  return { enabled, url, load, queue, drain, status: () => ({ enabled, lastSync, lastError }) };
})();

/* Before starting, replace the local data with what's in Supabase (or upload local data the first time). */
async function initStorage() {
  if (!supabase.enabled) { console.log('  Supabase: not configured — using the local data file only.'); return; }
  try {
    const remote = await supabase.load();
    if (remote) {
      const fresh = hydrate(remote);
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, fresh);
      console.log(`  Supabase: loaded data from ${supabase.url}`);
    } else {
      console.log(`  Supabase: table is empty — uploading the current local data to ${supabase.url}`);
    }
  } catch (e) {
    console.error(`  ${e.message}\n  Supabase: could not load — starting from the local data file; will keep trying to save.`);
  }
}

/* ---------------- Helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`; };
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function todayStr() {
  let f;
  try { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: db.settings.timezone }); }
  catch (e) { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return f.format(new Date());
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, name, value, days) {
  const secure = req.secure ? '; Secure' : '';
  const age = days > 0 ? `; Max-Age=${Math.round(days * 86400)}` : '; Max-Age=0';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`);
}

// Simple in-memory brute-force protection (per IP).
const attempts = new Map();
function limited(req, bucket, max = 10) {
  const e = attempts.get(`${bucket}:${req.ip}`);
  return !!e && e.reset > Date.now() && e.count >= max;
}
function fail(req, bucket, minutes = 15) {
  const k = `${bucket}:${req.ip}`;
  const e = attempts.get(k);
  if (!e || e.reset < Date.now()) attempts.set(k, { count: 1, reset: Date.now() + minutes * 60000 });
  else e.count++;
}

/** This computer's network addresses, real Wi-Fi/Ethernet first (virtual adapters last). */
function lanAddresses() {
  const virtual = /virtual|vbox|vmware|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal || n.address.startsWith('169.254.')) continue;
      const score = (virtual.test(name) ? 2 : 0) + (n.address.startsWith('192.168.56.') ? 2 : 0) + (/wi-?fi|wlan|wireless/i.test(name) ? -1 : 0);
      out.push({ ip: n.address, score });
    }
  }
  return out.sort((a, b) => a.score - b.score).map(x => x.ip);
}

function baseUrl(req) {
  if (db.settings.publicUrl) return db.settings.publicUrl.replace(/\/+$/, '');
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.|\[::1\])/.test(host)) {
    const ip = lanAddresses()[0];
    if (ip) return `http://${ip}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}

function notify(kind, text, extra = {}) {
  db.notifications.unshift({ id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(), kind, text, read: false, ...extra });
  db.notifications = db.notifications.slice(0, 300);
}

/* ---------------- Parishes, Masses, teams ---------------- */
const parishById = id => db.settings.parishes.find(p => p.id === id);
const serverById = id => db.servers.find(s => s.id === id);
const massKey = (date, parish, mass) => `${date}#${parish}#${mass}`;
const splitKey = k => { const [date, parish, mass] = k.split('#'); return { date, parish, mass }; };

/** The team assignment in effect on a date (latest shuffle whose "from" date is on or before it). */
function scheduleOn(parishId, date) {
  const list = (db.schedules[parishId] || []).filter(s => s.from <= date).sort((a, b) => a.from.localeCompare(b.from) || a.generatedAt.localeCompare(b.generatedAt));
  return list[list.length - 1] || null;
}
function teamOf(parishId, mass, date) {
  const s = scheduleOn(parishId, date);
  return (s && s.teams[mass]) || [];
}

function massInfo(parishId, massId, date) {
  const p = parishById(parishId);
  const idx = p ? p.masses.findIndex(x => x.id === massId) : -1;
  if (idx < 0) return null;
  const m = p.masses[idx];
  return {
    parish: p.id, parishName: p.name, mass: m.id, name: massName(idx), day: m.day, dayName: DAY_NAMES[m.day],
    time: m.time, timeLabel: fmtTime(m.time), date: date || null,
  };
}

/* ---------------- Active / inactive (3 absences in a row) ---------------- */
function recordsOf(id) {
  const out = [];
  for (const [k, rec] of Object.entries(db.attendance)) {
    const r = rec[id];
    if (r && !r.pending) out.push({ ...splitKey(k), ...r });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.at || '').localeCompare(b.at || ''));
}

/** Re-check one server after their attendance changed. Returns true if their status changed. */
function updateStatus(id) {
  const s = serverById(id);
  if (!s) return false;
  const recs = recordsOf(id).filter(r => r.date >= (s.since || '') && r.s !== 'E'); // excused doesn't count either way
  const last = recs[recs.length - 1];
  const n = db.settings.inactiveAfter;
  if (s.active) {
    const tail = recs.slice(-n);
    if (tail.length >= n && tail.every(r => r.s === 'A')) {
      s.active = false;
      s.inactiveReason = `${n} absences in a row (last: ${last.date})`;
      notify('inactive', `${s.name} is now Inactive — ${n} absences in a row.`, { server: id });
      db.version++;
      return true;
    }
  } else if (last && last.s === 'P' && last.date >= (s.since || '')) {
    s.active = true;
    s.inactiveReason = '';
    s.since = last.date;
    notify('active', `${s.name} served again (${last.date}) and is Active again.`, { server: id });
    db.version++;
    return true;
  }
  return false;
}

/* ---------------- App ---------------- */
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });

function sessionOf(req, cookie, kind) {
  const sid = cookies(req)[cookie];
  const s = sid && db.sessions[sid];
  if (!s || s.exp < Date.now() || (s.kind || 'admin') !== kind) return null;
  return s;
}
function currentAdmin(req) {
  const s = sessionOf(req, 'sid', 'admin');
  return s && db.admins.some(a => a.username === s.username) ? s.username : null;
}
function currentLeader(req) {
  const s = sessionOf(req, 'lsid', 'leader');
  return s ? db.leaders.find(l => l.username === s.username) || null : null;
}
function requireAdmin(req, res, next) {
  const u = currentAdmin(req);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.admin = u;
  next();
}
function requireLeader(req, res, next) {
  const l = currentLeader(req);
  if (!l) return res.status(401).json({ error: 'Please log in.' });
  if (!massInfo(l.parish, l.mass)) return res.status(400).json({ error: 'Your account is not linked to a Mass anymore. Please ask the admin.' });
  req.leader = l;
  next();
}
function startSession(req, res, username, kind) {
  const sid = crypto.randomBytes(32).toString('base64url');
  db.sessions[sid] = { username, kind, exp: Date.now() + SESSION_DAYS * 86400000 };
  persist();
  setCookie(req, res, kind === 'leader' ? 'lsid' : 'sid', sid, SESSION_DAYS);
}
function endSession(req, res, cookie) {
  const sid = cookies(req)[cookie];
  if (sid && db.sessions[sid]) { delete db.sessions[sid]; persist(); }
  setCookie(req, res, cookie, '', 0);
}

const validUser = u => /^[a-z0-9._-]{3,32}$/.test(u);
const USER_RULE = 'Username: 3–32 letters, numbers, dot, dash or underscore.';
const PW_RULE = 'Password must be at least 8 characters.';
const usernameTaken = u => db.admins.some(a => a.username === u) || db.leaders.some(l => l.username === u);

/* ----- Admin auth ----- */
app.get('/api/auth/status', (req, res) => res.json({ needsSetup: db.admins.length === 0, user: currentAdmin(req) }));

app.post('/api/auth/setup', (req, res) => {
  if (db.admins.length) return res.status(400).json({ error: 'Setup has already been done.' });
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!validUser(username)) return res.status(400).json({ error: USER_RULE });
  if (password.length < 8) return res.status(400).json({ error: PW_RULE });
  db.admins.push({ username, hash: hashPassword(password), created: new Date().toISOString() });
  startSession(req, res, username, 'admin');
  res.json({ ok: true, user: username });
});

app.post('/api/auth/login', (req, res) => {
  if (limited(req, 'login')) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const username = String(req.body.username || '').trim().toLowerCase();
  const admin = db.admins.find(a => a.username === username);
  if (!admin || !checkPassword(String(req.body.password || ''), admin.hash)) {
    fail(req, 'login');
    const isLeader = db.leaders.some(l => l.username === username);
    return res.status(401).json({ error: isLeader ? 'That is a Mass leader account — leaders log in on the mobile app (/app).' : 'Wrong username or password.' });
  }
  startSession(req, res, username, 'admin');
  res.json({ ok: true, user: username });
});

app.post('/api/auth/logout', (req, res) => { endSession(req, res, 'sid'); res.json({ ok: true }); });

/* ----- Admin accounts ----- */
app.get('/api/admins', requireAdmin, (req, res) => {
  res.json({ admins: db.admins.map(a => ({ username: a.username, created: a.created })), me: req.admin });
});
app.post('/api/admins', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!validUser(username)) return res.status(400).json({ error: USER_RULE });
  if (password.length < 8) return res.status(400).json({ error: PW_RULE });
  if (usernameTaken(username)) return res.status(400).json({ error: 'That username already exists.' });
  db.admins.push({ username, hash: hashPassword(password), created: new Date().toISOString() });
  persist();
  res.json({ ok: true });
});
app.delete('/api/admins/:username', requireAdmin, (req, res) => {
  const u = req.params.username;
  if (u === req.admin) return res.status(400).json({ error: "You can't remove your own account." });
  if (!db.admins.some(a => a.username === u)) return res.status(404).json({ error: 'Not found.' });
  db.admins = db.admins.filter(a => a.username !== u);
  for (const [t, s] of Object.entries(db.sessions)) if (s.username === u && (s.kind || 'admin') === 'admin') delete db.sessions[t];
  persist();
  res.json({ ok: true });
});
app.post('/api/me/password', requireAdmin, (req, res) => {
  const me = db.admins.find(a => a.username === req.admin);
  if (!checkPassword(String(req.body.current || ''), me.hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: PW_RULE });
  me.hash = hashPassword(pw);
  persist();
  res.json({ ok: true });
});

/* ----- Mass leader accounts (managed by admins) ----- */
const publicLeader = l => ({ username: l.username, parish: l.parish, mass: l.mass, created: l.created });

app.post('/api/leaders', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const parish = String(req.body.parish || '');
  const mass = String(req.body.mass || '');
  if (!validUser(username)) return res.status(400).json({ error: USER_RULE });
  if (password.length < 8) return res.status(400).json({ error: PW_RULE });
  if (usernameTaken(username)) return res.status(400).json({ error: 'That username already exists.' });
  if (!massInfo(parish, mass)) return res.status(400).json({ error: 'Choose a parish and Mass.' });
  db.leaders.push({ username, hash: hashPassword(password), parish, mass, created: new Date().toISOString() });
  persist();
  res.json({ leaders: db.leaders.map(publicLeader) });
});
app.patch('/api/leaders/:username', requireAdmin, (req, res) => {
  const l = db.leaders.find(x => x.username === req.params.username);
  if (!l) return res.status(404).json({ error: 'Not found.' });
  if (req.body.password !== undefined) {
    const pw = String(req.body.password || '');
    if (pw.length < 8) return res.status(400).json({ error: PW_RULE });
    l.hash = hashPassword(pw);
  }
  if (req.body.parish !== undefined) {
    if (!massInfo(String(req.body.parish), String(req.body.mass))) return res.status(400).json({ error: 'Choose a parish and Mass.' });
    l.parish = String(req.body.parish); l.mass = String(req.body.mass);
  }
  persist();
  res.json({ leaders: db.leaders.map(publicLeader) });
});
app.delete('/api/leaders/:username', requireAdmin, (req, res) => {
  const u = req.params.username;
  db.leaders = db.leaders.filter(l => l.username !== u);
  for (const [t, s] of Object.entries(db.sessions)) if (s.username === u && s.kind === 'leader') delete db.sessions[t];
  persist();
  res.json({ leaders: db.leaders.map(publicLeader) });
});

/* ----- Ministry data (admin) ----- */
const snapshot = () => ({
  version: db.version, servers: db.servers, settings: db.settings, schedules: db.schedules,
  attendance: db.attendance, submissions: db.submissions, notifications: db.notifications,
  leaders: db.leaders.map(publicLeader), today: todayStr(),
});

app.get('/api/state', requireAdmin, (req, res) => res.json(snapshot()));

function cleanServers(list) {
  if (!Array.isArray(list)) return null;
  return list.filter(a => a && a.id && a.name).map(a => cleanServer(a, serverById(a.id)));
}

app.put('/api/state', requireAdmin, (req, res) => {
  const { version, servers, settings, schedules } = req.body || {};
  if (version !== db.version) return res.status(409).json({ error: 'The data changed on the server.', state: snapshot() });
  const list = cleanServers(servers);
  if (!list || typeof schedules !== 'object' || !schedules || typeof settings !== 'object') return res.status(400).json({ error: 'Bad data.' });
  db.servers = list;
  db.settings = normalizeSettings(settings);
  db.schedules = schedules;
  db.version++;
  persist();
  res.json({ version: db.version });
});

app.put('/api/import', requireAdmin, (req, res) => {
  const b = req.body || {};
  const list = cleanServers(b.servers);
  if (!list) return res.status(400).json({ error: 'That file is not a valid backup.' });
  db.servers = list;
  db.settings = normalizeSettings(b.settings);
  db.schedules = b.schedules && typeof b.schedules === 'object' ? b.schedules : {};
  db.attendance = b.attendance && typeof b.attendance === 'object' ? b.attendance : {};
  db.submissions = b.submissions && typeof b.submissions === 'object' ? b.submissions : {};
  db.version++;
  persist();
  res.json(snapshot());
});

app.post('/api/servers/:id/new-code', requireAdmin, (req, res) => {
  const s = serverById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found.' });
  s.code = newCode();
  db.version++;
  persist();
  res.json(snapshot());
});

const validKey = k => /^\d{4}-\d{2}-\d{2}#[\w-]+#[\w-]+$/.test(k || '');

/** Admin sets/clears one mark. value: { s: 'P'|'A'|'E', reason? } or null. */
app.patch('/api/attendance', requireAdmin, (req, res) => {
  const { key, id, value } = req.body || {};
  if (!validKey(key) || !serverById(id)) return res.status(400).json({ error: 'Bad request.' });
  const rec = db.attendance[key] || (db.attendance[key] = {});
  if (value && ['P', 'A', 'E'].includes(value.s)) {
    const old = rec[id] || {};
    rec[id] = { ...old, s: value.s, at: new Date().toISOString(), via: 'admin', by: req.admin, pending: false };
    if (value.reason !== undefined) rec[id].reason = String(value.reason).slice(0, 300);
  } else {
    delete rec[id];
  }
  if (!Object.keys(rec).length) delete db.attendance[key];
  updateStatus(id);
  persist();
  res.json(snapshot());
});

/** Approve or reject a pending record (a server who served at a Mass they weren't assigned to). */
app.post('/api/approve', requireAdmin, (req, res) => {
  const { key, id, approve } = req.body || {};
  const r = db.attendance[key]?.[id];
  if (!r || !r.pending) return res.status(404).json({ error: 'That request was already handled.' });
  const s = serverById(id);
  const { date, parish, mass } = splitKey(key);
  const mi = massInfo(parish, mass);
  const where = `${mi ? `${mi.parishName} ${mi.name}` : 'a Mass'} (${date})`;
  if (approve) {
    r.pending = false;
    r.approvedBy = req.admin;
    r.approvedAt = new Date().toISOString();
    notify('approved', `${req.admin} approved ${s?.name || 'a server'} as Present at ${where}.`);
  } else {
    delete db.attendance[key][id];
    if (!Object.keys(db.attendance[key]).length) delete db.attendance[key];
    notify('rejected', `${req.admin} rejected ${s?.name || 'a server'}'s attendance at ${where}.`);
  }
  updateStatus(id);
  persist();
  res.json(snapshot());
});

app.post('/api/notifications/read', requireAdmin, (req, res) => {
  db.notifications.forEach(n => { n.read = true; });
  persist();
  res.json(snapshot());
});

/* ----- QR codes ----- */
const qrSvg = text => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
const serverQrUrl = (req, s) => `${baseUrl(req)}/s/${s.code}`;

app.get('/api/info', requireAdmin, (req, res) => {
  res.json({ baseUrl: baseUrl(req), lan: lanAddresses().map(ip => `http://${ip}:${PORT}`), port: PORT });
});

/** QR images for many servers at once (for printing ID cards). */
app.post('/api/qr/servers', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const out = {};
  for (const id of ids.slice(0, 1000)) {
    const s = serverById(id);
    if (s) out[id] = await qrSvg(serverQrUrl(req, s));
  }
  res.json({ qr: out });
});

app.get('/api/qr/text', requireAdmin, async (req, res) => {
  res.json({ svg: await qrSvg(String(req.query.text || '').slice(0, 500)) });
});

/* ----- Mass leader app (mobile) ----- */
app.post('/api/leader/login', (req, res) => {
  if (limited(req, 'llogin')) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const username = String(req.body.username || '').trim().toLowerCase();
  const l = db.leaders.find(x => x.username === username);
  if (!l || !checkPassword(String(req.body.password || ''), l.hash)) {
    fail(req, 'llogin');
    const isAdmin = db.admins.some(a => a.username === username);
    return res.status(401).json({ error: isAdmin ? 'That is an admin account — please use the admin website instead.' : 'Wrong username or password.' });
  }
  startSession(req, res, username, 'leader');
  res.json({ ok: true });
});
app.post('/api/leader/logout', (req, res) => { endSession(req, res, 'lsid'); res.json({ ok: true }); });

/** Dates this leader's Mass happens on, around today (for the date picker). */
function occurrences(day, today) {
  const t = parseDate(today);
  const back = (t.getDay() - day + 7) % 7;
  const last = addDays(today, -back);
  return [-21, -14, -7, 0, 7, 14].map(n => addDays(last, n));
}

const publicServer = s => s && ({ id: s.id, name: s.name, parish: parishById(s.parish)?.name || '—', role: s.role || '—', active: s.active });

function leaderView(l, date) {
  const m = massInfo(l.parish, l.mass, date);
  const key = massKey(date, l.parish, l.mass);
  const rec = db.attendance[key] || {};
  const team = teamOf(l.parish, l.mass, date);
  const ids = [...new Set([...team, ...Object.keys(rec)])];
  return {
    leader: l.username, ministry: db.settings.ministry, mass: m, date, today: todayStr(),
    dates: occurrences(m.day, todayStr()),
    allowManualPick: db.settings.allowManualPick,
    submitted: db.submissions[key] || null,
    hasSchedule: !!scheduleOn(l.parish, date),
    rows: ids.map(id => ({ ...publicServer(serverById(id)) || { id, name: '(removed)' }, onTeam: team.includes(id), record: rec[id] || null }))
      .sort((a, b) => (b.onTeam - a.onTeam) || a.name.localeCompare(b.name)),
    pickList: db.settings.allowManualPick ? db.servers.filter(s => !ids.includes(s.id)).map(publicServer).sort((a, b) => a.name.localeCompare(b.name)) : [],
  };
}

/** The date a leader is working on: the one they picked (if their Mass is on that weekday), else the latest one. */
function leaderDate(l, d) {
  const day = massInfo(l.parish, l.mass).day;
  if (isDate(d) && parseDate(d).getDay() === day) return d;
  return occurrences(day, todayStr())[3];
}

app.get('/api/leader/me', requireLeader, (req, res) => res.json(leaderView(req.leader, leaderDate(req.leader, req.query.date))));

function lockedFor(l, date) {
  return !!db.submissions[massKey(date, l.parish, l.mass)];
}

/** Record a server for the leader's Mass: by QR code (or by id, if "multiple choice" is allowed). */
app.post('/api/leader/scan', requireLeader, (req, res) => {
  const l = req.leader;
  const b = req.body || {};
  const date = leaderDate(l, b.date);
  if (lockedFor(l, date)) return res.status(400).json({ error: 'This Mass report was already submitted. Ask the admin to make changes.' });
  let s;
  if (b.code) {
    const code = String(b.code).trim().replace(/^.*\/s\//, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    s = db.servers.find(x => x.code === code);
    if (!s) {
      if (limited(req, 'scan', 30)) return res.status(429).json({ error: 'Too many unknown codes. Wait a few minutes.' });
      fail(req, 'scan', 5);
      return res.status(404).json({ error: 'This QR code is not registered. The server may have a new card — ask the admin.' });
    }
  } else if (b.id) {
    if (!db.settings.allowManualPick) return res.status(403).json({ error: 'Choosing names is turned off. Please scan the server\'s QR card.' });
    s = serverById(String(b.id));
    if (!s) return res.status(404).json({ error: 'Server not found.' });
  } else {
    return res.status(400).json({ error: 'Scan a QR card.' });
  }

  const key = massKey(date, l.parish, l.mass);
  const rec = db.attendance[key] || (db.attendance[key] = {});
  const info = publicServer(s);
  if (rec[s.id] && rec[s.id].s !== 'E') return res.json({ server: info, already: true, record: rec[s.id], view: leaderView(l, date) });

  const onTeam = teamOf(l.parish, l.mass, date).includes(s.id);
  if (!onTeam) {
    const reason = String(b.reason || '').trim();
    if (!reason) return res.json({ server: info, needReason: true });
    rec[s.id] = { s: 'P', pending: true, reason: reason.slice(0, 300), at: new Date().toISOString(), via: b.code ? 'qr' : 'pick', by: l.username };
    const m = massInfo(l.parish, l.mass, date);
    notify('pending', `${s.name} served at ${m.parishName} ${m.name} (${date}) but is not on that team. Reason: "${reason.slice(0, 120)}" — waiting for approval.`, { key, server: s.id });
  } else {
    rec[s.id] = { s: 'P', at: new Date().toISOString(), via: b.code ? 'qr' : 'pick', by: l.username };
    updateStatus(s.id);
  }
  persist();
  res.json({ server: info, record: rec[s.id], view: leaderView(l, date) });
});

/** Record an excuse (before the day, or on the day itself). */
app.post('/api/leader/excuse', requireLeader, (req, res) => {
  const l = req.leader;
  const b = req.body || {};
  const date = leaderDate(l, b.date);
  if (lockedFor(l, date)) return res.status(400).json({ error: 'This Mass report was already submitted.' });
  const s = serverById(String(b.id || ''));
  const reason = String(b.reason || '').trim();
  if (!s) return res.status(404).json({ error: 'Server not found.' });
  if (!reason) return res.status(400).json({ error: 'Please write the reason for the excuse.' });
  const key = massKey(date, l.parish, l.mass);
  const rec = db.attendance[key] || (db.attendance[key] = {});
  if (rec[s.id] && rec[s.id].s === 'P') return res.status(400).json({ error: `${s.name} is already marked Present.` });
  const type = date > todayStr() || b.type === 'before' ? 'before' : 'onday';
  rec[s.id] = { s: 'E', reason: reason.slice(0, 300), excuseType: type, at: new Date().toISOString(), via: 'leader', by: l.username };
  persist();
  res.json({ view: leaderView(l, date) });
});

/** Undo a mark (only before the report is submitted). */
app.post('/api/leader/undo', requireLeader, (req, res) => {
  const l = req.leader;
  const date = leaderDate(l, req.body?.date);
  if (lockedFor(l, date)) return res.status(400).json({ error: 'This Mass report was already submitted.' });
  const key = massKey(date, l.parish, l.mass);
  const id = String(req.body?.id || '');
  if (db.attendance[key]?.[id]) {
    delete db.attendance[key][id];
    if (!Object.keys(db.attendance[key]).length) delete db.attendance[key];
    updateStatus(id);
    persist();
  }
  res.json({ view: leaderView(l, date) });
});

/** Send the whole Mass report to the admin/secretary at once. Unscanned team members → Absent. */
app.post('/api/leader/submit', requireLeader, (req, res) => {
  const l = req.leader;
  const date = leaderDate(l, req.body?.date);
  if (date > todayStr()) return res.status(400).json({ error: 'You can submit the report on or after the day of the Mass.' });
  if (lockedFor(l, date)) return res.status(400).json({ error: 'Already submitted.' });
  const key = massKey(date, l.parish, l.mass);
  const rec = db.attendance[key] || (db.attendance[key] = {});
  const team = teamOf(l.parish, l.mass, date);
  const now = new Date().toISOString();
  const absent = [];
  team.forEach(id => {
    if (!rec[id] && serverById(id)) { rec[id] = { s: 'A', at: now, via: 'leader', by: l.username }; absent.push(id); }
  });
  const vals = Object.values(rec);
  const sum = {
    by: l.username, at: now,
    present: vals.filter(r => r.s === 'P' && !r.pending).length,
    pending: vals.filter(r => r.pending).length,
    excused: vals.filter(r => r.s === 'E').length,
    absent: vals.filter(r => r.s === 'A').length,
  };
  db.submissions[key] = sum;
  if (!Object.keys(rec).length) delete db.attendance[key];
  absent.forEach(updateStatus);
  const m = massInfo(l.parish, l.mass, date);
  notify('submitted', `${l.username} submitted ${m.parishName} ${m.name} (${date}): ${sum.present} present, ${sum.excused} excused, ${sum.absent} absent${sum.pending ? `, ${sum.pending} waiting for approval` : ''}.`, { key });
  persist();
  res.json({ view: leaderView(l, date) });
});

/* ----- Pages ----- */
// A server's QR card opens this link. Phones' own camera apps can open it; it hands the code to the leader app.
app.get('/s/:code', (req, res) => res.redirect(`/app?code=${encodeURIComponent(req.params.code)}`));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leader.html')));
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------------- Default accounts (from the system spec) ---------------- */
function seedAccounts() {
  let changed = false;
  if (!usernameTaken('altarservers')) {
    db.admins.push({ username: 'altarservers', hash: hashPassword('altarservers123'), created: new Date().toISOString() });
    changed = true;
  }
  const first = db.settings.parishes[0];
  if (!usernameTaken('1stmass') && first && first.masses[0]) {
    db.leaders.push({ username: '1stmass', hash: hashPassword('1stmass123'), parish: first.id, mass: first.masses[0].id, created: new Date().toISOString() });
    changed = true;
  }
  return changed;
}
(async () => {
  await initStorage();
  seedAccounts();
  persist();

  app.listen(PORT, () => {
    console.log(`\n  Altar Servers attendance system is running.`);
    console.log(`  Admin website (this computer):  http://localhost:${PORT}`);
    lanAddresses().forEach(ip => console.log(`  Leader app on the same Wi-Fi:   http://${ip}:${PORT}/app`));
    console.log(`  Data file (local backup): ${DB_FILE}`);
    console.log(`  Supabase sync: ${supabase.enabled ? supabase.url : 'off'}\n`);
  });

  // Make sure the last change reaches Supabase before the server stops.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => {
    try { await supabase.drain(); } catch (e) { /* already logged */ }
    process.exit(0);
  });
})();
