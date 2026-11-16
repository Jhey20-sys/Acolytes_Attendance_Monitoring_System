/* Altar Servers — Admin website
 * Talks to server.js. All data is shared between admins/secretaries and stored on the server.
 */
'use strict';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const STATUS = { P: 'Present', A: 'Absent', E: 'Excused' };

/* ---------------- Helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const thisMonth = () => todayStr().slice(0, 7);
const niceDate = s => parse(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const longDate = s => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthLabel = m => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const shiftMonth = (m, n) => { const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1); return ymd(d).slice(0, 7); };
const fmtTime = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`; };
const fmtWhen = iso => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const massName = i => `${ORDINAL[i] || `#${i + 1}`} Mass`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const shuffleArr = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

/* ---------------- Server API ---------------- */
async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) showLogin('Your session ended. Please log in again.');
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
  return data;
}

/* ---------------- State ---------------- */
let state = null; // { version, servers, settings, schedules, attendance, submissions, notifications, leaders }
let me = null;
let shownTab = null; // tab currently on screen; entry animations run only when it changes

const ui = {
  tab: 'dashboard',
  dashMonth: thisMonth(),
  search: '', fParish: '', fRole: '', fStatus: '',
  editing: null,
  schParish: null, schEntry: null,
  attParish: null, attDate: todayStr(),
  logsOpen: false, logParish: null, logFrom: '', logTo: '',
  repMonth: thisMonth(), repParish: '', repSort: 'name',
  info: null, admins: null, appQr: null,
};

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(flush); }, 300);
}
async function flush() {
  const body = { version: state.version, servers: state.servers, settings: state.settings, schedules: state.schedules };
  try {
    const r = await api('PUT', '/api/state', body);
    state.version = r.version;
    // New servers get their QR code on the server — fetch it.
    if (state.servers.some(s => !s.code) && !saveTimer) state = { ...state, ...(await api('GET', '/api/state')) };
  } catch (e) {
    if (e.status === 409 && e.data.state) {
      state = e.data.state;
      toast('The data was changed elsewhere (e.g. a leader scan) — loaded the latest. Please redo your last change.');
      render();
    } else if (e.status !== 401) toast(`Not saved: ${e.message}`);
  }
}
window.addEventListener('beforeunload', e => { if (saveTimer) { flush(); e.preventDefault(); } });

/** Apply a full snapshot returned by the server (attendance/approval calls). */
function applySnapshot(s) { state = s; render(); }

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3600);
}

/* ---------------- Data helpers ---------------- */
const parishes = () => state.settings.parishes;
const parishById = id => parishes().find(p => p.id === id);
const parishName = id => parishById(id)?.name || '—';
const byId = id => state.servers.find(a => a.id === id);
const nameOf = id => byId(id)?.name || '(removed)';
const sortedServers = list => [...(list || state.servers)].sort((a, b) => a.name.localeCompare(b.name));
const massIndex = (pid, mid) => (parishById(pid)?.masses || []).findIndex(m => m.id === mid);
function massLabel(pid, mid, withDay = true) {
  const p = parishById(pid);
  const i = massIndex(pid, mid);
  if (i < 0) return '(removed Mass)';
  const m = p.masses[i];
  return `${massName(i)}${withDay ? ` · ${DAY_NAMES[m.day]} ${fmtTime(m.time)}` : ''}`;
}
const keyOf = (date, pid, mid) => `${date}#${pid}#${mid}`;
const splitKey = k => { const [date, parish, mass] = k.split('#'); return { date, parish, mass }; };
const roleShort = r => (r ? r[0] : '');

function scheduleEntries(pid) {
  return [...(state.schedules[pid] || [])].sort((a, b) => a.from.localeCompare(b.from) || a.generatedAt.localeCompare(b.generatedAt));
}
function scheduleOn(pid, date) {
  const list = scheduleEntries(pid).filter(s => s.from <= date);
  return list[list.length - 1] || null;
}
const teamOf = (pid, mid, date) => scheduleOn(pid, date)?.teams?.[mid] || [];

function pendingList() {
  const out = [];
  for (const [key, rec] of Object.entries(state.attendance)) {
    for (const [id, r] of Object.entries(rec)) if (r.pending) out.push({ key, id, r, ...splitKey(key) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Present / Absent / Excused counts for a month (YYYY-MM), overall and per server. Pending records are not counted. */
function monthStats(month) {
  const tot = { P: 0, A: 0, E: 0 };
  const per = {};
  for (const [key, rec] of Object.entries(state.attendance)) {
    if (!key.startsWith(month)) continue;
    for (const [id, r] of Object.entries(rec)) {
      if (r.pending || !STATUS[r.s]) continue;
      tot[r.s]++;
      const p = per[id] || (per[id] = { P: 0, A: 0, E: 0 });
      p[r.s]++;
    }
  }
  return { tot, per };
}

/** The date of the 2nd meeting (e.g. 2nd Sunday) of a month. */
function secondMeeting(month) {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  while (d.getDay() !== Number(state.settings.meetingDay || 0)) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + 7);
  return ymd(d);
}
function shuffleDue(pid) {
  const second = secondMeeting(thisMonth());
  if (todayStr() <= second) return false;
  return !scheduleEntries(pid).some(s => s.from > second || s.generatedAt.slice(0, 10) >= second);
}

/* ---------------- Team shuffle ---------------- */
/**
 * Shuffle the active servers of one parish into teams, one team per Mass.
 * Elders, Seniors and Juniors are spread evenly over the teams, and people are moved
 * away from the team they had before as much as possible.
 */
function shuffleParish(pid, from) {
  const p = parishById(pid);
  if (!p.masses.length) { toast(`${p.name} has no Masses. Add them in Settings.`); return false; }
  const pool = state.servers.filter(s => s.active && s.parish === pid);
  if (!pool.length) { toast(`No active servers in ${p.name} yet.`); return false; }
  const prev = scheduleOn(pid, from);
  const prevTeam = {};
  if (prev) Object.entries(prev.teams).forEach(([mid, ids]) => ids.forEach(id => { prevTeam[id] = mid; }));
  const roles = state.settings.roles;
  const mids = p.masses.map(m => m.id);

  let best = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const groups = [...roles.map(r => pool.filter(s => s.role === r)), pool.filter(s => !roles.includes(s.role))];
    const ordered = groups.flatMap(g => shuffleArr([...g]));
    const teams = Object.fromEntries(mids.map(m => [m, []]));
    const offset = Math.floor(Math.random() * mids.length);
    ordered.forEach((s, i) => {
      const round = Math.floor(i / mids.length);
      const pos = i % mids.length;
      const idx = (round % 2 === 0 ? pos : mids.length - 1 - pos) + offset; // snake order keeps teams balanced
      teams[mids[idx % mids.length]].push(s.id);
    });
    const score = Object.entries(teams).reduce((n, [mid, ids]) => n + ids.filter(id => prevTeam[id] === mid).length, 0);
    if (!best || score < best.score) best = { teams, score };
    if (score === 0 || mids.length === 1) break;
  }
  const list = (state.schedules[pid] || []).filter(s => s.from !== from);
  const entry = { id: uid(), from, generatedAt: new Date().toISOString(), teams: best.teams };
  list.push(entry);
  state.schedules[pid] = list;
  ui.schEntry = entry.id;
  save();
  return true;
}

/* ---------------- Login ---------------- */
/* Friendly greeting based on the time of day on this device. */
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function showLogin(msg, needsSetup = false) {
  me = null; state = null; shownTab = null;
  stopTimers();
  document.body.classList.add('logged-out');
  document.getElementById('userBox').innerHTML = '';
  document.getElementById('view').innerHTML = `
    <form class="card stack login-card${msg ? ' shake' : ''}" data-form="${needsSetup ? 'setup' : 'login'}">
      <div style="text-align:center">
        <img src="logo.png" alt="Altar Servers" width="72" height="72">
        <p class="greet-kicker">Peace be with you</p>
        <h2 style="margin-top:4px">${needsSetup ? 'Welcome' : greeting()}</h2>
        <p class="muted small">${needsSetup ? 'Create the first admin account.' : 'Mass leader? <a href="/app">Open the leader app</a>'}</p>
      </div>
      ${msg ? `<div class="msg-err">${esc(msg)}</div>` : ''}
      <div><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required style="width:100%"></div>
      <div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required style="width:100%"></div>
      ${needsSetup ? '<div><label for="p2">Confirm password</label><input id="p2" name="password2" type="password" autocomplete="new-password" required style="width:100%"></div>' : ''}
      <button class="primary" type="submit">${needsSetup ? 'Create account' : 'Log in'}</button>
    </form>`;
  document.getElementById('u').focus();
}

async function boot() {
  try {
    const st = await api('GET', '/api/auth/status');
    if (st.needsSetup) return showLogin('', true);
    if (!st.user) return showLogin();
    me = st.user;
    state = await api('GET', '/api/state');
    document.body.classList.remove('logged-out');
    document.getElementById('userBox').innerHTML = `<span class="muted small">👤 ${esc(me)}</span> <button class="sm" data-action="logout">Log out</button>`;
    render();
    startPolling();
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="card empty">Can't reach the server.<br><br>Make sure it is running (<code>npm start</code>), then <button data-action="reload">try again</button>.</div>`;
  }
}

/* ---------------- Rendering ---------------- */
function render() {
  if (!state) return;
  if (!ui.schParish || !parishById(ui.schParish)) ui.schParish = parishes()[0]?.id || null;
  if (!ui.attParish || !parishById(ui.attParish)) ui.attParish = parishes()[0]?.id || null;
  document.getElementById('ministryName').textContent = state.settings.ministry;
  document.title = `${state.settings.ministry} — Admin`;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const pend = pendingList().length;
  const badge = document.getElementById('pendingBadge');
  badge.hidden = !pend; badge.textContent = pend;
  const views = { dashboard: viewDashboard, roster: viewRoster, schedule: viewSchedule, attendance: viewAttendance, approvals: viewApprovals, reports: viewReports, settings: viewSettings };
  const view = document.getElementById('view');
  const entering = ui.tab !== shownTab;
  shownTab = ui.tab;
  view.innerHTML = views[ui.tab]();
  view.classList.remove('enter');
  if (entering) { void view.offsetWidth; view.classList.add('enter'); if (ui.tab === 'dashboard') countUp(view); }
  if (ui.tab === 'settings') loadSettingsExtras();
}

/* Stat numbers count up from 0 when the dashboard opens. */
function countUp(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.stat b').forEach(el => {
    const end = Number(el.textContent);
    if (!end) return;
    const t0 = performance.now(), dur = 700;
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  });
}

/* ----- Dashboard ----- */
function viewDashboard() {
  const m = ui.dashMonth;
  const { tot } = monthStats(m);
  const active = state.servers.filter(s => s.active).length;
  const inactive = state.servers.length - active;
  const pend = pendingList();
  const unread = state.notifications.filter(n => !n.read).length;

  const reminders = [];
  parishes().forEach(p => { if (shuffleDue(p.id)) reminders.push(`<b>${esc(p.name)}</b> teams are due for reshuffling (the 2nd meeting of the month has passed). <button class="sm" data-action="goto-schedule" data-p="${p.id}">Go to schedule</button>`); });
  parishes().forEach(p => p.masses.forEach((ms, i) => {
    if (!state.leaders.some(l => l.parish === p.id && l.mass === ms.id)) reminders.push(`${esc(p.name)} ${massName(i)} has no leader account yet. <button class="sm" data-action="goto" data-tab="settings">Add one</button>`);
  }));
  if (pend.length) reminders.unshift(`<b>${pend.length}</b> attendance record(s) waiting for approval. <button class="sm primary" data-action="goto" data-tab="approvals">Review</button>`);

  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(m, i - 5));
  const perParish = parishes().map(p => {
    const ids = new Set(state.servers.filter(s => s.parish === p.id).map(s => s.id));
    const { per } = monthStats(m);
    const t = { P: 0, A: 0, E: 0 };
    Object.entries(per).forEach(([id, c]) => { if (ids.has(id)) { t.P += c.P; t.A += c.A; t.E += c.E; } });
    const act = state.servers.filter(s => s.parish === p.id && s.active).length;
    return { p, act, inact: ids.size - act, ...t };
  });

  return `
    <div class="section-head">
      <div><h2>${greeting()}, ${esc(me)}</h2>
        ${pend.length ? `<div class="muted small">${pend.length} awaiting approval</div>` : ''}</div>
      <div class="row">
        <button data-action="dash-month" data-d="-1" aria-label="Previous month">‹</button>
        <input type="month" value="${m}" data-action="dash-month-set" aria-label="Month">
        <button data-action="dash-month" data-d="1" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat ok"><b>${active}</b><span>Active servers</span></div>
      <div class="stat bad"><b>${inactive}</b><span>Inactive servers</span></div>
      <div class="stat"><b>${tot.P}</b><span>Present · ${monthLabel(m)}</span></div>
      <div class="stat"><b>${tot.A}</b><span>Absent · ${monthLabel(m)}</span></div>
      <div class="stat"><b>${tot.E}</b><span>Excused · ${monthLabel(m)}</span></div>
      <div class="stat ${pend.length ? 'warn' : ''}"><b>${pend.length}</b><span>Waiting for approval</span></div>
    </div>
    ${reminders.length ? `<div class="card stack" style="margin-top:14px"><h3>To do</h3><ul class="todo">${reminders.map(r => `<li>${r}</li>`).join('')}</ul></div>` : ''}
    <div class="grid" style="margin-top:14px; align-items:start">
      <div class="card">
        <h3>By parish / chapel · ${monthLabel(m)}</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Parish</th><th class="num">Active</th><th class="num">Inactive</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Excused</th></tr></thead>
          <tbody>${perParish.map(r => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.act}</td><td class="num">${r.inact}</td><td class="num">${r.P}</td><td class="num">${r.A}</td><td class="num">${r.E}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>Every month</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Month</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Excused</th></tr></thead>
          <tbody>${months.map(mm => { const t = monthStats(mm).tot; return `<tr${mm === m ? ' class="hl"' : ''}><td>${monthLabel(mm)}</td><td class="num">${t.P}</td><td class="num">${t.A}</td><td class="num">${t.E}</td></tr>`; }).join('')}</tbody>
        </table></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row spread"><h3>Notifications ${unread ? `<span class="badge">${unread} new</span>` : ''}</h3>
        <div class="row">
          ${unread ? '<button class="sm" data-action="read-all">Mark all as read</button>' : ''}
          ${state.notifications.length > unread ? '<button class="sm" data-action="clear-read">Clear read</button>' : ''}
        </div></div>
      ${state.notifications.length ? `<ul class="list notif">${state.notifications.slice(0, 40).map(n => `<li class="${n.read ? '' : 'unread'}"><span><span class="dot ${esc(n.kind)}"></span>${esc(n.text)}</span><span class="muted small">${fmtWhen(n.at)}</span></li>`).join('')}</ul>`
        : '<p class="muted small">Leader submissions, approvals and status changes will show up here.</p>'}
    </div>`;
}

/* ----- Roster ----- */
const parishOptions = (sel, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${parishes().map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
const roleOptions = (sel, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${state.settings.roles.map(r => `<option ${r === sel ? 'selected' : ''}>${esc(r)}</option>`).join('')}`;

function rosterFiltered() {
  const q = ui.search.trim().toLowerCase();
  return sortedServers().filter(s => (!q || s.name.toLowerCase().includes(q))
    && (!ui.fParish || s.parish === ui.fParish) && (!ui.fRole || s.role === ui.fRole)
    && (!ui.fStatus || (ui.fStatus === 'active') === s.active));
}

function viewRoster() {
  const list = rosterFiltered();
  const active = state.servers.filter(s => s.active).length;
  return `
    <div class="section-head">
      <div><h2>Roster</h2><div class="muted small">${state.servers.length} servers · ${active} active · ${state.servers.length - active} inactive.
        Status changes automatically: ${state.settings.inactiveAfter} absences in a row → Inactive; scanned again → Active.</div></div>
      <div class="row">
        <button data-action="print-qr" ${list.length ? '' : 'disabled'}>🖨 Print QR cards (${list.length})</button>
        <button data-action="export-roster">⬇ Export CSV</button>
      </div>
    </div>
    <div class="grid roster-grid">
      <div class="stack">
        <form class="card stack" data-form="add">
          <h3>➕ Add server</h3>
          <div><label for="nName">Complete name</label><input id="nName" name="name" required style="width:100%" placeholder="e.g. Juan A. Dela Cruz"></div>
          <div class="row">
            <div style="flex:1"><label for="nParish">Parish / chapel</label><select id="nParish" name="parish" required style="width:100%">${parishOptions(ui.fParish || '', '— Select —')}</select></div>
            <div style="flex:1"><label for="nRole">Role</label><select id="nRole" name="role" required style="width:100%">${roleOptions('', '— Select —')}</select></div>
          </div>
          <div><label for="nContact">Contact (optional)</label><input id="nContact" name="contact" style="width:100%"></div>
          <p class="muted small" style="margin:0">Status is set to <b>Active</b> automatically. A personal QR card is created for printing.</p>
          <button class="primary" type="submit">Add server</button>
        </form>
        <div class="card stack">
          <h3>Import from CSV</h3>
          <p class="muted small" style="margin:0">Columns: <b>Name</b> (or First Name / Last Name), <b>Parish</b> (or Chapel), <b>Role</b>, optional <b>Mass</b> and <b>Contact</b>.</p>
          <p class="muted small" style="margin:0"><b>Mass</b> puts the server on that Mass's team in their chapel's schedule, starting today. Write it as <i>1st Mass</i>, <i>2</i>, <i>8:00 AM</i> or <i>Sunday 4:00 PM</i>. Names already in the roster are matched, not duplicated. New chapels and Masses are created automatically.</p>
          <div class="row">
            <label class="btn" style="margin:0; cursor:pointer">📄 Choose CSV<input type="file" accept=".csv,text/csv,.txt" data-action="import-csv" hidden></label>
            <button class="sm" data-action="csv-template">⬇ Template</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:8px">
          <input type="search" placeholder="Search name…" value="${esc(ui.search)}" data-action="search" style="flex:2; min-width:140px" aria-label="Search">
          <select data-action="f-parish" aria-label="Parish filter">${parishOptions(ui.fParish, 'All parishes')}</select>
          <select data-action="f-role" aria-label="Role filter">${roleOptions(ui.fRole, 'All roles')}</select>
          <select data-action="f-status" aria-label="Status filter">
            <option value="">Active &amp; inactive</option>
            <option value="active" ${ui.fStatus === 'active' ? 'selected' : ''}>Active only</option>
            <option value="inactive" ${ui.fStatus === 'inactive' ? 'selected' : ''}>Inactive only</option>
          </select>
        </div>
        ${list.length ? `<ul class="list">${list.map(serverRow).join('')}</ul>` : `<div class="empty">${state.servers.length ? 'No matches.' : 'No servers yet. Add them on the left.'}</div>`}
      </div>
    </div>`;
}

function serverRow(s) {
  if (ui.editing === s.id) {
    return `<li><form class="row" data-form="edit" data-id="${s.id}" style="width:100%">
      <input name="name" value="${esc(s.name)}" required style="flex:2; min-width:160px" aria-label="Name">
      <select name="parish" aria-label="Parish">${parishOptions(s.parish)}</select>
      <select name="role" aria-label="Role">${roleOptions(s.role)}</select>
      <input name="contact" value="${esc(s.contact || '')}" placeholder="Contact" style="flex:1; min-width:110px" aria-label="Contact">
      <button class="primary sm" type="submit">Save</button>
      <button class="sm" type="button" data-action="cancel-edit">Cancel</button>
    </form></li>`;
  }
  return `<li class="${s.active ? '' : 'inactive'}">
    <div><div class="name">${esc(s.name)}</div>
      <div class="muted small">${esc(parishName(s.parish))} · ${esc(s.role || 'No role')} · <span class="pill ${s.active ? 'P' : 'A'}">${s.active ? 'Active' : 'Inactive'}</span>${!s.active && s.inactiveReason ? ` <span class="small">${esc(s.inactiveReason)}</span>` : ''}</div></div>
    <div class="row">
      <button class="sm" data-action="print-qr-one" data-id="${s.id}" title="Print this server's QR card">QR</button>
      <button class="sm" data-action="toggle-active" data-id="${s.id}">${s.active ? 'Set inactive' : 'Set active'}</button>
      <button class="sm" data-action="edit" data-id="${s.id}">Edit</button>
      <button class="sm danger" data-action="delete" data-id="${s.id}">Delete</button>
    </div>
  </li>`;
}

/* ----- Schedule (teams per Mass, shuffled per parish) ----- */
function viewSchedule() {
  const pid = ui.schParish;
  const p = parishById(pid);
  if (!p) return '<div class="card empty">Add a parish / chapel in Settings first.</div>';
  const entries = scheduleEntries(pid);
  let entry = entries.find(e => e.id === ui.schEntry) || scheduleOn(pid, todayStr()) || entries[entries.length - 1] || null;
  if (entry) ui.schEntry = entry.id;
  const second = secondMeeting(thisMonth());
  const suggested = todayStr() > second ? addDays(todayStr(), 1) : addDays(second, 1);
  const due = shuffleDue(pid);

  let body;
  if (!entry) {
    body = `<div class="card empty">No teams for ${esc(p.name)} yet. Press <b>Shuffle ${esc(p.name)}</b> to make them.</div>`;
  } else {
    const assigned = new Set(Object.values(entry.teams).flat());
    const unassigned = sortedServers(state.servers.filter(s => s.active && s.parish === pid && !assigned.has(s.id)));
    body = `<div class="grid">${p.masses.map((m, i) => {
      const ids = entry.teams[m.id] || [];
      const leaders = state.leaders.filter(l => l.parish === pid && l.mass === m.id).map(l => l.username);
      const addOpts = sortedServers(state.servers.filter(s => s.active && !ids.includes(s.id)))
        .map(s => `<option value="${s.id}">${esc(s.name)}${s.parish !== pid ? ` (${esc(parishName(s.parish))})` : ''}</option>`).join('');
      return `<div class="card day-card">
        <div class="mass-title"><span>${massName(i)}</span><span class="time">${DAY_NAMES[m.day]} ${fmtTime(m.time)}</span></div>
        <div class="muted small">Leader account: ${leaders.length ? leaders.map(esc).join(', ') : '<span style="color:var(--warn)">none</span>'} · ${ids.length} server(s)</div>
        <div class="chips">
          ${ids.map(id => { const s = byId(id); return `<span class="chip ${s && !s.active ? 'off' : ''}">${esc(nameOf(id))}${s?.role ? `<span class="role">${esc(roleShort(s.role))}</span>` : ''}
            <select class="move" data-action="move" data-entry="${entry.id}" data-from="${m.id}" data-id="${id}" aria-label="Move ${esc(nameOf(id))}" title="Move to another Mass">
              <option value="">⇄</option>${p.masses.filter(x => x.id !== m.id).map(x => `<option value="${x.id}">${massName(p.masses.indexOf(x))}</option>`).join('')}</select>
            <button title="Remove" aria-label="Remove ${esc(nameOf(id))}" data-action="unassign" data-entry="${entry.id}" data-mass="${m.id}" data-id="${id}">×</button></span>`; }).join('')}
          ${addOpts ? `<select data-action="assign" data-entry="${entry.id}" data-mass="${m.id}" aria-label="Add server"><option value="">+ Add</option>${addOpts}</select>` : ''}
        </div>
      </div>`;
    }).join('')}</div>
    ${unassigned.length ? `<div class="card" style="margin-top:12px"><h3>Not in a team yet (${unassigned.length})</h3><p class="muted small">Added after the last shuffle. Use “+ Add” on a Mass above, or shuffle again.</p>
      <div class="load-list">${unassigned.map(s => `<span>${esc(s.name)} · ${esc(s.role || '')}</span>`).join('')}</div></div>` : ''}`;
  }

  return `
    <div class="print-only"><h2>${esc(state.settings.ministry)} — ${esc(p.name)} Altar Server Schedule</h2>${entry ? `<p>Effective ${longDate(entry.from)}</p>` : ''}</div>
    <div class="section-head no-print">
      <div><h2>Schedule</h2><div class="muted small">Each Mass has a team. Shuffle each parish after the 2nd meeting of the month (this month: ${niceDate(second)}).</div></div>
      <div class="pills">${parishes().map(x => `<button class="${x.id === pid ? 'on' : ''}" data-action="sch-parish" data-p="${x.id}">${esc(x.name)}${shuffleDue(x.id) ? ' •' : ''}</button>`).join('')}</div>
    </div>
    ${due ? `<div class="msg-warn no-print">${esc(p.name)} is due for a reshuffle — the 2nd meeting of the month (${niceDate(second)}) has passed.</div>` : ''}
    <div class="card row no-print" style="margin-bottom:14px; align-items:flex-end">
      <div><label for="shFrom">New teams start on</label><input id="shFrom" type="date" value="${suggested}"></div>
      <button class="primary" data-action="shuffle">🔀 Shuffle ${esc(p.name)}</button>
      ${entries.length ? `<div><label for="shEntry">Showing teams</label><select id="shEntry" data-action="sch-entry">${entries.map(e => `<option value="${e.id}" ${entry && e.id === entry.id ? 'selected' : ''}>from ${niceDate(e.from)}${scheduleOn(pid, todayStr())?.id === e.id ? ' (current)' : ''}</option>`).join('')}</select></div>` : ''}
    </div>
    ${entry ? `<div class="row no-print" style="margin-bottom:14px">
      <span class="muted small">Effective ${niceDate(entry.from)} · shuffled ${fmtWhen(entry.generatedAt)}</span>
      <button data-action="sch-image">🖼 Save image for Messenger</button>
      <button data-action="copy-schedule">📋 Copy as text</button>
      <button data-action="print">🖨 Print</button>
      <button data-action="print-team-qr">🖨 Print team QR cards</button>
      <button class="danger" data-action="del-entry">Delete these teams</button>
    </div>` : ''}
    ${body}`;
}

function currentEntry() {
  return scheduleEntries(ui.schParish).find(e => e.id === ui.schEntry) || null;
}

function scheduleText(pid, entry) {
  const p = parishById(pid);
  let out = `✝ ${state.settings.ministry}\n${p.name.toUpperCase()} — ALTAR SERVER SCHEDULE\nEffective ${longDate(entry.from)}\n`;
  p.masses.forEach((m, i) => {
    const ids = entry.teams[m.id] || [];
    out += `\n${massName(i).toUpperCase()} · ${DAY_NAMES[m.day]} ${fmtTime(m.time)}\n`;
    out += ids.length ? ids.map(id => `  • ${nameOf(id)}${byId(id)?.role ? ` (${byId(id).role})` : ''}`).join('\n') : '  —';
    out += '\n';
  });
  out += '\nPlease bring your QR card. God bless your service! 🙏';
  return out;
}

/** Draw the schedule as a PNG image, ready to post in Messenger. */
async function scheduleImage(pid, entry) {
  const p = parishById(pid);
  const W = 1080, padX = 64, colW = (W - padX * 2 - 32) / 2, lineH = 46;
  const blocks = p.masses.map((m, i) => ({ title: `${massName(i)} · ${DAY_NAMES[m.day]} ${fmtTime(m.time)}`, names: (entry.teams[m.id] || []).map(id => ({ n: nameOf(id), r: byId(id)?.role || '' })) }));
  const blockH = b => 74 + Math.max(1, Math.ceil(b.names.length / 2)) * lineH + 24;
  const H = 300 + blocks.reduce((t, b) => t + blockH(b) + 24, 0) + 90;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px Geist, system-ui, "Segoe UI", Roboto, sans-serif`;
  const title = (w, s) => `${w} ${s}px Geist, system-ui, "Segoe UI", Roboto, sans-serif`;
  try { await Promise.all([document.fonts.load(title(700, 56)), document.fonts.load(font(500, 30))]); } catch (e) { /* fall back to system fonts */ }
  g.fillStyle = '#fbf9f5'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#b7191c'; g.fillRect(0, 0, W, 240);
  const logo = new Image();
  await new Promise(r => { logo.onload = r; logo.onerror = r; logo.src = 'logo.png'; });
  try { g.drawImage(logo, padX, 52, 136, 136); } catch (e) { /* no logo */ }
  g.fillStyle = '#f3d27a'; g.font = title(700, 30); g.fillText(state.settings.ministry.toUpperCase(), padX + 164, 92);
  g.fillStyle = '#fff'; g.font = title(700, 56); g.fillText(`${p.name} Schedule`, padX + 164, 154);
  g.font = font(400, 30); g.fillText(`Effective ${longDate(entry.from)}`, padX + 164, 200);
  let y = 280;
  for (const b of blocks) {
    const h = blockH(b);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#e4dcd1'; g.lineWidth = 2;
    g.beginPath(); g.roundRect ? g.roundRect(padX - 16, y, W - padX * 2 + 32, h, 18) : g.rect(padX - 16, y, W - padX * 2 + 32, h); g.fill(); g.stroke();
    g.fillStyle = '#b8892b'; g.fillRect(padX - 16, y, 8, h);
    g.fillStyle = '#b7191c'; g.font = title(700, 32); g.fillText(b.title, padX + 12, y + 52);
    g.font = font(500, 30);
    if (!b.names.length) { g.fillStyle = '#5f6577'; g.fillText('—', padX + 12, y + 74 + 30); }
    b.names.forEach((x, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const tx = padX + 12 + col * (colW + 32), ty = y + 74 + row * lineH + 30;
      g.fillStyle = '#1a2033'; g.font = font(500, 30);
      let name = x.n; while (g.measureText(name).width > colW - 110 && name.length > 4) name = name.slice(0, -2);
      if (name !== x.n) name += '…';
      g.fillText(name, tx, ty);
      if (x.r) { const nw = g.measureText(name).width; g.fillStyle = '#5f6577'; g.font = font(400, 22); g.fillText(x.r, tx + nw + 12, ty); }
    });
    y += h + 24;
  }
  g.fillStyle = '#5f6577'; g.font = font(400, 26);
  g.fillText('Please bring your QR card. God bless your service!', padX, H - 44);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

/* ----- Attendance ----- */
function viewAttendance() {
  const pid = ui.attParish;
  const p = parishById(pid);
  if (!p) return '<div class="card empty">Add a parish / chapel in Settings first.</div>';
  const date = ui.attDate;
  const dow = parse(date).getDay();
  const masses = p.masses.map((m, i) => ({ ...m, i })).filter(m => m.day === dow);
  const days = [...new Set(p.masses.map(m => DAY_NAMES[m.day]))];

  return `
    <div class="section-head">
      <div><h2>Attendance</h2><div class="muted small">${longDate(date)} · leader scans and submissions appear here automatically. You can change any mark.</div></div>
      <div class="row">
        <select data-action="att-parish" aria-label="Parish">${parishOptions(pid)}</select>
        <button data-action="att-day" data-d="-7" aria-label="Previous week">‹‹</button>
        <button data-action="att-day" data-d="-1" aria-label="Previous day">‹</button>
        <input type="date" value="${date}" data-action="att-date" aria-label="Date">
        <button data-action="att-day" data-d="1" aria-label="Next day">›</button>
        <button data-action="att-day" data-d="7" aria-label="Next week">››</button>
        <button data-action="logs-toggle" aria-expanded="${ui.logsOpen}">🗂 Archive / remove logs</button>
      </div>
    </div>
    ${ui.logsOpen ? logsPanel() : ''}
    ${masses.length ? `<div class="grid">${masses.map(m => attendanceCard(p, m, date)).join('')}</div>`
      : `<div class="card empty">${esc(p.name)} has no Mass on ${DAY_NAMES[dow]}. Masses are on: ${days.join(', ') || 'none — add them in Settings'}.</div>`}`;
}

/* ----- Attendance logs: archive / remove ----- */
/** Mass log keys (date#parish#mass) matching the panel's filter, in the active logs or in the archive. */
function logKeys(where) {
  const keys = where === 'archive' ? Object.keys(state.archiveIndex || {})
    : [...new Set([...Object.keys(state.attendance), ...Object.keys(state.submissions)])];
  return keys.filter(k => {
    const m = splitKey(k);
    return (!ui.logParish || m.parish === ui.logParish) && (!ui.logFrom || m.date >= ui.logFrom) && (!ui.logTo || m.date <= ui.logTo);
  }).sort();
}
function logFilterLabel() {
  const where = ui.logParish ? parishName(ui.logParish) : 'all parishes';
  if (ui.logFrom && ui.logFrom === ui.logTo) return `${where} on ${niceDate(ui.logFrom)}`;
  if (ui.logFrom || ui.logTo) return `${where}, ${ui.logFrom ? niceDate(ui.logFrom) : 'the first log'} to ${ui.logTo ? niceDate(ui.logTo) : 'the latest log'}`;
  return `${where}, all dates`;
}
function logsPanel() {
  const active = logKeys('active');
  const marks = active.reduce((n, k) => n + Object.keys(state.attendance[k] || {}).length, 0);
  const pending = active.reduce((n, k) => n + Object.values(state.attendance[k] || {}).filter(r => r.pending).length, 0);
  const archived = logKeys('archive');
  const archivedMarks = archived.reduce((n, k) => n + (state.archiveIndex[k] || 0), 0);
  const totalArchived = Object.keys(state.archiveIndex || {}).length;
  return `<div class="card stack" style="margin-bottom:16px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Archive or remove attendance logs</h3>
      <button class="sm" data-action="logs-toggle">Close</button></div>
    <p class="muted small" style="margin:0">A log is one Mass on one date: its marks (Present / Absent / Excused) and the leader's submitted report.
      <b>Archive</b> moves logs out of Attendance, the Dashboard and Monthly Reports, but keeps them so you can download or restore them later.
      <b>Delete permanently</b> erases them.</p>
    <div class="row">
      <div><label for="logParish">Parish / chapel</label><select id="logParish" data-action="log-parish">${parishOptions(ui.logParish || '', 'All parishes')}</select></div>
      <div><label for="logFrom">From</label><input id="logFrom" type="date" value="${ui.logFrom}" data-action="log-from"></div>
      <div><label for="logTo">To</label><input id="logTo" type="date" value="${ui.logTo}" data-action="log-to"></div>
      <div style="align-self:flex-end" class="row">
        <button class="sm" data-action="log-day">This day (${niceDate(ui.attDate)})</button>
        <button class="sm" data-action="log-clear">All dates</button>
      </div>
    </div>
    <div class="muted small">Selected: <b>${esc(logFilterLabel())}</b> · ${active.length} Mass log(s), ${marks} mark(s)${pending ? ` · <span style="color:var(--warn)">${pending} waiting for approval</span>` : ''}</div>
    <div class="row">
      <button class="primary" data-action="logs-run" data-op="archive" ${active.length ? '' : 'disabled'}>🗂 Archive ${active.length} log(s)</button>
      <button class="danger" data-action="logs-run" data-op="delete" ${active.length ? '' : 'disabled'}>🗑 Delete permanently</button>
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:4px 0">
    <h4 style="margin:0">Archived logs</h4>
    ${totalArchived ? `<div class="muted small">${totalArchived} archived Mass log(s) in total · ${archived.length} match the selection above (${archivedMarks} mark(s)).</div>
      <div class="row">
        <button class="sm" data-action="logs-download">⬇ Download archive (CSV)</button>
        <button class="sm" data-action="logs-run" data-op="restore" ${archived.length ? '' : 'disabled'}>↩ Restore ${archived.length} selected</button>
        <button class="sm danger" data-action="logs-run" data-op="purge" ${archived.length ? '' : 'disabled'}>🗑 Delete ${archived.length} selected from archive</button>
      </div>` : '<div class="muted small">Nothing archived yet.</div>'}
  </div>`;
}

/** Turn archived logs into CSV rows. */
function archiveCsv(arch) {
  const keys = [...new Set([...Object.keys(arch.attendance), ...Object.keys(arch.submissions)])].sort();
  const rows = [['Date', 'Parish / Chapel', 'Mass', 'Name', 'Role', 'Mark', 'Pending approval', 'Reason', 'Recorded by', 'Report submitted by', 'Archived at']];
  for (const k of keys) {
    const { date, parish, mass } = splitKey(k);
    const sub = arch.submissions[k];
    const recs = Object.entries(arch.attendance[k] || {});
    const base = [date, parishName(parish), massLabel(parish, mass)];
    const tail = [sub ? `${sub.by} (${fmtWhen(sub.at)})` : '', arch.archivedAt[k] ? fmtWhen(arch.archivedAt[k]) : ''];
    if (!recs.length) rows.push([...base, '', '', '', '', '', '', ...tail]);
    for (const [id, r] of recs) rows.push([...base, nameOf(id), byId(id)?.role || '', STATUS[r.s] || r.s, r.pending ? 'Yes' : '', r.reason || '', r.by || '', ...tail]);
  }
  return toCsv(rows);
}

function attendanceCard(p, m, date) {
  const key = keyOf(date, p.id, m.id);
  const rec = state.attendance[key] || {};
  const team = teamOf(p.id, m.id, date);
  const ids = [...new Set([...team, ...Object.keys(rec)])].sort((a, b) => (team.includes(b) - team.includes(a)) || nameOf(a).localeCompare(nameOf(b)));
  const sub = state.submissions[key];
  const others = sortedServers(state.servers.filter(s => !ids.includes(s.id))).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(parishName(s.parish))})</option>`).join('');
  return `<div class="card">
    <div class="mass-title"><span>${massName(m.i)}</span><span class="time">${fmtTime(m.time)}</span></div>
    <div class="muted small">${sub ? `✔ Submitted by ${esc(sub.by)} · ${fmtWhen(sub.at)}` : 'Not submitted by the leader yet'}</div>
    <div style="margin-top:6px">
      ${ids.length ? ids.map(id => attRow(key, id, rec[id], !team.includes(id))).join('') : '<p class="muted small">No team for this date. Shuffle in Schedule.</p>'}
    </div>
    <div class="row" style="margin-top:10px">
      ${team.length ? `<button class="sm" data-action="rest-absent" data-key="${key}" data-ids="${team.join(',')}">Mark rest absent</button>` : ''}
      ${others ? `<select class="sm" data-action="add-other" data-key="${key}" aria-label="Add another server"><option value="">+ Another server served</option>${others}</select>` : ''}
    </div>
  </div>`;
}

function attRow(key, id, r, notOnTeam) {
  const s = byId(id);
  const tags = [];
  if (notOnTeam) tags.push('<span class="tag">not on team</span>');
  if (r?.pending) tags.push('<span class="tag warn">pending approval</span>');
  if (r?.via === 'qr') tags.push(`<span class="tag qr" title="Scanned by ${esc(r.by)}">QR ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`);
  if (r?.s === 'E') tags.push(`<span class="tag">${r.excuseType === 'before' ? 'excused in advance' : 'excused on the day'}</span>`);
  return `<div class="att-row">
    <span class="att-name">${esc(nameOf(id))} <span class="muted small">${esc(s?.role || '')}</span>${tags.join('')}
      ${r?.reason ? `<div class="muted small">“${esc(r.reason)}”${r.by ? ` — ${esc(r.by)}` : ''}</div>` : ''}</span>
    ${r?.pending ? `<span class="row"><button class="sm primary" data-action="approve" data-key="${key}" data-id="${id}">Approve</button><button class="sm danger" data-action="reject" data-key="${key}" data-id="${id}">Reject</button></span>`
      : `<span class="seg">${Object.keys(STATUS).map(k => `<button class="${k} ${r?.s === k ? 'on' : ''}" title="${STATUS[k]}" data-action="mark" data-key="${key}" data-id="${id}" data-s="${k}">${k}</button>`).join('')}</span>`}
  </div>`;
}

/* ----- Approvals ----- */
function viewApprovals() {
  const list = pendingList();
  return `
    <div class="section-head"><div><h2>Approvals</h2>
      <div class="muted small">Servers who served at a Mass they are not assigned to. The leader of that Mass wrote the reason. They count as Present only after an admin/secretary approves.</div></div>
      ${list.length > 1 ? '<button class="primary" data-action="approve-all">Approve all</button>' : ''}</div>
    ${list.length ? `<div class="card"><ul class="list">${list.map(x => {
      const s = byId(x.id);
      return `<li><div><div class="name">${esc(nameOf(x.id))} <span class="muted small">${esc(parishName(s?.parish))} · ${esc(s?.role || '')}</span></div>
        <div class="small">Served at <b>${esc(parishName(x.parish))} ${esc(massLabel(x.parish, x.mass))}</b>, ${niceDate(x.date)}</div>
        <div class="muted small">Reason: “${esc(x.r.reason)}” — noted by leader ${esc(x.r.by)} · ${fmtWhen(x.r.at)}</div></div>
        <div class="row"><button class="primary sm" data-action="approve" data-key="${x.key}" data-id="${x.id}">Approve (Present)</button>
          <button class="danger sm" data-action="reject" data-key="${x.key}" data-id="${x.id}">Reject</button></div></li>`;
    }).join('')}</ul></div>` : '<div class="card empty">Nothing waiting for approval. 🙌</div>'}`;
}

/* ----- Monthly reports ----- */
function reportRows(month) {
  const { per } = monthStats(month);
  return state.servers.map(s => {
    const c = per[s.id] || { P: 0, A: 0, E: 0 };
    return { s, P: c.P, A: c.A, E: c.E };
  });
}
function sortRows(rows) {
  return rows.sort(ui.repSort === 'present' ? (a, b) => b.P - a.P || a.A - b.A || a.s.name.localeCompare(b.s.name) : (a, b) => a.s.name.localeCompare(b.s.name));
}

function reportTable(title, rows) {
  const t = rows.reduce((x, r) => ({ P: x.P + r.P, A: x.A + r.A, E: x.E + r.E }), { P: 0, A: 0, E: 0 });
  return `<h4>${title} (${rows.length})</h4>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Parish / Chapel</th><th>Role in ministry</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Excuses</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.s.name)}</td><td>${esc(parishName(r.s.parish))}</td><td>${esc(r.s.role)}</td><td class="num">${r.P}</td><td class="num">${r.A}</td><td class="num">${r.E}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="3">Total</th><th class="num">${t.P}</th><th class="num">${t.A}</th><th class="num">${t.E}</th></tr></tfoot>
    </table></div>` : '<p class="muted small">None.</p>'}`;
}

function viewReports() {
  const m = ui.repMonth;
  const rows = reportRows(m);
  const shown = parishes().filter(p => !ui.repParish || p.id === ui.repParish);
  return `
    <div class="print-only"><h2>${esc(state.settings.ministry)} — Monthly Report</h2><p>${monthLabel(m)}</p></div>
    <div class="section-head no-print">
      <div><h2>Monthly Reports</h2><div class="muted small">Summary of active &amp; inactive servers per parish. For big occasions, sort by “Most present” to choose servers.</div></div>
      <div class="row">
        <input type="month" value="${m}" data-action="rep-month" aria-label="Month">
        <select data-action="rep-parish" aria-label="Parish">${parishOptions(ui.repParish, 'All parishes')}</select>
        <select data-action="rep-sort" aria-label="Sort"><option value="name">Sort by name</option><option value="present" ${ui.repSort === 'present' ? 'selected' : ''}>Most present first</option></select>
        <button data-action="print">🖨 Print</button>
        <button data-action="export-report">⬇ CSV</button>
      </div>
    </div>
    ${shown.map(p => {
      const pr = rows.filter(r => r.s.parish === p.id);
      return `<div class="card report-card" style="margin-bottom:14px">
        <div class="row spread"><h3>${esc(p.name)} · ${monthLabel(m)}</h3>
          <span class="muted small">${pr.filter(r => r.s.active).length} active · ${pr.filter(r => !r.s.active).length} inactive</span></div>
        ${reportTable('Active servers', sortRows(pr.filter(r => r.s.active)))}
        ${reportTable('Inactive servers', sortRows(pr.filter(r => !r.s.active)))}
      </div>`;
    }).join('')}
    ${!ui.repParish && rows.some(r => !parishById(r.s.parish)) ? `<div class="card">${reportTable('No parish set', sortRows(rows.filter(r => !parishById(r.s.parish))))}</div>` : ''}`;
}

/* ----- Settings ----- */
function viewSettings() {
  const st = state.settings;
  const massOpts = parishes().flatMap(p => p.masses.map((m, i) => `<option value="${p.id}|${m.id}">${esc(p.name)} — ${massName(i)} (${DAY_NAMES[m.day]} ${fmtTime(m.time)})</option>`)).join('');
  return `
    <div class="section-head"><div><h2>Settings</h2></div></div>
    <div class="stack">
      <div class="card stack">
        <div><label for="ministry">Ministry name</label><input id="ministry" value="${esc(st.ministry)}" data-action="ministry" style="width:100%; max-width:420px"></div>
      </div>

      <div class="card stack">
        <h3>Parishes / chapels and their Masses</h3>
        <p class="muted small" style="margin:0">Each Mass gets its own team when you shuffle, and its own leader account for the mobile app.</p>
        ${parishes().map(p => `<div class="parish-cfg">
          <div class="row"><input value="${esc(p.name)}" data-action="parish-name" data-p="${p.id}" aria-label="Parish name" style="font-weight:600">
            <button class="sm" data-action="add-mass" data-p="${p.id}" ${p.masses.length >= 8 ? 'disabled' : ''}>+ Mass</button>
            <button class="sm danger" data-action="del-parish" data-p="${p.id}">Remove</button></div>
          <div class="row" style="margin-top:8px">${p.masses.map((m, i) => `<span class="chip" style="padding:3px 4px 3px 10px">
            <b class="small">${massName(i)}</b>
            <select data-action="mass-day" data-p="${p.id}" data-m="${m.id}" aria-label="Day" style="padding:2px 4px">${DAY_NAMES.map((d, di) => `<option value="${di}" ${di === m.day ? 'selected' : ''}>${d.slice(0, 3)}</option>`).join('')}</select>
            <input type="time" value="${m.time}" data-action="mass-time" data-p="${p.id}" data-m="${m.id}" aria-label="Time" style="padding:2px 4px">
            <button title="Remove this Mass" data-action="del-mass" data-p="${p.id}" data-m="${m.id}">×</button></span>`).join('') || '<span class="muted small">No Masses yet.</span>'}</div>
        </div>`).join('')}
        <div><button data-action="add-parish">+ Add parish / chapel</button></div>
      </div>

      <div class="card stack">
        <h3>Mass leader accounts (mobile app)</h3>
        <p class="muted small" style="margin:0">Leaders log in on their phone at <b>${esc(ui.info ? `${ui.info.baseUrl}/app` : '/app')}</b> and scan the servers' QR cards.</p>
        <div class="row" style="align-items:flex-start">
          <div class="qr-box small-qr" id="appQr">${ui.appQr || '<span class="muted small">…</span>'}</div>
          <ul class="list" style="flex:1; min-width:260px">${state.leaders.length ? state.leaders.map(l => `<li><span><b>${esc(l.username)}</b> <span class="muted small">${esc(parishName(l.parish))} — ${esc(massLabel(l.parish, l.mass))}</span></span>
            <span class="row"><button class="sm" data-action="leader-pw" data-u="${esc(l.username)}">New password</button><button class="sm danger" data-action="del-leader" data-u="${esc(l.username)}">Remove</button></span></li>`).join('') : '<li class="muted">No leader accounts yet.</li>'}</ul>
        </div>
        <form class="row" data-form="add-leader" style="align-items:flex-end">
          <div><label for="lU">Username</label><input id="lU" name="username" required autocomplete="off" placeholder="e.g. 2ndmass" autocapitalize="none"></div>
          <div><label for="lP">Password (8+ characters)</label><input id="lP" name="password" type="text" minlength="8" required autocomplete="off"></div>
          <div><label for="lM">For which Mass</label><select id="lM" name="mass" required>${massOpts}</select></div>
          <button type="submit">Add leader</button>
        </form>
      </div>

      <div class="card stack">
        <h3>Rules</h3>
        <label style="color:var(--text)"><input type="checkbox" data-action="manual-pick" ${st.allowManualPick ? 'checked' : ''}>
          Allow leaders to choose servers from a list (“multiple choices”) instead of scanning. <span class="muted">Leave OFF so servers must bring their QR card.</span></label>
        <div class="row" style="align-items:flex-end">
          <div><label for="inAfter">Absences in a row before Inactive</label><input id="inAfter" type="number" min="1" max="20" value="${st.inactiveAfter}" data-action="inactive-after" style="width:110px"></div>
          <div><label for="meetDay">Meeting day (shuffle after the 2nd one each month)</label><select id="meetDay" data-action="meeting-day">${DAY_NAMES.map((d, i) => `<option value="${i}" ${i === Number(st.meetingDay) ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
          <div><label for="tz">Time zone</label><input id="tz" value="${esc(st.timezone || '')}" data-action="tz" placeholder="Asia/Manila" style="width:170px"></div>
        </div>
      </div>

      <div class="card stack">
        <h3>Link used in QR codes</h3>
        <p class="muted small" style="margin:0">Phones must be able to open this address. On the church Wi-Fi it's this computer's network address; if you host the system online, put the website address here.
          <b>Re-print QR cards after changing it.</b></p>
        <div><label for="publicUrl">Public address (leave blank to detect automatically)</label>
          <input id="publicUrl" placeholder="${esc(ui.info?.lan?.[0] || 'https://your-site.example.com')}" value="${esc(st.publicUrl || '')}" data-action="public-url" style="width:100%; max-width:420px"></div>
        <div class="muted small">Currently using: <b>${esc(ui.info?.baseUrl || '…')}</b></div>
      </div>

      <div class="card stack">
        <h3>Admin / secretary accounts</h3>
        <div id="adminsBox"><span class="muted small">Loading…</span></div>
        <form class="row" data-form="add-admin" style="align-items:flex-end">
          <div><label for="aU">New username</label><input id="aU" name="username" required autocomplete="off" autocapitalize="none"></div>
          <div><label for="aP">Password (8+ characters)</label><input id="aP" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
          <button type="submit">Add admin</button>
        </form>
        <form class="row" data-form="change-pw" style="align-items:flex-end">
          <div><label for="cpC">Your current password</label><input id="cpC" name="current" type="password" required autocomplete="current-password"></div>
          <div><label for="cpN">New password</label><input id="cpN" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
          <button type="submit">Change my password</button>
        </form>
      </div>

      <div class="card stack">
        <h3>Backup &amp; data</h3>
        <p class="muted small" style="margin:0">Everything is stored on the server in <code>data/db.json</code>. Export a backup regularly.</p>
        <div class="row">
          <button data-action="export-json">⬇ Export backup</button>
          <label class="btn" style="margin:0; cursor:pointer">⬆ Import backup<input type="file" accept="application/json,.json" data-action="import-json" hidden></label>
          <button class="danger" data-action="reset">Erase all ministry data</button>
        </div>
      </div>
    </div>`;
}

async function loadSettingsExtras() {
  try {
    if (!ui.info) { ui.info = await api('GET', '/api/info'); if (ui.tab === 'settings') return render(); }
    if (!ui.appQr) {
      const r = await api('GET', `/api/qr/text?text=${encodeURIComponent(`${ui.info.baseUrl}/app`)}`);
      ui.appQr = r.svg;
      const b = document.getElementById('appQr'); if (b) b.innerHTML = r.svg;
    }
    const r = await api('GET', '/api/admins');
    const box = document.getElementById('adminsBox');
    if (box) box.innerHTML = `<ul class="list">${r.admins.map(a => `<li><span><b>${esc(a.username)}</b>${a.username === r.me ? ' <span class="tag">you</span>' : ''}</span>
      ${a.username !== r.me ? `<button class="sm danger" data-action="del-admin" data-u="${esc(a.username)}">Remove</button>` : ''}</li>`).join('')}</ul>`;
  } catch (e) { /* shown elsewhere */ }
}

/* ---------------- Printing QR cards ---------------- */
async function printQrCards(ids, title) {
  if (!ids.length) return toast('No servers to print.');
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print.');
  w.document.write('<p style="font-family:sans-serif">Preparing QR cards…</p>');
  try {
    const { qr } = await api('POST', '/api/qr/servers', { ids });
    const logo = `${location.origin}/logo.png`;
    const cards = ids.map(id => {
      const s = byId(id);
      if (!s || !qr[id]) return '';
      return `<div class="card"><div class="top"><img src="${logo}" alt=""><div><b>${esc(state.settings.ministry)}</b><span>Altar Server ID</span></div></div>
        <div class="qr">${qr[id]}</div>
        <div class="nm">${esc(s.name)}</div><div class="meta">${esc(parishName(s.parish))} · ${esc(s.role || '')}</div><div class="code">${esc(s.code)}</div></div>`;
    }).join('');
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:#000}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .card{border:1.5px dashed #999;border-radius:10px;padding:10px;text-align:center;break-inside:avoid}
      .top{display:flex;gap:8px;align-items:center;text-align:left;border-bottom:2px solid #b7191c;padding-bottom:6px;margin-bottom:6px}
      .top img{width:34px;height:34px}.top b{display:block;font-size:11px}.top span{font-size:10px;color:#b7191c;font-weight:700;text-transform:uppercase}
      .qr svg{width:150px;height:150px}.nm{font-weight:700;font-size:14px}.meta{font-size:12px}.code{font-family:monospace;font-size:11px;color:#555;letter-spacing:1px}
      h1{font-size:16px;margin:0 0 8px}@media print{h1{display:none}body{padding:0}}
    </style></head><body><h1>${esc(title)} — cut along the dashed lines</h1><div class="grid">${cards}</div></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  } catch (e) { w.close(); toast(e.message); }
}

/* ---------------- CSV ---------------- */
function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); }
}
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(s => s.trim())).filter(r => r.some(Boolean));
}
const COLS = {
  name: ['name', 'fullname', 'completename', 'servername', 'acolyte'],
  first: ['firstname', 'first', 'givenname'], middle: ['middlename', 'middle', 'mi'], last: ['lastname', 'last', 'surname'],
  parish: ['parish', 'chapel', 'parishchapel', 'parishorchapel'], role: ['role', 'roleinministry', 'level', 'rank'],
  mass: ['mass', 'massschedule', 'schedule', 'masstime', 'team', 'assignedmass'],
  contact: ['contact', 'contactno', 'contactnumber', 'phone', 'mobile', 'cellphone', 'email'],
};

/**
 * Read a Mass cell such as "1st Mass", "Second", "2", "8:00 AM", "Sunday 4:00 PM" or "16:00".
 * Returns { index } (0-based Mass number), and/or { day, time } when a time is given.
 */
function parseMassCell(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return null;
  const out = {};
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].findIndex(d => new RegExp(`\\b${d}`).test(s));
  if (day >= 0) out.day = day;
  const t = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\b\.?/) || s.match(/(\d{1,2})[:.](\d{2})/);
  if (t) {
    let h = Number(t[1]); const m = Number(t[2] || 0);
    if (t[3] === 'p' && h < 12) h += 12;
    if (t[3] === 'a' && h === 12) h = 0;
    if (h < 24 && m < 60) out.time = `${pad(h)}:${pad(m)}`;
  }
  if (!out.time) {
    const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
    const w = words.findIndex(x => s.includes(x));
    const n = s.match(/(?:^|\bm|\bmass\s*#?\s*)(\d)(?:st|nd|rd|th)?\b/) || s.match(/\b(\d)(?:st|nd|rd|th)?\b/);
    if (w >= 0) out.index = w; else if (n) out.index = Number(n[1]) - 1;
    if (out.index !== undefined && (out.index < 0 || out.index > 7)) delete out.index;
  }
  return out.time || out.index !== undefined ? out : null;
}

/**
 * Import servers from a CSV. Columns: Name (or First/Middle/Last), Parish/Chapel, Role, optional Mass, optional Contact.
 * - New names are added to the roster; names already in the roster are matched (not duplicated).
 * - Chapels and Masses that don't exist yet are created.
 * - When a Mass column is present, each server is placed on that Mass's team in their chapel's schedule
 *   (effective today). Servers not listed in the file keep their current team.
 */
function importCsv(text) {
  const rows = parseCsv(text);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  (rows[0] || []).forEach((h, i) => { for (const [k, names] of Object.entries(COLS)) if (map[k] === undefined && names.includes(norm(h).replace(/[0-9]/g, ''))) map[k] = i; });
  if (map.name === undefined && map.first === undefined) return toast('Could not find a Name column in the first row.');
  const get = (r, k) => (map[k] !== undefined ? (r[map[k]] || '').trim() : '');
  const findRole = v => state.settings.roles.find(r => norm(r) === norm(v) || norm(r) === `${norm(v)}s`) || '';

  // Work on copies so nothing changes unless the admin confirms.
  const parishList = JSON.parse(JSON.stringify(parishes()));
  const newParishes = [], newMasses = [];
  const findParish = v => parishList.find(p => norm(p.name) === norm(v) || p.id === norm(v));
  function parishFor(v) {
    if (!v) return null;
    let p = findParish(v);
    if (!p) {
      let id = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'parish';
      while (parishList.some(x => x.id === id)) id += '-2';
      p = { id, name: v.replace(/\s+/g, ' ').trim().slice(0, 60), masses: [] };
      parishList.push(p); newParishes.push(p.name);
    }
    return p;
  }
  function massFor(p, cell) {
    const m = parseMassCell(cell);
    if (!m) return null;
    let found;
    if (m.time) found = p.masses.find(x => x.time === m.time && (m.day === undefined || x.day === m.day));
    else found = p.masses[m.index];
    if (found) return found.id;
    if (p.masses.length >= 8) return null;
    if (m.time) {
      const nm = { id: `m${uid()}`, day: m.day ?? p.masses[0]?.day ?? 0, time: m.time };
      p.masses.push(nm); newMasses.push(`${p.name} ${DAY_NAMES[nm.day]} ${fmtTime(nm.time)}`);
      return nm.id;
    }
    while (p.masses.length <= m.index) {
      const last = p.masses[p.masses.length - 1];
      const nm = { id: `m${uid()}${p.masses.length}`, day: last ? last.day : 0, time: last ? last.time : '07:00' };
      p.masses.push(nm); newMasses.push(`${p.name} ${massName(p.masses.length - 1)} (set its time in Settings)`);
    }
    return p.masses[m.index].id;
  }

  const byName = new Map(state.servers.map(s => [s.name.toLowerCase(), s]));
  const add = [], fill = [], seen = new Set();
  const assign = {}; // parishId -> { serverId: massId }
  let unknownMass = 0, noParish = 0;
  for (const r of rows.slice(1)) {
    const name = (get(r, 'name') || [get(r, 'first'), get(r, 'middle'), get(r, 'last')].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const p = parishFor(get(r, 'parish'));
    if (!p) noParish++;
    const role = findRole(get(r, 'role'));
    let s = byName.get(name.toLowerCase());
    if (!s) {
      s = { id: uid(), name: name.slice(0, 100), parish: p?.id || '', role, contact: get(r, 'contact'), active: true, since: todayStr() };
      add.push(s);
    } else if ((!s.parish && p) || (!s.role && role)) {
      fill.push({ s, parish: s.parish || p?.id || '', role: s.role || role });
    }
    if (map.mass !== undefined && get(r, 'mass')) {
      const mp = p || parishList.find(x => x.id === s.parish);
      const mid = mp && massFor(mp, get(r, 'mass'));
      if (mid) (assign[mp.id] = assign[mp.id] || {})[s.id] = mid; else unknownMass++;
    }
  }

  parishList.forEach(p => { if (!p.masses.length) p.masses.push({ id: `m${uid()}`, day: 0, time: '07:00' }); });
  const assigned = Object.values(assign).reduce((n, a) => n + Object.keys(a).length, 0);
  if (!add.length && !fill.length && !assigned) return toast('Nothing to import: no new names or Mass assignments found.');
  const lines = [];
  if (add.length) lines.push(`• Add ${add.length} new server(s)`);
  const matched = seen.size - add.length;
  if (matched) lines.push(`• ${matched} name(s) already in the roster are matched, not duplicated${fill.length ? ` (${fill.length} get a missing parish/role filled in)` : ''}`);
  if (newParishes.length) lines.push(`• Create parish / chapel: ${newParishes.join(', ')}`);
  if (newMasses.length) lines.push(`• Create Mass: ${newMasses.join('; ')}`);
  if (assigned) lines.push(`• Put ${assigned} server(s) on Mass teams in ${Object.keys(assign).map(id => parishList.find(p => p.id === id).name).join(', ')} (schedule effective today, ${niceDate(todayStr())})`);
  if (noParish) lines.push(`• ${noParish} row(s) have no parish / chapel; set it later with Edit`);
  if (unknownMass) lines.push(`• ${unknownMass} Mass value(s) could not be read; those servers are not put on a team`);
  if (!confirm(`Import this CSV?\n\n${lines.join('\n')}`)) return;

  state.settings.parishes = parishList;
  state.servers.push(...add);
  fill.forEach(f => { f.s.parish = f.parish; f.s.role = f.role; });
  const today = todayStr();
  for (const [pid, a] of Object.entries(assign)) {
    const p = parishList.find(x => x.id === pid);
    const list = state.schedules[pid] || [];
    let entry = list.find(e => e.from === today);
    if (!entry) {
      const cur = scheduleOn(pid, today);
      entry = { id: uid(), from: today, generatedAt: new Date().toISOString(), teams: JSON.parse(JSON.stringify(cur?.teams || {})) };
      list.push(entry);
    }
    p.masses.forEach(m => { entry.teams[m.id] = entry.teams[m.id] || []; });
    for (const [sid, mid] of Object.entries(a)) {
      Object.keys(entry.teams).forEach(k => { entry.teams[k] = entry.teams[k].filter(id => id !== sid); });
      entry.teams[mid].push(sid);
    }
    state.schedules[pid] = list;
    if (ui.schParish === pid) ui.schEntry = entry.id;
  }
  save(); render();
  toast(`Imported: ${add.length} new server(s)${assigned ? `, ${assigned} placed on Mass teams` : ''}.`);
}

/* ---------------- Polling: leader scans & submissions show up live ---------------- */
let pollTimer = null;
function stopTimers() { clearInterval(pollTimer); pollTimer = null; }
function startPolling() {
  stopTimers();
  pollTimer = setInterval(async () => {
    if (document.hidden || saveTimer || !state) return;
    try {
      const s = await api('GET', '/api/state');
      if (saveTimer || !state) return;
      const changed = s.version !== state.version || JSON.stringify(s.attendance) !== JSON.stringify(state.attendance) || s.notifications.length !== state.notifications.length || JSON.stringify(s.leaders) !== JSON.stringify(state.leaders);
      if (!changed) return;
      state = s;
      const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (!typing) { const y = window.scrollY; render(); window.scrollTo(0, y); }
    } catch (e) { /* offline; try again */ }
  }, 6000);
}

/* ---------------- Actions ---------------- */
async function serverCall(method, url, body) {
  try { applySnapshot(await api(method, url, body)); } catch (e) { toast(e.message); }
}

document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn && state) { ui.tab = tabBtn.dataset.tab; ui.editing = null; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('button[data-action]');
  if (!el) return;
  const { action } = el.dataset;

  if (action === 'reload') { location.reload(); return; }
  if (action === 'logout') {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await flush(); }
    await api('POST', '/api/auth/logout').catch(() => {});
    showLogin();
    return;
  }
  if (!state) return;

  switch (action) {
    case 'goto': ui.tab = el.dataset.tab; break;
    case 'goto-schedule': ui.tab = 'schedule'; ui.schParish = el.dataset.p; ui.schEntry = null; break;
    case 'dash-month': ui.dashMonth = shiftMonth(ui.dashMonth, Number(el.dataset.d)); break;
    case 'read-all': return serverCall('POST', '/api/notifications/read');
    case 'clear-read':
      if (!confirm('Clear all notifications that have been read? This cannot be undone.')) return;
      return serverCall('POST', '/api/notifications/clear');

    /* roster */
    case 'print-qr': printQrCards(rosterFiltered().map(s => s.id), 'Altar Server QR cards'); return;
    case 'print-qr-one': printQrCards([el.dataset.id], `QR card — ${nameOf(el.dataset.id)}`); return;
    case 'toggle-active': {
      const s = byId(el.dataset.id);
      s.active = !s.active; s.since = todayStr(); s.inactiveReason = s.active ? '' : 'Set by admin';
      save(); break;
    }
    case 'edit': ui.editing = el.dataset.id; break;
    case 'cancel-edit': ui.editing = null; break;
    case 'delete': {
      const s = byId(el.dataset.id);
      if (!confirm(`Delete ${s.name}?\n\nTheir attendance history will show “(removed)”. Tip: set them Inactive instead to keep their name in reports.`)) return;
      state.servers = state.servers.filter(x => x.id !== s.id);
      Object.values(state.schedules).forEach(list => list.forEach(en => Object.keys(en.teams).forEach(m => { en.teams[m] = en.teams[m].filter(id => id !== s.id); })));
      save(); break;
    }
    case 'export-roster':
      download(`roster-${todayStr()}.csv`, toCsv([['Name', 'Parish', 'Role', 'Status', 'Contact', 'QR code'],
        ...sortedServers().map(s => [s.name, parishName(s.parish), s.role, s.active ? 'Active' : 'Inactive', s.contact || '', s.code])]), 'text/csv');
      return;
    case 'csv-template': {
      const p = parishes()[0], q = parishes()[1] || p;
      const mass = (pp, i) => { const m = pp?.masses[i] || pp?.masses[0]; return m ? `${massName(pp.masses.indexOf(m))} (${DAY_NAMES[m.day]} ${fmtTime(m.time)})` : '1st Mass'; };
      download('roster-template.csv', toCsv([['Name', 'Parish', 'Role', 'Mass', 'Contact'],
        ['Juan Dela Cruz', p?.name || 'Agusan', 'Seniors', mass(p, 0), '09171234567'],
        ['Maria Santos', p?.name || 'Agusan', 'Juniors', mass(p, 1), ''],
        ['Paolo Reyes', q?.name || 'Tablon', 'Elders', mass(q, 0), '']]), 'text/csv');
      return;
    }

    /* schedule */
    case 'sch-parish': ui.schParish = el.dataset.p; ui.schEntry = null; break;
    case 'shuffle': {
      const from = document.getElementById('shFrom').value || todayStr();
      const p = parishById(ui.schParish);
      if ((state.schedules[p.id] || []).some(s => s.from === from) && !confirm(`Teams starting ${niceDate(from)} already exist for ${p.name}. Replace them?`)) return;
      if (shuffleParish(p.id, from)) toast(`${p.name} shuffled ✔ — teams start ${niceDate(from)}.`);
      break;
    }
    case 'unassign': {
      const en = currentEntry();
      en.teams[el.dataset.mass] = en.teams[el.dataset.mass].filter(id => id !== el.dataset.id);
      save(); break;
    }
    case 'del-entry': {
      const en = currentEntry();
      if (!en || !confirm(`Delete the ${parishName(ui.schParish)} teams that start ${niceDate(en.from)}?`)) return;
      state.schedules[ui.schParish] = state.schedules[ui.schParish].filter(x => x.id !== en.id);
      ui.schEntry = null; save(); break;
    }
    case 'print': window.print(); return;
    case 'copy-schedule': {
      const text = scheduleText(ui.schParish, currentEntry());
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast('Copied — paste it in Messenger.'))
        .catch(() => download(`schedule-${parishName(ui.schParish)}.txt`, text, 'text/plain'));
      return;
    }
    case 'sch-image': {
      const en = currentEntry();
      const blob = await scheduleImage(ui.schParish, en);
      const name = `${parishName(ui.schParish)}-schedule-${en.from}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).catch(() => download(name, blob));
      } else { download(name, blob); toast('Image saved — post it in the Messenger group.'); }
      return;
    }
    case 'print-team-qr': {
      const en = currentEntry();
      const p = parishById(ui.schParish);
      printQrCards(p.masses.flatMap(m => en.teams[m.id] || []), `${p.name} team QR cards`);
      return;
    }

    /* attendance */
    case 'att-day': ui.attDate = addDays(ui.attDate, Number(el.dataset.d)); break;
    case 'logs-toggle':
      ui.logsOpen = !ui.logsOpen;
      if (ui.logsOpen && ui.logParish === null) { ui.logParish = ui.attParish; ui.logFrom = ui.logTo = ui.attDate; }
      break;
    case 'log-day': ui.logParish = ui.attParish; ui.logFrom = ui.logTo = ui.attDate; break;
    case 'log-clear': ui.logFrom = ''; ui.logTo = ''; break;
    case 'logs-run': {
      const op = el.dataset.op;
      const keys = logKeys(op === 'archive' || op === 'delete' ? 'active' : 'archive');
      if (!keys.length) return toast('No logs match the selection.');
      const pending = op === 'archive' || op === 'delete'
        ? keys.reduce((n, k) => n + Object.values(state.attendance[k] || {}).filter(r => r.pending).length, 0) : 0;
      const what = `${keys.length} Mass log(s) for ${logFilterLabel()}`;
      const msg = {
        archive: `Archive ${what}?\n\nThey leave Attendance, the Dashboard and Monthly Reports, but are kept. You can download or restore them later.`,
        delete: `Permanently delete ${what}?\n\nThis erases the marks and the leaders' submitted reports. It cannot be undone. Consider "Archive" instead.`,
        restore: `Restore ${what} from the archive?\n\nThey come back to Attendance, the Dashboard and Monthly Reports.`,
        purge: `Permanently delete ${what} from the archive?\n\nThis cannot be undone. Download the archive first if you want a copy.`,
      }[op] + (pending ? `\n\n${pending} record(s) are still waiting for approval and will leave the Approvals list.` : '');
      if (!confirm(msg)) return;
      if ((op === 'delete' || op === 'purge') && !confirm(`Last check: permanently delete ${keys.length} Mass log(s)?`)) return;
      try {
        const r = await api('POST', '/api/logs', { action: op, parish: ui.logParish || '', from: ui.logFrom, to: ui.logTo });
        applySnapshot(r);
        toast({ archive: 'Archived', delete: 'Deleted', restore: 'Restored', purge: 'Deleted from archive' }[op] + `: ${r.changed} Mass log(s).`);
      } catch (err) { toast(err.message); }
      return;
    }
    case 'logs-download': {
      try {
        const arch = await api('GET', '/api/logs/archive');
        download(`attendance-archive-${todayStr()}.csv`, archiveCsv(arch), 'text/csv');
      } catch (err) { toast(err.message); }
      return;
    }
    case 'mark': {
      const { key, id, s } = el.dataset;
      const cur = state.attendance[key]?.[id];
      return serverCall('PATCH', '/api/attendance', { key, id, value: cur?.s === s ? null : { s } });
    }
    case 'rest-absent': {
      const { key } = el.dataset;
      const rec = state.attendance[key] || {};
      const todo = el.dataset.ids.split(',').filter(id => id && !rec[id]);
      if (!todo.length) return toast('Everyone is already marked.');
      for (const id of todo) await api('PATCH', '/api/attendance', { key, id, value: { s: 'A' } }).catch(() => {});
      state = await api('GET', '/api/state');
      break;
    }
    case 'approve':
    case 'reject':
      return serverCall('POST', '/api/approve', { key: el.dataset.key, id: el.dataset.id, approve: action === 'approve' });
    case 'approve-all': {
      if (!confirm('Approve all waiting records as Present?')) return;
      for (const x of pendingList()) await api('POST', '/api/approve', { key: x.key, id: x.id, approve: true }).catch(() => {});
      state = await api('GET', '/api/state');
      toast('All approved ✔');
      break;
    }

    /* reports */
    case 'export-report': {
      const rows = reportRows(ui.repMonth).filter(r => !ui.repParish || r.s.parish === ui.repParish);
      download(`monthly-report-${ui.repMonth}.csv`, toCsv([['Month', 'Parish / Chapel', 'Status', 'Name', 'Role in ministry', 'Present', 'Absent', 'Excuses'],
        ...sortRows(rows).sort((a, b) => parishName(a.s.parish).localeCompare(parishName(b.s.parish)) || (b.s.active - a.s.active))
          .map(r => [monthLabel(ui.repMonth), parishName(r.s.parish), r.s.active ? 'Active' : 'Inactive', r.s.name, r.s.role, r.P, r.A, r.E])]), 'text/csv');
      return;
    }

    /* settings */
    case 'add-parish': {
      const name = (prompt('Name of the parish / chapel:') || '').trim();
      if (!name) return;
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'parish';
      while (parishById(id)) id += '-2';
      parishes().push({ id, name, masses: [{ id: `m${uid()}`, day: 0, time: '07:00' }] });
      save(); break;
    }
    case 'del-parish': {
      const p = parishById(el.dataset.p);
      const n = state.servers.filter(s => s.parish === p.id).length;
      if (n) return toast(`${p.name} still has ${n} server(s). Move them to another parish first.`);
      if (!confirm(`Remove ${p.name}?`)) return;
      state.settings.parishes = parishes().filter(x => x.id !== p.id);
      delete state.schedules[p.id];
      save(); break;
    }
    case 'add-mass': {
      const p = parishById(el.dataset.p);
      const last = p.masses[p.masses.length - 1];
      p.masses.push({ id: `m${uid()}`, day: last ? last.day : 0, time: last ? last.time : '07:00' });
      save(); break;
    }
    case 'del-mass': {
      const p = parishById(el.dataset.p);
      const mid = el.dataset.m;
      const lead = state.leaders.filter(l => l.parish === p.id && l.mass === mid).map(l => l.username);
      if (!confirm(`Remove ${p.name} ${massLabel(p.id, mid)}?${lead.length ? `\n\nLeader account(s) ${lead.join(', ')} will stop working until you link them to another Mass.` : ''}\nAttendance already recorded is kept.`)) return;
      p.masses = p.masses.filter(m => m.id !== mid);
      (state.schedules[p.id] || []).forEach(en => { delete en.teams[mid]; });
      save(); break;
    }
    case 'leader-pw': {
      const pw = prompt(`New password for ${el.dataset.u} (8+ characters):`);
      if (!pw) return;
      try { const r = await api('PATCH', `/api/leaders/${encodeURIComponent(el.dataset.u)}`, { password: pw }); state.leaders = r.leaders; toast('Password changed.'); } catch (err) { toast(err.message); }
      return;
    }
    case 'del-leader': {
      if (!confirm(`Remove leader account "${el.dataset.u}"?`)) return;
      try { const r = await api('DELETE', `/api/leaders/${encodeURIComponent(el.dataset.u)}`); state.leaders = r.leaders; } catch (err) { toast(err.message); }
      break;
    }
    case 'del-admin':
      if (!confirm(`Remove admin "${el.dataset.u}"?`)) return;
      try { await api('DELETE', `/api/admins/${encodeURIComponent(el.dataset.u)}`); toast('Admin removed.'); } catch (err) { toast(err.message); }
      loadSettingsExtras();
      return;
    case 'export-json': {
      const { servers, settings, schedules, attendance, submissions } = state;
      let archive;
      try { archive = await api('GET', '/api/logs/archive'); } catch (err) { return toast(`Backup not made: ${err.message}`); }
      download(`altar-servers-backup-${todayStr()}.json`, JSON.stringify({ servers, settings, schedules, attendance, submissions, archive }, null, 2), 'application/json');
      return;
    }
    case 'reset':
      if (!confirm('Erase ALL servers, schedules and attendance? Accounts and parishes are kept. This cannot be undone.')) return;
      if (!confirm('Are you really sure? Export a backup first if unsure.')) return;
      return serverCall('PUT', '/api/import', { servers: [], settings: state.settings, schedules: {}, attendance: {}, submissions: {} });
    default: return;
  }
  render();
});

document.addEventListener('change', e => {
  const el = e.target;
  const { action } = el.dataset;
  if (!action || !state) return;
  const st = state.settings;
  switch (action) {
    case 'dash-month-set': if (!el.value) return; ui.dashMonth = el.value; break;
    case 'f-parish': ui.fParish = el.value; break;
    case 'f-role': ui.fRole = el.value; break;
    case 'f-status': ui.fStatus = el.value; break;
    case 'import-csv': {
      const f = el.files[0];
      if (f) readTextFile(f).then(importCsv).catch(() => toast('Could not read that file.'));
      return;
    }
    case 'sch-entry': ui.schEntry = el.value; break;
    case 'assign': {
      if (!el.value) return;
      const en = currentEntry();
      Object.keys(en.teams).forEach(m => { en.teams[m] = en.teams[m].filter(id => id !== el.value); });
      (en.teams[el.dataset.mass] = en.teams[el.dataset.mass] || []).push(el.value);
      save(); break;
    }
    case 'move': {
      if (!el.value) return;
      const en = currentEntry();
      en.teams[el.dataset.from] = en.teams[el.dataset.from].filter(id => id !== el.dataset.id);
      (en.teams[el.value] = en.teams[el.value] || []).push(el.dataset.id);
      save(); break;
    }
    case 'att-parish': ui.attParish = el.value; break;
    case 'log-parish': ui.logParish = el.value; break;
    case 'log-from': ui.logFrom = el.value; break;
    case 'log-to': ui.logTo = el.value; break;
    case 'att-date': if (!el.value) return; ui.attDate = el.value; break;
    case 'add-other':
      if (!el.value) return;
      serverCall('PATCH', '/api/attendance', { key: el.dataset.key, id: el.value, value: { s: 'P', reason: 'Added by admin' } });
      return;
    case 'rep-month': if (!el.value) return; ui.repMonth = el.value; break;
    case 'rep-parish': ui.repParish = el.value; break;
    case 'rep-sort': ui.repSort = el.value; break;
    case 'ministry': st.ministry = el.value.trim() || 'Altar Servers Ministry'; save(); break;
    case 'parish-name': { const p = parishById(el.dataset.p); p.name = el.value.trim() || p.name; save(); break; }
    case 'mass-day': { const m = parishById(el.dataset.p).masses.find(x => x.id === el.dataset.m); m.day = Number(el.value); save(); break; }
    case 'mass-time': { const m = parishById(el.dataset.p).masses.find(x => x.id === el.dataset.m); if (el.value) m.time = el.value; save(); return; }
    case 'manual-pick': st.allowManualPick = el.checked; save(); toast(el.checked ? 'Leaders can now choose names from a list.' : 'Leaders must scan QR cards.'); return;
    case 'inactive-after': st.inactiveAfter = Math.max(1, Math.min(20, Number(el.value) || 3)); save(); return;
    case 'meeting-day': st.meetingDay = Number(el.value); save(); return;
    case 'tz': {
      const tz = el.value.trim();
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (err) { toast('Unknown time zone. Example: Asia/Manila'); return; }
      st.timezone = tz; save(); toast('Time zone saved.');
      return;
    }
    case 'public-url':
      st.publicUrl = el.value.trim(); save();
      setTimeout(() => api('GET', '/api/info').then(r => { ui.info = r; ui.appQr = null; render(); }), 700);
      return;
    case 'import-json': {
      const f = el.files[0];
      if (!f) return;
      f.text().then(async txt => {
        const data = JSON.parse(txt);
        if (!Array.isArray(data.servers)) throw new Error('bad');
        if (!confirm('Replace all current ministry data with this backup?')) return;
        applySnapshot(await api('PUT', '/api/import', data));
        toast('Backup imported ✔');
      }).catch(() => toast('That file is not a valid backup.'));
      return;
    }
    default: return;
  }
  render();
});

document.addEventListener('input', e => {
  if (e.target.dataset.action !== 'search') return;
  ui.search = e.target.value;
  const pos = e.target.selectionStart;
  render();
  const box = document.querySelector('[data-action="search"]');
  box.focus(); box.setSelectionRange(pos, pos);
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const kind = form.dataset.form;

  if (kind === 'login' || kind === 'setup') {
    const username = fd.get('username').trim();
    const password = fd.get('password');
    if (kind === 'setup' && password !== fd.get('password2')) return showLogin('Passwords do not match.', true);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try { await api('POST', kind === 'setup' ? '/api/auth/setup' : '/api/auth/login', { username, password }); boot(); }
    catch (err) { showLogin(err.message, kind === 'setup'); }
    return;
  }
  if (kind === 'add-admin') {
    try { await api('POST', '/api/admins', { username: fd.get('username'), password: fd.get('password') }); form.reset(); toast('Admin added.'); loadSettingsExtras(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (kind === 'change-pw') {
    try { await api('POST', '/api/me/password', { current: fd.get('current'), password: fd.get('password') }); form.reset(); toast('Password changed.'); }
    catch (err) { toast(err.message); }
    return;
  }
  if (kind === 'add-leader') {
    const [parish, mass] = String(fd.get('mass') || '').split('|');
    try {
      const r = await api('POST', '/api/leaders', { username: fd.get('username'), password: fd.get('password'), parish, mass });
      state.leaders = r.leaders; toast('Leader account added.'); render();
    } catch (err) { toast(err.message); }
    return;
  }

  const exists = n => state.servers.some(a => a.name.toLowerCase() === n.toLowerCase());
  if (kind === 'add') {
    const name = fd.get('name').trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (exists(name) && !confirm(`${name} is already on the roster. Add anyway?`)) return;
    state.servers.push({ id: uid(), name, parish: fd.get('parish'), role: fd.get('role'), contact: fd.get('contact').trim(), active: true, since: todayStr() });
    ui.fParish = fd.get('parish');
    save(); render();
    document.getElementById('nName').focus();
    toast(`${name} added — Active. Print their QR card with the “QR” button.`);
  } else if (kind === 'edit') {
    const s = byId(form.dataset.id);
    s.name = fd.get('name').trim() || s.name;
    s.parish = fd.get('parish'); s.role = fd.get('role'); s.contact = fd.get('contact').trim();
    ui.editing = null;
    save(); render();
  }
});

boot();
