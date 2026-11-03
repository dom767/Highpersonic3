#!/usr/bin/env python3
"""Package a static-hosting copy into Export/Local or Export/VersionN with textures.json."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from serve import ASSETS_DIR_NAME, _scan_texture_manifest

EXPORT_ROOT = "Export"
TEXTURES_MANIFEST_NAME = "textures.json"
INDEX_HTML_NAME = "index.html"
BUNDLE_MIN_NAME = "app.bundle.min.js"
OUTPUT_NAME_PATTERN = re.compile(r"(?:Local|Version\d+)$")

SCRIPT_SRC_PATTERN = re.compile(
    r'<script\s+[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>',
    re.IGNORECASE,
)

# Root-relative (/consent.js) and absolute URLs are served by the site, not bundled.
EXTERNAL_SRC_PREFIXES = ("http://", "https://", "/")

EXCLUDE_DIRS = {
    ".git",
    ".cursor",
    EXPORT_ROOT,
    "__pycache__",
    "actions",
    "scripts",
    "node_modules",
}

EXCLUDE_FILES = {
    ".gitattributes",
    ".gitignore",
    "TODO.txt",
    "serve.py",
    "export-static.py",
    "StartServer.ps1",
    "StartServer.cmd",
    "RunLocal.cmd",
    "VERSION",
    "DeployLocal.cmd",
    "DeployProd.cmd",
    "README.md",
    "deploy.md",
}


def _project_root() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _should_skip(rel_path: str, name: str, is_dir: bool) -> bool:
    if is_dir:
        return name in EXCLUDE_DIRS
    if name.startswith(".env") or name.endswith(".deploy-secrets.env"):
        return True
    if name in EXCLUDE_FILES:
        return True
    if name == "SKILL.md":
        return True
    return False


def _normalize_rel_path(rel_path: str) -> str:
    return rel_path.replace("\\", "/")


def _load_bundled_script_paths(project_root: str) -> list[str]:
    html_path = os.path.join(project_root, INDEX_HTML_NAME)
    with open(html_path, encoding="utf-8") as handle:
        html_content = handle.read()
    script_paths = _parse_script_sources(html_content)
    if not script_paths:
        raise RuntimeError(f"No external script tags found in {html_path}")
    return script_paths


def _copy_tree(
    src_root: str,
    dest_root: str,
    *,
    skip_rel_paths: set[str] | None = None,
) -> int:
    skip_rel_paths = skip_rel_paths or set()
    copied = 0
    for dir_path, dir_names, file_names in os.walk(src_root):
        rel_dir = os.path.relpath(dir_path, src_root)
        if rel_dir == ".":
            rel_dir = ""

        dir_names[:] = [
            name
            for name in dir_names
            if not _should_skip(
                os.path.join(rel_dir, name) if rel_dir else name,
                name,
                True,
            )
        ]

        for name in file_names:
            rel_path = os.path.join(rel_dir, name) if rel_dir else name
            if _should_skip(rel_path, name, False):
                continue
            if _normalize_rel_path(rel_path) in skip_rel_paths:
                continue

            src_path = os.path.join(dir_path, name)
            dest_path = os.path.join(dest_root, rel_path)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            shutil.copy2(src_path, dest_path)
            copied += 1

    return copied


def _write_textures_manifest(export_root: str, project_root: str) -> int:
    manifest = _scan_texture_manifest(project_root)
    assets_dir = os.path.join(export_root, ASSETS_DIR_NAME)
    os.makedirs(assets_dir, exist_ok=True)
    manifest_path = os.path.join(assets_dir, TEXTURES_MANIFEST_NAME)
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    return len(manifest)


def _parse_script_sources(html_content: str) -> list[str]:
    sources: list[str] = []
    for match in SCRIPT_SRC_PATTERN.finditer(html_content):
        src = match.group(1).strip()
        if src.startswith(EXTERNAL_SRC_PREFIXES):
            continue
        sources.append(src.replace("\\", "/"))
    return sources


def _concatenate_scripts(src_root: str, script_paths: list[str]) -> tuple[str, int]:
    parts: list[str] = []
    total_bytes = 0
    for rel_path in script_paths:
        abs_path = os.path.join(src_root, rel_path.replace("/", os.sep))
        if not os.path.isfile(abs_path):
            raise FileNotFoundError(f"Bundled script not found: {rel_path}")
        with open(abs_path, encoding="utf-8") as handle:
            content = handle.read()
        parts.append(content)
        total_bytes += len(content.encode("utf-8"))

    return ";\n".join(parts) + "\n", total_bytes


def _resolve_npx() -> str | None:
    # On Windows, bare "npx" can resolve to Node's extensionless bash shim,
    # which CreateProcess can't run (WinError 193), so try npx.cmd first.
    candidates = ("npx.cmd", "npx") if os.name == "nt" else ("npx", "npx.cmd")
    for candidate in candidates:
        path = shutil.which(candidate)
        if path:
            return path
    return None


def _minify_with_terser(source: str, output_path: str) -> None:
    npx = _resolve_npx()
    if not npx:
        raise RuntimeError("npx is required to minify the build.")

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".js",
        delete=False,
    ) as handle:
        handle.write(source)
        temp_path = handle.name

    try:
        result = subprocess.run(
            [
                npx,
                "--yes",
                "terser",
                temp_path,
                "-c",
                "-m",
                "-o",
                output_path,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            raise RuntimeError(f"Terser failed ({result.returncode}): {stderr}")
    except OSError as exc:
        raise RuntimeError("Could not run Terser") from exc
    finally:
        os.unlink(temp_path)


def _rewrite_index_html(
    html_path: str,
    bundle_name: str,
    script_paths: list[str],
    version: str,
) -> None:
    with open(html_path, encoding="utf-8") as handle:
        html_content = handle.read()

    block_pattern = re.compile(
        r"(?:\s*<script\s+[^>]*\bsrc=[\"'](?!https?://|/)[^\"']+[\"'][^>]*>\s*</script>)+",
        re.IGNORECASE,
    )
    replacement = f'\n  <script src="{bundle_name}?v={version}"></script>'
    new_content, count = block_pattern.subn(replacement, html_content, count=1)
    if count != 1:
        raise RuntimeError(
            f"Expected to replace one external script block in {html_path}, replaced {count}"
        )

    new_content = new_content.replace("__VERSION__", version)
    if "__VERSION__" in new_content:
        raise RuntimeError(f"Version placeholder left in {html_path}")
    if version not in new_content:
        raise RuntimeError(f"Packaged HTML is missing version {version}")

    with open(html_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(new_content)


def _delete_bundled_files(export_dir: str, script_paths: list[str]) -> int:
    removed = 0
    for rel_path in script_paths:
        abs_path = os.path.join(export_dir, rel_path.replace("/", os.sep))
        if os.path.isfile(abs_path):
            os.remove(abs_path)
            removed += 1
    return removed


def _remove_empty_dirs(export_dir: str, script_paths: list[str]) -> int:
    candidates: set[str] = set()
    for rel_path in script_paths:
        dir_part = os.path.dirname(rel_path.replace("/", os.sep))
        while dir_part:
            candidates.add(os.path.join(export_dir, dir_part))
            dir_part = os.path.dirname(dir_part)

    removed = 0
    for dir_path in sorted(candidates, key=lambda path: path.count(os.sep), reverse=True):
        if not os.path.isdir(dir_path):
            continue
        try:
            if not os.listdir(dir_path):
                os.rmdir(dir_path)
                removed += 1
        except OSError:
            continue
    return removed


def _bundle_js(
    export_dir: str,
    project_root: str,
    script_paths: list[str],
    version: str,
) -> dict[str, object]:
    concat_source, raw_bytes = _concatenate_scripts(project_root, script_paths)
    min_path = os.path.join(export_dir, BUNDLE_MIN_NAME)
    bundle_name = BUNDLE_MIN_NAME

    _minify_with_terser(concat_source, min_path)
    bundle_bytes = os.path.getsize(min_path)

    html_path = os.path.join(export_dir, INDEX_HTML_NAME)
    _rewrite_index_html(html_path, bundle_name, script_paths, version)
    removed = _delete_bundled_files(export_dir, script_paths)
    empty_dirs_removed = _remove_empty_dirs(export_dir, script_paths)

    return {
        "bundle_name": bundle_name,
        "script_count": len(script_paths),
        "raw_bytes": raw_bytes,
        "bundle_bytes": bundle_bytes,
        "removed": removed,
        "empty_dirs_removed": empty_dirs_removed,
    }


def main() -> int:
    project_root = _project_root()
    os.chdir(project_root)

    parser = argparse.ArgumentParser(
        description="Internal packager; called by Deploy Local / Deploy Prod via packageBuild"
    )
    parser.add_argument("--output", required=True, help="Export/Local or Export/VersionN")
    parser.add_argument("--version", required=True, help="Asset version string (0.N.C)")
    args = parser.parse_args()

    version = str(args.version).strip()
    if not re.fullmatch(r"[\w.-]+", version):
        raise RuntimeError(f"Invalid asset version: {version}")

    export_dir = os.path.abspath(os.path.join(project_root, args.output))
    export_root = os.path.join(project_root, EXPORT_ROOT)
    if os.path.dirname(export_dir) != export_root or not OUTPUT_NAME_PATTERN.fullmatch(
        os.path.basename(export_dir)
    ):
        raise RuntimeError("Output must be Export/Local or Export/VersionN")

    # prepareDir may have already created an empty destination.
    os.makedirs(export_dir, exist_ok=True)

    script_paths = _load_bundled_script_paths(project_root)
    skip_scripts = {_normalize_rel_path(path) for path in script_paths}
    copied = _copy_tree(project_root, export_dir, skip_rel_paths=skip_scripts)
    texture_count = _write_textures_manifest(export_dir, project_root)
    bundle_info = _bundle_js(export_dir, project_root, script_paths, version)

    print(f"Export ready: {export_dir}")
    print(f"Version:      {version}")
    print(f"Files copied: {copied}")
    print(f"Textures:     {texture_count} listed in assets/{TEXTURES_MANIFEST_NAME}")
    print(f"JS bundle:    {bundle_info['bundle_name']}")
    print(
        f"              {bundle_info['script_count']} scripts -> "
        f"{bundle_info['raw_bytes']:,} bytes raw -> "
        f"{bundle_info['bundle_bytes']:,} bytes bundled"
    )
    print(f"              {bundle_info['removed']} source .js files removed from export")
    if bundle_info["empty_dirs_removed"]:
        print(
            f"              {bundle_info['empty_dirs_removed']} empty folders removed from export"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
