#!/usr/bin/env node
// @ts-check
/**
 * Deploy Local — serve the latest Export/VersionN on this machine.
 * Builds first when there is no export yet, or when run with --build.
 * Port: $PORT, else 8080 (Highpersonic3's reserved port; stop StartServer.cmd first).
 *
 * From a terminal the server runs in the foreground (Ctrl+C stops it). From the
 * dashboard (no TTY) it starts in the background and prints how to stop it.
 * See deploy.md and AgentController docs/RepositoryCommands.md.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { findPython, latestExportDir, root, runExport } from "./lib/export.mjs";

process.chdir(root);

const port = Number(process.env.PORT) || 8080;

if (process.argv.includes("--build") || !latestExportDir()) runExport();

const exportDir = latestExportDir();
if (!exportDir) {
  console.error("Deploy Local: no Export/VersionN folder found after building.");
  process.exit(1);
}

const python = findPython();
if (!python) {
  console.error("Python 3 was not found. Install it from https://www.python.org/downloads/ and retry.");
  process.exit(1);
}

if (!(await portIsFree(port))) {
  console.error(`Deploy Local: port ${port} is already in use (StartServer.cmd or an earlier Deploy Local?).`);
  console.error("Stop that server, or set PORT to another port, and retry.");
  process.exit(1);
}

const args = [...python.args, "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", exportDir];
const url = `http://127.0.0.1:${port}/`;
console.log(`Serving ${exportDir}`);
console.log(`Open ${url}`);
console.log("(/consent.js is served by the live site root, so it 404s locally; that's expected.)");

if (process.stdout.isTTY) {
  console.log("Press Ctrl+C to stop.");
  const child = spawn(python.cmd, args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  // Detached with no inherited pipes, so the dashboard's run finishes while the server keeps going.
  const child = spawn(python.cmd, args, { cwd: root, stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  console.log(`Server started in the background (PID ${child.pid}).`);
  console.log(process.platform === "win32" ? `Stop it with: taskkill /PID ${child.pid} /T /F` : `Stop it with: kill ${child.pid}`);
}

/** @param {number} p */
function portIsFree(p) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(p, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
