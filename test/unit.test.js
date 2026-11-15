/* Unit tests for the admin website's logic (public/app.js). Run: npm test */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, sampleState } = require('./helpers/load-app');

const fresh = (opts) => { const t = loadApp(opts); t.app.state = sampleState(); return t; };
const plain = v => JSON.parse(JSON.stringify(v)); // vm objects → plain objects for deepEqual

describe('Helpers', () => {
  const { app } = loadApp();
  it('fmtTime converts 24-hour times to 12-hour AM/PM', () => {
    assert.equal(app.fmtTime('06:00'), '6:00 AM');
    assert.equal(app.fmtTime('12:30'), '12:30 PM');
    assert.equal(app.fmtTime('00:15'), '12:15 AM');
    assert.equal(app.fmtTime('16:05'), '4:05 PM');
  });
  it('massName gives ordinal Mass names', () => {
    assert.equal(app.massName(0), 'First Mass');
    assert.equal(app.massName(2), 'Third Mass');
    assert.equal(app.massName(9), '#10 Mass');
  });
  it('addDays crosses month and year boundaries', () => {
    assert.equal(app.addDays('2026-11-30', 1), '2026-12-01');
    assert.equal(app.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(app.addDays('2026-03-01', -1), '2026-02-28');
  });
  it('esc escapes HTML special characters', () => {
    assert.equal(app.esc(`<b>"Tom" & 'Jerry'</b>`), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
    assert.equal(app.esc(null), '');
  });
  it('keyOf and splitKey round-trip an attendance key', () => {
    const k = app.keyOf('2026-11-15', 'agusan', 'm1');
    assert.equal(k, '2026-11-15#agusan#m1');
    assert.deepEqual(plain(app.splitKey(k)), { date: '2026-11-15', parish: 'agusan', mass: 'm1' });
  });
  it('secondMeeting finds the 2nd Sunday of the month', () => {
    const { app: a } = fresh();
    assert.equal(a.secondMeeting('2026-11'), '2026-11-08'); // Nov 1, 2026 is a Sunday
    assert.equal(a.secondMeeting('2026-12'), '2026-12-13');
  });
});

describe('CSV reading and writing', () => {
  const { app } = loadApp();
  it('parses quoted fields, escaped quotes and CRLF line endings', () => {
    const rows = app.parseCsv('Name,Note\r\n"Dela Cruz, Juan","He said ""hi"""\r\n');
    assert.deepEqual(plain(rows), [['Name', 'Note'], ['Dela Cruz, Juan', 'He said "hi"']]);
  });
  it('detects semicolon and tab delimiters (Excel regional settings)', () => {
    assert.deepEqual(plain(app.parseCsv('Name;Role\nAna;Juniors')), [['Name', 'Role'], ['Ana', 'Juniors']]);
    assert.deepEqual(plain(app.parseCsv('Name\tRole\nAna\tJuniors')), [['Name', 'Role'], ['Ana', 'Juniors']]);
  });
  it('strips a UTF-8 BOM, trims cells and skips blank rows', () => {
    assert.deepEqual(plain(app.parseCsv('﻿Name, Role \n\n , \n Ana , Juniors\n')), [['Name', 'Role'], ['Ana', 'Juniors']]);
  });
  it('toCsv quotes every cell, escapes quotes and adds a BOM for Excel', () => {
    assert.equal(app.toCsv([['a', 'b"c'], [1, null]]), '﻿"a","b""c"\r\n"1",""');
  });
});

describe('Mass cell parsing (CSV "Mass" column)', () => {
  const { app } = loadApp();
  const cases = [
    ['1st Mass', { index: 0 }], ['Second Mass', { index: 1 }], ['3', { index: 2 }], ['m2', { index: 1 }],
    ['Mass 2', { index: 1 }], ['8:00 AM', { time: '08:00' }], ['8am', { time: '08:00' }],
    ['4:00 p.m.', { time: '16:00' }], ['16:00', { time: '16:00' }], ['12:00 AM', { time: '00:00' }],
    ['Sat 5:30 PM', { day: 6, time: '17:30' }], ['First Mass (Sunday 6:00 AM)', { day: 0, time: '06:00' }],
  ];
  for (const [input, expected] of cases) {
    it(`reads "${input}"`, () => assert.deepEqual(plain(app.parseMassCell(input)), expected));
  }
  it('returns null for empty or unreadable values', () => {
    assert.equal(app.parseMassCell(''), null);
    assert.equal(app.parseMassCell('whenever'), null);
    assert.equal(app.parseMassCell('9th Mass'), null); // only 8 Masses per parish are allowed
  });
});

describe('CSV import', () => {
  it('adds new servers with parish and role matched by name', () => {
    const { app } = fresh();
    app.importCsv('Name,Chapel,Role,Contact\nAna Lim,agusan,Elder,0917\nRico Tan,TABLON,juniors,');
    const s = plain(app.state.servers).map(x => [x.name, x.parish, x.role, x.contact, x.active]);
    assert.deepEqual(s, [['Ana Lim', 'agusan', 'Elders', '0917', true], ['Rico Tan', 'tablon', 'Juniors', '', true]]);
  });
  it('joins First / Middle / Last name columns', () => {
    const { app } = fresh();
    app.importCsv('First Name,Middle,Last Name,Parish\nJuan,A.,Dela Cruz,Agusan');
    assert.equal(app.state.servers[0].name, 'Juan A. Dela Cruz');
  });
  it('does not duplicate names already in the roster or repeated in the file', () => {
    const { app } = fresh();
    app.state.servers.push({ id: 'old', name: 'Juan Dela Cruz', parish: 'agusan', role: '', active: true });
    app.importCsv('Name,Parish,Role\njuan dela cruz,Agusan,Seniors\nAna,Agusan,Juniors\nANA,Agusan,Juniors');
    assert.deepEqual(plain(app.state.servers).map(x => x.name), ['Juan Dela Cruz', 'Ana']);
    assert.equal(app.state.servers[0].role, 'Seniors', 'missing role of an existing server is filled in');
  });
  it('puts servers on Mass teams by number, ordinal or time, effective today', () => {
    const { app } = fresh();
    app.importCsv('Name,Parish,Role,Mass\nA,Agusan,Elders,1st Mass\nB,Agusan,Seniors,2\nC,Agusan,Juniors,4:00 PM\nD,Tablon,Juniors,First');
    const id = n => app.state.servers.find(s => s.name === n).id;
    const ag = app.state.schedules.agusan[0];
    assert.equal(ag.from, app.ymd(new Date()));
    assert.deepEqual(plain(ag.teams), { m1: [id('A')], m2: [id('B')], m3: [id('C')] });
    assert.deepEqual(plain(app.state.schedules.tablon[0].teams), { m1: [id('D')] });
  });
  it('moves an existing team member and keeps servers not in the file on their team', () => {
    const { app } = fresh();
    app.state.servers.push({ id: 'x', name: 'Xavier', parish: 'agusan', role: 'Elders', active: true },
      { id: 'y', name: 'Yna', parish: 'agusan', role: 'Juniors', active: true });
    app.state.schedules.agusan = [{ id: 'e0', from: '2026-01-01', generatedAt: '2026-01-01T00:00:00Z', teams: { m1: ['x', 'y'], m2: [], m3: [] } }];
    app.importCsv('Name,Parish,Mass\nXavier,Agusan,3rd');
    const entries = app.state.schedules.agusan;
    assert.equal(entries.length, 2, 'the old schedule is kept as history');
    assert.deepEqual(plain(entries[0].teams), { m1: ['x', 'y'], m2: [], m3: [] }, 'history unchanged');
    assert.deepEqual(plain(entries[1].teams), { m1: ['y'], m2: [], m3: ['x'] });
  });
  it('creates missing chapels and Masses', () => {
    const { app } = fresh();
    app.importCsv('Name,Chapel,Mass\nKim,San Isidro Chapel,Saturday 5:00 PM\nLea,Agusan,4th Mass\nMia,Sta. Cruz,');
    const p = plain(app.state.settings.parishes);
    const si = p.find(x => x.name === 'San Isidro Chapel');
    assert.ok(si, 'new chapel created');
    assert.equal(si.id, 'san-isidro-chapel');
    assert.deepEqual(si.masses.map(m => [m.day, m.time]), [[6, '17:00']]);
    assert.equal(p.find(x => x.id === 'agusan').masses.length, 4, '4th Mass added to Agusan');
    assert.equal(p.find(x => x.name === 'Sta. Cruz').masses.length, 1, 'a chapel without a Mass gets one default Mass');
    for (const x of p) for (const m of x.masses) assert.match(m.id, /^[\w-]{1,20}$/, 'Mass ids pass the server\'s validation');
  });
  it('changes nothing when the admin cancels the confirmation', () => {
    const { app, log } = fresh({ confirm: false });
    const before = JSON.stringify(app.state);
    app.importCsv('Name,Chapel,Mass\nKim,New Chapel,1st');
    assert.equal(JSON.stringify(app.state), before);
    assert.equal(log.saves, 0);
    assert.equal(log.confirms.length, 1);
  });
  it('shows a clear summary before importing', () => {
    const { app, log } = fresh();
    app.importCsv('Name,Parish,Mass\nA,Agusan,1st\nB,Agusan,whenever\nC,,');
    const msg = log.confirms[0];
    assert.match(msg, /Add 3 new server/);
    assert.match(msg, /Put 1 server\(s\) on Mass teams in Agusan/);
    assert.match(msg, /1 Mass value\(s\) could not be read/);
    assert.match(msg, /1 row\(s\) have no parish/);
  });
  it('rejects a file without a Name column', () => {
    const { app, log } = fresh();
    app.importCsv('Parish,Role\nAgusan,Juniors');
    assert.equal(app.state.servers.length, 0);
    assert.match(log.toasts.at(-1), /Could not find a Name column/);
  });
});

describe('Team shuffle', () => {
  function withServers(n, roles = ['Elders', 'Seniors', 'Juniors']) {
    const t = fresh();
    for (let i = 0; i < n; i++) t.app.state.servers.push({ id: `s${i}`, name: `S${i}`, parish: 'agusan', role: roles[i % roles.length], active: true });
    return t;
  }
  it('puts every active server on exactly one team, with balanced team sizes', () => {
    const { app } = withServers(14);
    assert.equal(app.shuffleParish('agusan', '2026-11-16'), true);
    const teams = Object.values(plain(app.state.schedules.agusan[0].teams));
    const all = teams.flat();
    assert.equal(all.length, 14);
    assert.equal(new Set(all).size, 14);
    const sizes = teams.map(t => t.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes ${sizes}`);
  });
  it('spreads each role evenly over the Masses', () => {
    const { app } = withServers(9);
    app.shuffleParish('agusan', '2026-11-16');
    const role = id => app.state.servers.find(s => s.id === id).role;
    for (const team of Object.values(app.state.schedules.agusan[0].teams)) {
      assert.deepEqual(plain(team.map(role)).sort(), ['Elders', 'Juniors', 'Seniors']);
    }
  });
  it('leaves out inactive servers and servers of other parishes', () => {
    const { app } = withServers(6);
    app.state.servers[0].active = false;
    app.state.servers.push({ id: 'other', name: 'Other', parish: 'tablon', role: 'Juniors', active: true });
    app.shuffleParish('agusan', '2026-11-16');
    const all = Object.values(app.state.schedules.agusan[0].teams).flat();
    assert.ok(!all.includes('s0') && !all.includes('other'));
    assert.equal(all.length, 5);
  });
  it('moves people off their previous team', () => {
    const { app } = withServers(6);
    app.shuffleParish('agusan', '2026-10-01');
    const first = plain(app.state.schedules.agusan[0].teams);
    app.shuffleParish('agusan', '2026-11-16');
    const second = plain(app.state.schedules.agusan.find(e => e.from === '2026-11-16').teams);
    const stayed = Object.entries(second).reduce((n, [m, ids]) => n + ids.filter(id => first[m].includes(id)).length, 0);
    assert.equal(stayed, 0);
  });
  it('refuses to shuffle a parish without active servers', () => {
    const { app, log } = fresh();
    assert.equal(app.shuffleParish('puerto', '2026-11-16'), false);
    assert.match(log.toasts.at(-1), /No active servers/);
  });
});

describe('Archive / remove attendance logs (panel logic)', () => {
  function withLogs() {
    const t = fresh();
    const s = t.app.state;
    s.servers.push({ id: 'a', name: 'Ana', parish: 'agusan', role: 'Elders', active: true });
    s.attendance = {
      '2026-10-04#agusan#m1': { a: { s: 'P' } },
      '2026-11-01#agusan#m1': { a: { s: 'A' } },
      '2026-11-01#tablon#m1': { a: { s: 'P', pending: true } },
    };
    s.submissions = { '2026-11-08#agusan#m2': { by: '2ndmass', at: '2026-11-08T02:00:00Z' } };
    s.archiveIndex = { '2026-09-06#agusan#m1': 1 };
    return t;
  }
  it('selects logs by parish and inclusive date range, including submitted reports without marks', () => {
    const { app } = withLogs();
    Object.assign(app.ui, { logParish: 'agusan', logFrom: '2026-11-01', logTo: '2026-11-08' });
    assert.deepEqual(plain(app.logKeys('active')), ['2026-11-01#agusan#m1', '2026-11-08#agusan#m2']);
    Object.assign(app.ui, { logParish: '', logFrom: '', logTo: '' });
    assert.equal(app.logKeys('active').length, 4);
    assert.deepEqual(plain(app.logKeys('archive')), ['2026-09-06#agusan#m1']);
  });
  it('describes the selection in plain words', () => {
    const { app } = withLogs();
    Object.assign(app.ui, { logParish: 'agusan', logFrom: '2026-11-01', logTo: '2026-11-01' });
    assert.match(app.logFilterLabel(), /^Agusan on /);
    Object.assign(app.ui, { logParish: '', logFrom: '', logTo: '' });
    assert.equal(app.logFilterLabel(), 'all parishes, all dates');
  });
  it('shows counts and warns about records waiting for approval', () => {
    const { app } = withLogs();
    Object.assign(app.ui, { logParish: '', logFrom: '2026-11-01', logTo: '2026-11-30' });
    const html = app.logsPanel();
    assert.match(html, /3 Mass log\(s\), 2 mark\(s\)/);
    assert.match(html, /1 waiting for approval/);
    assert.match(html, /Archive 3 log\(s\)/);
    assert.match(html, /1 archived Mass log\(s\) in total/);
  });
  it('downloads the archive as CSV, one row per mark', () => {
    const { app } = withLogs();
    const csv = app.archiveCsv({
      attendance: { '2026-09-06#agusan#m1': { a: { s: 'E', reason: 'Sick', by: '1stmass' } } },
      submissions: { '2026-09-06#agusan#m1': { by: '1stmass', at: '2026-09-06T01:00:00Z' } },
      archivedAt: { '2026-09-06#agusan#m1': '2026-11-15T04:00:00Z' },
    });
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^"Date","Parish \/ Chapel","Mass","Name"/);
    assert.match(lines[1], /^"2026-09-06","Agusan","First Mass · Sunday 6:00 AM","Ana","Elders","Excused","","Sick","1stmass"/);
  });
});

describe('Monthly statistics', () => {
  it('counts Present / Absent / Excused per month and ignores pending records', () => {
    const { app } = fresh();
    app.state.attendance = {
      '2026-11-01#agusan#m1': { a: { s: 'P' }, b: { s: 'A' }, c: { s: 'E' }, d: { s: 'P', pending: true } },
      '2026-11-08#agusan#m1': { a: { s: 'P' }, b: { s: 'A' } },
      '2026-10-25#agusan#m1': { a: { s: 'A' } },
    };
    const { tot, per } = plain(app.monthStats('2026-11'));
    assert.deepEqual(tot, { P: 2, A: 2, E: 1 });
    assert.deepEqual(per.a, { P: 2, A: 0, E: 0 });
    assert.equal(per.d, undefined);
  });
});
