// Paste into the Chrome DevTools console (F12 -> Console) on http://210.13.55.114:9903/login
// Collects the whole DEMO front end and downloads it as dt-distribution-demo-frontend.tar
(async () => {
  const cap = {}, q = ['index.html'], seen = new Set(q), miss = [];
  const add = (p) => { p = p.replace(/^\.?\//, '').split('?')[0].split('#')[0]; if (!p || p.startsWith('http') || p.startsWith('data:') || p.includes('${')) return; if (!seen.has(p)) { seen.add(p); q.push(p); } };
  ['assets/json/config.json', 'assets/json/language/en.json', 'assets/json/language/zh.json', 'assets/json/map/light.json', 'assets/json/map/dark.json',
   'assets/json/echarts/light.json', 'assets/json/echarts/dark.json', 'default.css', 'dark.css', 'favicon.ico', 'assets/js/theme-bootstrap.js', 'images/pump-station.svg'].forEach(add);
  while (q.length) {
    const p = q.shift(); let r;
    try { r = await fetch('/' + p, { cache: 'no-store' }); } catch (e) { miss.push(p); continue; }
    if (!r.ok) { miss.push(p + ':' + r.status); continue; }
    const ct = r.headers.get('content-type') || ''; const buf = await r.arrayBuffer();
    if (ct.includes('text/html') && p !== 'index.html') { miss.push(p + ':html'); continue; }
    cap[p] = buf;
    if (/\.(js|css|html|json)$/.test(p)) {
      const t = new TextDecoder().decode(buf);
      (t.match(/(chunk|main|polyfills|scripts)-[A-Z0-9]{8}\.js|styles-[A-Z0-9]{8}\.css/g) || []).forEach(add);
      (t.match(/media\/[\w\-\.]+/g) || []).forEach(add);
      (t.match(/assets\/[\w\-\/\.%]+\.(png|svg|jpg|jpeg|gif|json|js|css|ico|webp|glb|gltf|woff2?|ttf|mp4|txt|xml|geojson)/g) || []).forEach(add);
      if (p.endsWith('.html')) (t.match(/(href|src)="([^"]+)"/g) || []).forEach(m => add(m.split('"')[1]));
    }
  }
  // models (only when logged in): every uploaded EPANET input file
  try {
    const u = JSON.parse(localStorage.digitaltwin_sw_user || 'null'); const H = u && u.token ? { Authorization: 'Bearer ' + u.token } : null;
    if (H) {
      const ins = (await (await fetch('/api/epanet/input/all', { headers: H })).json()).data || [];
      for (const i of ins) { const r = await fetch('/api/epanet/files/epanet/' + i.path + '/' + i.file, { headers: H }); if (r.ok) cap['_models/' + i.name + '__' + i.file] = await r.arrayBuffer(); }
      cap['_models/inputs.json'] = new TextEncoder().encode(JSON.stringify(ins, null, 1)).buffer;
    }
  } catch (e) { miss.push('models: ' + e.message); }
  const enc = new TextEncoder(), parts = [];
  for (const [name, buf] of Object.entries(cap)) {
    const h = new Uint8Array(512), w = (s, o, l) => h.set(enc.encode(s).slice(0, l), o);
    let n = name, pre = ''; if (enc.encode(n).length > 99) { const i = n.lastIndexOf('/', 154); pre = n.slice(0, i); n = n.slice(i + 1); }
    w(n, 0, 100); w('0000644\0', 100, 8); w('0000000\0', 108, 8); w('0000000\0', 116, 8);
    w(buf.byteLength.toString(8).padStart(11, '0') + '\0', 124, 12); w(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
    w('        ', 148, 8); w('0', 156, 1); w('ustar\0', 257, 6); w('00', 263, 2); w(pre, 345, 155);
    let s = 0; for (const x of h) s += x; w(s.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(h, new Uint8Array(buf)); const pad = (512 - buf.byteLength % 512) % 512; if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts)); a.download = 'dt-distribution-demo-frontend.tar';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('DONE: ' + Object.keys(cap).length + ' files; not found: ' + miss.length);
})();
