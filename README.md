# Highpersonic3

Audio visualizer (WebGPU) with a companion Studio tool for producing TikTok-ready clips.

## Running and deploying

Use the dashboard actions or double-click the matching root wrapper:

- `RunDev.cmd` — serve the working tree without building, in a separate window.
- `Build.cmd` — package once into `Export/Build<k>` and record `Export/latest.json`. No release claim or upload.
- `DeployLocal.cmd` — stamp the latest build as `b<k>-local` into `Export/Build<k>-local` and serve it in a separate window. Never rebuilds.
- `DeployProd.cmd` — humans only: claim a release number, stamp the latest build into `Export/VersionN`, upload it and verify the live asset version. Never rebuilds.

Both deploy commands require a completed Build. Servers use `PORT`, defaulting to 8080; stop the previous server before using the same port. Close the server window or press Ctrl+C to stop it. `StartServer.cmd` remains the foreground development server entry point.

Requires Node.js and Python 3; Build also uses npx/Terser. Production requires authenticated AWS CLI v2 and GitHub access. See [deploy.md](deploy.md).

Copyright (c) 2026 Dominic Penfold. All rights reserved.
