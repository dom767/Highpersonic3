# Highpersonic3

Audio visualizer (WebGPU) with a companion Studio tool for producing TikTok-ready clips.

## Running and deploying

- `StartServer.cmd` — dev server on http://localhost:8080/ (`serve.py`).
- `Build.cmd` — package a static copy into `Export/VersionN` (no upload).
- `DeployLocal.cmd` — serve the latest export locally (builds one if needed).
- `DeployProd.cmd` — build and upload to https://baffledcat.com/highpersonic3/ (humans only).

These are AgentController repository commands (`actions/*.mjs`); see [deploy.md](deploy.md).

Copyright (c) 2026 Dominic Penfold. All rights reserved.
