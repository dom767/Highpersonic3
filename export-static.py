#!/usr/bin/env python3
"""Prepare a static-hosting copy under Export/VersionN/ with textures.json."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from serve import ASSETS_DIR_NAME, _scan_texture_manifest

EXPORT_ROOT = "Export"
VERSION_PREFIX = "Version"
VERSION_DIR_PATTERN = re.compile(r"^Version(\d+)$")
TEXTURES_MANIFEST_NAME = "textures.json"
INDEX_HTML_NAME = "index.html"
BUNDLE_MIN_NAME = "app.bundle.min.js"
BUNDLE_FALLBACK_NAME = "app.bundle.js"

SCRIPT_SRC_PATTERN = re.compile(
    r'<script\s+[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>',
    re.IGNORECASE,
)

EXCLUDE_DIRS = {
    ".git",
    ".cursor",
    EXPORT_ROOT,
    "__pycache__",
}

EXCLUDE_FILES = {
    ".gitattributes",
    "TODO.txt",
    "serve.py",
    "export-static.py",
    "Export-Static.ps1",
    "Export-Static.cmd",
    "StartServer.ps1",
    "StartServer.cmd",
}


def _project_root() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _next_version_number(export_root: str) -> int:
    if not os.path.isdir(export_root):
        return 1

    highest = 0
    for name in os.listdir(export_root):
        path = os.path.join(export_root, name)
        if not os.path.isdir(path):
            continue
        match = VERSION_DIR_PATTERN.match(name)
        if match:
            highest = max(highest, int(match.group(1)))

    return highest + 1


def _should_skip(rel_path: str, name: str, is_dir: bool) -> bool:
    if is_dir:
        return name in EXCLUDE_DIRS
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
        if src.startswith(("http://", "https://", "//")):
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
    for candidate in ("npx", "npx.cmd"):
        path = shutil.which(candidate)
        if path:
            return path
    return None


def _minify_with_terser(source: str, output_path: str) -> bool:
    npx = _resolve_npx()
    if not npx:
        print("Warning: npx not found; skipping minification.")
        return False

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
            print(f"Warning: terser failed ({result.returncode}): {stderr or 'no output'}")
            return False
        return True
    except FileNotFoundError:
        print("Warning: terser invocation failed; skipping minification.")
        return False
    finally:
        os.unlink(temp_path)


def _rewrite_index_html(
    html_path: str,
    bundle_name: str,
    script_paths: list[str],
) -> None:
    with open(html_path, encoding="utf-8") as handle:
        html_content = handle.read()

    script_tags = [
        f'<script src="{src}"></script>'
        for src in script_paths
    ]
    block_pattern = re.compile(
        r"(?:\s*<script\s+[^>]*\bsrc=[\"'][^\"']+[\"'][^>]*>\s*</script>)+",
        re.IGNORECASE,
    )
    replacement = f'\n  <script src="{bundle_name}"></script>'
    new_content, count = block_pattern.subn(replacement, html_content, count=1)
    if count != 1:
        raise RuntimeError(
            f"Expected to replace one external script block in {html_path}, replaced {count}"
        )

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
) -> dict[str, object]:
    concat_source, raw_bytes = _concatenate_scripts(project_root, script_paths)
    min_path = os.path.join(export_dir, BUNDLE_MIN_NAME)
    bundle_name = BUNDLE_MIN_NAME

    if _minify_with_terser(concat_source, min_path):
        bundle_bytes = os.path.getsize(min_path)
    else:
        bundle_name = BUNDLE_FALLBACK_NAME
        fallback_path = os.path.join(export_dir, bundle_name)
        with open(fallback_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(concat_source)
        bundle_bytes = os.path.getsize(fallback_path)
        if os.path.isfile(min_path):
            os.remove(min_path)

    html_path = os.path.join(export_dir, INDEX_HTML_NAME)
    _rewrite_index_html(html_path, bundle_name, script_paths)
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

    export_root = os.path.join(project_root, EXPORT_ROOT)
    version_number = _next_version_number(export_root)
    version_label = VERSION_PREFIX + str(version_number)
    export_dir = os.path.join(export_root, version_label)

    os.makedirs(export_dir, exist_ok=True)

    script_paths = _load_bundled_script_paths(project_root)
    skip_scripts = {_normalize_rel_path(path) for path in script_paths}
    copied = _copy_tree(project_root, export_dir, skip_rel_paths=skip_scripts)
    texture_count = _write_textures_manifest(export_dir, project_root)
    bundle_info = _bundle_js(export_dir, project_root, script_paths)

    print(f"Export ready: {export_dir}")
    print(f"Version:      {version_label}")
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
    print()
    print("Upload (see BaffledCat/INFRASTRUCTURE.md for cache policy):")
    print(f"  # Long TTL assets")
    print(
        f"  aws s3 sync \"{export_dir}\" s3://YOUR-BUCKET/highpersonic3/ --delete "
        f"--cache-control \"public, max-age=31536000, immutable\" "
        f"--exclude index.html --exclude \"*.js\""
    )
    print(f"  # Short TTL (60s) HTML + JS")
    print(
        f"  aws s3 cp \"{os.path.join(export_dir, INDEX_HTML_NAME)}\" "
        f"s3://YOUR-BUCKET/highpersonic3/index.html --cache-control \"public, max-age=60\""
    )
    print(
        f"  aws s3 sync \"{export_dir}\" s3://YOUR-BUCKET/highpersonic3/ "
        f"--exclude \"*\" --include \"*.js\" --cache-control \"public, max-age=60\""
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
