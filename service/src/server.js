'use strict';
// avaris-ds-api — Avaris DS service of the Digital Twin "Supply Model" pages (water distribution).
// Replaces the lost EPANET service of the DEMO (NestJS, /api/epanet). Routes and answers follow
// docs/DS_API_Reverse_Spec.md: the front end is unchanged, only its texts are renamed. Engine: OWA EPANET 2.3
// (bin/<os>/avaris_ds_engine, source in engine/). Nginx forwards /api/epanet/* here (prefix kept or stripped).
//
// Environment:
//   PORT=8016  DATA_DIR=./data  ENGINE=<engine executable>  ENGINE_PARALLEL=2
//   DATABASE_URL=postgres://…   (servers; without it the built-in SQLite file <DATA_DIR>/avaris-ds.db)
//   AUTH_URL=<user service URL that answers 200 for a valid Bearer token>  (empty: a Bearer token is only required)
//   AUTH=off                    (no token check - local tests only)
//   DEFAULT_PRJ=<file with the WKT for models without Model editing projection metadata>
//   TEMP_KEEP=20                (analysis scenarios kept per model, oldest removed first)

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('./db');
const engine = require('./engine');
const network = require('./model/network');
const INP = require('./model/inp');
const analysis = require('./analysis');
const multipart = require('./lib/multipart');

const PORT = +process.env.PORT || 8016;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const ENGINE = process.env.ENGINE || path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'win' : 'linux', 'avaris_ds_engine' + (process.platform === 'win32' ? '.exe' : ''));
const AUTH = (process.env.AUTH || 'on').toLowerCase() !== 'off';
const AUTH_URL = process.env.AUTH_URL || '';
const DEFAULT_PRJ = process.env.DEFAULT_PRJ && fs.existsSync(process.env.DEFAULT_PRJ) ? fs.readFileSync(process.env.DEFAULT_PRJ, 'utf8') : '';
const TEMP_KEEP = Math.max(1, +process.env.TEMP_KEEP || 20);

fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const dbInfo = db.open(DATA); engine.init(DATA, ENGINE); network.init(DATA, DEFAULT_PRJ);

// ---------------------------------------------------------------- helpers
const send = (res, code, obj, headers = {}) => {
  const b = Buffer.from(JSON.stringify(obj)); const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers);
  const acc = res.req && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '');
  if (!acc || b.length < 32768) { h['Content-Length'] = b.length; res.writeHead(code, h); return res.end(b); }
  zlib.gzip(b, { level: 1 }, (err, gz) => { if (res.destroyed) return; if (err) { h['Content-Length'] = b.length; res.writeHead(code, h); return res.end(b); }
    h['Content-Encoding'] = 'gzip'; h['Content-Length'] = gz.length; h['Vary'] = 'Accept-Encoding'; res.writeHead(code, h); res.end(gz); });
};
// NestJS answers: POST -> 201 Created, others 200; the body always says statusCode 200
const ok = (res, data, message = 'success') => send(res, res.req.method === 'POST' ? 201 : 200, { statusCode: 200, message, data });
const fail = (res, code, message) => send(res, code, { statusCode: code, message, error: http.STATUS_CODES[code] });
const readJson = (req, max = 64 * 1024 * 1024) => new Promise((resolve, reject) => { let b = '', n = 0; req.setEncoding('utf8');
  req.on('data', c => { n += c.length; if (n > max) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else b += c; });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(Object.assign(new Error('Request body is not valid JSON'), { status: 400 })); } }); });
const U = (s) => String(s).toUpperCase();
const sidOf = (b) => (typeof b.scenario === 'string' ? b.scenario : (b.scenario && b.scenario.id)) || b.scenarioId || b.id;
const inputOfScenario = (sc) => (sc && sc.input ? db.inputs.get(sc.input.id) : null);

// Bearer token check (cached 5 min; a token accepted in the last 24 h stays valid while the login service is down)
const authCache = new Map();
async function authorised(req) {
  if (!AUTH) return true;
  const m = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || ''); if (!m) return false;
  if (!AUTH_URL) return true;
  const key = crypto.createHash('sha256').update(m[1]).digest('hex'); const c = authCache.get(key);
  if (c && c.until > Date.now()) return true;
  try {
    const r = await fetch(AUTH_URL, { headers: { Authorization: 'Bearer ' + m[1] }, signal: AbortSignal.timeout(8000) });
    if (r.ok) { authCache.set(key, { until: Date.now() + 300000, seen: Date.now() }); return true; }
    if (r.status === 401 || r.status === 403) { authCache.delete(key); return false; }
    console.error('[auth] login service answered ' + r.status);
  } catch (e) { console.error('[auth]', e.message); }
  return !!(c && Date.now() - c.seen < 86400000);
}

// ---------------------------------------------------------------- results
// front-end parameter names -> .out variables
const NODE_PARAM = { demand: 'demand', head: 'head', pressure: 'pressure', waterQuality: 'quality', waterAge: 'quality', quality: 'quality' };
const LINK_PARAM = { flow: 'flow', velocity: 'velocity', headloss: 'headloss', hydraulicSlope: 'headloss', avgWaterQuality: 'avg_quality', avgWaterAge: 'avg_quality',
  status: 'status', setting: 'setting', reactionRate: 'reaction_rate', friction: 'friction', quality: 'avg_quality' };
const normParam = (p) => { const s = String(p); if (NODE_PARAM[s] || LINK_PARAM[s]) return s; const c = s.replace(/_([a-z])/g, (_, x) => x.toUpperCase()); return NODE_PARAM[c] || LINK_PARAM[c] ? c : s; };
function paramValues(out, net, kind, param, period) {
  const v = (kind === 'node' ? NODE_PARAM : LINK_PARAM)[param]; if (!v) throw Object.assign(new Error(`Unknown ${kind} parameter ${param}`), { status: 400 });
  const a = out.values(kind, v, period);
  if (param !== 'hydraulicSlope') return a;
  // hydraulic slope as the DEMO computed it: unit headloss (per 1000 length units) divided by the pipe length; 0 for pumps and valves
  const r = new Float32Array(a.length); for (let i = 0; i < a.length; i++) r[i] = slopeOf(net, out.linkIds[i], a[i]); return r;
}
function slopeOf(net, name, hl) { const l = net.doc.linkByName.get(U(name)); const L = l && l.type === 'PIPE' ? Number(l.values[3]) : 0; return L > 0 ? hl / L : 0; }
function seriesOf(out, net, kind, param, index) {
  const v = (kind === 'node' ? NODE_PARAM : LINK_PARAM)[param]; if (!v) throw Object.assign(new Error(`Unknown ${kind} parameter ${param}`), { status: 400 });
  const s = out.series(kind, v, index);
  if (param === 'hydraulicSlope') return s.map(x => slopeOf(net, out.linkIds[index], x));
  return s;
}
// domain-wide maxima of every parameter (scenario.output, used for the legends): the largest value, signed (DEMO)
function outputMaxima(out, net) {
  const r3 = (x) => Math.round(x * 1000) / 1000; const node = {}, link = {};
  for (const p of ['demand', 'head', 'pressure', 'waterQuality', 'waterAge']) node[p] = r3(maxOf(out, net, 'node', p));
  for (const p of ['flow', 'velocity', 'headloss', 'hydraulicSlope', 'avgWaterQuality', 'avgWaterAge', 'status', 'setting', 'reactionRate', 'friction']) link[p] = r3(maxOf(out, net, 'link', p));
  return { node, link };
}
function maxOf(out, net, kind, param) { let m = -Infinity; for (let p = 0; p < out.periods; p++) { const a = paramValues(out, net, kind, param, p); for (let i = 0; i < a.length; i++) { const x = a[i]; if (x > m && Number.isFinite(x)) m = x; } } return Number.isFinite(m) ? m : 0; }

function scenarioRun(sid) {
  const sc = db.scenarios.get(sid); if (!sc) throw Object.assign(new Error('Scenario not found'), { status: 404 });
  const input = inputOfScenario(sc); if (!input) throw Object.assign(new Error('The model of this scenario is not available'), { status: 404 });
  const net = network.get(input); const out = engine.reader(sid);
  return { sc, input, net, out };
}
function needOut(x) { if (!x.out) throw Object.assign(new Error('This scenario has no simulation results yet. Run it first.'), { status: 400 }); return x.out; }

// ---------------------------------------------------------------- running
const runningIds = new Set();
async function runScenario(sid, edits = {}) {
  const sc = db.scenarios.get(sid); const input = inputOfScenario(sc); if (!input) throw Object.assign(new Error('The model of this scenario is not available'), { status: 404 });
  const net = network.get(input);
  const e = engine.scenarioEdits(sc);
  const text = INP.engineText(net.doc, Object.assign({ options: e.options, times: e.times }, edits));
  runningIds.add(sid); db.scenarios.setStatus(sid, engine.queued() ? 2 : 1, { output: null });
  try {
    const r = await engine.runText(sid, text, (p) => { const cur = db.scenarios.get(sid); if (cur && cur.status !== 1) db.scenarios.setStatus(sid, 1); void p; });
    if (!r.ok) { db.scenarios.setStatus(sid, 0, { output: null, error: r.message }); return { ok: false, message: r.message }; }
    const out = engine.reader(sid); const output = outputMaxima(out, net);
    db.scenarios.setStatus(sid, 3, { output, error: null, periods: out.periods, report_step: out.reportStep });
    return { ok: true, message: 'success' };
  } finally { runningIds.delete(sid); }
}
// analysis scenarios (category TEMP): a copy of the base scenario run with the analysis edits; old ones are removed
async function tempRun(base, name, edits) {
  const keep = { ...base }; for (const k of ['id', 'createdAt', 'updatedAt', 'input', 'status', 'output', 'legend', 'error']) delete keep[k];
  const sc = db.scenarios.create(base.input.id, Object.assign(keep, { name, hour: null, category: 'TEMP', status: 0, output: null, legend: null, analysis: edits.describe || null }));
  const temps = db.scenarios.byInput(base.input.id).filter(s => s.category === 'TEMP');
  for (const t of temps.slice(0, Math.max(0, temps.length - TEMP_KEEP))) if (!runningIds.has(t.id)) { engine.removeRun(t.id); db.scenarios.remove(t.id); }
  const r = await runScenario(sc.id, edits);
  if (!r.ok) throw Object.assign(new Error('Simulation failed: ' + r.message), { status: 400 });
  return db.scenarios.get(sc.id);
}
// scenarios of a model whose results no longer match it (model saved in Model editing, main model changed)
function clearResults(inputId) { for (const s of db.scenarios.byInput(inputId)) { engine.removeRun(s.id); if (s.category === 'TEMP') db.scenarios.remove(s.id); else db.scenarios.setStatus(s.id, 0, { output: null }); } }

// ---------------------------------------------------------------- models (inputs)
function saveModelFile(input, text) {
  const dir = network.filesDir(input.path); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, input.file); const tmp = f + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
}
function setMain(inputId) {
  for (const i of db.inputs.all()) if (!!i.main !== (i.id === inputId)) db.inputs.update(i.id, { main: i.id === inputId });
  // the live scenarios (one per hour) always belong to the main model
  const lives = db.scenarios.all().filter(s => s.category === 'LIVE');
  for (const s of lives) if (s.input && s.input.id !== inputId) { engine.removeRun(s.id); db.scenarios.remove(s.id); }
  ensureLive(inputId);
}
function ensureLive(inputId) {
  const input = db.inputs.get(inputId); if (!input) return;
  const base = db.scenarios.byInput(inputId).find(s => s.category === 'ORIGIN') || null;
  const have = new Set(db.scenarios.byInput(inputId).filter(s => s.category === 'LIVE').map(s => +s.hour));
  let fields; try { fields = engine.scenarioFromDoc(network.get(input).doc); } catch (e) { return; }
  if (base) { fields = { ...base }; for (const k of ['id', 'createdAt', 'updatedAt', 'input', 'status', 'output', 'legend', 'name', 'category', 'hour', 'error']) delete fields[k]; }
  for (let h = 1; h <= 24; h++) if (!have.has(h)) db.scenarios.create(inputId, Object.assign({}, fields, { name: 'scenario' + h, hour: h, category: 'LIVE', description: 'Live scenario, hour ' + h, status: 0, output: null, legend: null }));
}
function removeInput(id) {
  const i = db.inputs.get(id); if (!i) return false;
  for (const s of db.scenarios.byInput(id)) { engine.removeRun(s.id); db.scenarios.remove(s.id); }
  db.inputs.remove(id); network.forget(id);
  if (i.path && !db.inputs.all().some(o => o.path === i.path)) fs.rmSync(network.filesDir(i.path), { recursive: true, force: true });
  if (i.main) { const n = db.inputs.all()[0]; if (n) setMain(n.id); }
  return true;
}

// ---------------------------------------------------------------- router
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), fn });

// POST /upload/inp  multipart: name, files (one .inp, optional .prj)  -> { result, path, file, scenario }
route('POST', '/upload/inp', async (req, res) => {
  const p = crypto.randomUUID(); const dir = network.filesDir(p); fs.mkdirSync(dir, { recursive: true });
  let files; try { ({ files } = await multipart.parse(req, dir)); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return fail(res, 400, 'Upload failed: ' + e.message); }
  const inps = files.filter(f => /\.inp$/i.test(f.filename));
  if (inps.length !== 1) { fs.rmSync(dir, { recursive: true, force: true }); return fail(res, 400, inps.length ? 'Only one INP file can be uploaded.' : 'Please upload an INP file.'); }
  const inp = inps[0]; const name = path.basename(inp.filename).replace(/[^\w.\-() ]/g, '_');
  const prj = files.find(f => /\.prj$/i.test(f.filename));
  try {
    let text = fs.readFileSync(inp.path, 'utf8');
    const doc = INP.parse(text);
    if (!doc.nodes.length) throw new Error('no junctions, reservoirs or tanks found');
    if (prj && !doc.meta.projection) { doc.meta.projection = fs.readFileSync(prj.path, 'utf8').trim(); text = INP.build(doc); }
    fs.writeFileSync(path.join(dir, name), text);
    for (const f of files) if (f.path !== path.join(dir, name)) try { fs.unlinkSync(f.path); } catch (e) {}
    ok(res, { result: true, path: p, file: name, scenario: crypto.randomUUID(), counts: { nodes: doc.nodes.length, links: doc.links.length } });
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); fail(res, 400, 'The INP file could not be read: ' + e.message); }
});
// POST /input/create  { name, file, path, main, scenario:{ name, id } } -> input; creates the ORIGIN scenario (+ the live ones for the main model)
route('POST', '/input/create', async (req, res) => {
  const b = await readJson(req); const f = b.path && b.file && path.join(network.filesDir(b.path), b.file);
  if (!f || !fs.existsSync(f)) return fail(res, 400, 'Upload the model file first.');
  const input = db.inputs.create({ name: String(b.name || b.file).trim() || b.file, path: b.path, file: b.file, main: false });
  let fields; try { fields = engine.scenarioFromDoc(network.get(input).doc); } catch (e) { db.inputs.remove(input.id); return fail(res, 400, 'The INP file could not be read: ' + e.message); }
  const sname = (b.scenario && b.scenario.name) || ''; const sid = (b.scenario && b.scenario.id) || undefined;
  db.scenarios.create(input.id, Object.assign({}, fields, { name: sname, hour: null, category: 'ORIGIN', description: 'Date: ' + new Date().toLocaleString('en-US'), status: 0, output: null, legend: null }), sid);
  if (b.main !== false || !db.inputs.all().some(i => i.main && i.id !== input.id)) setMain(input.id);
  ok(res, db.inputs.get(input.id));
});
route('GET', '/input/all', (req, res) => ok(res, db.inputs.all()));
route('GET', '/input/:id/detail', (req, res, p) => { const i = db.inputs.get(p.id); return i ? ok(res, i) : fail(res, 404, 'Model not found'); });
route('POST', '/input/:id/update', async (req, res, p) => { const b = await readJson(req); const d = b.input || b; const i = db.inputs.get(p.id); if (!i) return fail(res, 404, 'Model not found');
  const upd = {}; if (d.name !== undefined) upd.name = String(d.name); const r = db.inputs.update(p.id, upd); if (d.main) setMain(p.id); ok(res, db.inputs.get(r.id)); });
route('POST', '/input/change', async (req, res) => { const b = await readJson(req); const id = (b.input && b.input.id) || b.id; if (!id || !db.inputs.get(id)) return fail(res, 404, 'Model not found');
  setMain(id); ok(res, { result: true }); });
route('DELETE', '/input/:id/remove', (req, res, p) => ok(res, { result: removeInput(p.id) }));

// Model editing
route('GET', '/input/:id/editor', (req, res, p) => { const i = db.inputs.get(p.id); if (!i) return fail(res, 404, 'Model not found');
  const net = network.get(i); ok(res, Object.assign(INP.editorView(net.doc, net.text, DEFAULT_PRJ), { id: i.id, name: i.name })); });
// POST /input/editor/preview { content, operation?, projection? } -> the edited draft (nothing is saved)
route('POST', '/input/editor/preview', async (req, res) => {
  const b = await readJson(req); let doc;
  try { doc = INP.parse(String(b.content || '')); } catch (e) { return fail(res, 400, 'The model text could not be read: ' + e.message); }
  if (b.projection) doc.meta.projection = String(b.projection).trim();
  if (b.operation) INP.applyOperation(doc, b.operation, DEFAULT_PRJ);
  if (!doc.nodes.length) return fail(res, 400, 'The model has no junctions, reservoirs or tanks.');
  const text = b.operation || b.projection ? INP.build(doc) : String(b.content);
  ok(res, INP.editorView(INP.parse(text), text, DEFAULT_PRJ));
});
// POST /input/:id/editor { content, revision } -> saved; results of the model's scenarios are cleared
route('POST', '/input/:id/editor', async (req, res, p) => {
  const i = db.inputs.get(p.id); if (!i) return fail(res, 404, 'Model not found');
  const b = await readJson(req); const net = network.get(i);
  if (b.revision && b.revision !== INP.revision(net.text)) return fail(res, 409, 'The model was changed by someone else after you loaded it. Reload it and apply your edits again.');
  const doc = INP.parse(String(b.content || '')); if (!doc.nodes.length) return fail(res, 400, 'The model has no junctions, reservoirs or tanks.');
  const text = String(b.content);
  saveModelFile(i, text); const upd = db.inputs.update(i.id, {}); network.forget(i.id); clearResults(i.id);
  const n2 = network.get(upd); ok(res, Object.assign(INP.editorView(n2.doc, n2.text, DEFAULT_PRJ), { id: upd.id, name: upd.name }));
});
// model file as saved
route('GET', '/files/epanet/:path/:file', (req, res, p) => {
  const f = path.join(network.filesDir(p.path), p.file); if (!f.startsWith(network.filesDir(p.path)) || !fs.existsSync(f)) return fail(res, 404, 'File not found');
  const b = fs.readFileSync(f); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Content-Disposition': 'attachment; filename="' + p.file.replace(/"/g, '') + '"' }); res.end(b);
});

// ---- scenarios
route('GET', '/scenario/all', (req, res) => ok(res, db.scenarios.all().filter(s => s.category !== 'TEMP')));
route('GET', '/scenario/:id/detail', (req, res, p) => { const s = db.scenarios.get(p.id); return s ? ok(res, s) : fail(res, 404, 'Scenario not found'); });
route('GET', '/scenario/:id/legend', (req, res, p) => { const s = db.scenarios.get(p.id); return s ? ok(res, s) : fail(res, 404, 'Scenario not found'); });
route('GET', '/scenario/hour/:h', (req, res, p) => { const main = db.inputs.all().find(i => i.main); const h = +p.h === 0 ? 24 : +p.h;
  const s = db.scenarios.all().find(x => x.category === 'LIVE' && +x.hour === h && (!main || x.input.id === main.id)); return s ? ok(res, s) : fail(res, 404, 'Scenario not found'); });
route('POST', '/scenario/create', async (req, res) => { const b = await readJson(req); const d = b.scenario || b; const inputId = (d.input && d.input.id) || d.input_id || (db.inputs.all().find(i => i.main) || {}).id;
  const input = db.inputs.get(inputId); if (!input) return fail(res, 400, 'Choose a model for the scenario.');
  const fields = engine.scenarioFromDoc(network.get(input).doc); const data = Object.assign(fields, d); delete data.input;
  ok(res, db.scenarios.create(input.id, Object.assign(data, { category: d.category || 'NORMAL', status: 0, output: null }))); });
route('POST', '/scenario/:id/update', async (req, res, p) => { const b = await readJson(req); const d = b.scenario || b; const s = db.scenarios.get(p.id); if (!s) return fail(res, 404, 'Scenario not found');
  const data = Object.assign({}, d); delete data.input; delete data.output;
  if (runningIds.has(p.id) && data.status !== undefined) delete data.status;
  ok(res, db.scenarios.update(p.id, data)); });
route('DELETE', '/scenario/:id/remove', (req, res, p) => { const s = db.scenarios.get(p.id); if (!s) return fail(res, 404, 'Scenario not found');
  if (runningIds.has(p.id)) return fail(res, 400, 'The scenario is running.'); engine.removeRun(p.id); db.scenarios.remove(p.id); ok(res, { result: true }); });

// POST /run/inp { scenario | scenarioId, force } -> started; the page polls /scenario/:id/detail until status 3
route('POST', '/run/inp', async (req, res) => {
  const b = await readJson(req); const sid = sidOf(b); const sc = sid && db.scenarios.get(sid); if (!sc) return fail(res, 404, 'Scenario not found');
  if (runningIds.has(sid)) return ok(res, { result: true, status: db.scenarios.get(sid).status }, 'The simulation is already running.');
  if (sc.status === 3 && !b.force) return ok(res, { result: true, status: 3 }, 'The scenario already has results.');
  runScenario(sid).catch(e => { console.error('[run]', e.message); db.scenarios.setStatus(sid, 0, { error: e.message }); });
  ok(res, { result: true, status: 1 }, 'Simulation started.');
});

// ---- objects
route('GET', '/node/input/:inputId', (req, res, p) => { const i = db.inputs.get(p.inputId); return i ? ok(res, network.get(i).nodes) : fail(res, 404, 'Model not found'); });
route('GET', '/link/input/:inputId', (req, res, p) => { const i = db.inputs.get(p.inputId); return i ? ok(res, network.get(i).links) : fail(res, 404, 'Model not found'); });
route('GET', '/node/input/:inputId/name/:name', (req, res, p) => { const i = db.inputs.get(p.inputId); if (!i) return fail(res, 404, 'Model not found');
  const n = network.get(i).nodeByName.get(U(decodeURIComponent(p.name))); return n ? ok(res, n) : fail(res, 404, 'Node not found'); });
route('GET', '/link/input/:inputId/name/:name', (req, res, p) => { const i = db.inputs.get(p.inputId); if (!i) return fail(res, 404, 'Model not found');
  const n = network.get(i).linkByName.get(U(decodeURIComponent(p.name))); return n ? ok(res, n) : fail(res, 404, 'Link not found'); });
function findObject(id) { for (const i of db.inputs.all()) { const n = network.get(i).byId.get(id); if (n) return { input: i, obj: n }; } return null; }
route('GET', '/node/:id/detail', (req, res, p) => { const f = findObject(p.id); return f && f.obj.junction !== undefined ? ok(res, f.obj) : fail(res, 404, 'Node not found'); });
route('GET', '/link/:id/detail', (req, res, p) => { const f = findObject(p.id); return f && f.obj.pipe !== undefined ? ok(res, f.obj) : fail(res, 404, 'Link not found'); });
// object edits through the API go through the same operations as Model editing and are saved at once
const SECTION = { JUNCTION: 'JUNCTIONS', RESERVOIR: 'RESERVOIRS', TANK: 'TANKS', PIPE: 'PIPES', PUMP: 'PUMPS', VALVE: 'VALVES' };
function objectValues(o) {
  const t = U(o.type || ''); const j = o.junction || {}, r = o.reservoir || {}, k = o.tank || {}, pi = o.pipe || {}, va = o.valve || {}, pu = o.pump || {};
  if (t === 'JUNCTION') return [o.name, j.elev ?? 0, j.demand ?? 0, j.pattern || ''].filter((v, i) => i < 3 || v !== '');
  if (t === 'RESERVOIR') return [o.name, r.head ?? 0, r.pattern || ''].filter((v, i) => i < 2 || v !== '');
  if (t === 'TANK') return [o.name, k.elev ?? 0, k.init_level ?? 0, k.min_level ?? 0, k.max_level ?? 0, k.diameter ?? 0, k.min_vol ?? 0, k.vol_curve || '*'];
  if (t === 'PIPE') return [o.name, pi.start_node, pi.end_node, pi.length ?? 0, pi.diameter ?? 0, pi.roughness ?? 100, pi.loss ?? 0, pi.status || 'Open'];
  if (t === 'VALVE') return [o.name, va.start_node, va.end_node, va.diameter ?? 0, va.type || 'TCV', va.setting ?? 0, va.loss ?? 0];
  if (t === 'PUMP') { const v = [o.name, pu.start_node, pu.end_node]; for (const [a, b] of Object.entries(pu)) if (!['start_node', 'end_node'].includes(a)) v.push(U(a), b); return v; }
  throw Object.assign(new Error('Unknown object type ' + o.type), { status: 400 });
}
function editObject(input, op) { const net = network.get(input); const doc = INP.parse(net.text); INP.applyOperation(doc, op, DEFAULT_PRJ); const text = INP.build(doc);
  saveModelFile(input, text); const upd = db.inputs.update(input.id, {}); network.forget(input.id); clearResults(input.id); return network.get(upd); }
for (const kind of ['node', 'link']) {
  route('POST', `/${kind}/create`, async (req, res) => { const b = await readJson(req); const o = b[kind] || b; const input = db.inputs.get((o.input && o.input.id) || o.input_id || (db.inputs.all().find(i => i.main) || {}).id);
    if (!input) return fail(res, 400, 'Choose a model.'); const op = { kind: 'upsert', section: SECTION[U(o.type)], values: objectValues(o) };
    if (kind === 'node' && o.geometry && o.geometry.coordinates) op.mapPosition = o.geometry.coordinates;
    const n = editObject(input, op); ok(res, (kind === 'node' ? n.nodeByName : n.linkByName).get(U(o.name))); });
  route('POST', `/${kind}/:id/update`, async (req, res, p) => { const b = await readJson(req); const o = b[kind] || b; const f = findObject(p.id); if (!f) return fail(res, 404, 'Object not found');
    const cur = f.obj; const merged = Object.assign({}, cur, o, { type: cur.type }); const op = { kind: 'upsert', section: SECTION[cur.type], originalId: cur.name, values: objectValues(merged) };
    if (kind === 'node' && o.geometry && o.geometry.coordinates) op.mapPosition = o.geometry.coordinates;
    const n = editObject(f.input, op); ok(res, (kind === 'node' ? n.nodeByName : n.linkByName).get(U(merged.name))); });
  route('DELETE', `/${kind}/:id/remove`, (req, res, p) => { const f = findObject(p.id); if (!f) return fail(res, 404, 'Object not found');
    editObject(f.input, { kind: 'remove', section: SECTION[f.obj.type], originalId: f.obj.name }); ok(res, { result: true }); });
}

// ---- results
// POST /output/variable/:param/:kind/:name { id, periodIndex? } -> [{ name, <param>: series | value }]
route('POST', '/output/variable/:param/:kind/:name', async (req, res, p) => {
  const kind = p.kind === 'node' || p.kind === 'link' ? p.kind : null; if (!kind) return fail(res, 404, 'Not found');
  const b = await readJson(req); const x = scenarioRun(sidOf(b)); const out = needOut(x); const param = normParam(p.param); const name = decodeURIComponent(p.name);
  const idx = (kind === 'node' ? out.nodeIndex : out.linkIndex).get(U(name)); if (idx === undefined) return fail(res, 404, `${name} is not in the results`);
  const id = (kind === 'node' ? out.nodeIds : out.linkIds)[idx];
  if (b.periodIndex !== undefined && b.periodIndex !== null) { const a = paramValues(out, x.net, kind, param, Math.min(out.periods - 1, Math.max(0, b.periodIndex | 0))); return ok(res, [{ name: id, [param]: a[idx] }]); }
  ok(res, [{ name: id, [param]: seriesOf(out, x.net, kind, param, idx) }]);
});
// POST /output/variable/:param/:kind { id, type?, periodIndex? } -> [{ name, <param>: value }] for every object (of the type)
route('POST', '/output/variable/:param/:kind', async (req, res, p) => {
  const kind = p.kind === 'node' || p.kind === 'link' ? p.kind : null; if (!kind) return fail(res, 404, 'Not found');
  const b = await readJson(req); const x = scenarioRun(sidOf(b)); const out = needOut(x); const param = normParam(p.param);
  const period = Math.min(out.periods - 1, Math.max(0, (b.periodIndex | 0) || 0)); const a = paramValues(out, x.net, kind, param, period);
  const ids = kind === 'node' ? out.nodeIds : out.linkIds; const type = b.type ? U(b.type) : null; const objs = kind === 'node' ? x.net.doc.nodeByName : x.net.doc.linkByName;
  const data = []; for (let i = 0; i < ids.length; i++) { if (type) { const o = objs.get(U(ids[i])); if (!o || o.type !== type) continue; } data.push({ name: ids[i], [param]: a[i] }); }
  ok(res, data);
});
// POST /output/variable/:param/period/:a/:b/(nodes|links) { scenario } -> [{ name, <param>: [values of periods a..b] }]
route('POST', '/output/variable/:param/period/:a/:b/:kinds', async (req, res, p) => {
  const kind = p.kinds === 'nodes' ? 'node' : p.kinds === 'links' ? 'link' : null; if (!kind) return fail(res, 404, 'Not found');
  const b = await readJson(req); const x = scenarioRun(sidOf(b)); const out = needOut(x); const param = normParam(p.param);
  const a0 = +p.a, a1 = +p.b; if (!Number.isInteger(a0) || !Number.isInteger(a1) || a0 < 0 || a1 < a0 || a1 >= out.periods) return fail(res, 400, 'Invalid result period range.');
  const cols = []; for (let t = a0; t <= a1; t++) cols.push(paramValues(out, x.net, kind, param, t));
  const ids = kind === 'node' ? out.nodeIds : out.linkIds; ok(res, ids.map((n, i) => ({ name: n, [param]: cols.map(c => c[i]) })));
});

// ---- analyses
const baseOf = (b) => { const sc = db.scenarios.get(sidOf(b)); if (!sc) throw Object.assign(new Error('Scenario not found'), { status: 404 }); return sc; };
const mainNet = () => { const i = db.inputs.all().find(o => o.main) || db.inputs.all()[0]; if (!i) throw Object.assign(new Error('No model has been uploaded.'), { status: 400 }); return network.get(i); };
// the valve searches get no scenario: the flow directions come from the main model's newest completed run (if any)
function netAndFlows(b) {
  if (b.scenario) { const x = scenarioRun(sidOf(b)); return [x.net, x.out]; }
  const net = mainNet(); const done = db.scenarios.byInput(net.input.id).filter(s => s.status === 3 && s.category !== 'TEMP').sort((a, c) => (a.updatedAt < c.updatedAt ? 1 : -1));
  for (const s of done) { const r = engine.reader(s.id); if (r) return [net, r]; } return [net, null];
}
route('POST', '/analysis/close/valve', async (req, res) => { const b = await readJson(req); const [net, out] = netAndFlows(b); ok(res, analysis.closeValves(net, b, out)); });
route('POST', '/analysis/quality/close/valves', async (req, res) => { const b = await readJson(req); const [net, out] = netAndFlows(b); ok(res, analysis.qualityValves(net, b, out)); });
route('POST', '/analysis/low/pressure', async (req, res) => { const b = await readJson(req); const x = scenarioRun(sidOf(b)); ok(res, analysis.lowPressure(x.net, needOut(x), b, b.periodIndex | 0)); });
route('POST', '/analysis/water/quality', async (req, res) => { const b = await readJson(req); const x = scenarioRun(sidOf(b)); ok(res, analysis.waterQuality(x.net, needOut(x), b, b.periodIndex | 0)); });
const nameOf = (v) => (typeof v === 'string' ? v : v && (v.name || v.code || v.node_code || v.burst_node || (v.properties && v.properties.name)));
route('POST', '/analysis/close/simulation', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  const valves = (b.close_valves || []).map(nameOf).filter(Boolean); ok(res, await tempRun(base, 'Valve Closure Simulation', { closeLinks: valves, describe: { close_valves: valves } })); });
route('POST', '/analysis/burst', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  ok(res, await tempRun(base, 'Pipe Burst Analysis', { extraDemands: [{ node: nameOf(b.burst_node), demand: +b.demand || 0 }], describe: { burst_node: nameOf(b.burst_node), demand: +b.demand || 0 } })); });
route('POST', '/analysis/burst/emitter', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  ok(res, await tempRun(base, 'Pipe Burst Analysis', { emitters: [{ node: nameOf(b.node_code), coefficient: +b.emitter_coefficient || 0 }], describe: { node_code: nameOf(b.node_code), emitter_coefficient: +b.emitter_coefficient } })); });
route('POST', '/analysis/burst/multi', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  const pts = (b.burst_points || []).map(x => ({ node: nameOf(x.burst_node || x.node_code || x.node || x), demand: +x.demand || 0 })).filter(x => x.node);
  ok(res, await tempRun(base, 'Pipe Burst Analysis', { extraDemands: pts, describe: { burst_points: pts } })); });
route('POST', '/analysis/burst/emitter/multi', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  const pts = (b.burst_points || []).map(x => ({ node: nameOf(x.node_code || x.burst_node || x.node || x), coefficient: +x.emitter_coefficient || 0 })).filter(x => x.node);
  ok(res, await tempRun(base, 'Pipe Burst Analysis', { emitters: pts, describe: { burst_points: pts } })); });
// hydrant flushing: each outfall node discharges freely (emitter coefficient given or 1)
route('POST', '/analysis/flush', async (req, res) => { const b = await readJson(req); const base = baseOf(b);
  const pts = (b.outfalls || []).map(x => ({ node: nameOf(x), coefficient: +(x && x.emitter_coefficient) || 1 })).filter(x => x.node);
  ok(res, await tempRun(base, 'Flushing Analysis', { emitters: pts, describe: { outfalls: pts } })); });

// ---- projects (kept for the front end's project list)
route('GET', '/project/all', (req, res) => ok(res, db.projects.all()));
route('GET', '/project/:id/detail', (req, res, p) => { const r = db.projects.get(p.id); return r ? ok(res, r) : fail(res, 404, 'Project not found'); });
route('POST', '/project/create', async (req, res) => { const b = await readJson(req); ok(res, db.projects.create(b.project || b)); });
route('POST', '/project/:id/update', async (req, res, p) => { const b = await readJson(req); const r = db.projects.update(p.id, b.project || b); return r ? ok(res, r) : fail(res, 404, 'Project not found'); });
route('DELETE', '/project/:id/remove', (req, res, p) => { db.projects.remove(p.id); ok(res, { result: true }); });

route('GET', '/health', (req, res) => ok(res, { service: 'avaris-ds-api', version: require('../package.json').version, database: dbInfo.kind, engine: fs.existsSync(ENGINE) ? path.basename(ENGINE) : 'missing', queued: engine.queued() }));

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  res.req = req;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let p = decodeURI(new URL(req.url, 'http://x').pathname).replace(/^\/api\/epanet(?=\/|$)/, '') || '/';
  const r = routes.find(x => x.method === req.method && x.re.test(p));
  if (!r) return fail(res, 404, `Cannot ${req.method} /api/epanet${p}`);
  if (p !== '/health' && !p.startsWith('/files/') && !(await authorised(req))) return fail(res, 401, 'Unauthorized');
  try { await r.fn(req, res, r.re.exec(p).groups || {}); }
  catch (e) { if (!e.status) console.error('[api]', req.method, p, e.stack || e.message); if (!res.headersSent) fail(res, e.status || 500, e.message); }
});
server.requestTimeout = 0; server.headersTimeout = 120000;
const shutdown = () => { server.close(); db.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
// runs that were interrupted by a restart are not running any more
for (const s of db.scenarios.all()) if (s.status === 1 || s.status === 2) db.scenarios.setStatus(s.id, 0);
for (const s of db.scenarios.all().filter(x => x.category === 'TEMP')) { /* kept until TEMP_KEEP pushes them out */ }
server.listen(PORT, process.env.HOST || undefined, () => console.log(`avaris-ds-api on :${PORT}  data ${DATA}  ${dbInfo.kind}  engine ${ENGINE}${AUTH ? (AUTH_URL ? '  auth ' + AUTH_URL : '  auth: Bearer token required') : '  auth OFF'}`));
