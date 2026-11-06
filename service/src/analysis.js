'use strict';
// Network analyses of the Supply Model pages (graph searches on the model, results from the scenario run).
//  closeValves     /analysis/close/valve          valves to close to isolate a pipe or junction
//                    MIN_RANGE: nearest valves around it (smallest shut-down area)
//                    MIN_COUNT: fewest valves that cut it from every source (minimum cut; valves cost 1, other links can not be cut)
//  qualityValves   /analysis/quality/close/valves valves around a set of nodes (contaminated area)
//  lowPressure     /analysis/low/pressure         supply path from a node back to its source along the flow
//  waterQuality    /analysis/water/quality        SOURCE: upstream pipes reaching the node within the duration
//                                                 DIFFUSION: downstream spread from the node within the duration

const U = (s) => String(s).toUpperCase();
const INF = 1e9;

function linkRec(net, l, extra) { const r = net.linkByName.get(U(l.name)); return Object.assign({}, r, extra || {}); }
function nodeRec(net, name, extra) { const r = net.nodeByName.get(U(name)); return r ? Object.assign({}, r, extra || {}) : null; }
const isValve = (l, invalid) => l.type === 'VALVE' && !invalid.has(U(l.name));

// ------------------------------------------------------------------------------------------------ valve isolation
function isolate(net, startNodes, startLinks, invalid, mode) {
  invalid = new Set((invalid || []).map(v => U(typeof v === 'string' ? v : v.name || v.code || '')));
  if (mode === 'MIN_COUNT') { const r = minCut(net, startNodes, startLinks, invalid); if (r) return r; }
  // MIN_RANGE: grow through every link that is not a closable valve
  const seenN = new Set(), seenL = new Set(), valves = new Map(), pipes = [];
  const q = [];
  for (const l of startLinks) { seenL.add(U(l.name)); pipes.push({ l, from: U(l.from), to: U(l.to) }); q.push(U(l.from), U(l.to)); }
  for (const n of startNodes) q.push(U(n));
  while (q.length) {
    const n = q.shift(); if (seenN.has(n)) continue; seenN.add(n);
    for (const e of net.adj.get(n) || []) {
      const k = U(e.link.name); if (seenL.has(k)) continue;
      if (isValve(e.link, invalid)) { if (!valves.has(k)) valves.set(k, { l: e.link, from: n, to: e.other }); continue; }
      seenL.add(k); pipes.push({ l: e.link, from: n, to: e.other }); q.push(e.other);
    }
  }
  return { valves: [...valves.values()], pipes, nodes: [...seenN] };
}

// minimum valve cut between the start element and all sources (Edmonds-Karp on a node graph, link = edge both ways)
function minCut(net, startNodes, startLinks, invalid) {
  const names = [...net.adj.keys()], idx = new Map(names.map((n, i) => [n, i]));
  const S = names.length, T = S + 1, N = S + 2;
  const head = new Int32Array(N).fill(-1), to = [], cap = [], nxt = [], edgeLink = [];
  const add = (a, b, c, l) => { to.push(b); cap.push(c); nxt.push(head[a]); edgeLink.push(l); head[a] = to.length - 1; to.push(a); cap.push(0); nxt.push(head[b]); edgeLink.push(l); head[b] = to.length - 1; };
  const startSet = new Set(); for (const l of startLinks) { startSet.add(U(l.from)); startSet.add(U(l.to)); } for (const n of startNodes) startSet.add(U(n));
  const startLinkSet = new Set(startLinks.map(l => U(l.name)));
  for (const l of net.doc.links) {
    if (startLinkSet.has(U(l.name))) continue; const a = idx.get(U(l.from)), b = idx.get(U(l.to)); if (a === undefined || b === undefined) continue;
    const c = isValve(l, invalid) ? 1 : INF; add(a, b, c, l); add(b, a, c, l);
  }
  let hasSource = false;
  for (const s of startSet) if (idx.has(s)) add(S, idx.get(s), INF, null);
  for (const n of net.sources()) { const i = idx.get(U(n.name)); if (i === undefined) continue; if (startSet.has(U(n.name))) return null; add(i, T, INF, null); hasSource = true; }
  if (!hasSource) return null;
  let flow = 0; const prev = new Int32Array(N);
  for (;;) {
    prev.fill(-1); prev[S] = -2; const q = [S];
    while (q.length && prev[T] === -1) { const u = q.shift(); for (let e = head[u]; e !== -1; e = nxt[e]) if (cap[e] > 0 && prev[to[e]] === -1) { prev[to[e]] = e; q.push(to[e]); } }
    if (prev[T] === -1) break;
    let f = INF; for (let v = T; v !== S; v = to[prev[v] ^ 1]) f = Math.min(f, cap[prev[v]]);
    if (f >= INF) return null;                       // a source is reachable without any valve
    for (let v = T; v !== S; v = to[prev[v] ^ 1]) { cap[prev[v]] -= f; cap[prev[v] ^ 1] += f; }
    flow += f; if (flow > 500) return null;
  }
  // nodes reachable from S in the residual graph = isolated area; saturated valve edges leaving it = valves to close
  const reach = new Uint8Array(N); const q = [S]; reach[S] = 1;
  while (q.length) { const u = q.shift(); for (let e = head[u]; e !== -1; e = nxt[e]) if (cap[e] > 0 && !reach[to[e]]) { reach[to[e]] = 1; q.push(to[e]); } }
  const valves = new Map(), pipes = [], seenL = new Set(), nodes = [];
  for (const l of startLinks) { seenL.add(U(l.name)); pipes.push({ l, from: U(l.from), to: U(l.to) }); }
  for (let i = 0; i < S; i++) if (reach[i]) nodes.push(names[i]);
  for (let i = 0; i < S; i++) {
    if (!reach[i]) continue;
    for (const e of net.adj.get(names[i]) || []) {
      const k = U(e.link.name); if (seenL.has(k)) continue; const j = idx.get(e.other);
      if (reach[j]) { seenL.add(k); pipes.push({ l: e.link, from: names[i], to: e.other }); }
      else if (isValve(e.link, invalid)) { if (!valves.has(k)) valves.set(k, { l: e.link, from: names[i], to: e.other }); }
    }
  }
  return { valves: [...valves.values()], pipes, nodes };
}

function closeValves(net, body) {
  const code = body.code, type = U(body.type || 'PIPE');
  let startLinks = [], startNodes = [];
  if (type === 'JUNCTION' || type === 'NODE') { if (!net.doc.nodeByName.has(U(code))) throw bad(`Junction ${code} was not found.`); startNodes = [code]; }
  else { const l = net.doc.linkByName.get(U(code)); if (!l) throw bad(`Pipe ${code} was not found.`); startLinks = [l]; }
  const r = isolate(net, startNodes, startLinks, body.invalid_valves, U(body.close_type || 'MIN_RANGE'));
  // in_node: the side towards the isolated area, out_node: the other side (DEMO field names)
  return {
    valves: r.valves.map(v => linkRec(net, v.l, { in_node: v.from === U(v.l.from) ? v.l.from : v.l.to, out_node: v.from === U(v.l.from) ? v.l.to : v.l.from })),
    pipes: r.pipes.map(p => linkRec(net, p.l, { in_node: p.from === U(p.l.from) ? p.l.from : p.l.to, out_node: p.from === U(p.l.from) ? p.l.to : p.l.from })),
    users: [],
  };
}

function qualityValves(net, body) {
  const nodes = (body.node_codes || []).filter(n => net.doc.nodeByName.has(U(n)));
  if (!nodes.length) return { valves: [], pipes: [], users: [] };
  // the contaminated nodes are one area: start from all of them
  const r = isolate(net, nodes, [], body.invalid_valves, 'MIN_RANGE');
  return {
    valves: r.valves.map(v => linkRec(net, v.l, { in_node: v.from === U(v.l.from) ? v.l.from : v.l.to, out_node: v.from === U(v.l.from) ? v.l.to : v.l.from })),
    pipes: r.pipes.map(p => linkRec(net, p.l, { in_node: p.from === U(p.l.from) ? p.l.from : p.l.to, out_node: p.from === U(p.l.from) ? p.l.to : p.l.from })),
    users: [],
  };
}

// ------------------------------------------------------------------------------------------------ flow-based searches
// values of the run at one period, by object name
function snapshot(out, period) {
  const g = (k, v) => out.values(k, v, period);
  return { flow: g('link', 'flow'), vel: g('link', 'velocity'), hl: g('link', 'headloss'), head: g('node', 'head'), pres: g('node', 'pressure'),
    li: (name) => out.linkIndex.get(U(name)), ni: (name) => out.nodeIndex.get(U(name)) };
}
function nodeLinks(net, name) {
  const ins = [], outs = [];
  for (const e of net.adj.get(U(name)) || []) (e.dir === 1 ? outs : ins).push(e.link.name);   // by link direction (from -> to)
  return { in_links: ins, out_links: outs };
}
function slope(l, hl) { const L = Number(l.values[3]); return l.type === 'PIPE' && L > 0 ? Math.abs(hl) / 1000 : 0; }   // unit headloss -> m/m (ft/ft)

function lowPressure(net, out, body, period = 0) {
  const name = body.low_pressure; if (!net.doc.nodeByName.has(U(name))) throw bad(`Node ${name} was not found.`);
  const s = snapshot(out, period), isSource = new Set(net.sources().map(n => U(n.name)));
  const nodes = [], pipes = [], seen = new Set();
  let cur = U(name), plant = null;
  for (let step = 0; step < 100000; step++) {
    seen.add(cur);
    const nn = net.doc.nodeByName.get(cur); const i = s.ni(nn.name);
    nodes.push(nodeRec(net, nn.name, Object.assign(nodeLinks(net, nn.name), { head: s.head[i], pressure: s.pres[i] })));
    if (isSource.has(cur)) { plant = nodes.pop(); break; }
    // the link bringing the most water into this node
    let best = null, bq = 0;
    for (const e of net.adj.get(cur) || []) { const li = s.li(e.link.name); const q = s.flow[li] * e.dir;   // q < 0: flows towards cur
      if (-q > bq && !seen.has(e.other)) { bq = -q; best = e; } }
    if (!best) break;
    const li = s.li(best.link.name);
    pipes.push(linkRec(net, best.link, { in_node: best.other === U(best.link.from) ? best.link.from : best.link.to, out_node: nn.name,
      flow: s.flow[li], velocity: s.vel[li], hydraulicslope: slope(best.link, s.hl[li]) }));
    cur = best.other;
  }
  return { plant, pipes, nodes };
}

function waterQuality(net, out, body, period = 0) {
  const name = body.quality_node; if (!net.doc.nodeByName.has(U(name))) throw bad(`Node ${name} was not found.`);
  const limit = Math.max(0, Number(body.duration) || 24) * 3600, upstream = U(body.method || 'SOURCE') !== 'DIFFUSION';
  const s = snapshot(out, period);
  // Dijkstra on travel time along the flow (upstream: against it)
  const time = new Map([[U(name), 0]]), done = new Set(), pipes = [], seenL = new Set();
  const heap = [[0, U(name)]];
  const pop = () => { let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i; return heap.splice(bi, 1)[0]; };
  while (heap.length) {
    const [t, n] = pop(); if (done.has(n)) continue; done.add(n);
    for (const e of net.adj.get(n) || []) {
      const li = s.li(e.link.name); const q = s.flow[li] * e.dir;        // > 0: flows away from n
      if (upstream ? !(q < -1e-9) : !(q > 1e-9)) continue;
      const v = Math.abs(s.vel[li]); const L = e.link.type === 'PIPE' ? Number(e.link.values[3]) || 0 : 0;
      const dt = L > 0 ? (v > 1e-9 ? L / v : Infinity) : 0;
      const nt = t + dt; if (nt > limit) continue;
      const k = U(e.link.name); if (!seenL.has(k)) { seenL.add(k); pipes.push(linkRec(net, e.link, { in_node: upstream ? e.other : n, out_node: upstream ? n : e.other, flow: s.flow[li], velocity: s.vel[li], time: nt })); }
      if (nt < (time.get(e.other) ?? Infinity)) { time.set(e.other, nt); heap.push([nt, e.other]); }
    }
  }
  const nodes = [...done].filter(n => n !== U(name)).map(n => nodeRec(net, net.doc.nodeByName.get(n).name, Object.assign(nodeLinks(net, n), { time: time.get(n) })));
  return { pipes, nodes };
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
module.exports = { closeValves, qualityValves, lowPressure, waterQuality };
