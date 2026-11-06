'use strict';
// multipart/form-data parser that streams file parts to disk (models can be several hundred MB).
// parse(req, dir) -> Promise<{ fields: {name: value}, files: [{ field, filename, path, size }]}>

const fs = require('fs');
const path = require('path');

function parse(req, dir, maxBytes = 4 * 1024 ** 3) {
  return new Promise((resolve, reject) => {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
    if (!m) return reject(new Error('not multipart/form-data'));
    const boundary = Buffer.from('\r\n--' + (m[1] || m[2]));
    const fields = {}, files = [];
    let buf = Buffer.from('\r\n'), state = 'preamble', part = null, total = 0;
    const safe = (n) => path.basename(String(n || 'file')).replace(/[^\w.\- ()]+/g, '_');
    const openPart = (hdr) => {
      const disp = /content-disposition:[^\r\n]*/i.exec(hdr); const d = disp ? disp[0] : '';
      const name = (/\bname="([^"]*)"/i.exec(d) || [])[1], filename = (/filename="([^"]*)"/i.exec(d) || [])[1];
      if (filename !== undefined) { const p = path.join(dir, safe(filename)); part = { field: name, filename: safe(filename), path: p, size: 0, ws: fs.createWriteStream(p) }; }
      else part = { field: name, chunks: [] };
    };
    const write = (b) => { if (!b.length) return; if (part.ws) { part.ws.write(b); part.size += b.length; } else part.chunks.push(b); };
    const flushed = [];
    const closePart = () => { if (!part) return; if (part.ws) { const ws = part.ws; flushed.push(new Promise(r => ws.on('finish', r))); ws.end(); const { ws: _w, ...f } = part; files.push(f); } else fields[part.field] = Buffer.concat(part.chunks).toString('utf8'); part = null; };
    req.on('data', (chunk) => {
      total += chunk.length; if (total > maxBytes) { req.destroy(); return reject(new Error('upload too large')); }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (state === 'preamble' || state === 'boundary') {
          const i = buf.indexOf(boundary); if (i < 0) { if (state === 'boundary' && part) { const keep = boundary.length; write(buf.subarray(0, Math.max(0, buf.length - keep))); buf = buf.subarray(Math.max(0, buf.length - keep)); } return; }
          if (state === 'boundary' && part) write(buf.subarray(0, i)); closePart();
          buf = buf.subarray(i + boundary.length); state = 'after';
        }
        if (state === 'after') { if (buf.length < 2) return; if (buf[0] === 45 && buf[1] === 45) { state = 'end'; return; } state = 'headers'; }
        if (state === 'headers') { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; openPart(buf.subarray(0, i).toString('latin1')); buf = buf.subarray(i + 4); state = 'boundary'; }
        if (state === 'end') return;
      }
    });
    req.on('end', () => { closePart(); Promise.all(flushed).then(() => resolve({ fields, files })); });
    req.on('error', reject);
  });
}

module.exports = { parse };
