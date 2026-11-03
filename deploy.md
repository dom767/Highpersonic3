# Highpersonic3 build and deployment

## Three commands

Run `RunLocal.cmd`, `DeployLocal.cmd` or `DeployProd.cmd`, or the corresponding `node actions/<Name>.mjs` from the dashboard. Wrappers contain no action logic and respect `AC_NO_PAUSE` on failure. There is no separate Build action: each deploy packages its own build.

**Run Local** opens `StartServer.cmd` in its own window and returns. It serves the working tree with `serve.py`, including the dynamic texture manifest, without packaging. `PORT` defaults to the reserved human port 8080.

**Deploy Local** requires a clean working tree. It packages a fresh build into `Export/Local` stamped `0.0.C` (C = `git rev-list --count HEAD`), writes `build.json`, opens a static server in its own window and returns. It never claims a release number. Stop any server using the same port first; close the new window or press Ctrl+C to stop it.

**Deploy Prod** is for humans only. It requires a clean tree and HEAD on the GitHub branch, takes C from HEAD, claims N via `scripts/release-version.mjs` (floor = highest local `Export/VersionN`), packages into `Export/VersionN` stamped `0.N.C`, writes `build.json`, compares non-HTML hashes to `Export/Local` when the source commit matches (warnings only), uploads that folder and verifies the live asset-version global equals `0.N.C`. A failed release may consume a number; numbers are never reused.

## Package details

Both deploys call `packageBuild({ dir, version })` in `actions/lib/build.mjs`, which runs `export-static.py --output <dir> --version <version>`. Packaging preserves this app's classic script order, minifies the bundle with Terser (failure aborts), copies runtime images and generates `assets/textures.json`. Source scripts, servers, actions, release tooling and docs are omitted. Development requires no packaging step.

`index.html` receives the versioned bundle URL (`?v=0.N.C`) and `self.__HIGHPERSONIC3_ASSET_VERSION__` written directly at package time (source still uses `__VERSION__` placeholders for local serving). Runtime texture manifest and image requests read that global. The site-root `/consent.js` reference is versioned too; it is supplied by the parent site and will return 404 on the standalone local server. JavaScript and data contain no baked deployment version. No worker entry points exist. `build.json` next to the output records version, N, C, source commit, build time and SHA-256 hashes of every non-HTML file.

## Production target

- Owned prefix: `s3://baffledcat.com/highpersonic3/`
- Public URL: https://baffledcat.com/highpersonic3/
- Static assets, including JS/CSS: `public, max-age=31536000, immutable`
- `*.json.gz`: the same immutable cache, `Content-Type: application/gzip`, no Content-Encoding
- `index.html`: `public, max-age=60`, uploaded last

Deployment syncs only this app's prefix. AWS CLI v2 must already be authenticated (`aws login` if required). The release helper needs GitHub access. No secrets are stored in these scripts. Live verification retries a cache-busted request and requires the HTML asset-version global to match `0.N.C`. DNS and Cloudflare changes are separate human operations. Old `Export/BuildN`, `Build<k>-local` and `latest.json` folders are left alone and are no longer consumed.

## Validation

Set `PORT` to your assigned port and `AC_NO_PAUSE=1`. Run Run Local and confirm source scripts are served, stop that server, then run Deploy Local. Confirm the served HTML has `0.0.C`, versioned bundle URLs and no `__VERSION__`; request the bundle, manifest and an image. Inspect `Export/Local/build.json`.

Agents must never run Deploy Prod, claim VERSION or upload. No data refresh is needed before packaging.
