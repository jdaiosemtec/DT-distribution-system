'use strict';
// Reader for the EPANET 2.x binary output file (.out), layout of OWA EPANET 2.3 src/output.c:
//   prolog  15 x INT4, 3 titles (80), inp + rpt file names (260 each), chem name + units (32 each),
//           node IDs (32), link IDs (32), link N1, N2, type (INT4), tank node idx (INT4), tank area (REAL4),
//           node elevation, link length, link diameter (REAL4)
//   energy  per pump: INT4 index + 6 REAL4, then 1 REAL4 (peak demand charge)
//   results per reporting period: 4 node variables x Nnodes, 8 link variables x Nlinks (REAL4)
//   epilog  4 REAL4 (average reaction rates), INT4 periods, INT4 warning flag, INT4 magic number
// Values are in the units of the .inp (the engine writes them converted), so they need no conversion here.

const fs = require('fs');

const MAGIC = 516114521, IDLEN = 32;
const NODE_VARS = ['demand', 'head', 'pressure', 'quality'];
const LINK_VARS = ['flow', 'velocity', 'headloss', 'avg_quality', 'status', 'setting', 'reaction_rate', 'friction'];

class EpaOut {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(this.fd).size;
    const head = Buffer.alloc(60); fs.readSync(this.fd, head, 0, 60, 0);
    const I = (i) => head.readInt32LE(i * 4);
    if (I(0) !== MAGIC) throw new Error('not an EPANET output file: ' + file);
    this.nNodes = I(2); this.nTanks = I(3); this.nLinks = I(4); this.nPumps = I(5); this.nValves = I(6);
    this.qualFlag = I(7); this.traceNode = I(8); this.flowUnits = I(9); this.pressUnits = I(10);
    this.reportStart = I(12); this.reportStep = I(13); this.duration = I(14);
    const tail = Buffer.alloc(12); fs.readSync(this.fd, tail, 0, 12, size - 12);
    this.periods = tail.readInt32LE(0); this.warning = tail.readInt32LE(4);
    if (tail.readInt32LE(8) !== MAGIC) throw new Error('EPANET output file is incomplete (run did not finish): ' + file);
    // prolog
    let off = 60 + 3 * 80 + 2 * 260 + 2 * IDLEN;
    const readIds = (n) => { const b = Buffer.alloc(n * IDLEN); fs.readSync(this.fd, b, 0, b.length, off); off += b.length; const out = new Array(n);
      for (let i = 0; i < n; i++) { const s = b.subarray(i * IDLEN, (i + 1) * IDLEN); const z = s.indexOf(0); out[i] = s.toString('latin1', 0, z < 0 ? IDLEN : z); } return out; };
    const readI = (n) => { const b = Buffer.alloc(n * 4); fs.readSync(this.fd, b, 0, b.length, off); off += b.length; return new Int32Array(b.buffer, b.byteOffset, n).slice(); };
    const readF = (n) => { const b = Buffer.alloc(n * 4); fs.readSync(this.fd, b, 0, b.length, off); off += b.length; return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
    this.nodeIds = readIds(this.nNodes); this.linkIds = readIds(this.nLinks);
    this.linkN1 = readI(this.nLinks); this.linkN2 = readI(this.nLinks); this.linkType = readI(this.nLinks);
    this.tankNode = readI(this.nTanks); this.tankArea = readF(this.nTanks);
    this.elevation = readF(this.nNodes); this.length = readF(this.nLinks); this.diameter = readF(this.nLinks);
    off += this.nPumps * 28 + 4;                                 // energy section
    this.resultsOffset = off;
    this.periodBytes = (4 * this.nNodes + 8 * this.nLinks) * 4;
    this.nodeIndex = new Map(this.nodeIds.map((id, i) => [id.toUpperCase(), i]));
    this.linkIndex = new Map(this.linkIds.map((id, i) => [id.toUpperCase(), i]));
    this._cache = new Map();
  }
  close() { if (this.fd != null) { fs.closeSync(this.fd); this.fd = null; } }
  periodTime(p) { return this.reportStart + p * this.reportStep; }        // seconds
  // all values of one variable for one period: Float32Array (nNodes or nLinks)
  values(kind, v, period) {
    const vi = (kind === 'node' ? NODE_VARS : LINK_VARS).indexOf(v); if (vi < 0) throw new Error('unknown ' + kind + ' variable ' + v);
    period = Math.max(0, Math.min(this.periods - 1, period | 0));
    const key = kind + vi + ':' + period; const c = this._cache.get(key); if (c) return c;
    const n = kind === 'node' ? this.nNodes : this.nLinks;
    const pos = this.resultsOffset + period * this.periodBytes + (kind === 'node' ? vi * this.nNodes : 4 * this.nNodes + vi * this.nLinks) * 4;
    const b = Buffer.alloc(n * 4); fs.readSync(this.fd, b, 0, b.length, pos);
    const a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    if (this._cache.size > 256) this._cache.clear(); this._cache.set(key, a); return a;
  }
  // time series of one object (index) for one variable
  series(kind, v, index) {
    const vi = (kind === 'node' ? NODE_VARS : LINK_VARS).indexOf(v); if (vi < 0) throw new Error('unknown ' + kind + ' variable ' + v);
    const base = this.resultsOffset + (kind === 'node' ? vi * this.nNodes : 4 * this.nNodes + vi * this.nLinks) * 4 + index * 4;
    const out = new Array(this.periods), b = Buffer.alloc(4);
    for (let p = 0; p < this.periods; p++) { fs.readSync(this.fd, b, 0, 4, base + p * this.periodBytes); out[p] = b.readFloatLE(0); }
    return out;
  }
  // max of |value| over all objects and periods (legends)
  maxAbs(kind, v) { let m = 0; for (let p = 0; p < this.periods; p++) { const a = this.values(kind, v, p); for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (x > m && Number.isFinite(x)) m = x; } } return m; }
}

module.exports = { EpaOut, NODE_VARS, LINK_VARS };
