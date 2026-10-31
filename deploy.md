# Highpersonic3 build and deployment

## Four commands

Run `RunDev.cmd`, `Build.cmd`, `DeployLocal.cmd` or `DeployProd.cmd`, or the corresponding `node actions/<Name>.mjs` from the dashboard. Wrappers contain no action logic and respect `AC_NO_PAUSE` on failure.

**Run Dev** opens `StartServer.cmd` in its own window and returns. It serves the working tree with `serve.py`, including the dynamic texture manifest, without a build. `PORT` defaults to the reserved human port 8080.

**Build** is the only packager. It creates the next `Export/Build<k>` without claiming VERSION or uploading. The build number identifies the snapshot, not a production release. `Export/latest.json` records the build directory, timestamp, source commit and whether the source had uncommitted changes. Failed builds never replace that manifest. Builds retain `__VERSION__` only in HTML. Never edit a completed build.

**Deploy Local** reads the manifest, prints the build and commit, stamps `b<k>-local` into a copy at `Export/Build<k>-local`, then opens a static Python server in its own window and returns. Repeating it reuses that local copy. It never rebuilds. Stop any server using the same port first; close the new window or press Ctrl+C to stop it.

**Deploy Prod** is for humans only. It reads the same manifest and prints the build and commit before doing anything else. It checks AWS authentication, claims VERSION using `scripts/release-version.mjs` (GitHub-backed numbering, including the highest existing release folder as a floor), stamps a copy at `Export/VersionN`, uploads that folder and checks the live asset-version global. It never rebuilds and takes no legacy `--no-build` or `--dry-run` flags. A failed release may consume a number; numbers are never reused. Claiming a release may fast-forward the clone, but deployment still uses the original build snapshot.

Both deployments fail with “run Build first” when no completed build is recorded. Local stamping and production stamping leave the original build untouched. These explicit four-command rules supersede the older standards text describing build-during-deploy and local Version folders.

## Package details

The internal `export-static.py --output Export/Build<k>` is called only by Build. It preserves this app's classic script order, minifies the bundle with Terser (failure aborts), copies runtime images and generates `assets/textures.json`. Source scripts, servers, actions, release tooling and docs are omitted. Development requires no packaging step.

`index.html` contains the versioned bundle URL (`?v=__VERSION__`) and `self.__HIGHPERSONIC3_ASSET_VERSION__`. Runtime texture manifest and image requests read that global. The site-root `/consent.js` reference is versioned too; it is supplied by the parent site and will return 404 on the standalone local server. JavaScript and data contain no baked deployment version. No worker entry points exist.

## Production target

- Owned prefix: `s3://baffledcat.com/highpersonic3/`
- Public URL: https://baffledcat.com/highpersonic3/
- Static assets, including JS/CSS: `public, max-age=31536000, immutable`
- `*.json.gz`: the same immutable cache, `Content-Type: application/gzip`, no Content-Encoding
- `index.html`: `public, max-age=60`, uploaded last

Deployment syncs only this app's prefix. AWS CLI v2 must already be authenticated (`aws login` if required). The release helper needs GitHub access. No secrets are stored in these scripts. Live verification retries a cache-busted request and requires the HTML asset-version global to match the claimed release. DNS and Cloudflare changes are separate human operations.

## Validation

Set `PORT` to your assigned port and `AC_NO_PAUSE=1`. Run Run Dev and confirm source scripts are served, stop that server, run Build, then Deploy Local. Confirm the served HTML has `b<k>-local`, versioned bundle URLs and no `__VERSION__`; request the bundle, manifest and an image. Inspect the manifest's source commit.

Agents must never run Deploy Prod, claim VERSION or upload. Test production stamping by importing `stampCopy` from `actions/lib/build.mjs` and stamping the latest build to a fresh scratch folder under Export. Confirm HTML replacement and byte-identical bundles/data, then remove that scratch folder. No data refresh is needed before packaging.
