'use strict';
// Results of the DEMO model 526 compared with what the DEMO back end answered (captured 2026-11-05, scenario19, period 8).
// Differences that are known and accepted: pressure is (head - elevation) in EPANET 2.3; the DEMO multiplied it by the
// specific gravity (0.998), so DEMO pressures are 0.2 % lower. The DEMO's low-pressure path left the flow at a stagnant
// pipe (GD000385); here it follows the largest inflow.   node test/demo526.js
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const INP = require('../src/model/inp'), E = require('../src/engine'), N = require('../src/model/network'), A = require('../src/analysis');
const { EpaOut } = require('../src/results/epaout');
const MODEL = path.join(ROOT, '..', 'models', 'demo526', '526.inp');
const ENGINE = path.join(ROOT, 'bin', process.platform === 'win32' ? 'win' : 'linux', 'avaris_ds_engine' + (process.platform === 'win32' ? '.exe' : ''));
let fails = 0; const check = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo526-'));
const doc = INP.parse(fs.readFileSync(MODEL, 'utf8')); const e = E.scenarioEdits(E.scenarioFromDoc(doc));
fs.writeFileSync(path.join(dir, 'run.inp'), INP.engineText(doc, { options: e.options, times: e.times }));
execFileSync(ENGINE, ['run.inp', 'run.rpt', 'run.out'], { cwd: dir });
const o = new EpaOut(path.join(dir, 'run.out'));
check(o.periods === 193 && o.reportStep === 900, `193 periods of 15 min (${o.periods}, ${o.reportStep} s)`);
const L = (n, v) => o.values('link', v, 8)[o.linkIndex.get(n)], Nd = (n, v) => o.values('node', v, 8)[o.nodeIndex.get(n)];
const ref = { flow: { 'GD000517-GD000491': 29.5993, 'GD00050-GD000271': -30.16658, 'R-1-GD0002': 216.92195, 'PMP-1': 108.40333, 'FM00011': 108.51864 },
  velocity: { 'GD000517-GD000491': 0.418742, 'GD00050-GD000271': 0.426767, 'R-1-GD0002': 0.7672 },
  headloss: { 'GD000517-GD000491': 0.673939, 'GD00050-GD000271': 0.698236, 'R-1-GD0002': 0.921414, 'PMP-1': -50.17341 },
  friction: { 'GD000517-GD000491': 0.0226333, 'R-1-GD0002': 0.0184369 } };
for (const [v, m] of Object.entries(ref)) for (const [n, x] of Object.entries(m)) check(near(L(n, v), x, 0.002), `${v} ${n}: ${L(n, v).toFixed(5)} (DEMO ${x})`);
for (const [n, x] of Object.entries({ GD000461: 129.69992, GD00050: 128.29436, '1420-B': 130.06789, 'R-1': 79.94597 })) check(near(Nd(n, 'head'), x, 1e-4), `head ${n}: ${Nd(n, 'head').toFixed(4)} (DEMO ${x})`);
for (const [n, x] of Object.entries({ GD000461: 0.0409046, GD00050: 0.2905226, 'R-1': -216.92195 })) check(near(Nd(n, 'demand'), x, 1e-3), `demand ${n}: ${Nd(n, 'demand').toFixed(5)} (DEMO ${x})`);
for (const [n, x] of Object.entries({ GD000461: 60.49664, GD00050: 44.51675 })) check(near(Nd(n, 'pressure') * 0.998, x, 1e-4), `pressure ${n} x SG: ${(Nd(n, 'pressure') * 0.998).toFixed(4)} (DEMO ${x})`);
// slope as the DEMO computes it: unit headloss / length
const lk = (n) => doc.linkByName.get(n.toUpperCase());
for (const [n, x] of Object.entries({ 'GD000517-GD000491': 0.01930754, 'GD00050-GD000271': 0.0058011, 'R-1-GD0002': 0.08562249 })) { const s = L(n, 'headloss') / Number(lk(n).values[3]); check(near(s, x, 0.002), `hydraulicSlope ${n}: ${s.toFixed(6)} (DEMO ${x})`); }
// analyses
const fdir = path.join(dir, 'files', 'epanet', 'p'); fs.mkdirSync(fdir, { recursive: true }); fs.copyFileSync(MODEL, path.join(fdir, '526.inp')); N.init(dir, '');
const net = N.get({ id: 'x', path: 'p', file: '526.inp', updatedAt: 'a' });
const cv = A.closeValves(net, { code: 'FM0001332-GD00052', type: 'PIPE', close_type: 'MIN_RANGE', invalid_valves: [] }, o);
const f = (x) => x.name + '|' + x.in_node + '>' + x.out_node;
check(JSON.stringify(cv.valves.map(f).sort()) === JSON.stringify(['FM0001204|2040-A>2040-B', 'TCV-357|2570-A>2570-B', 'FM0001332|2424-A>2424-B'].sort()), 'close/valve: same 3 valves as DEMO, same orientation');
const demoPipes = ['GD00052-GD00064|GD00064>GD00052', 'GD00085-GD00064|GD00085>GD00064', 'FM0001204-GD00085|2040-B>GD00085', 'FM0001204|2040-A>2040-B', 'FM0001205-GD000103|GD00085>GD000103', 'GD000103-GD00048|GD000103>GD00048', 'GD00048-GD0008|GD00048>GD0008', 'GD00059-GD0008(2)|GD0008>2570-B', 'TCV-357|2570-A>2570-B', 'FM0001332-GD00052|GD00052>2424-B', 'FM0001332|2424-A>2424-B'];
check(JSON.stringify(cv.pipes.map(f).sort()) === JSON.stringify(demoPipes.sort()), 'close/valve: same 11 pipes as DEMO, same orientation');
const lp = A.lowPressure(net, o, { low_pressure: 'GD00050' });
check(lp.plant && lp.plant.name === 'R-1' && near(lp.plant.head, 79.96736, 1e-4), `low/pressure reaches R-1 (head ${lp.plant && lp.plant.head.toFixed(4)}, DEMO 79.9674)`);
check(JSON.stringify(lp.nodes[0].in_links) === '["GD00050-GD000271"]' && JSON.stringify(lp.nodes[0].out_links) === '["GD000114-GD00050"]', 'low/pressure: in/out links as DEMO');
check(lp.pipes[0].name === 'GD00050-GD000271' && near(lp.pipes[0].hydraulicslope, 0.005812662, 0.002), 'low/pressure: first pipe and slope as DEMO');
const wq = A.waterQuality(net, o, { quality_node: 'GD00050', duration: 6, method: 'SOURCE' });
check(wq.pipes[0].name === 'GD00050-GD000271' && Math.abs(wq.pipes[0].time - 281.74) < 0.5, `water/quality: first pipe ${wq.pipes[0].name} at ${wq.pipes[0].time.toFixed(1)} s (DEMO 281.7)`);
check(Math.abs(wq.pipes.length - 318) <= 15, `water/quality: ${wq.pipes.length} pipes (DEMO 318)`);
o.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
