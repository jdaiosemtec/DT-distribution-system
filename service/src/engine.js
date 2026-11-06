'use strict';
// Runs the Avaris DS engine (OWA EPANET 2.3, bin/<os>/avaris_ds_engine) on a scenario.
// One run directory per scenario: DATA/runs/<scenarioId>/run.inp, run.rpt, run.out, engine.log.
// Runs are queued; at most ENGINE_PARALLEL (default 2) run at the same time.
// Scenario status: 0 not started / failed, 1 running, 2 queued, 3 completed (DEMO values; the front end polls for 3).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const INP = require('./model/inp');
const { EpaOut } = require('./results/epaout');

let DATA = null, ENGINE = '';
const PARALLEL = Math.max(1, +process.env.ENGINE_PARALLEL || 2);
const queue = []; let running = 0;
const readers = new Map();                    // scenarioId -> EpaOut
function init(dataDir, engine) { DATA = dataDir; ENGINE = engine; fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true }); }
const runDir = (id) => path.join(DATA, 'runs', id);

// scenario record -> [OPTIONS] / [TIMES] edits (only the fields the scenario sets)
const hhmm = (h) => { const v = Number(h); if (!Number.isFinite(v)) return undefined; const m = Math.round(v * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
function scenarioEdits(sc) {
  const o = {}, t = {};
  const setO = (k, v) => { if (v !== undefined && v !== null && v !== '') o[k] = v; };
  setO('Units', sc.units); setO('Headloss', sc.headloss); setO('Viscosity', sc.viscosity); setO('Diffusivity', sc.diffusivity);
  setO('Specific Gravity', sc.specific_gravity); setO('Trials', sc.trials); setO('Accuracy', sc.accuracy);
  if (sc.unbalanced) setO('Unbalanced', String(sc.unbalanced).toUpperCase() === 'CONTINUE' && sc.unbalanced_n ? `Continue ${sc.unbalanced_n}` : sc.unbalanced);
  setO('Pattern', sc.pattern); setO('Demand Multiplier', sc.demand_multiplier); setO('Emitter Exponent', sc.emitter_exponent); setO('Tolerance', sc.tolerance);
  if (sc.quality) setO('Quality', String(sc.quality).toUpperCase() === 'TRACE' && sc.quality_id ? `Trace ${sc.quality_id}` : sc.quality);
  const T = sc.times || {};
  if (T.duration !== undefined) t['Duration'] = hhmm(T.duration);
  if (T.hyd_timestep !== undefined) t['Hydraulic Timestep'] = hhmm(T.hyd_timestep);
  if (T.pattern_timestep !== undefined) t['Pattern Timestep'] = hhmm(T.pattern_timestep);
  if (T.quality_timestep !== undefined && Number(T.quality_timestep) > 0) t['Quality Timestep'] = hhmm(T.quality_timestep);
  if (T.report_start !== undefined) t['Report Start'] = hhmm(T.report_start);
  // report step: the hydraulic step (DEMO results have one period per hydraulic step: 48 h / 0.25 h -> 193 periods)
  if (T.report_timestep !== undefined) t['Report Timestep'] = hhmm(T.report_timestep);
  else if (T.hyd_timestep !== undefined) t['Report Timestep'] = hhmm(T.hyd_timestep);
  return { options: o, times: t };
}

// scenario fields read from a model ([OPTIONS] / [TIMES]) when a scenario is created for it
function scenarioFromDoc(doc) {
  const O = doc.options, T = doc.times;
  const hrs = (v) => { if (v === undefined || v === null || v === '') return undefined; const s = String(v).trim().split(/\s+/); let x = s[0];
    let h; if (x.includes(':')) { const p = x.split(':').map(Number); h = p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600; } else h = Number(x);
    const u = (s[1] || '').toUpperCase(); if (u.startsWith('MIN')) h /= 60; else if (u.startsWith('SEC')) h /= 3600; else if (u.startsWith('DAY')) h *= 24;
    if (!x.includes(':') && !u) h = h; return Number.isFinite(h) ? String(Math.round(h * 1e6) / 1e6) : undefined; };
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : v);
  const unb = String(O.UNBALANCED || 'STOP').split(/\s+/);
  const q = String(O.QUALITY || 'NONE').split(/\s+/);
  return {
    units: (O.UNITS || 'GPM').toUpperCase(), headloss: (O.HEADLOSS || 'H-W').toUpperCase(), hydraulics: null, hydraulics_filename: null,
    quality: q[0].toUpperCase(), quality_id: q[1] || null, viscosity: n(O.VISCOSITY ?? 1), diffusivity: n(O.DIFFUSIVITY ?? null),
    specific_gravity: n(O['SPECIFIC GRAVITY'] ?? 1), trials: n(O.TRIALS ?? 200), accuracy: n(O.ACCURACY ?? 0.001),
    unbalanced: unb[0].toUpperCase(), unbalanced_n: n(unb[1] ?? 0), pattern: O.PATTERN || null, demand_multiplier: n(O['DEMAND MULTIPLIER'] ?? null),
    emitter_exponent: n(O['EMITTER EXPONENT'] ?? 0.5), tolerance: n(O.TOLERANCE ?? 0.01), map: O.MAP || null,
    times: { duration: hrs(T.DURATION) ?? '0', hyd_timestep: hrs(T['HYDRAULIC TIMESTEP']) ?? '1', pattern_timestep: hrs(T['PATTERN TIMESTEP']) ?? '1',
      quality_timestep: hrs(T['QUALITY TIMESTEP']) ?? '0', report_start: hrs(T['REPORT START']) ?? '0' },
    report: { parameters: [] },
  };
}

// run -> Promise<{ ok, message, dir }>; onProgress(percent)
function runText(id, text, onProgress) {
  return new Promise((resolve) => {
    const job = () => {
      running++;
      const dir = runDir(id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      closeReader(id);
      const inp = path.join(dir, 'run.inp'), rpt = path.join(dir, 'run.rpt'), out = path.join(dir, 'run.out');
      fs.writeFileSync(inp, text);
      let log = '', last = -1, err = '';
      const p = spawn(ENGINE, [inp, rpt, out], { cwd: dir, windowsHide: true });
      const onData = (b) => { const s = b.toString(); log += s; for (const line of s.split(/\r?\n/)) {
        const m = /^PROGRESS (\d+)/.exec(line); if (m) { const v = +m[1]; if (v !== last) { last = v; onProgress && onProgress(v); } }
        const e = /^ERROR (\d+) (.*)/.exec(line); if (e) err = `EPANET error ${e[1]}: ${e[2]}`; } };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      const done = (code) => {
        running--; fs.writeFileSync(path.join(dir, 'engine.log'), log);
        let ok = code === 0 && fs.existsSync(out) && !err;
        if (ok) { try { new EpaOut(out).close(); } catch (e) { ok = false; err = e.message; } }
        if (!ok && !err) { try { const r = fs.readFileSync(rpt, 'utf8'); const m = /Error \d+:[^\r\n]*/.exec(r); err = m ? m[0] : 'Simulation failed (exit code ' + code + ')'; } catch (e) { err = 'Simulation failed (exit code ' + code + ')'; } }
        resolve({ ok, message: ok ? 'success' : err, dir }); next();
      };
      p.on('error', (e) => { err = 'Engine could not be started: ' + e.message; done(-1); });
      p.on('close', done);
    };
    queue.push(job); next();
  });
}
function next() { while (running < PARALLEL && queue.length) queue.shift()(); }
function queued() { return queue.length; }

function reader(id) {
  let r = readers.get(id); if (r) return r;
  const f = path.join(runDir(id), 'run.out'); if (!fs.existsSync(f)) return null;
  try { r = new EpaOut(f); } catch (e) { return null; }
  readers.set(id, r); if (readers.size > 64) { const k = readers.keys().next().value; closeReader(k); }
  return r;
}
function closeReader(id) { const r = readers.get(id); if (r) { r.close(); readers.delete(id); } }
function removeRun(id) { closeReader(id); fs.rmSync(runDir(id), { recursive: true, force: true }); }

module.exports = { init, runText, reader, closeReader, removeRun, scenarioEdits, scenarioFromDoc, runDir, queued };
