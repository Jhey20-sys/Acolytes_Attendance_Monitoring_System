/* Smoke tests: start a real copy of the server and walk through the main admin and leader flows over HTTP.
 * Safety: the server runs from a temporary copy (no .env), with its own empty data folder and
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set to empty, so the real database is never touched.
 * Run: npm test */
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
let tmp, proc, base, output = '';

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Minimal cookie-aware HTTP client (one per user). */
function client() {
  const jar = {};
  return async function call(method, url, body, opts = {}) {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-smoke-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(tmp, 'data'), SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
  });
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  const t0 = Date.now();
  while (!/is running/.test(output)) {
    if (Date.now() - t0 > 15000) throw new Error(`Server did not start:\n${output}`);
    await new Promise(r => setTimeout(r, 100));
  }
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once('exit', r));
    proc.kill();
    await exited; // Windows keeps the folder locked until the process is gone
  }
  if (!tmp) return;
  // Remove the node_modules link first so cleanup can never reach the project's real node_modules.
  try { fs.unlinkSync(path.join(tmp, 'node_modules')); } catch (e) { return; }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* temp folder; the OS cleans it up */ }
});

describe('Smoke: server and pages', () => {
  it('starts with Supabase sync OFF (test never touches the real database)', () => {
    assert.match(output, /Supabase sync: off/);
  });
  it('serves the admin website', async () => {
    const r = await client()('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>[^<]*<\/title>/);
    assert.match(r.text, /logo\.png/);
  });
  it('serves the Mass leader app at /app', async () => {
    const r = await client()('GET', '/app');
    assert.equal(r.status, 200);
    assert.match(r.text, /Altar Server Check-in/);
  });
  it('serves the new logo images and app manifests', async () => {
    const c = client();
    for (const f of ['/logo.png', '/logo-icon.png', '/apple-touch-icon.png']) {
      const r = await c('GET', f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get('content-type'), 'image/png', f);
    }
    const m = await c('GET', '/manifest.json');
    assert.equal(m.json.icons[0].src, 'logo-icon.png');
  });
  it('serves the QR scanner library', async () => {
    const r = await client()('GET', '/vendor/jsQR.js');
    assert.equal(r.status, 200);
  });
});

describe('Smoke: admin and leader flow', () => {
  const admin = client(), leader = client();
  let state, ids = {}, codes = {}, date;

  it('blocks data access without logging in', async () => {
    assert.equal((await admin('GET', '/api/state')).status, 401);
    assert.equal((await leader('GET', '/api/leader/me')).status, 401);
  });
  it('rejects a wrong admin password', async () => {
    const r = await admin('POST', '/api/auth/login', { username: 'altarservers', password: 'wrong-password' });
    assert.equal(r.status, 401);
  });
  it('logs in with the default admin account', async () => {
    const r = await admin('POST', '/api/auth/login', { username: 'altarservers', password: 'altarservers123' });
    assert.equal(r.status, 200);
    assert.equal((await admin('GET', '/api/auth/status')).json.user, 'altarservers');
  });
  it('loads the ministry data with the default parishes', async () => {
    const r = await admin('GET', '/api/state');
    assert.equal(r.status, 200);
    state = r.json;
    assert.deepEqual(state.settings.parishes.map(p => p.name), ['Agusan', 'Tablon', 'Puerto']);
  });
  it('saves new servers and a Mass team (each server gets a QR code)', async () => {
    const add = (id, name, role) => ({ id, name, parish: 'agusan', role, active: true, since: '2026-01-01' });
    const servers = [add('s1', 'Ana Lim', 'Elders'), add('s2', 'Ben Cruz', 'Seniors'), add('s3', 'Carl Uy', 'Juniors'), add('s4', 'Dina Go', 'Juniors')];
    const schedules = { agusan: [{ id: 'e1', from: '2026-01-01', generatedAt: '2026-01-01T00:00:00Z', teams: { m1: ['s1', 's2', 's3'], m2: ['s4'], m3: [] } }] };
    const r = await admin('PUT', '/api/state', { version: state.version, servers, settings: state.settings, schedules });
    assert.equal(r.status, 200);
    state = (await admin('GET', '/api/state')).json;
    assert.equal(state.servers.length, 4);
    for (const s of state.servers) { assert.match(s.code, /^[A-Z0-9]{8}$/); ids[s.name] = s.id; codes[s.name] = s.code; }
  });
  it('refuses a save based on outdated data (conflict protection)', async () => {
    const r = await admin('PUT', '/api/state', { version: state.version - 1, servers: state.servers, settings: state.settings, schedules: state.schedules });
    assert.equal(r.status, 409);
  });
  it('creates a Mass leader account', async () => {
    const r = await admin('POST', '/api/leaders', { username: 'smokeleader', password: 'smoke12345', parish: 'agusan', mass: 'm2' });
    assert.equal(r.status, 200);
    assert.ok(r.json.leaders.some(l => l.username === 'smokeleader'));
  });
  it('does not let an admin account log in to the leader app', async () => {
    const r = await client()('POST', '/api/leader/login', { username: 'altarservers', password: 'altarservers123' });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /admin account/);
  });
  it('logs in the default leader (Agusan, First Mass) and shows the team', async () => {
    assert.equal((await leader('POST', '/api/leader/login', { username: '1stmass', password: '1stmass123' })).status, 200);
    const r = await leader('GET', '/api/leader/me');
    assert.equal(r.status, 200);
    date = r.json.date;
    assert.equal(r.json.mass.parishName, 'Agusan');
    assert.equal(r.json.mass.name, 'First Mass');
    assert.deepEqual(r.json.rows.filter(x => x.onTeam).map(x => x.name).sort(), ['Ana Lim', 'Ben Cruz', 'Carl Uy']);
  });
  it('scans a team member\'s QR card as Present', async () => {
    const r = await leader('POST', '/api/leader/scan', { code: codes['Ana Lim'], date });
    assert.equal(r.status, 200);
    assert.equal(r.json.record.s, 'P');
    assert.equal(r.json.server.name, 'Ana Lim');
  });
  it('accepts the full QR link (phone camera) and reports a repeat scan', async () => {
    const r = await leader('POST', '/api/leader/scan', { code: `http://x/s/${codes['Ana Lim']}`, date });
    assert.equal(r.json.already, true);
  });
  it('rejects an unknown QR code', async () => {
    const r = await leader('POST', '/api/leader/scan', { code: 'ZZZZZZZZ', date });
    assert.equal(r.status, 404);
  });
  it('needs a reason for a server from another team, then saves it as pending', async () => {
    const r1 = await leader('POST', '/api/leader/scan', { code: codes['Dina Go'], date });
    assert.equal(r1.json.needReason, true);
    const r2 = await leader('POST', '/api/leader/scan', { code: codes['Dina Go'], date, reason: 'Substitute' });
    assert.equal(r2.json.record.pending, true);
  });
  it('records an excuse', async () => {
    const r = await leader('POST', '/api/leader/excuse', { id: ids['Ben Cruz'], reason: 'Sick', date });
    assert.equal(r.status, 200);
    assert.equal(r.json.view.rows.find(x => x.name === 'Ben Cruz').record.s, 'E');
  });
  it('blocks choosing names from a list while that rule is off', async () => {
    const r = await leader('POST', '/api/leader/scan', { id: ids['Carl Uy'], date });
    assert.equal(r.status, 403);
  });
  it('submits the report: unscanned team members become Absent, then the report locks', async () => {
    const r = await leader('POST', '/api/leader/submit', { date });
    assert.equal(r.status, 200);
    const rows = Object.fromEntries(r.json.view.rows.map(x => [x.name, x.record]));
    assert.equal(rows['Carl Uy'].s, 'A');
    assert.ok(r.json.view.submitted);
    assert.equal((await leader('POST', '/api/leader/submit', { date })).status, 400);
    assert.equal((await leader('POST', '/api/leader/scan', { code: codes['Carl Uy'], date })).status, 400);
  });
  it('notifies the admin about the submission and the pending request', async () => {
    const s = (await admin('GET', '/api/state')).json;
    const kinds = s.notifications.map(n => n.kind);
    assert.ok(kinds.includes('submitted') && kinds.includes('pending'));
  });
  it('lets the admin approve the pending request', async () => {
    const key = `${date}#agusan#m1`;
    const r = await admin('POST', '/api/approve', { key, id: ids['Dina Go'], approve: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.attendance[key][ids['Dina Go']].pending, false);
  });
  it('makes a server Inactive after 3 absences in a row, and Active again when present', async () => {
    const id = ids['Carl Uy'];
    for (const d of ['2026-02-01', '2026-02-08']) await admin('PATCH', '/api/attendance', { key: `${d}#agusan#m1`, id, value: { s: 'A' } });
    let s = (await admin('GET', '/api/state')).json.servers.find(x => x.id === id);
    assert.equal(s.active, false, `3 absences (incl. today's report) → Inactive; reason: ${s.inactiveReason}`);
    const later = `${date.slice(0, 4) === '2026' ? '2026-12-06' : date}`;
    await admin('PATCH', '/api/attendance', { key: `${later}#agusan#m1`, id, value: { s: 'P' } });
    s = (await admin('GET', '/api/state')).json.servers.find(x => x.id === id);
    assert.equal(s.active, true);
  });
  it('makes printable QR cards that link to /s/<code>, which opens the leader app', async () => {
    const r = await admin('POST', '/api/qr/servers', { ids: [ids['Ana Lim']] });
    assert.match(r.json.qr[ids['Ana Lim']], /<svg/);
    const link = await client()('GET', `/s/${codes['Ana Lim']}`);
    assert.equal(link.status, 302);
    assert.equal(link.headers.get('location'), `/app?code=${codes['Ana Lim']}`);
  });
  it('writes everything to the local data file', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'db.json'), 'utf8'));
    assert.equal(saved.servers.length, 4);
    assert.ok(Object.keys(saved.submissions).length >= 1);
  });
  it('logs out (the session stops working)', async () => {
    await admin('POST', '/api/auth/logout');
    assert.equal((await admin('GET', '/api/state')).status, 401);
    await leader('POST', '/api/leader/logout');
    assert.equal((await leader('GET', '/api/leader/me')).status, 401);
  });
});
