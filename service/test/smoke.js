'use strict';
// Smoke test of avaris-ds-api: starts the service on a temporary data folder (AUTH=off), uploads a model, runs it and
// calls every route the Supply Model pages use.   node test/smoke.js [model.inp]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const MODEL = process.argv[2] || path.join(__dirname, 'Net3.inp');
const PORT = 18016, B = `http://127.0.0.1:${PORT}/api/epanet`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'avaris-ds-test-'));
let fails = 0; const t0 = Date.now();
const check = (c, msg) => { if (c) console.log('  ok  ' + msg); else { fails++; console.log('  FAIL ' + msg); } };
const J = { 'Content-Type': 'application/json' };
const get = async (p) => { const r = await fetch(B + p); return { st: r.status, j: await r.json() }; };
const post = async (p, b) => { const r = await fetch(B + p, { method: 'POST', headers: J, body: JSON.stringify(b) }); return { st: r.status, j: await r.json() }; };
const del = async (p) => { const r = await fetch(B + p, { method: 'DELETE' }); return { st: r.status, j: await r.json() }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: Object.assign({}, process.env, { AUTH: 'off', DATA_DIR: DATA, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 50 && !log.includes('avaris-ds-api on'); i++) await sleep(100);
  try {
    console.log('model', MODEL);
    const fd = new FormData(); fd.append('name', 'Test'); fd.append('files', new Blob([fs.readFileSync(MODEL)]), path.basename(MODEL));
    let r = await (await fetch(B + '/upload/inp', { method: 'POST', body: fd })).json();
    check(r.data && r.data.result && r.data.path, 'upload/inp');
    r = await post('/input/create', { name: 'Test', status: -1, file: r.data.file, path: r.data.path, main: true, scenario: { name: 'base', id: r.data.scenario } });
    check(r.st === 201 && r.j.data.main === true, 'input/create (main)');
    const inputId = r.j.data.id;
    let sc = (await get('/scenario/all')).j.data;
    check(sc.length === 25 && sc.filter(s => s.category === 'LIVE').length === 24, 'ORIGIN + 24 LIVE scenarios');
    const o = sc.find(s => s.category === 'ORIGIN');
    r = await post('/run/inp', { scenario: o, scenarioId: o.id, force: true }); check(r.st === 201, 'run/inp started');
    let d; for (let i = 0; i < 600; i++) { await sleep(200); d = (await get('/scenario/' + o.id + '/detail')).j.data; if (d.status === 3 || d.status === 0) break; }
    check(d.status === 3, 'run completed (status 3) ' + (d.error || ''));
    check(d.output && d.output.node && d.output.node.pressure > 0 && d.output.link.flow > 0, 'scenario.output maxima ' + JSON.stringify(d.output));
    const nodes = (await get('/node/input/' + inputId)).j.data, links = (await get('/link/input/' + inputId)).j.data;
    check(nodes.length > 0 && nodes[0].geometry && nodes[0].id, `node/input (${nodes.length})`);
    check(links.length > 0 && links[0].geometry, `link/input (${links.length})`);
    const j1 = nodes.find(n => n.type === 'JUNCTION'), p1 = links.find(l => l.type === 'PIPE');
    r = await post('/output/variable/pressure/node', { id: o.id, periodIndex: 2 }); check(r.j.data.length === nodes.length && typeof r.j.data[0].pressure === 'number', 'output pressure all nodes');
    r = await post('/output/variable/waterAge/node', { id: o.id }); check(r.j.data.length === nodes.length && 'waterAge' in r.j.data[0], 'output waterAge');
    r = await post('/output/variable/avgWaterAge/link', { id: o.id }); check(r.j.data.length === links.length && 'avgWaterAge' in r.j.data[0], 'output avgWaterAge links');
    r = await post('/output/variable/hydraulicSlope/link', { id: o.id, periodIndex: 1 }); check(r.j.data.length === links.length, 'output hydraulicSlope');
    r = await post('/output/variable/pressure/node/' + encodeURIComponent(j1.name), { id: o.id }); check(Array.isArray(r.j.data[0].pressure) && r.j.data[0].pressure.length === d.periods, 'node series');
    r = await post('/output/variable/flow/link/' + encodeURIComponent(p1.name), { id: o.id, periodIndex: 1 }); check(typeof r.j.data[0].flow === 'number', 'link value at period');
    r = await post('/output/variable/pressure/period/0/1/nodes', { scenario: { id: o.id } }); check(r.j.data[0].pressure.length === 2, 'period range');
    r = await post('/output/variable/pressure/period/5/1/nodes', { scenario: { id: o.id } }); check(r.st === 400, 'bad period range -> 400');
    r = await post('/output/variable/pressure/node', { id: o.id, type: 'JUNCTION' }); check(r.j.data.length === nodes.filter(n => n.type === 'JUNCTION').length, 'filter by type');
    r = await get('/scenario/' + o.id + '/legend'); check(r.j.data.output, 'scenario legend');
    r = await get('/node/input/' + inputId + '/name/' + encodeURIComponent(j1.name)); check(r.j.data.id === j1.id, 'node by name');
    r = await get('/node/' + j1.id + '/detail'); check(r.j.data.name === j1.name, 'node detail');
    r = await get('/link/' + p1.id + '/detail'); check(r.j.data.name === p1.name, 'link detail');
    // analyses
    for (const mode of ['MIN_RANGE', 'MIN_COUNT']) { r = await post('/analysis/close/valve', { code: p1.name, type: 'PIPE', close_type: mode, invalid_valves: [] });
      check(r.st === 201 && Array.isArray(r.j.data.valves) && r.j.data.pipes.length >= 1, `close/valve ${mode}: ${r.j.data.valves && r.j.data.valves.length} valves, ${r.j.data.pipes && r.j.data.pipes.length} pipes`); }
    r = await post('/analysis/close/valve', { code: j1.name, type: 'JUNCTION', close_type: 'MIN_RANGE', invalid_valves: [] }); check(r.st === 201, 'close/valve junction');
    r = await post('/analysis/low/pressure', { low_pressure: j1.name, scenario: d }); check(r.st === 201 && r.j.data.nodes.length >= 1, `low/pressure: ${r.j.data.nodes && r.j.data.nodes.length} nodes, plant ${r.j.data.plant && r.j.data.plant.name}`);
    for (const m of ['SOURCE', 'DIFFUSION']) { r = await post('/analysis/water/quality', { quality_node: j1.name, duration: 6, method: m, scenario: d }); check(r.st === 201 && Array.isArray(r.j.data.pipes), `water/quality ${m}: ${r.j.data.pipes && r.j.data.pipes.length} pipes`); }
    r = await post('/analysis/quality/close/valves', { node_codes: nodes.slice(0, 5).map(n => n.name), invalid_valves: [] }); check(r.st === 201, 'quality/close/valves');
    r = await post('/analysis/burst/emitter/multi', { burst_points: [{ node_code: j1.name, emitter_coefficient: 5 }], scenario: d });
    check(r.st === 201 && r.j.data.category === 'TEMP' && r.j.data.status === 3, 'burst/emitter/multi -> TEMP scenario');
    if (r.j.data && r.j.data.id) { const a = await post('/output/variable/pressure/node/' + encodeURIComponent(j1.name), { id: r.j.data.id, periodIndex: 0 }); const b = await post('/output/variable/pressure/node/' + encodeURIComponent(j1.name), { id: o.id, periodIndex: 0 });
      check(a.j.data[0].pressure < b.j.data[0].pressure, `burst lowers pressure at the burst node (${b.j.data[0].pressure.toFixed(2)} -> ${a.j.data[0].pressure.toFixed(2)})`); }
    const valves = links.filter(l => l.type === 'VALVE' || l.type === 'PIPE').slice(0, 2);
    r = await post('/analysis/close/simulation', { close_valves: valves, close_nodes: [], scenario: d }); check(r.st === 201 && r.j.data.status === 3, 'close/simulation');
    r = await post('/analysis/burst', { burst_node: j1.name, demand: 10, scenario: d }); check(r.st === 201 && r.j.data.status === 3, 'burst (demand)');
    check((await get('/scenario/all')).j.data.every(s => s.category !== 'TEMP'), 'TEMP scenarios not listed');
    // Model editing
    r = await get('/input/' + inputId + '/editor'); const ed = r.j.data;
    check(ed.nodes.length === nodes.length && ed.revision && ed.content.includes('[JUNCTIONS]'), 'editor load');
    const jn = ed.nodes.find(n => n.section === 'JUNCTIONS'), pn = ed.links.find(l => l.section === 'PIPES');
    r = await post('/input/editor/preview', { content: ed.content, operation: { kind: 'upsert', section: 'JUNCTIONS', originalId: jn.name, values: [jn.name, '123.5', ...jn.values.slice(2)], related: {} } });
    check(r.st === 201 && r.j.data.nodes.find(n => n.name === jn.name).values[1] === '123.5', 'editor preview: edit junction');
    r = await post('/input/editor/preview', { content: r.j.data.content, operation: { kind: 'upsert', section: 'PIPES', originalId: pn.name, values: pn.values, related: {}, outOfService: true, burialDepth: 1.5, vertices: [] } });
    check(r.j.data.links.find(l => l.name === pn.name).outOfService === true && r.j.data.outOfServiceCount === 1, 'editor preview: out of service');
    const geo = jn.geometry.coordinates;
    r = await post('/input/editor/preview', { content: r.j.data.content, operation: { kind: 'upsert', section: 'JUNCTIONS', values: ['NEWJ1', '10', '0'], related: { DEMANDS: '2.5' }, mapPosition: [geo[0] + 0.0001, geo[1]] } });
    check(r.st === 201 && r.j.data.nodes.some(n => n.name === 'NEWJ1' && n.related.DEMANDS === '2.5'), 'editor preview: add junction with demand');
    r = await post('/input/editor/preview', { content: r.j.data.content, operation: { kind: 'upsert', section: 'PIPES', values: ['NEWP1', jn.name, 'NEWJ1', '50', '200', '120', '0'], related: {}, vertices: [] } });
    check(r.st === 201 && r.j.data.links.some(l => l.name === 'NEWP1'), 'editor preview: add pipe');
    let bad = await post('/input/editor/preview', { content: r.j.data.content, operation: { kind: 'remove', section: 'JUNCTIONS', originalId: 'NEWJ1' } }); check(bad.st === 400, 'editor: connected node cannot be deleted');
    const content2 = r.j.data.content;
    bad = await post('/input/' + inputId + '/editor', { content: content2, revision: 'stale' }); check(bad.st === 409, 'editor save: stale revision -> 409');
    r = await post('/input/' + inputId + '/editor', { content: content2, revision: ed.revision }); check(r.st === 201 && r.j.data.nodes.some(n => n.name === 'NEWJ1'), 'editor save');
    d = (await get('/scenario/' + o.id + '/detail')).j.data; check(d.status === 0 && !d.output, 'saving cleared the results');
    r = await post('/run/inp', { scenarioId: o.id, force: true }); for (let i = 0; i < 600; i++) { await sleep(200); d = (await get('/scenario/' + o.id + '/detail')).j.data; if (d.status === 3 || d.status === 0) break; }
    check(d.status === 3, 'edited model runs ' + (d.error || ''));
    r = await post('/output/variable/flow/link/' + encodeURIComponent(pn.name), { id: o.id, periodIndex: 1 }); check(Math.abs(r.j.data[0].flow) < 1e-6, `out-of-service pipe carries no flow (${r.j.data[0].flow})`);
    r = await fetch(B + '/files/epanet/' + (await get('/input/' + inputId + '/detail')).j.data.path + '/' + path.basename(MODEL)); const txt = await r.text(); check(txt.startsWith(';@MODEL_EDIT ') && txt.includes('NEWP1'), 'model file download keeps the edit metadata');
    // second model, main switch, delete
    const fd2 = new FormData(); fd2.append('name', 'Second'); fd2.append('files', new Blob([fs.readFileSync(MODEL)]), 'second.inp');
    r = await (await fetch(B + '/upload/inp', { method: 'POST', body: fd2 })).json();
    r = await post('/input/create', { name: 'Second', file: r.data.file, path: r.data.path, main: false, scenario: { name: 's2', id: r.data.scenario } }); const in2 = r.j.data.id;
    check((await get('/input/all')).j.data.length === 2, 'two models');
    r = await post('/input/change', { input: { id: in2 } }); check(r.j.data.result, 'input/change');
    sc = (await get('/scenario/all')).j.data; check(sc.filter(s => s.category === 'LIVE').every(s => s.input.id === in2) && sc.filter(s => s.category === 'LIVE').length === 24, 'LIVE scenarios moved to the new main model');
    r = await get('/scenario/hour/0'); check(r.j.data.hour === 24 && r.j.data.input.id === in2, 'scenario/hour/0 -> hour 24 of the main model');
    r = await del('/input/' + in2 + '/remove'); check(r.j.data.result && (await get('/input/all')).j.data.length === 1, 'input remove');
    check((await get('/input/all')).j.data[0].main === true, 'remaining model is main again');
    r = await get('/health'); check(r.j.data.service === 'avaris-ds-api', 'health');
  } catch (e) { fails++; console.log('  FAIL exception ' + (e.stack || e)); }
  srv.kill(); await sleep(300); fs.rmSync(DATA, { recursive: true, force: true });
  if (/\[api\]/.test(log)) console.log('service log:\n' + log);
  console.log(fails ? `${fails} FAILED` : 'all passed', `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fails ? 1 : 0);
})();
