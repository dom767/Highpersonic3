# Static export and deploy pattern

This document describes a reusable packaging pattern for browser apps that ship as static files (HTML, CSS, JS, images, and other assets). The goal is a repeatable local export that produces a clean, versioned distribution folder, then optionally uploads it to object storage.

Use this as a template for other applications: keep the same folder layout and pipeline stages, and swap project-specific names, exclusions, and hosting details.

## Goals

- Produce a self-contained static build that can be hosted without a local Python/Node server.
- Keep every export in an incrementing version folder so previous builds remain available for comparison or rollback.
- Reduce HTTP requests and payload size by concatenating and minifying application JavaScript.
- Exclude development-only files (servers, export tooling, editor config, skills, etc.).
- Upload with cache headers that favour long-lived assets and short-lived HTML/JS entry points.

## Layout

```text
ProjectRoot/
  index.html              # source entry page (many <script src="..."> tags in dev)
  *.js / feature folders  # source modules loaded individually during development
  assets/                 # images and other static media
  export-static.py        # packaging script (Python)
  Export-Static.ps1       # Windows wrapper: export + optional S3 upload
  Export-Static.cmd       # double-click / CLI entry that calls the .ps1
  Export/                 # generated; typically gitignored
    Version1/
    Version2/
    VersionN/             # latest successful export
```

Conventions:

| Item | Convention |
| --- | --- |
| Export root | `Export/` at the project root |
| Version folders | `Version1`, `Version2`, … (no zero-padding) |
| Next version | Highest existing `VersionN` + 1; if none exist, start at `1` |
| Git | Ignore `Export/` so builds stay local unless you choose otherwise |

Each `VersionN` folder is a complete snapshot of what should be published. Do not mutate an old version in place; always create the next number.

## Pipeline overview

```text
Source tree
    │
    ▼
1. Choose next VersionN under Export/
    │
    ▼
2. Copy publishable files (with exclusions)
    │
    ▼
3. Generate any build-time manifests (optional)
    │
    ▼
4. Concatenate local JS in HTML script order
    │
    ▼
5. Minify the concatenated bundle (fallback: unminified concat)
    │
    ▼
6. Rewrite index.html to a single bundle <script>
    │
    ▼
7. Delete the individual source .js files from the export
    │
    ▼
8. (Optional) Upload latest VersionN to hosting
```

## Running an export

### Prerequisites

- **Python 3** — runs the packaging script.
- **Node.js / npx** (recommended) — used to invoke [Terser](https://terser.org/) for minification. If `npx` is missing or Terser fails, the export still succeeds with an unminified concatenated bundle.
- **AWS CLI v2** (only if uploading) — authenticated for the target bucket.

### Commands

```powershell
# Full export + upload (defaults: bucket/prefix configured in the wrapper)
.\Export-Static.cmd

# Export only (no upload)
.\Export-Static.ps1 -SkipUpload

# Export + upload to a custom location
.\Export-Static.ps1 -S3Bucket "example.com" -S3Prefix "my-app/"
```

Or call the Python packager directly:

```powershell
py -3 export-static.py
# or: python export-static.py
```

The PowerShell wrapper always runs the Python export first, then (unless `-SkipUpload`) finds the newest `Export/VersionN` and syncs it to S3.

## Stage details

### 1. Version selection

Scan `Export/` for directories matching `^Version(\d+)$`. Take the maximum number and add one. Create `Export/VersionN/`.

This keeps a linear history of builds without overwriting. Useful for:

- Diffing two releases locally
- Re-uploading an older folder if needed
- Avoiding accidental clobber of a known-good package

### 2. Copy with exclusions

Copy the project tree into the new version folder, skipping development and tooling paths.

Typical exclusions:

- VCS / editor: `.git`, `.cursor`
- The export root itself: `Export/`
- Local servers and packaging scripts: `serve.py`, `export-static.py`, `Export-Static.*`, `StartServer.*`
- Docs or agent helpers that are not part of the runtime: `SKILL.md`, `TODO.txt`, etc.
- Build artefacts: `__pycache__`, etc.

Also skip the individual JS modules that will be replaced by the bundle (see below), so they are never written then deleted unnecessarily—or delete them after bundling; either approach is fine as long as the final folder only contains the bundle.

### 3. Build-time manifests (optional)

If the app discovers assets at runtime via a server API in development, generate a static equivalent during export (for example `assets/textures.json` listing texture files). Other apps might generate:

- An asset manifest
- A config stamp / build id
- A service-worker precache list

Keep this step deterministic and based only on files present in the source tree.

### 4. JavaScript concatenation

Parse `index.html` for local `<script src="...">` tags in document order. Ignore absolute/CDN URLs (`http:`, `https:`, `//`).

Concatenate those files in the same order, joining with `;\n` so ASI edge cases between files are less likely to break the bundle.

Why order matters: many small apps rely on script-tag order for globals rather than a module bundler. Preserving HTML order keeps behaviour identical to development.

### 5. Minification

Preferred output name: `app.bundle.min.js`.

Run Terser via `npx --yes terser` with compress (`-c`) and mangle (`-m`). Write the result into the export folder.

If minification is unavailable:

- Write `app.bundle.js` (concatenated, not minified)
- Point `index.html` at that fallback name
- Treat this as a warning, not a hard failure, so packaging never depends on Node being installed

Report raw vs bundled byte sizes in the export log so size regressions are obvious.

### 6. Rewrite the HTML entry

Replace the contiguous block of local external script tags with a single tag:

```html
<script src="app.bundle.min.js"></script>
```

(or `app.bundle.js` on fallback).

Leave CDN / third-party scripts alone if they were not part of the concatenated set.

### 7. Remove source modules from the export

Delete every JS file that was folded into the bundle, then remove any directories that became empty. The published tree should not ship both the bundle and the original modules.

### 8. Upload (optional)

Upload the **latest** `Export/VersionN` (not the whole `Export/` tree). Suggested cache policy for static hosting on S3 (or compatible):

| Content | Cache-Control | Rationale |
| --- | --- | --- |
| Images, fonts, media, other immutable assets | `public, max-age=31536000, immutable` | Rarely change; long cache is safe when filenames are stable or content-hashed |
| `index.html` | `public, max-age=60` | Must pick up new bundle references quickly |
| `*.js` (including the bundle) | `public, max-age=60` | Bundle name is often stable (`app.bundle.min.js`); short TTL avoids stale JS after deploy |

Example sync pattern:

1. Sync everything except `index.html` and `*.js` with long cache + `--delete`.
2. Copy `index.html` with 60s cache.
3. Sync only `*.js` with 60s cache.

`--delete` keeps the remote prefix aligned with the export folder. Adjust bucket and key prefix per application.

## Adapting this pattern to another app

1. **Copy the packaging scripts** (`export-static.py` + platform wrappers) into the new project.
2. **Set exclusions** for that project's tooling and docs.
3. **Confirm script discovery** — development `index.html` (or equivalent) must list local scripts in load order.
4. **Choose bundle filenames** — keep `app.bundle.min.js` / `app.bundle.js` unless the host already uses another convention.
5. **Add or remove manifest generation** as needed.
6. **Point the upload wrapper** at the correct bucket/prefix, or drop upload and publish the `VersionN` folder some other way (Netlify, GitHub Pages, rsync, etc.).
7. **Gitignore `Export/`** unless you intentionally version builds in the repo.

## What stays in source vs what ships

| In source (development) | In `Export/VersionN` (distribution) |
| --- | --- |
| Many small `.js` files + many script tags | One JS bundle + one script tag |
| Optional local server / live asset APIs | Static files (+ generated manifests) |
| Editor rules, skills, export tooling | Omitted |
| Working tree as edited | Frozen snapshot for that version number |

## Checklist for a healthy export

- [ ] New `Export/VersionN` created (number incremented)
- [ ] No packaging/server scripts in the version folder
- [ ] `index.html` references a single app bundle
- [ ] Individual bundled source `.js` files are gone from the export
- [ ] Minified bundle present when Node/npx is available; otherwise unminified fallback
- [ ] Any required manifests written
- [ ] Upload (if used) targets only the latest version folder with appropriate cache headers

## Design notes

- **No full bundler required.** Concatenation + optional Terser is enough for apps that already load scripts as globals in a fixed order. If you later adopt ES modules and imports, replace the concat step with a real bundler but keep the versioned `Export/VersionN` and upload stages.
- **Version folders are the artefact of record.** CI or humans should publish a folder, not a floating “dist” that is overwritten without history.
- **Fail soft on minify; fail hard on missing scripts.** A missing source file or a failed HTML rewrite should abort the export. Missing Terser should warn and continue.
- **Keep the wrapper thin.** Python (or another language) owns packaging logic; the shell script owns environment checks and upload.
