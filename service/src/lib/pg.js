'use strict';
// Minimal PostgreSQL client (wire protocol 3.0) – Node only, no packages, so the service image builds and runs on an
// intranet server without npm. Covers what avaris-api needs: one connection, queries one after another, parameters
// ($1, $2 … as text), password / MD5 / SCRAM-SHA-256 login, optional TLS (sslmode=require / verify-full).
//   const pg = new Client('postgres://user:pass@host:5432/db?sslmode=require'); await pg.query('SELECT $1::int AS n', [1])
//   -> { rows: [{ n: 1 }], rowCount: 1 }        await pg.exec('CREATE …; CREATE …')   (several statements, no parameters)
const net = require('net'), tls = require('tls'), crypto = require('crypto');

const INT = new Set([20, 21, 23, 26]), FLOAT = new Set([700, 701, 1700]), JSON_T = new Set([114, 3802]);
function conv(v, oid) { if (v === null) return null; if (INT.has(oid) || FLOAT.has(oid)) return Number(v); if (oid === 16) return v === 't'; if (JSON_T.has(oid)) return JSON.parse(v); return v; }

class Client {
  constructor(url) {
    const u = new URL(url);
    this.cfg = { host: u.hostname || '127.0.0.1', port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)) || decodeURIComponent(u.username), ssl: u.searchParams.get('sslmode') || 'disable',
      schema: u.searchParams.get('schema') || '' };
    this.sock = null; this.buf = Buffer.alloc(0); this.q = Promise.resolve(); this.wait = null;
  }
  // ---- connection -------------------------------------------------------------------------------------------------
  async connect() {
    const c = this.cfg;
    let s = await new Promise((res, rej) => { const k = net.connect(c.port, c.host); k.once('connect', () => res(k)); k.once('error', rej); k.setTimeout(10000, () => k.destroy(new Error('PostgreSQL: connection timed out'))); });
    s.setTimeout(0);
    if (c.ssl !== 'disable') {
      const r = Buffer.alloc(8); r.writeInt32BE(8); r.writeInt32BE(80877103, 4); s.write(r);
      const a = await new Promise((res, rej) => { s.once('data', (d) => res(d)); s.once('error', rej); });
      if (a[0] !== 0x53) { if (c.ssl === 'prefer') { /* plain */ } else throw new Error('PostgreSQL server does not accept TLS (sslmode=' + c.ssl + ')'); }
      else s = await new Promise((res, rej) => { const t = tls.connect({ socket: s, servername: net.isIP(c.host) ? undefined : c.host, rejectUnauthorized: c.ssl === 'verify-full' || c.ssl === 'verify-ca' }, () => res(t)); t.once('error', rej); });
    }
    this.sock = s; this.buf = Buffer.alloc(0); this.inbox = [];
    s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    s.on('error', (e) => this.fail(e)); s.on('close', () => { this.sock = null; this.fail(new Error('PostgreSQL connection closed')); });
    const params = ['user', c.user, 'database', c.database, 'application_name', 'avaris-api', 'client_encoding', 'UTF8'];
    if (c.schema) params.push('options', '-c search_path=' + c.schema);
    const body = Buffer.concat([int32(196608), ...params.map(cstr), Buffer.from([0])]);
    s.write(Buffer.concat([int32(body.length + 4), body]));
    await this.handshake();
  }
  async handshake() {
    let scram = null;
    for (;;) {
      const m = await this.next();
      if (m.t === 'E') throw pgError(m.b);
      if (m.t === 'Z') return;
      if (m.t !== 'R') continue;
      const code = m.b.readInt32BE(0);
      if (code === 0) continue;
      if (code === 3) this.send('p', cstr(this.cfg.password));
      else if (code === 5) { const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
        this.send('p', cstr('md5' + md5(Buffer.concat([Buffer.from(md5(this.cfg.password + this.cfg.user)), m.b.subarray(4, 8)])))); }
      else if (code === 10) { const mech = m.b.subarray(4).toString().split('\0'); if (!mech.includes('SCRAM-SHA-256')) throw new Error('PostgreSQL: no supported login method (' + mech.join(', ') + ')');
        const nonce = crypto.randomBytes(18).toString('base64'); scram = { nonce, first: 'n=*,r=' + nonce }; const cf = Buffer.from('n,,' + scram.first);
        this.send('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(cf.length), cf])); }
      else if (code === 11) { const sf = m.b.subarray(4).toString(); const a = Object.fromEntries(sf.split(',').map(x => [x[0], x.slice(2)]));
        if (!a.r.startsWith(scram.nonce)) throw new Error('PostgreSQL: SCRAM nonce mismatch');
        const salted = crypto.pbkdf2Sync(this.cfg.password, Buffer.from(a.s, 'base64'), +a.i, 32, 'sha256'); const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
        const ck = hmac(salted, 'Client Key'), sk = crypto.createHash('sha256').update(ck).digest(); const fin = 'c=biws,r=' + a.r; const auth = scram.first + ',' + sf + ',' + fin;
        const sig = hmac(sk, auth); const proof = Buffer.from(ck.map((b, i) => b ^ sig[i])); scram.server = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
        this.send('p', Buffer.from(fin + ',p=' + proof.toString('base64'))); }
      else if (code === 12) { const v = m.b.subarray(4).toString().split(',').find(x => x.startsWith('v=')); if (!v || v.slice(2) !== scram.server) throw new Error('PostgreSQL: server signature mismatch'); }
      else throw new Error('PostgreSQL: login method ' + code + ' is not supported');
    }
  }
  // ---- messages ---------------------------------------------------------------------------------------------------
  send(type, body) { this.sock.write(Buffer.concat([Buffer.from(type), int32(body.length + 4), body])); }
  pump() {
    while (this.buf.length >= 5) { const len = this.buf.readInt32BE(1); if (this.buf.length < len + 1) return;
      const m = { t: String.fromCharCode(this.buf[0]), b: this.buf.subarray(5, len + 1) }; this.buf = this.buf.subarray(len + 1);
      if (m.t === 'N' || m.t === 'A' || m.t === 'S' || m.t === 'K') continue;      // notices, notifications, parameter status, key data
      (this.inbox || (this.inbox = [])).push(m); }
    if (this.wait && this.inbox && this.inbox.length) { const w = this.wait; this.wait = null; w.res(this.inbox.shift()); }
  }
  next() { if (this.inbox && this.inbox.length) return Promise.resolve(this.inbox.shift()); return new Promise((res, rej) => { this.wait = { res, rej }; }); }
  fail(e) { if (this.wait) { const w = this.wait; this.wait = null; w.rej(e); } }
  // ---- queries (one after another) ----------------------------------------------------------------------------------
  query(sql, params = []) { return this.run(() => this._query(sql, params)); }
  exec(sql) { return this.run(() => this._exec(sql)); }
  run(fn) { const p = this.q.then(async () => { if (!this.sock) await this.connect(); return fn(); }); this.q = p.catch(() => {}); return p; }
  async _query(sql, params) {
    const vals = params.map(v => v === null || v === undefined ? null : Buffer.from(typeof v === 'object' ? JSON.stringify(v) : String(v)));
    this.send('P', Buffer.concat([cstr(''), cstr(sql), int16(0)]));
    this.send('B', Buffer.concat([cstr(''), cstr(''), int16(0), int16(vals.length), ...vals.map(v => v === null ? int32(-1) : Buffer.concat([int32(v.length), v])), int16(0)]));
    this.send('D', Buffer.concat([Buffer.from('P'), cstr('')])); this.send('E', Buffer.concat([cstr(''), int32(0)])); this.send('S', Buffer.alloc(0));
    return this.collect();
  }
  async _exec(sql) { this.send('Q', cstr(sql)); return this.collect(); }
  async collect() {
    let fields = [], rows = [], err = null, count = 0;
    for (;;) {
      const m = await this.next();
      if (m.t === 'T') { fields = []; let o = 2; for (let i = 0, n = m.b.readInt16BE(0); i < n; i++) { const e = m.b.indexOf(0, o); const name = m.b.toString('utf8', o, e); o = e + 1; fields.push({ name, oid: m.b.readInt32BE(o + 6) }); o += 18; } }
      else if (m.t === 'D') { const r = {}; let o = 2; for (let i = 0, n = m.b.readInt16BE(0); i < n; i++) { const l = m.b.readInt32BE(o); o += 4; const f = fields[i];
          r[f.name] = conv(l < 0 ? null : m.b.toString('utf8', o, o + l), f.oid); if (l > 0) o += l; } rows.push(r); }
      else if (m.t === 'C') { const tag = m.b.toString('utf8', 0, m.b.length - 1).split(' '); count += +tag[tag.length - 1] || 0; }
      else if (m.t === 'E') err = pgError(m.b);
      else if (m.t === 'Z') { if (err) throw err; return { rows, rowCount: count }; }
    }
  }
  async end() { try { await this.q; if (this.sock) { this.send('X', Buffer.alloc(0)); this.sock.end(); } } catch (e) {} }
}
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function cstr(s) { return Buffer.from(String(s) + '\0'); }
function pgError(b) { const f = {}; let o = 0; while (o < b.length && b[o]) { const e = b.indexOf(0, o + 1); f[String.fromCharCode(b[o])] = b.toString('utf8', o + 1, e); o = e + 1; }
  const e = new Error('PostgreSQL: ' + (f.M || 'error') + (f.D ? ' – ' + f.D : '')); e.code = f.C; return e; }

module.exports = { Client };
