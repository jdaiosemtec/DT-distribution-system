'use strict';
// EPANET .inp handling for the Avaris DS service.
//  - parse(text): sections with their raw lines kept (so a saved model is the user's file with only the edited lines
//    changed), network objects (junctions, reservoirs, tanks, pipes, pumps, valves), coordinates, vertices, options,
//    times and the ;@MODEL_EDIT metadata header written by Model editing (outOfService, burialDepth, projection, suspended)
//  - build(doc): text back from the sections (metadata header first)
//  - the Model editing operations (upsert / remove of one element, raw text) used by /input/editor/preview

const crypto = require('crypto');
const Proj = require('../lib/proj');

const NODE_SECTIONS = ['JUNCTIONS', 'RESERVOIRS', 'TANKS'];
const LINK_SECTIONS = ['PIPES', 'PUMPS', 'VALVES'];
const TYPE_OF = { JUNCTIONS: 'JUNCTION', RESERVOIRS: 'RESERVOIR', TANKS: 'TANK', PIPES: 'PIPE', PUMPS: 'PUMP', VALVES: 'VALVE' };
// sections whose lines belong to one element (first token = element ID); shown in the editor as "related" text
const RELATED = {
  JUNCTIONS: ['DEMANDS', 'EMITTERS', 'QUALITY', 'SOURCES', 'TAGS'],
  RESERVOIRS: ['QUALITY', 'SOURCES', 'TAGS'],
  TANKS: ['QUALITY', 'SOURCES', 'MIXING', 'TAGS'],
  PIPES: ['REACTIONS', 'TAGS'],
  PUMPS: ['STATUS', 'TAGS'],
  VALVES: ['STATUS', 'TAGS'],
};
// canonical order when a section has to be added
const ORDER = ['TITLE', 'JUNCTIONS', 'RESERVOIRS', 'TANKS', 'PIPES', 'PUMPS', 'VALVES', 'TAGS', 'DEMANDS', 'STATUS', 'PATTERNS', 'CURVES',
  'CONTROLS', 'RULES', 'ENERGY', 'EMITTERS', 'QUALITY', 'SOURCES', 'REACTIONS', 'MIXING', 'TIMES', 'REPORT', 'OPTIONS', 'COORDINATES', 'VERTICES', 'LABELS', 'BACKDROP', 'END'];
const META = ';@MODEL_EDIT ';
// two-word [OPTIONS] keywords
const OPT2 = new Set(['SPECIFIC GRAVITY', 'DEMAND MULTIPLIER', 'EMITTER EXPONENT', 'DEMAND MODEL', 'MINIMUM PRESSURE', 'REQUIRED PRESSURE', 'PRESSURE EXPONENT', 'HEAD ERROR', 'FLOW CHANGE', 'BACKFLOW ALLOWED', 'DEMAND CHARGE']);

const tok = (line) => { const s = line.split(';')[0].trim(); return s ? s.split(/\s+/) : []; };
const U = (s) => String(s).toUpperCase();

// ------------------------------------------------------------------------------------------------ parse
function parse(text) {
  text = String(text).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const doc = { sections: new Map(), order: [], meta: { outOfService: [], burialDepth: {}, projection: '', suspended: [] }, warnings: [] };
  let metaText = '', cur = null;
  for (const raw of lines) {
    if (raw.startsWith(META)) { metaText += raw.slice(META.length); continue; }
    const m = /^\s*\[([^\]]+)\]/.exec(raw);
    if (m) { cur = U(m[1].trim()); if (!doc.sections.has(cur)) { doc.sections.set(cur, []); doc.order.push(cur); } continue; }
    if (cur === null) { if (raw.trim()) { cur = 'TITLE'; doc.sections.set(cur, []); doc.order.push(cur); } else continue; }
    doc.sections.get(cur).push(raw);
  }
  if (metaText) { try { Object.assign(doc.meta, JSON.parse(metaText)); } catch (e) { doc.warnings.push('Model editing metadata could not be read: ' + e.message); } }
  index(doc);
  return doc;
}

// objects and lookups from the section lines
function index(doc) {
  const sec = (n) => doc.sections.get(n) || [];
  doc.nodes = []; doc.links = []; doc.nodeByName = new Map(); doc.linkByName = new Map();
  for (const s of NODE_SECTIONS) for (const l of sec(s)) { const t = tok(l); if (!t.length) continue;
    const o = { section: s, type: TYPE_OF[s], name: t[0], values: t }; doc.nodes.push(o); doc.nodeByName.set(U(t[0]), o); }
  for (const s of LINK_SECTIONS) for (const l of sec(s)) { const t = tok(l); if (t.length < 3) continue;
    const o = { section: s, type: TYPE_OF[s], name: t[0], from: t[1], to: t[2], values: t, vertices: [] }; doc.links.push(o); doc.linkByName.set(U(t[0]), o); }
  for (const l of sec('COORDINATES')) { const t = tok(l); if (t.length < 3) continue; const n = doc.nodeByName.get(U(t[0])); if (n) n.xy = [+t[1], +t[2]]; }
  for (const l of sec('VERTICES')) { const t = tok(l); if (t.length < 3) continue; const k = doc.linkByName.get(U(t[0])); if (k) k.vertices.push([+t[1], +t[2]]); }
  doc.options = {}; for (const l of sec('OPTIONS')) { const t = tok(l); if (!t.length) continue; const two = t.length > 2 && OPT2.has(U(t[0]) + ' ' + U(t[1]));
    doc.options[two ? U(t[0]) + ' ' + U(t[1]) : U(t[0])] = t.slice(two ? 2 : 1).join(' '); }
  doc.times = {}; for (const l of sec('TIMES')) { const t = tok(l); if (!t.length) continue; let k = U(t[0]), v = t.slice(1);
    if (v.length && /^(TIMESTEP|START|STATISTIC)$/i.test(v[0]) && !/^STATISTIC$/i.test(k)) { k += ' ' + U(v[0]); v = v.slice(1); } doc.times[k] = v.join(' '); }
  const units = U((doc.options.UNITS || 'GPM').split(/\s+/)[0]);
  doc.units = units; doc.metric = ['LPS', 'LPM', 'MLD', 'CMH', 'CMD', 'CMS'].includes(units);
  doc.title = sec('TITLE').map(s => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ build
function metaLines(meta) {
  const j = JSON.stringify(meta); const out = []; for (let i = 0; i < j.length; i += 240) out.push(META + j.slice(i, i + 240)); return out;
}
function build(doc, withMeta = true) {
  const out = []; const m = doc.meta;
  if (withMeta && (m.outOfService.length || Object.keys(m.burialDepth).length || m.projection || (m.suspended || []).length)) { out.push(...metaLines(m), ''); }
  const order = [...doc.order]; if (!order.includes('END')) order.push('END');
  for (const s of order) { if (s === 'END') continue; out.push('[' + s + ']'); out.push(...(doc.sections.get(s) || [])); if (out[out.length - 1] !== '') out.push(''); }
  out.push('[END]', '');
  return out.join('\r\n');
}
const revision = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function section(doc, name) {
  if (!doc.sections.has(name)) {
    doc.sections.set(name, []);
    // keep the canonical order for new sections
    const at = doc.order.findIndex(s => ORDER.indexOf(s) > ORDER.indexOf(name));
    if (at < 0) { const e = doc.order.indexOf('END'); if (e >= 0) doc.order.splice(e, 0, name); else doc.order.push(name); } else doc.order.splice(at, 0, name);
  }
  return doc.sections.get(name);
}
const isDataLine = (l) => tok(l).length > 0;
function removeById(doc, name, id, firstTokenOnly = true) {
  const L = doc.sections.get(name); if (!L) return 0; const u = U(id); let n = 0;
  for (let i = L.length - 1; i >= 0; i--) { const t = tok(L[i]); if (t.length && U(t[0]) === u) { L.splice(i, 1); n++; } }
  return n;
}
const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : String(v); };

// ------------------------------------------------------------------------------------------------ projection
function projOf(doc, fallback) { try { const w = doc.meta.projection || fallback; return w ? Proj.parse(w) : null; } catch (e) { return null; } }
function toGeo(S, xy) { if (!xy) return null; if (!S) return [xy[0], xy[1]]; return Proj.toGeo(S, xy[0], xy[1]); }
function fromGeo(S, ll) { if (!S) return [ll[0], ll[1]]; return Proj.fromGeo(S, ll[0], ll[1]); }

// ------------------------------------------------------------------------------------------------ editor view
// the record set of GET /input/:id/editor and the preview answers
function editorView(doc, text, defaultProjection) {
  const S = projOf(doc, defaultProjection);
  const relOf = (o) => { const r = {}; for (const s of RELATED[o.section] || []) { const L = doc.sections.get(s) || []; const u = U(o.name);
    r[s] = L.filter(l => { const t = tok(l); return t.length && U(t[0]) === u; }).map(l => tok(l).slice(1).join(' ')).join('\n'); } return r; };
  const oos = new Set((doc.meta.outOfService || []).map(U));
  const nodes = doc.nodes.map(n => ({ section: n.section, name: n.name, values: n.values, related: relOf(n), coordinates: n.xy || null,
    geometry: n.xy ? { type: 'Point', coordinates: toGeo(S, n.xy) } : null, burialDepth: doc.meta.burialDepth[n.name] ?? null }));
  const links = doc.links.map(k => {
    const a = doc.nodeByName.get(U(k.from)), b = doc.nodeByName.get(U(k.to));
    const pts = a && a.xy && b && b.xy ? [a.xy, ...k.vertices, b.xy] : null;
    return { section: k.section, name: k.name, values: k.values, related: relOf(k), vertices: k.vertices, outOfService: oos.has(U(k.name)),
      burialDepth: doc.meta.burialDepth[k.name] ?? null, geometry: pts ? { type: 'LineString', coordinates: pts.map(p => toGeo(S, p)) } : null };
  });
  return { content: text, nodes, links, warnings: doc.warnings, projection: doc.meta.projection || defaultProjection || '', defaultProjection: defaultProjection || doc.meta.projection || '',
    units: doc.units, sections: [...doc.order.filter(s => s !== 'END'), 'END'], outOfServiceCount: oos.size, revision: revision(text) };
}

// ------------------------------------------------------------------------------------------------ editor operations
function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }

// { kind:'upsert', section, originalId?, values[], related{}, mapPosition?[lon,lat], vertices?[[x,y]], outOfService?, burialDepth? }
// { kind:'remove', section, originalId }
function applyOperation(doc, op, defaultProjection) {
  const secName = U(op.section || ''); if (!TYPE_OF[secName]) bad('Unknown section ' + op.section);
  const isNode = NODE_SECTIONS.includes(secName);
  if (op.kind === 'remove') {
    const id = op.originalId; if (!id) bad('No element to delete.');
    if (isNode) {
      const used = doc.links.filter(k => U(k.from) === U(id) || U(k.to) === U(id)); if (used.length) bad(`Node ${id} is still connected to ${used.map(k => k.name).slice(0, 5).join(', ')}${used.length > 5 ? ' …' : ''}. Remove those links first.`);
      removeById(doc, secName, id); removeById(doc, 'COORDINATES', id);
    } else { removeById(doc, secName, id); removeById(doc, 'VERTICES', id); doc.meta.outOfService = (doc.meta.outOfService || []).filter(x => U(x) !== U(id)); }
    for (const s of RELATED[secName]) removeById(doc, s, id);
    delete doc.meta.burialDepth[id];
    index(doc); return doc;
  }
  if (op.kind !== 'upsert') bad('Unknown operation ' + op.kind);
  const values = (op.values || []).map(v => String(v).trim()).filter((v, i, a) => i < a.length);
  const id = values[0]; if (!id) bad('Element ID is required.'); if (/\s|;/.test(id)) bad('Element ID cannot contain spaces or semicolons.');
  if (id.length > 31) bad('Element ID can be at most 31 characters.');
  const orig = op.originalId;
  const clash = (isNode ? doc.nodeByName : doc.linkByName).get(U(id));
  if (clash && (!orig || U(orig) !== U(id))) bad(`${id} already exists.`);
  if (!isNode) { if (values.length < 3) bad('A link needs a start node and an end node.');
    for (const n of [values[1], values[2]]) if (!doc.nodeByName.has(U(n))) bad(`Node ${n} does not exist.`); if (U(values[1]) === U(values[2])) bad('Start node and end node must differ.'); }
  const line = values.map(fmt).join(' ');
  const L = section(doc, secName);
  if (orig) { const u = U(orig); const i = L.findIndex(l => { const t = tok(l); return t.length && U(t[0]) === u; }); if (i < 0) bad(`${orig} was not found.`); L[i] = line;
    if (U(orig) !== U(id)) renameRefs(doc, orig, id, isNode); }
  else L.push(line);
  // related sections: replace the element's lines
  for (const [s, txt] of Object.entries(op.related || {})) {
    if (!(RELATED[secName] || []).includes(s)) continue; removeById(doc, s, id);
    const rows = String(txt || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean); if (rows.length) section(doc, s).push(...rows.map(r => id + ' ' + r));
  }
  if (isNode && op.mapPosition) { const S = projOf(doc, defaultProjection); const xy = fromGeo(S, op.mapPosition); removeById(doc, 'COORDINATES', id); section(doc, 'COORDINATES').push(`${id} ${fmt(xy[0])} ${fmt(xy[1])}`); }
  if (isNode && !orig && !op.mapPosition) bad('Choose a map position or enter longitude and latitude.');
  if (!isNode && Array.isArray(op.vertices)) { removeById(doc, 'VERTICES', id); if (op.vertices.length) section(doc, 'VERTICES').push(...op.vertices.map(p => `${id} ${fmt(p[0])} ${fmt(p[1])}`)); }
  if (!isNode && op.outOfService !== undefined) { const set = new Set((doc.meta.outOfService || []).map(U)); const arr = (doc.meta.outOfService || []).filter(x => U(x) !== U(id));
    if (op.outOfService) arr.push(id); doc.meta.outOfService = arr; void set; }
  if (op.burialDepth !== undefined) { const v = op.burialDepth === null || op.burialDepth === '' ? null : Number(op.burialDepth); if (v === null || !Number.isFinite(v)) delete doc.meta.burialDepth[id]; else doc.meta.burialDepth[id] = v; }
  index(doc); return doc;
}
function renameRefs(doc, from, to, isNode) {
  const u = U(from);
  for (const [s, L] of doc.sections) {
    if (['TITLE', 'OPTIONS', 'TIMES', 'REPORT', 'PATTERNS', 'CURVES', 'ENERGY', 'BACKDROP', 'LABELS'].includes(s)) continue;
    for (let i = 0; i < L.length; i++) {
      const t = tok(L[i]); if (!t.length) continue; let ch = false;
      if (U(t[0]) === u && (isNode ? [...NODE_SECTIONS, 'COORDINATES', 'DEMANDS', 'EMITTERS', 'QUALITY', 'SOURCES', 'MIXING', 'TAGS'] : [...LINK_SECTIONS, 'VERTICES', 'STATUS', 'REACTIONS', 'TAGS']).includes(s)) { t[0] = to; ch = true; }
      if (isNode && LINK_SECTIONS.includes(s)) for (const k of [1, 2]) if (t[k] && U(t[k]) === u) { t[k] = to; ch = true; }
      if (s === 'CONTROLS' || s === 'RULES') { const r = L[i].replace(new RegExp('(\\b(?:NODE|LINK|JUNCTION|RESERVOIR|TANK|PIPE|PUMP|VALVE)\\s+)' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'gi'), '$1' + to); if (r !== L[i]) { L[i] = r; continue; } }
      if (ch) L[i] = t.join(' ');
    }
  }
  if (!isNode) doc.meta.outOfService = (doc.meta.outOfService || []).map(x => (U(x) === u ? to : x));
  if (doc.meta.burialDepth[from] !== undefined) { doc.meta.burialDepth[to] = doc.meta.burialDepth[from]; delete doc.meta.burialDepth[from]; }
}

// ------------------------------------------------------------------------------------------------ engine input
// The text the engine runs: out-of-service links closed for the whole run ([STATUS] CLOSED and any control/rule on them
// removed), a scenario's options/times applied, extra edits (emitters, closed links) for the analyses.
function engineText(doc, edits = {}) {
  const d = parse(build(doc));             // work on a copy
  const closed = new Set([...(d.meta.outOfService || []), ...(edits.closeLinks || [])].map(U));
  if (closed.size) {
    for (const id of closed) removeById(d, 'STATUS', id);
    section(d, 'STATUS').push(...[...closed].map(id => (d.linkByName.get(id) || { name: id }).name + ' CLOSED'));
    const ctl = d.sections.get('CONTROLS'); if (ctl) for (let i = ctl.length - 1; i >= 0; i--) { const t = tok(ctl[i]); if (t.length > 1 && U(t[0]) === 'LINK' && closed.has(U(t[1]))) ctl.splice(i, 1); }
    // rules: drop whole rules whose actions touch a closed link
    const rl = d.sections.get('RULES'); if (rl) { const out = []; let cur = []; const flush = () => { if (cur.length && !cur.some(l => { const t = tok(l); return /^(THEN|ELSE|AND)$/i.test(t[0] || '') && /^(LINK|PIPE|PUMP|VALVE)$/i.test(t[1] || '') && closed.has(U(t[2] || '')); })) out.push(...cur); cur = []; };
      for (const l of rl) { if (/^\s*RULE\b/i.test(l)) flush(); cur.push(l); } flush(); d.sections.set('RULES', out); }
    // a closed pipe whose status column says CV keeps a check valve; others are fine
  }
  if (edits.emitters && edits.emitters.length) {
    for (const e of edits.emitters) removeById(d, 'EMITTERS', e.node);
    section(d, 'EMITTERS').push(...edits.emitters.map(e => `${e.node} ${fmt(e.coefficient)}`));
  }
  if (edits.extraDemands && edits.extraDemands.length) {
    for (const e of edits.extraDemands) section(d, 'DEMANDS').push(`${e.node} ${fmt(e.demand)}`);
  }
  if (edits.times) { const T = section(d, 'TIMES'); for (const [k, v] of Object.entries(edits.times)) { if (v === undefined || v === null || v === '') continue; const key = U(k);
    // EPANET matches keywords by their first letters (REPORTING TIMESTEP = REPORT TIMESTEP): compare 4-letter stems
    const stem = (a) => a.map(w => w.slice(0, 4)).join(' '); const ks = key.split(/\s+/);
    for (let i = T.length - 1; i >= 0; i--) { const t = tok(T[i]).map(U); const two = ks.length > 1; if (stem(t.slice(0, two ? 2 : 1)) === stem(ks) && (two || !/^(TIME|STAR)/.test(t[1] || ''))) T.splice(i, 1); }
    T.push(`${k} ${v}`); } }
  if (edits.options) { const O = section(d, 'OPTIONS'); for (const [k, v] of Object.entries(edits.options)) { if (v === undefined || v === null || v === '') continue; const key = U(k);
    for (let i = O.length - 1; i >= 0; i--) { const t = tok(O[i]).map(U).join(' '); if (t.startsWith(key + ' ') || t === key) O.splice(i, 1); } O.push(`${k} ${v}`); } }
  if (edits.quality) { const O = section(d, 'OPTIONS'); for (let i = O.length - 1; i >= 0; i--) if (/^\s*QUALITY\b/i.test(O[i])) O.splice(i, 1); O.push('Quality ' + edits.quality); }
  // report: summary only (the results are read from the binary file)
  d.sections.set('REPORT', ['Status No', 'Summary No', 'Page 0']); if (!d.order.includes('REPORT')) section(d, 'REPORT');
  return build(d, false);
}

module.exports = { parse, build, index, revision, editorView, applyOperation, engineText, projOf, toGeo, fromGeo, tok, NODE_SECTIONS, LINK_SECTIONS, TYPE_OF, RELATED };
