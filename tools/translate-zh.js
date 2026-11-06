'use strict';
// Makes the built front end free of Chinese text (only server file paths keep their names).
//  1. UI texts: whole string literals found in frontend/i18n/zh-en.json are replaced with English ("...", '...', `...`
//     or a template segment), so a short word never changes inside a longer text or in code. One pass per file.
//  2. comments inside embedded shader / code strings: Chinese words are removed.
//  3. whatever is left is library data that must keep its value to work (spreadsheet number formats, the Unicode
//     ranges of a sheet-name check, map region keys, GIS type keys, font names): written as \uXXXX escapes, same value.
// This file is ASCII only; Chinese in the table is read from the JSON file.
const fs = require('fs'), path = require('path');
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'i18n', 'zh-en.json'), 'utf8'));
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const CJK_G = new RegExp(CJK.source, 'g');
const esc4 = (c, up) => { const h = c.charCodeAt(0).toString(16).padStart(4, '0'); return '\\u' + (up ? h.toUpperCase() : h); };
const uesc = (s, up) => s.replace(/[^\x00-\x7f]/g, c => esc4(c, up));
function enc(s, q) {
  let o = s.replace(/\\/g, '\\\\').replace(/\n/g, q === '`' ? '\n' : '\\n').replace(/\r/g, '\\r').replace(/\t/g, q === '`' ? '\t' : '\\t');
  return q === '`' ? o.replace(/`/g, '\\`') : o.split(q).join('\\' + q);
}
const QUOTES = [['"', '"', '"'], ["'", "'", "'"], ['`', '`', '`'], ['`', '${', '`'], ['}', '${', '`'], ['}', '`', '`']];
// every source form of every entry -> its English form
const FORMS = new Map(), GROUPS = [];               // GROUPS: [probe strings, forms] per entry (quick test first)
const addGroup = (probes, forms) => { GROUPS.push([probes, forms]); for (const [f, e] of forms) FORMS.set(f, e); };
for (const [k, v] of Object.entries(MAP)) {
  if (k === v || !CJK.test(k) || k.length >= 400) continue;
  const forms = [];
  for (const [q1, q2, qe] of QUOTES) { const to = q1 + enc(v, qe) + q2; for (const b of new Set([enc(k, qe), uesc(enc(k, qe), true), uesc(enc(k, qe), false)])) forms.push([q1 + b + q2, { to, k, q1, b, q2 }]); }
  const c = k.match(CJK)[0], i = k.indexOf(c); const head = k.slice(i, i + 2);
  addGroup([head, uesc(head, true), uesc(head, false)], forms);
}
// texts inside a longer literal (HTML) or with escapes the table cannot express
const RAW = [['placeholder="\u9a8c\u8bc1\u7801"', 'placeholder="Captcha"'], ['\u65cb\u8f6c\u89d2\u5ea6(\\xB0)', 'Rotation (\\xB0)'],
  ['"#\u6cf5\u7ad9\u542f\u505c\u72b6\u6001"', '"#pump-station-status"'], ['"#Pump Station On/Off Status"', '"#pump-station-status"'], ['getElementById("\u706f")', 'getElementById("lamp")']];
for (const [a, b] of RAW) { const fs_ = [...new Set([a, uesc(a, true), uesc(a, false)])]; addGroup(fs_, fs_.map(f => [f, { to: b, k: a, q1: '', b: f, q2: '' }])); }
const PATH_KEEP = /\/(?:files|temp)\/[^"'`]*\.xlsx/;      // server file paths keep their names

function translate(src, used) {
  let n = 0;
  // which two-character heads occur (raw or escaped), found in one scan instead of a search per entry
  const heads = new Set(); let m; const rh = new RegExp(CJK.source + '[\\s\\S]?', 'g'); while ((m = rh.exec(src))) { heads.add(m[0]); heads.add(m[0][0]); rh.lastIndex = m.index + 1; }
  const eh = /\\u[0-9a-fA-F]{4}(?:\\u[0-9a-fA-F]{4}|[^\\])/g; while ((m = eh.exec(src))) { heads.add(m[0]); heads.add(m[0].slice(0, 6)); eh.lastIndex = m.index + 6; }
  // occurrences: each distinct body is searched once (indexOf), then the quotes around it are checked
  const cand = [];                                 // [start, end, entry]
  for (const [probes, forms] of GROUPS) {
    if (!probes.some(p => heads.has(p) || (p.length > 12 && src.includes(p)))) continue;
    const byBody = new Map(); for (const [, e] of forms) { let a = byBody.get(e.b); if (!a) byBody.set(e.b, a = []); a.push(e); }
    for (const [b, es] of byBody) for (let i = src.indexOf(b); i >= 0; i = src.indexOf(b, i + 1))
      for (const e of es) if (src.startsWith(e.q1, i - e.q1.length) && src.startsWith(e.q2, i + b.length)) { cand.push([i - e.q1.length, i + b.length + e.q2.length, e]); break; }
  }
  let s = src;
  if (cand.length) {                               // longest first wins overlaps, then one rebuild
    cand.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])); const occ = []; const taken = [];
    const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
    for (const c of cand) if (free(c[0], c[1])) { occ.push(c); taken.push(c); }
    occ.sort((a, b) => a[0] - b[0]); const out = []; let at = 0;
    for (const [i, j, e] of occ) { out.push(src.slice(at, i), e.to); at = j; n++; used.add(e.k); }
    out.push(src.slice(at)); s = out.join('');
  }
  // decode escaped Chinese so that steps 2 and 3 see it
  if (!/\\u(?:3[0-9a-fA-F]|4[e-fE-F]|[5-9][0-9a-fA-F]|[fF][fF])[0-9a-fA-F]{2}/.test(s) && !CJK.test(s)) return { s, n };
  // 2. Chinese words in comments (// ... up to a line end or \n escape, and /* ... */) of embedded code strings
  const strip = (t) => t.replace(CJK_G, '').replace(/\\u(?:3[0-9a-fA-F]|4[e-fE-F]|[5-9][0-9a-fA-F]|[fF][fF])[0-9a-fA-F]{2}/g, (m) => CJK.test(String.fromCharCode(parseInt(m.slice(2), 16))) ? '' : m);
  s = s.replace(/\/\/(?:[^\n\\"'`]|\\(?!n))*/g, (m) => CJK.test(m) || /\\u[4-9]/.test(m) ? strip(m) : m);
  s = s.replace(/\/\*[\s\S]{0,2000}?\*\//g, (m) => CJK.test(m) ? strip(m) : m);
  // 3. the rest: \uXXXX escapes (same value), except server file paths
  const keep = []; s = s.replace(new RegExp('"[^"\\n]*' + PATH_KEEP.source + '"', 'g'), (m) => { keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000'; });
  s = s.replace(CJK_G, (c) => esc4(c, true));
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[+i]);
  return { s, n };
}
module.exports = { translate, MAP, CJK };
