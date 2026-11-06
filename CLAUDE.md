# DT distribution system – notes for Claude

- Reproduction of the DT **Supply Model** (water distribution) pages of the DEMO http://210.13.55.114:9903 (login
  DigitalTwin; the user logs in, never type the password). Sister project: jdaiosemtec/DT-collection-system (cc, the
  collection / Avaris DS drainage side) – same structure, reuse its tools.
- Front end: `frontend/dist` = DEMO build as served (do not edit), `tools/build-frontend.js` → `frontend/build`
  (Chinese → English via `frontend/i18n/zh-en.json`, EPANET → Avaris texts, patches that must match exactly).
- Service: `service/` = **avaris-ds-api** (Node ≥ 22.5, no packages), routes in `docs/DS_API_Reverse_Spec.md`.
  PostgreSQL with `DATABASE_URL` (servers), built-in SQLite otherwise (PC test bench). One process.
  Engine OWA EPANET 2.3: `engine/avaris_ds_engine.c`, binaries `service/bin/linux`, `service/bin/win` (build: `engine/build.sh`).
- Local test on the user's PC: `start-local.cmd` → http://localhost:8090 (service :8016); other APIs go to the DEMO.
  Ports differ from the collection test (8080 / 8015) so both can run. The PC is only a test bench; targets OCI / AWS.
- Tests (run before every delivery; old features must keep working): `node service/test/smoke.js` (Net3),
  `node service/test/smoke.js models/demo526/526.inp`, `node service/test/demo526.js` (results vs. DEMO reference values).
- Replies to the user in Chinese; UI text and code English only.
- DEMO front end cannot be downloaded from the built-in browser: the user runs `tools/capture-demo-*.js` in Chrome.
