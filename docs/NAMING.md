# Naming

- Service: **avaris-ds-api** (replaces the lost EPANET service of the DEMO). Engine executable: **avaris_ds_engine**
  (OWA EPANET 2.3, `engine/avaris_ds_engine.c`).
- Interface texts: "EPANET" is shown as **Avaris** (Model editing: "Avaris model (.inp)", "Complete Avaris input file").
- Kept unchanged (not visible to users, changing them would break the front end): the API path `/api/epanet`, the
  config key `epanet_api`, the front-end names `epanetService`, `app-epanet-file-upload`, the model file route
  `/files/epanet/…`.
- Database tables use the prefix `t_avaris_ds_` so the distribution and collection services can share one PostgreSQL
  database.
- The whole interface is English: Chinese texts are translated at build time (`frontend/i18n/zh-en.json`, shared with
  DT-collection-system); only server file paths and library data (spreadsheet formats, map region keys) keep their
  values, written as `\uXXXX` escapes.
