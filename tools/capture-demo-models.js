// Paste into the Chrome DevTools console on http://210.13.55.114:9903 while LOGGED IN.
// Downloads every uploaded EPANET model of the DEMO plus its record list as dt-distribution-demo-models.tar
(async () => {
  const u = JSON.parse(localStorage.digitaltwin_sw_user || 'null');
  if (!u || !u.token) { console.log('NOT LOGGED IN - log in first, then run again'); return; }
  const H = { Authorization: 'Bearer ' + u.token }, cap = {}, enc = new TextEncoder();
  const ins = (await (await fetch('/api/epanet/input/all', { headers: H })).json()).data || [];
  for (const i of ins) { const r = await fetch('/api/epanet/files/epanet/' + i.path + '/' + i.file, { headers: H }); if (r.ok) cap[i.name + '__' + i.file] = await r.arrayBuffer(); }
  const sc = (await (await fetch('/api/epanet/scenario/all', { headers: H })).json()).data || [];
  cap['inputs.json'] = enc.encode(JSON.stringify(ins, null, 1)).buffer;
  cap['scenarios.json'] = enc.encode(JSON.stringify(sc, null, 1)).buffer;
  const parts = [];
  for (const [name, buf] of Object.entries(cap)) {
    const h = new Uint8Array(512), w = (s, o, l) => h.set(enc.encode(s).slice(0, l), o);
    w(name, 0, 100); w('0000644\0', 100, 8); w('0000000\0', 108, 8); w('0000000\0', 116, 8);
    w(buf.byteLength.toString(8).padStart(11, '0') + '\0', 124, 12); w(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
    w('        ', 148, 8); w('0', 156, 1); w('ustar\0', 257, 6); w('00', 263, 2);
    let s = 0; for (const x of h) s += x; w(s.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(h, new Uint8Array(buf)); const pad = (512 - buf.byteLength % 512) % 512; if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts)); a.download = 'dt-distribution-demo-models.tar';
  document.body.appendChild(a); a.click(); a.remove();
  console.log('DONE: ' + Object.keys(cap).join(', '));
})();
