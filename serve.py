#!/usr/bin/env python3
"""Static file server with a dynamic texture manifest at /assets/textures.json."""

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
TEXTURES_MANIFEST_PATH = "/assets/textures.json"
ASSETS_DIR_NAME = "assets"


def _label_from_basename(basename: str) -> str:
    label = basename.replace("-", " ").replace("_", " ").strip()
    if label and label == label.lower():
        label = label.title()
    return label or basename


def _scan_texture_manifest(project_root: str) -> list[dict[str, str]]:
    assets_dir = os.path.join(project_root, ASSETS_DIR_NAME)
    if not os.path.isdir(assets_dir):
        return []

    entries: list[dict[str, str]] = []
    for name in os.listdir(assets_dir):
        if name == "textures.json":
            continue
        path = os.path.join(assets_dir, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_EXTENSIONS:
            continue
        basename = os.path.splitext(name)[0]
        entries.append(
            {
                "path": f"{ASSETS_DIR_NAME}/{name}",
                "label": _label_from_basename(basename),
            }
        )

    entries.sort(key=lambda e: e["label"].lower())
    return entries


class TextureManifestHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == TEXTURES_MANIFEST_PATH:
            self._serve_textures_manifest()
            return
        super().do_GET()

    def _serve_textures_manifest(self) -> None:
        project_root = os.path.dirname(os.path.abspath(__file__))
        payload = json.dumps(_scan_texture_manifest(project_root)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    project_root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_root)
    server = ThreadingHTTPServer(("", port), TextureManifestHandler)
    print(f"Serving '{project_root}' on http://localhost:{port}")
    print("Press Ctrl+C to stop the server.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
