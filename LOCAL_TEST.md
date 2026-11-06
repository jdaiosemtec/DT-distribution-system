# DT Distribution — local test build (Windows)

Runs the new Avaris DS service (Supply Model pages, OWA EPANET 2.3 engine) and the English Avaris front end on your
computer. All other APIs (login, dashboard data, sensors, KPI, assets) are still forwarded to the DEMO server
(http://210.13.55.114:9903). Ports 8090 / 8016, so it can run next to the collection test (8080 / 8015).

## One-time setup
1. Node.js **LTS** 22.5 or newer from https://nodejs.org (default options).
2. Download this repository (GitHub → Code → Download ZIP) and extract it, e.g. to `D:\DT-distribution-system`.

## Start
Double-click **`start-local.cmd`**. Two windows open (Avaris DS service, local web server) and the browser opens
http://localhost:8090. Log in with the DigitalTwin account. Close the two windows to stop.

## First steps
1. **Model** → the model list is empty at first. Upload the DEMO model: `models\demo526\526.inp` (model name `526`,
   main model). The 24 live scenarios and the ORIGIN scenario are created.
2. Open **Leakage Location / Leakage Impact / Dispatching Strategy / Model editing** – the current hour's live scenario
   runs automatically (a few seconds for 526).
3. Data is kept in `local\data\`; delete the folder to start from scratch.
