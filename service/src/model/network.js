'use strict';
// Model store: one uploaded EPANET model (input) -> its .inp file, parsed document, object records with stable ids
// (the shapes the DEMO returned for /node/input/:id and /link/input/:id) and a graph for the analyses.
// Files: DATA/files/<path>/<file>.inp (the model as saved), DATA/files/<path>/ids.json (name -> id, kept across saves).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const INP = require('./inp');

let DATA = null, DEFAULT_PRJ = '';
const cache = new Map();                 // inputId -> Network
function init(dataDir, defaultPrj) { DATA = dataDir; DEFAULT_PRJ = defaultPrj || ''; fs.mkdirSync(path.join(DATA, 'files', 'epanet'), { recursive: true }); }
const filesDir = (p) => path.join(DATA, 'files', 'epanet', p);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const U = (s) => String(s).toUpperCase();

class Network {
  constructor(input) {
    this.input = input;
    this.file = path.join(filesDir(input.path), input.file);
    this.text = fs.readFileSync(this.file, 'utf8');
    this.doc = INP.parse(this.text);
    this.S = INP.projOf(this.doc, DEFAULT_PRJ);
    this._ids();
    this._records();
    this._graph();
  }
  _ids() {
    const f = path.join(filesDir(this.input.path), 'ids.json');
    let ids = {}; try { ids = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    let changed = false; const get = (k) => { if (!ids[k]) { ids[k] = crypto.randomUUID(); changed = true; } return ids[k]; };
    for (const n of this.doc.nodes) n.id = get('N:' + U(n.name));
    for (const l of this.doc.links) l.id = get('L:' + U(l.name));
    if (changed) fs.writeFileSync(f, JSON.stringify(ids));
  }
  _records() {
    const d = this.doc, S = this.S, inp = inputRef(this.input), t = this.input.updatedAt || this.input.createdAt;
    const geo = (xy) => (xy ? INP.toGeo(S, xy) : null);
    const r9 = (v) => Math.round(v * 1e9) / 1e9;
    // base demand of a junction: the [DEMANDS] lines replace the junction column when present (EPANET rule)
    const dem = new Map(); for (const l of d.sections.get('DEMANDS') || []) { const t2 = INP.tok(l); if (t2.length > 1) { const k = U(t2[0]); dem.set(k, (dem.get(k) || 0) + (num(t2[1]) || 0)); } }
    this.nodes = d.nodes.map(n => {
      const v = n.values, g = geo(n.xy);
      const rec = { id: n.id, createdAt: t, updatedAt: t, name: n.name, type: n.type, input: inp,
        geometry: g ? { type: 'Point', coordinates: [r9(g[0]), r9(g[1])] } : null, junction: null, reservoir: null, tank: null, output: null };
      if (n.type === 'JUNCTION') rec.junction = { demand: dem.has(U(n.name)) ? dem.get(U(n.name)) : (num(v[2]) ?? 0), elev: num(v[1]) ?? 0, pattern: v[3] || '' };
      else if (n.type === 'RESERVOIR') rec.reservoir = { head: num(v[1]) ?? 0, pattern: v[2] || '' };
      else rec.tank = { elev: num(v[1]) ?? 0, init_level: num(v[2]) ?? 0, min_level: num(v[3]) ?? 0, max_level: num(v[4]) ?? 0, diameter: num(v[5]) ?? 0, min_vol: num(v[6]) ?? 0, vol_curve: v[7] && v[7] !== '*' ? v[7] : '', overflow: v[8] || '' };
      return rec;
    });
    const nodeXY = new Map(d.nodes.map(n => [U(n.name), n.xy]));
    this.links = d.links.map(l => {
      const v = l.values, a = nodeXY.get(U(l.from)), b = nodeXY.get(U(l.to));
      const pts = a && b ? [a, ...l.vertices, b].map(p => { const g = geo(p); return [r9(g[0]), r9(g[1])]; }) : null;
      const rec = { id: l.id, createdAt: t, updatedAt: t, name: l.name, type: l.type, input: inp,
        geometry: pts ? { type: 'LineString', coordinates: pts } : null, pipe: null, pump: null, valve: null, output: null };
      if (l.type === 'PIPE') rec.pipe = { diameter: num(v[4]) ?? 0, end_node: l.to, length: num(v[3]) ?? 0, loss: num(v[6]) ?? 0, roughness: num(v[5]) ?? 0, start_node: l.from, status: v[7] || '' };
      else if (l.type === 'PUMP') { const p = { start_node: l.from, end_node: l.to }; for (let i = 3; i < v.length - 1; i += 2) p[v[i].toLowerCase()] = v[i + 1]; rec.pump = p; }
      else rec.valve = { start_node: l.from, end_node: l.to, diameter: num(v[3]) ?? 0, type: v[4] || '', setting: v[5] ?? '', loss: num(v[6]) ?? 0 };
      return rec;
    });
    this.nodeByName = new Map(this.nodes.map(n => [U(n.name), n]));
    this.linkByName = new Map(this.links.map(l => [U(l.name), l]));
    this.byId = new Map([...this.nodes.map(n => [n.id, n]), ...this.links.map(l => [l.id, l])]);
  }
  _graph() {
    // adjacency: node name -> [{ link, other }]
    this.adj = new Map(this.nodes.map(n => [U(n.name), []]));
    for (const l of this.doc.links) {
      const a = U(l.from), b = U(l.to); if (!this.adj.has(a) || !this.adj.has(b)) continue;
      this.adj.get(a).push({ link: l, other: b, dir: 1 }); this.adj.get(b).push({ link: l, other: a, dir: -1 });
    }
  }
  sources() { return this.nodes.filter(n => n.type === 'RESERVOIR' || n.type === 'TANK'); }
}

function inputRef(i) { return { id: i.id, createdAt: i.createdAt, updatedAt: i.updatedAt, name: i.name, path: i.path, file: i.file, main: !!i.main }; }
function get(input) {
  if (!input) return null;
  const c = cache.get(input.id);
  if (c && c.input.updatedAt === input.updatedAt && c.input.main === input.main && c.input.name === input.name) return c;
  const n = new Network(input); cache.set(input.id, n); return n;
}
function forget(inputId) { cache.delete(inputId); }

module.exports = { init, get, forget, filesDir, inputRef, Network };
