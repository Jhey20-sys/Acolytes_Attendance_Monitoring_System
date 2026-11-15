/* Loads public/app.js (browser code) inside a Node "vm" sandbox with a fake DOM,
 * so its functions can be unit-tested without a browser or a server. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

// Functions and state the tests need. `const`/`let` at the top level of a script are not
// properties of the sandbox, so expose them through one object appended to the source.
const EXPORTS = `
;globalThis.__app = {
  pad, ymd, addDays, fmtTime, massName, esc, keyOf, splitKey, toCsv, csvCell,
  parseCsv, parseMassCell, importCsv, shuffleParish, secondMeeting, monthStats,
  scheduleOn, scheduleEntries, DAY_NAMES, ui,
  get state() { return state; }, set state(v) { state = v; },
};`;

/** A do-nothing object that tolerates any property access or call (stands in for DOM nodes). */
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub()),
    set: () => true,
    apply: () => stub(),
  });
}

/**
 * @param {object} [opts]
 * @param {boolean|function} [opts.confirm=true] answer (or answer function) for window.confirm
 */
function loadApp(opts = {}) {
  const log = { toasts: [], confirms: [], saves: 0 };
  const answer = typeof opts.confirm === 'function' ? opts.confirm : () => opts.confirm !== false;
  const toastEl = { textContent: '', classList: { add() {}, remove() {} } };
  const document = new Proxy({
    addEventListener() {}, removeEventListener() {},
    getElementById: id => (id === 'toast' ? toastEl : stub()),
    querySelector: () => stub(), querySelectorAll: () => [],
    createElement: () => stub(), body: stub(), documentElement: stub(), hidden: false,
  }, { get: (t, k) => (k in t ? t[k] : stub()) });
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Intl, Date, Math, JSON, Promise, URL, Blob: function () {}, TextDecoder,
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), scrollTo() {}, scrollY: 0 },
    location: { origin: 'http://localhost:3000', reload() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: () => new Promise(() => {}), // boot() waits forever; nothing reaches a real server
    confirm: msg => { log.confirms.push(msg); return answer(msg); },
    prompt: () => null, alert() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC + EXPORTS, sandbox, { filename: 'public/app.js' });
  const app = sandbox.__app;
  // Watch toasts and saves without touching the network.
  Object.defineProperty(toastEl, 'textContent', { set: v => log.toasts.push(v), get: () => log.toasts[log.toasts.length - 1] || '' });
  vm.runInContext('save = () => { __log.saves++; }; render = () => {};', Object.assign(sandbox, { __log: log }));
  return { app, log };
}

/** A small, realistic state object (3 parishes like the default settings). */
function sampleState() {
  return {
    version: 1,
    servers: [],
    leaders: [],
    attendance: {},
    submissions: {},
    notifications: [],
    schedules: {},
    settings: {
      ministry: 'Altar Servers Ministry', roles: ['Elders', 'Seniors', 'Juniors'], meetingDay: 0, inactiveAfter: 3,
      parishes: [
        { id: 'agusan', name: 'Agusan', masses: [{ id: 'm1', day: 0, time: '06:00' }, { id: 'm2', day: 0, time: '08:00' }, { id: 'm3', day: 0, time: '16:00' }] },
        { id: 'tablon', name: 'Tablon', masses: [{ id: 'm1', day: 0, time: '07:00' }] },
        { id: 'puerto', name: 'Puerto', masses: [{ id: 'm1', day: 0, time: '07:00' }] },
      ],
    },
  };
}

module.exports = { loadApp, sampleState };
