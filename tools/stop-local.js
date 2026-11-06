'use strict';
// Stops an earlier local test (Windows): the node processes listening on the simulation service and web server ports.
// A simulation that is running keeps running (the engine is a separate process) and is picked up by the new service.
//   node tools/stop-local.js [8016 8090]
const { execSync } = require('child_process');
const ports = process.argv.slice(2).map(Number).filter(Boolean); if (!ports.length) ports.push(8016, 8090);
if (process.platform !== 'win32') process.exit(0);
let lines = []; try { lines = execSync('netstat -ano -p tcp', { encoding: 'utf8' }).split(/\r?\n/); } catch (e) { process.exit(0); }
const pids = new Set();
for (const l of lines) { const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l); if (m && ports.includes(+m[1]) && +m[2] !== process.pid) pids.add(m[2]); }
for (const pid of pids) {
  let name = ''; try { name = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }); } catch (e) {}
  if (!/node\.exe/i.test(name)) { console.log(`Port in use by another program (PID ${pid}), not stopped: ${name.split(',')[0] || '?'}`); continue; }
  try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); console.log(`Stopped the earlier instance (PID ${pid}).`); } catch (e) {}
}
