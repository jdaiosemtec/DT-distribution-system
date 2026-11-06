# DT Distribution — Supply Model service (`/api/epanet`) reverse-engineered API spec v0.1

Source: the DEMO at http://210.13.55.114:9903 (Angular 17 build, collected 2026-11-05), service layer `chunk-D4XF2Q7O.js`
(class with `epanet_api = config.api.epanet_api + "/api/epanet"`), the pages that use it, and live answers of the DEMO
back end (NestJS: POST answers HTTP 201, errors `{statusCode, message, error}`).
The DEMO back end still answers; its source is lost. The new service **avaris-ds-api** (`service/`) implements every route
below with the same request and answer shapes. Engine: OWA EPANET 2.3 (`engine/`).

## Pages and the routes they use
| Page (route) | Component chunk | Routes |
|---|---|---|
| Leakage Location (`supply-model/location`) | G5DFSNGK, I4U3IEXH | scenario/all, run/inp, scenario/:id/update, scenario/:id/detail, node/link input, output/variable, analysis/burst/emitter/multi (affected users of the ALD alarms) |
| Leakage Impact → Pipe Burst / Water Quality / Low Pressure (`supply-model/impact/*`) | YNLMDVRF | analysis/burst/emitter/multi, analysis/water/quality, analysis/quality/close/valves, analysis/low/pressure, output/variable |
| Dispatching Strategy (`supply-model/simulation`) | G5DFSNGK, F4VIX3FJ | analysis/close/valve (MIN_RANGE / MIN_COUNT), analysis/close/simulation, output/variable |
| Model editing (`supply-model/editing`) | EFFWOWUM | input/all, input/:id/editor, input/editor/preview, POST input/:id/editor |
| Model / scenario list, upload (dashboard + toolbar) | F4VIX3FJ, 3ADQV7FL | upload/inp, input/create, input/change, input/:id/remove, scenario/*, run/inp |

## Live scenarios
The main model has 24 scenarios of category `LIVE` (`hour` 1…24; hour 0 is shown as 24) and one `ORIGIN` scenario.
Opening a page runs the scenario of the current hour (`scenario/:id/update {status:0}` → `run/inp {force:true}` → polls
`scenario/:id/detail` until `status` 3). On the DEMO all hours give identical results (same model, no live data), so the
new service runs the model as it is. Status values: 0 not run / failed, 1 running, 2 queued, 3 completed.
Analysis runs create scenarios of category `TEMP` (not listed by `scenario/all`; the newest `TEMP_KEEP` are kept).

## Routes (all under `/api/epanet`)
| Method | Path | Body / answer |
|---|---|---|
| POST | `/upload/inp` | multipart `name`, `files` (one .inp, optional .prj) → `{result, path, file, scenario}` |
| POST | `/input/create` | `{name, file, path, main, scenario:{name,id}}` → input; creates the ORIGIN scenario (+ LIVE when main) |
| GET | `/input/all`, `/input/:id/detail` | input `{id, createdAt, updatedAt, name, path, file, main}` |
| POST | `/input/:id/update` `{input}`, `/input/change` `{input}` | change makes it the main model (LIVE scenarios move) → `{result}` |
| DELETE | `/input/:id/remove` | → `{result}` |
| GET | `/input/:id/editor` | `{content, nodes[], links[], warnings, projection, defaultProjection, units, sections, outOfServiceCount, revision, id, name}` |
| POST | `/input/editor/preview` | `{content, operation?, projection?}` → same shape (nothing saved). operation: `{kind:'upsert', section, originalId?, values[], related{}, mapPosition?, vertices?, outOfService?, burialDepth?}` or `{kind:'remove', section, originalId}` |
| POST | `/input/:id/editor` | `{content, revision}` → saved model (409 when the revision is stale); results of the model's scenarios are cleared |
| GET | `/files/epanet/:path/:file` | the model file as saved |
| GET | `/scenario/all`, `/scenario/:id/detail`, `/scenario/:id/legend`, `/scenario/hour/:h` | scenario (see below) |
| POST | `/scenario/create {scenario}`, `/scenario/:id/update {scenario}` · DELETE `/scenario/:id/remove` | |
| POST | `/run/inp` | `{scenario, scenarioId, force}` → started |
| GET | `/node/input/:inputId`, `/link/input/:inputId` | object records (below) |
| GET | `/node/input/:inputId/name/:name`, `/node/:id/detail`, `/link/:id/detail` | one record |
| POST/DELETE | `/node|link/create {node|link}`, `/:id/update`, `/:id/remove` | saved into the model at once |
| POST | `/output/variable/:param/node|link/:name` | `{id, periodIndex?}` → `[{name, <param>: series}]` (value when periodIndex given) |
| POST | `/output/variable/:param/node|link` | `{id, type?, periodIndex?}` → `[{name, <param>: value}]` for all objects |
| POST | `/output/variable/:param/period/:a/:b/nodes|links` | `{scenario}` → `[{name, <param>: [values a…b]}]`; 400 "Invalid result period range." |
| POST | `/analysis/close/valve` | `{code, type:'PIPE'|'JUNCTION', close_type:'MIN_RANGE'|'MIN_COUNT', invalid_valves[]}` → `{valves[], pipes[], users[]}` (records + `in_node`, `out_node`) |
| POST | `/analysis/close/simulation` | `{close_valves[], close_nodes[], scenario}` → TEMP scenario run with the valves closed |
| POST | `/analysis/burst` · `/burst/emitter` · `/burst/multi` · `/burst/emitter/multi` | demand or emitter at node(s) → TEMP scenario "Pipe Burst Analysis" |
| POST | `/analysis/low/pressure` | `{low_pressure, scenario}` → `{plant, pipes[], nodes[]}` supply path node → source (period 0) |
| POST | `/analysis/water/quality` | `{quality_node, duration (h), method:'SOURCE'|'DIFFUSION', scenario}` → `{pipes[] (+flow, velocity, time s), nodes[]}` |
| POST | `/analysis/quality/close/valves` | `{node_codes[], invalid_valves[]}` → `{valves[], pipes[], users[]}` |
| POST | `/analysis/flush` | `{outfalls[], scenario}` → TEMP scenario (not used by the pages) |
| GET/POST/DELETE | `/project/*` | project list (kept for the front end) |

### Result parameters
Node: `demand, head, pressure, waterQuality, waterAge` (quality and age are the EPANET quality result).
Link: `flow, velocity, headloss, hydraulicSlope, avgWaterQuality, avgWaterAge, status, setting, reactionRate, friction`.
Values are in the units of the model (`units` LPS → m, m/s). `scenario.output` holds the domain-wide maximum of each.
One period per hydraulic time step (DEMO: 48 h at 0.25 h → 193 periods).

### Records
Node: `{id, createdAt, updatedAt, name, type: JUNCTION|RESERVOIR|TANK, input, geometry (WGS84 Point), junction{demand, elev, pattern} | reservoir{head, pattern} | tank{…}, output:null}`.
Link: `{…, type: PIPE|PUMP|VALVE, geometry (LineString), pipe{diameter, end_node, length, loss, roughness, start_node, status} | pump{…} | valve{…}}`.
Coordinates: model coordinates converted with the projection of the Model editing metadata (`;@MODEL_EDIT {"projection": WKT, "outOfService": [...], "burialDepth": {...}, "suspended": []}` lines at the top of the .inp), or `DEFAULT_PRJ`.

## DEMO model
`526` (526.inp): 1,339 nodes, 1,400 links (1 reservoir R-1, pumps, TCV valves), LPS, H-W, AGE quality, 48 h, 0.25 h steps,
UTM-like transverse Mercator (NAD83, central meridian −70.1875).
