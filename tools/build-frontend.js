#!/usr/bin/env node
'use strict';
// Builds the Avaris DT front end (water distribution DEMO, http://210.13.55.114:9903) from the untouched copy:
//   frontend/dist (DEMO as served)  ->  frontend/build (served by the local test / the server)
//   0. Chinese texts -> English (frontend/i18n/zh-en.json, tools/translate-zh.js - shared with DT-collection-system)
//   1. visible "EPANET" texts -> "Avaris" (the API keeps its /api/epanet path and service names; docs/NAMING.md)
//   2. patches below (every patch must match the expected number of times, otherwise the build stops: a new DEMO build)
//   3. config.json: app.url / api.url = PUBLIC_URL (default "__PUBLIC_URL__", replaced by the web server per request)
//   node tools/build-frontend.js [--public-url http://localhost:8080] [--if-changed]

const fs = require('fs'), path = require('path');
const { translate } = require('./translate-zh');
const ROOT = path.join(__dirname, '..'), SRC = path.join(ROOT, 'frontend', 'dist'), OUT = path.join(ROOT, 'frontend', 'build'), ADD = path.join(ROOT, 'frontend', 'avaris-addons');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PUBLIC_URL = arg('--public-url', '__PUBLIC_URL__');
const TEXT = new Set(['.js', '.mjs', '.css', '.json', '.html', '.svg', '.txt']);

// [file regex, find, replace, expected count]
const PATCHES = [
  // Model editing: user-visible engine name
  [/^chunk-.*\.js$/, '"EPANET model (.inp)"', '"Avaris model (.inp)"', 1],
  [/^chunk-.*\.js$/, '"Complete EPANET input file"', '"Complete Avaris input file"', 1],
  // Dispatching Strategy: typo and full-width exclamation mark
  [/^chunk-.*\.js$/, '"Please select brust point\\uFF01"', '"Please select a burst point."', 1],
];

function* walk(d) { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
const STAMP = path.join(OUT, '.build-stamp');
const stamp = (() => { const c = require('crypto').createHash('sha1'); for (const f of [__filename, path.join(__dirname, 'translate-zh.js'), path.join(ROOT, 'frontend', 'i18n', 'zh-en.json'), ...[...walk(ADD)].sort()]) c.update(f + fs.readFileSync(f)); c.update(PUBLIC_URL); return c.digest('hex'); })();
if (process.argv.includes('--if-changed') && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8') === stamp) { console.log('front end is up to date'); process.exit(0); }

fs.rmSync(OUT, { recursive: true, force: true });
let files = 0, translated = 0; const usedZh = new Set(); const hits = PATCHES.map(() => 0);
for (const f of walk(SRC)) {
  const rel = path.relative(SRC, f), dst = path.join(OUT, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); files++;
  if (!TEXT.has(path.extname(f).toLowerCase())) { fs.copyFileSync(f, dst); continue; }
  let s = fs.readFileSync(f, 'utf8');
  if (/\.m?js$/.test(f)) { const r = translate(s, usedZh); s = r.s; translated += r.n; }
  PATCHES.forEach(([fre, find, rep], i) => { if (!fre.test(path.basename(f))) return; const n = s.split(find).length - 1; if (n) { hits[i] += n; s = s.split(find).join(rep); } });
  // English everywhere: the Chinese language pack serves the English texts
  if (rel === path.join('assets', 'json', 'language', 'en.json')) s = s.replace(/（/g, ' (').replace(/）/g, ')');
  if (rel === path.join('assets', 'json', 'language', 'zh.json')) s = fs.readFileSync(path.join(SRC, 'assets', 'json', 'language', 'en.json'), 'utf8').replace(/（/g, ' (').replace(/）/g, ')');
  if (path.extname(f) === '.svg') s = s.replace(/图层/g, 'Layer').replace(/图标/g, 'Icon').replace(/插画/g, 'Illustration').replace(/资源/g, 'Resource');
  if (rel === path.join('assets', 'json', 'config.json')) { const j = JSON.parse(s); j.app.url = PUBLIC_URL; j.api.url = PUBLIC_URL; j.api.epanet_api = ''; s = JSON.stringify(j, null, 4); }
  if (rel === 'index.html' && fs.existsSync(ADD)) {
    const css = fs.readdirSync(ADD).filter(x => x.endsWith('.css')).map(x => `    <link rel="stylesheet" href="assets/avaris/${x}">`).join('\n');
    const js = fs.readdirSync(ADD).filter(x => x.endsWith('.js')).map(x => `    <script src="assets/avaris/${x}" defer></script>`).join('\n');
    if (css) s = s.replace('</head>', css + '\n</head>'); if (js) s = s.replace('</body>', js + '\n</body>');
  }
  fs.writeFileSync(dst, s);
}
PATCHES.forEach(([, find], i) => { if (hits[i] !== PATCHES[i][3]) throw new Error(`patch ${i + 1} matched ${hits[i]} times, expected ${PATCHES[i][3]}: ${find}`); });
if (fs.existsSync(ADD)) { fs.mkdirSync(path.join(OUT, 'assets', 'avaris'), { recursive: true });
  for (const f of fs.readdirSync(ADD)) { const src = path.join(ADD, f), dst = path.join(OUT, 'assets', 'avaris', f); if (f.endsWith('.js')) fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))); else fs.copyFileSync(src, dst); } }
fs.writeFileSync(STAMP, stamp);
console.log(`${files} files, ${translated} Chinese texts translated (${usedZh.size} distinct), patches ${hits.join('/')}, public url ${PUBLIC_URL}`);
