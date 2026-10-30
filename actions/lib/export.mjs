// @ts-check
/**
 * Shared helpers for the repository commands (Build / Deploy Local / Deploy Prod).
 * Lives in a subfolder so the dashboard (which lists actions/*.mjs) does not
 * show it as a button (see docs/RepositoryCommands.md).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const exportRoot = path.join(root, "Export");

const VERSION_DIR = /^Version(\d+)$/;

/** Find a working Python 3 launcher: `py -3` first, then `python`. */
export function findPython() {
  /** @type {[string, string[]][]} */
  const candidates = [["py", ["-3"]], ["python", []], ["python3", []]];
  for (const [cmd, args] of candidates) {
    const probe = spawnSync(cmd, [...args, "--version"], { stdio: "ignore" });
    if (probe.status === 0) return { cmd, args };
  }
  return null;
}

/** Run export-static.py, which writes the next Export/VersionN. */
export function runExport() {
  const python = findPython();
  if (!python) {
    console.error("Python 3 was not found. Install it from https://www.python.org/downloads/ and retry.");
    process.exit(1);
  }
  const result = spawnSync(python.cmd, [...python.args, "export-static.py"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`export-static.py failed (exit ${result.status ?? "?"}).`);
    process.exit(result.status || 1);
  }
}

/** Absolute path of the highest Export/VersionN, or null if there is none. */
export function latestExportDir() {
  if (!fs.existsSync(exportRoot)) return null;
  let best = -1;
  let bestName = "";
  for (const entry of fs.readdirSync(exportRoot, { withFileTypes: true })) {
    const match = entry.isDirectory() && VERSION_DIR.exec(entry.name);
    if (match && Number(match[1]) > best) {
      best = Number(match[1]);
      bestName = entry.name;
    }
  }
  return best < 0 ? null : path.join(exportRoot, bestName);
}
