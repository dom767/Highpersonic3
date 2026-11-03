# Highpersonic3

Audio visualizer (WebGPU) with a companion Studio tool for producing TikTok-ready clips.

## Running and deploying

Use the dashboard actions or double-click the matching root wrapper:

- `RunLocal.cmd` — serve the working tree without packaging, in a separate window.
- `DeployLocal.cmd` — package into `Export/Local` stamped `0.0.C` and serve it in a separate window.
- `DeployProd.cmd` — humans only: claim N, package into `Export/VersionN` stamped `0.N.C`, upload and verify the live asset version.

There is no separate Build action; each deploy packages its own build. Both deploys refuse uncommitted changes; Deploy Prod also requires HEAD on the GitHub branch. Servers use `PORT`, defaulting to 8080; stop the previous server before using the same port. Close the server window or press Ctrl+C to stop it. `StartServer.cmd` remains the foreground development server entry point.

Requires Node.js and Python 3; packaging also uses npx/Terser. Production requires authenticated AWS CLI v2 and GitHub access. See [deploy.md](deploy.md).

Copyright (c) 2026 Dominic Penfold. All rights reserved.
