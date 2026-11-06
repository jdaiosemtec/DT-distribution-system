'use strict';
// Local test web server (stands in for Nginx; Node only, no packages):
//   /api/epanet/*                  -> the local Avaris DS service (avaris-ds-api, default 127.0.0.1:8016)
//   other /api/*, /resources/* ...    -> the DEMO server (login, assets, monitoring, maps, documents)
//   everything else                   -> frontend/build (Avaris front end); unknown files are fetched from the DEMO,
//                                        unknown app routes get index.html (Angular routing)
//   assets/json/config.json: __PUBLIC_URL__ is replaced by the address the browser used (e.g. http://localhost:8080)
// Env: PORT=8090  AVARIS_DS_API=http://127.0.0.1:8016  DEMO=http://210.13.55.114:9903  WEB_ROOT=../frontend/build

const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8090;
const API = new URL(process.env.AVARIS_DS_API || 'http://127.0.0.1:8016');
const DEMO = new URL(process.env.DEMO || 'http://210.13.55.114:9903');   // on a server: the DT platform's back end (http or https)
const lib = (t) => (t.protocol === 'https:' ? https : http), portOf = (t) => t.port || (t.protocol === 'https:' ? 443 : 80);
const INSECURE = process.env.DEMO_TLS_INSECURE === '1';             // DT platform with a self-signed certificate (intranet)
const ROOT = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '..', 'frontend', 'build'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.bin': 'application/octet-stream', '.txt': 'text/plain' };

function proxy(req, res, target, stripHost) {
  const headers = Object.assign({}, req.headers); headers.host = target.host;
  if (stripHost) { delete headers.origin; delete headers.referer; }
  const up = lib(target).request({ host: target.hostname, port: portOf(target), method: req.method, path: req.url, headers, rejectUnauthorized: !INSECURE }, (r) => { r.on('error', () => res.destroy()); res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ statusCode: 502, message: (target === API ? 'Avaris DS service' : 'DEMO server') + ' not reachable: ' + e.message })); } else res.destroy(); });
  // the map cancels many tile requests while zooming: a closed browser connection must only end its own request
  // (unhandled stream errors used to stop this server, and the map stayed empty until it was restarted)
  req.on('error', () => up.destroy()); res.on('error', () => up.destroy()); res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
}
function serveFile(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  if (file.endsWith(path.join('assets', 'json', 'config.json'))) {
    const origin = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https://' : 'http://') + (req.headers.host || ('localhost:' + PORT));   // behind Nginx with HTTPS: https
    const b = Buffer.from(fs.readFileSync(file, 'utf8').split('__PUBLIC_URL__').join(origin));
    res.writeHead(200, { 'Content-Type': TYPES[ext], 'Cache-Control': 'no-store', 'Content-Length': b.length }); return res.end(b);
  }
  // the browser always asks again (no-cache) and gets 304 when the file did not change: a rebuilt front end is used at
  // once, without Ctrl+F5 (the chunk file names stay the same between builds)
  const st = fs.statSync(file); const lm = st.mtime.toUTCString(); const tag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Last-Modified': lm, 'Cache-Control': 'no-cache' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache', ETag: tag, 'Last-Modified': lm, 'Content-Length': st.size });
  const rs = fs.createReadStream(file); rs.on('error', () => res.destroy()); res.on('error', () => rs.destroy()); rs.pipe(res);
}

// Local test accounts (local/local-login.json, never in git):
//   { "users": { "jerry": "123" }, "demo": { "username": "<DEMO account>", "password": "<DEMO password>" } }
// Logging in with a local account signs in to the DEMO with the "demo" account; any other login goes to the DEMO as typed.
const LOGIN_FILE = path.join(__dirname, 'local-login.json');
function localLogin(req, res) {
  let L = null; try { L = JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8')); } catch (e) { return false; }
  let body = ''; req.setEncoding('utf8'); req.on('data', (c) => body += c);
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch (e) {}
    const users = L.users || {}; const isLocal = b.username && Object.prototype.hasOwnProperty.call(users, b.username) && String(users[b.username]) === String(b.password);
    const out = Buffer.from(JSON.stringify(isLocal && L.demo ? Object.assign({}, b, { username: L.demo.username, password: L.demo.password }) : b));
    const headers = Object.assign({}, req.headers, { host: DEMO.host, 'content-length': out.length }); delete headers.origin; delete headers.referer;
    const up = lib(DEMO).request({ host: DEMO.hostname, port: portOf(DEMO), method: 'POST', path: req.url, headers, rejectUnauthorized: !INSECURE }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ statusCode: 502, message: 'DEMO server not reachable: ' + e.message })); });
    up.end(out);
  });
  return true;
}

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST' && p === '/api/user/auth/login' && fs.existsSync(LOGIN_FILE) && localLogin(req, res)) return;
  if (p.startsWith('/api/epanet/')) return proxy(req, res, API);
  if (p.startsWith('/api/') || p.startsWith('/resources/')) return proxy(req, res, DEMO, true);
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
  if (path.extname(p)) return proxy(req, res, DEMO, true);              // a file the collected front end does not have
  serveFile(req, res, path.join(ROOT, 'index.html'));                    // Angular route
});
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, '.build-stamp'), 'utf8').slice(0, 8); } catch (e) { return '?'; } })();
process.on('uncaughtException', (e) => console.error('[web] ' + (e && e.message)));   // keep serving
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use: an earlier local test is still open. Close its windows (or run start-local.cmd again).` : e.message); process.exit(1); });
server.listen(PORT, process.env.HOST || undefined, () => console.log(`Avaris DT Distribution web (front end ${VERSION}): http://localhost:${PORT}   (front end ${ROOT}; Avaris DS ${API.href}; everything else ${DEMO.href})`));
