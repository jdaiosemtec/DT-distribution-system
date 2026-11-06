'use strict';
// Service database. Two back ends, same API:
//   DATABASE_URL=postgres://user:password@host:5432/db[?sslmode=require&schema=avaris]  -> PostgreSQL (servers)
//   no DATABASE_URL                                   -> Node's built-in SQLite, one file <DATA>/avaris.db (the PC test
//                                                        bench: nothing to install)
// Rows keep the DEMO record shapes as JSON so the API returns exactly what the front end expects.
// Tables (prefix t_avaris_ds_ so the distribution service can share a database with the collection service):
// t_avaris_ds_input, t_avaris_ds_scenario, t_avaris_ds_project, t_avaris_ds_state (JSON documents).
// Model files and results stay files in DATA_DIR (files/<path>/<model>.inp, runs/<scenario>/run.out …).
//
// The rows are small (model and scenario records, legends) and avaris-api runs as ONE process, so all rows are read
// into memory at the start and reads come from there (the API stays synchronous); every change is written to the
// database at once, in order. PostgreSQL: the start-up read runs in a child process (synchronous start, no packages),
// the writes go through lib/pg.js; flush() waits for the last write (called on SIGTERM / docker stop).

process.removeAllListeners('warning'); process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const TABLES = { t_avaris_ds_input: [], t_avaris_ds_scenario: ['input_id', 'status'], t_avaris_ds_project: [] };
const COLS = (t) => ['id', ...TABLES[t], 'data', 'created_at', 'updated_at'];
const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS t_avaris_ds_input (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_scenario (id TEXT PRIMARY KEY, input_id TEXT, status INTEGER DEFAULT 0, data JSONB NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_project (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_state (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS i_avaris_ds_scenario_input ON t_avaris_ds_scenario (input_id);`;
const SCHEMA_SQLITE = `PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS t_avaris_ds_input (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_scenario (id TEXT PRIMARY KEY, input_id TEXT, status INTEGER DEFAULT 0, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_project (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS t_avaris_ds_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT);`;

// ---- memory: table -> Map(id -> row { id, …columns, data: JSON text, created_at, updated_at }) ---------------------
const M = { t_avaris_ds_input: new Map(), t_avaris_ds_scenario: new Map(), t_avaris_ds_project: new Map() };
const KV = new Map();                                     // key -> JSON text
let back = null;                                          // { put(table,row), del(table,id), putKv(key,text), flush() }
let kind = '';

function open(dir) {
  const url = process.env.DATABASE_URL || '';
  if (url) openPg(url); else openSqlite(path.join(dir, 'avaris-ds.db'));
  return { kind };
}
function iso(v) { if (v == null || v === '') return v; const d = new Date(v); return isNaN(d) ? String(v) : d.toISOString(); }
function load(rowsByTable, kvRows) {
  for (const t of Object.keys(M)) { M[t].clear(); for (const r of rowsByTable[t] || []) { const o = { id: r.id };
    for (const c of TABLES[t]) o[c] = r[c]; o.data = typeof r.data === 'string' ? r.data : JSON.stringify(r.data); o.created_at = iso(r.created_at); o.updated_at = iso(r.updated_at); M[t].set(o.id, o); } }
  KV.clear(); for (const r of kvRows || []) KV.set(r.key, typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
}

function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const s = new DatabaseSync(file); s.exec(SCHEMA_SQLITE); kind = 'SQLite ' + file;
  const rows = {}; for (const t of Object.keys(M)) rows[t] = s.prepare('SELECT * FROM ' + t).all();
  load(rows, s.prepare('SELECT * FROM t_avaris_ds_state').all());
  const put = {}; for (const t of Object.keys(M)) put[t] = s.prepare(`INSERT OR REPLACE INTO ${t} (${COLS(t).join(',')}) VALUES (${COLS(t).map(() => '?').join(',')})`);
  const del = {}; for (const t of Object.keys(M)) del[t] = s.prepare(`DELETE FROM ${t} WHERE id = ?`);
  const kv = s.prepare('INSERT OR REPLACE INTO t_avaris_ds_state (key, data, updated_at) VALUES (?,?,?)');
  back = { put: (t, r) => put[t].run(...COLS(t).map(c => r[c] ?? null)), del: (t, id) => del[t].run(id), putKv: (k, v) => kv.run(k, v, now()), flush: async () => {} };
}

function openPg(url) {
  const safe = url.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:***@');
  // start-up read in a child process: tables created, all rows printed as JSON
  const child = `const { Client } = require(${JSON.stringify(path.join(__dirname, 'lib', 'pg.js'))}); (async () => { const c = new Client(process.env.DATABASE_URL);
    await c.exec(${JSON.stringify(SCHEMA_PG)}); const out = { rows: {} };
    for (const t of ${JSON.stringify(Object.keys(M))}) out.rows[t] = (await c.query('SELECT * FROM ' + t)).rows;
    out.kv = (await c.query('SELECT key, data FROM t_avaris_ds_state')).rows; process.stdout.write(JSON.stringify(out)); await c.end(); })().catch(e => { process.stderr.write(e.message); process.exit(3); });`;
  let out;
  try { out = JSON.parse(execFileSync(process.execPath, ['-e', child], { env: process.env, maxBuffer: 1 << 30, timeout: 60000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { throw new Error(`PostgreSQL (${safe}) is not reachable or refused: ${String(e.stderr || e.message).trim()}`); }
  load(out.rows, out.kv); kind = 'PostgreSQL ' + safe;
  const { Client } = require('./lib/pg'); const pg = new Client(url);
  let last = Promise.resolve(), failed = 0;
  const w = (sql, params) => { last = pg.query(sql, params).catch(e => { failed++; console.error('[db] write failed:', e.message); }); return last; };
  const up = (t) => { const c = COLS(t); return `INSERT INTO ${t} (${c.join(',')}) VALUES (${c.map((x, i) => '$' + (i + 1) + (x === 'data' ? '::jsonb' : x.endsWith('_at') ? '::timestamptz' : '')).join(',')})
    ON CONFLICT (id) DO UPDATE SET ${c.slice(1).map(x => x + ' = EXCLUDED.' + x).join(', ')}`; };
  const UP = {}; for (const t of Object.keys(M)) UP[t] = up(t);
  back = { put: (t, r) => w(UP[t], COLS(t).map(c => r[c] ?? null)), del: (t, id) => w(`DELETE FROM ${t} WHERE id = $1`, [id]),
    putKv: (k, v) => w('INSERT INTO t_avaris_ds_state (key, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [k, v]),
    flush: async () => { await last; await pg.end(); }, failed: () => failed };
}

// ---- row helpers --------------------------------------------------------------------------------------------------
function rowObj(r) { if (!r) return null; return Object.assign({ id: r.id, createdAt: r.created_at, updatedAt: r.updated_at }, JSON.parse(r.data)); }
function put(t, r) { M[t].set(r.id, r); back.put(t, r); }
function del(t, id) { if (M[t].delete(id)) back.del(t, id); }
const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

const inputs = {
  all() { return [...M.t_avaris_ds_input.values()].sort(byCreated).map(rowObj); },
  get(id) { return rowObj(M.t_avaris_ds_input.get(id)); },
  create(data, id = uuid()) { const t = now(); put('t_avaris_ds_input', { id, data: JSON.stringify(strip(data)), created_at: t, updated_at: t }); return inputs.get(id); },
  update(id, data) { const r = M.t_avaris_ds_input.get(id); if (!r) return null; const d = Object.assign(JSON.parse(r.data), strip(data));
    put('t_avaris_ds_input', Object.assign({}, r, { data: JSON.stringify(d), updated_at: now() })); return inputs.get(id); },
  remove(id) { del('t_avaris_ds_input', id); },
};

// a scenario carries its input record (the front end reads scenario.input.id / name / main)
const INPUT_KEYS = ['id', 'createdAt', 'updatedAt', 'name', 'path', 'file', 'main'];
const scenarios = {
  all() { return [...M.t_avaris_ds_scenario.values()].sort(byCreated).map(scenarios._obj); },
  get(id) { return scenarios._obj(M.t_avaris_ds_scenario.get(id)); },
  byInput(inputId) { return [...M.t_avaris_ds_scenario.values()].filter(r => r.input_id === inputId).sort(byCreated).map(scenarios._obj); },
  _obj(r) { if (!r) return null; const o = rowObj(r); o.status = r.status; const i = inputs.get(r.input_id);
    o.input = i ? Object.fromEntries(INPUT_KEYS.map(k => [k, i[k] ?? null])) : null; return o; },
  create(inputId, data, id = uuid()) { const t = now(); put('t_avaris_ds_scenario', { id, input_id: inputId, status: data.status | 0, data: JSON.stringify(strip(data)), created_at: t, updated_at: t }); return scenarios.get(id); },
  update(id, data) {
    const r = M.t_avaris_ds_scenario.get(id); if (!r) return null;
    const d = Object.assign(JSON.parse(r.data), strip(data)); delete d.status; const st = data.status !== undefined && data.status !== null ? data.status | 0 : r.status;
    put('t_avaris_ds_scenario', Object.assign({}, r, { data: JSON.stringify(d), status: st, updated_at: now() })); return scenarios.get(id);
  },
  setStatus(id, status, extra) { const r = M.t_avaris_ds_scenario.get(id); if (!r) return; const d = extra ? JSON.stringify(Object.assign(JSON.parse(r.data), extra)) : r.data;
    put('t_avaris_ds_scenario', Object.assign({}, r, { status, data: d, updated_at: now() })); },
  remove(id) { del('t_avaris_ds_scenario', id); },
};

const projects = {
  all() { return [...M.t_avaris_ds_project.values()].sort(byCreated).map(rowObj); },
  get(id) { return rowObj(M.t_avaris_ds_project.get(id)); },
  create(data, id = uuid()) { const t = now(); put('t_avaris_ds_project', { id, data: JSON.stringify(strip(data)), created_at: t, updated_at: t }); return projects.get(id); },
  update(id, data) { const r = M.t_avaris_ds_project.get(id); if (!r) return null; put('t_avaris_ds_project', Object.assign({}, r, { data: JSON.stringify(Object.assign(JSON.parse(r.data), strip(data))), updated_at: now() })); return projects.get(id); },
  remove(id) { del('t_avaris_ds_project', id); },
};

// JSON documents; get returns a fresh copy
const state = {
  get(key) { const v = KV.get(key); return v === undefined ? undefined : JSON.parse(v); },
  set(key, obj) { const v = JSON.stringify(obj); if (KV.get(key) === v) return; KV.set(key, v); back.putKv(key, v); },
  keys(prefix = '') { return [...KV.keys()].filter(k => k.startsWith(prefix)); },
};

function strip(o) { const c = Object.assign({}, o); delete c.id; delete c.createdAt; delete c.updatedAt; delete c.input; return c; }
function flush() { return back ? back.flush() : Promise.resolve(); }

module.exports = { open, inputs, scenarios, projects, state, uuid, flush, kind: () => kind };
