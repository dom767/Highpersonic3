#!/usr/bin/env node
// @ts-check
/**
 * Deploy Prod — build the next Export/VersionN and upload it to
 * s3://baffledcat.com/highpersonic3/, then check the live index.html matches.
 * Humans only (the dashboard confirms first); agents must never run this.
 *
 *   node actions/DeployProd.mjs              build, then upload
 *   node actions/DeployProd.mjs --no-build   upload the latest existing export
 *   node actions/DeployProd.mjs --dry-run    build, print the aws commands, upload nothing
 *
 * See deploy.md and AgentController standards/guidelines/deploy.md.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { latestExportDir, root, runExport } from "./lib/export.mjs";

const S3_BUCKET = "baffledcat.com";
const S3_PREFIX = "highpersonic3/";
const PUBLIC_URL = "https://baffledcat.com/highpersonic3/";
const LONG_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=60";

process.chdir(root);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

if (!argv.includes("--no-build")) runExport();

const exportDir = latestExportDir();
if (!exportDir) {
  console.error("Deploy Prod: no Export/VersionN folder found.");
  process.exit(1);
}
const indexPath = path.join(exportDir, "index.html");
const s3Base = `s3://${S3_BUCKET}/${S3_PREFIX}`;

/** @type {[string, string[]][]} */
const steps = [
  ["1/3 Long-cache assets", ["s3", "sync", exportDir, s3Base, "--delete", "--cache-control", LONG_CACHE, "--exclude", "index.html", "--exclude", "*.js"]],
  ["2/3 JS with 60s cache", ["s3", "sync", exportDir, s3Base, "--exclude", "*", "--include", "*.js", "--cache-control", SHORT_CACHE]],
  ["3/3 index.html with 60s cache (last)", ["s3", "cp", indexPath, `${s3Base}index.html`, "--cache-control", SHORT_CACHE]],
];

console.log("");
console.log(`Deploy Prod: ${exportDir} -> ${s3Base}`);
for (const [, args] of steps) console.log(`  aws ${args.map(quote).join(" ")}`);

if (dryRun) {
  console.log("");
  console.log("--dry-run: nothing uploaded.");
  process.exit(0);
}

if (spawnSync("aws", ["--version"], { stdio: "ignore", shell: true }).status !== 0) {
  console.error("AWS CLI was not found. Install AWS CLI v2 and retry.");
  process.exit(1);
}
if (spawnSync("aws", ["sts", "get-caller-identity"], { stdio: "inherit", shell: true }).status !== 0) {
  console.error("AWS credentials are not valid. Run `aws login` (or `aws sso login`) and retry.");
  process.exit(1);
}

for (const [label, args] of steps) {
  console.log("");
  console.log(label);
  const result = spawnSync("aws", args.map(quote), { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`Deploy Prod: "${label}" failed (exit ${result.status ?? "?"}).`);
    process.exit(result.status || 1);
  }
}

// Verify: the live index.html should be the one we just uploaded. The query string
// gives a fresh Cloudflare cache key so a stale edge copy doesn't hide the result.
console.log("");
console.log(`Verifying ${PUBLIC_URL}`);
const expected = normalise(fs.readFileSync(indexPath, "utf8"));
let live = "";
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    const response = await fetch(`${PUBLIC_URL}?deploycheck=${Date.now()}`, { cache: "no-store" });
    live = response.ok ? normalise(await response.text()) : "";
  } catch (err) {
    console.log(`  attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
  }
  if (live === expected) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (live !== expected) {
  console.error("Deploy Prod: the live index.html does not match the upload (wrong prefix or stale cache).");
  console.error("Purge the Cloudflare cache for the HTML/JS URLs and check again.");
  process.exit(1);
}
console.log(`Upload complete and verified: ${path.basename(exportDir)} is live at ${PUBLIC_URL}`);

/** @param {string} text */
function normalise(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Quote one argument for the shell (aws is a .cmd/.exe found via PATH, so shell: true). @param {string} arg */
function quote(arg) {
  return /[\s"*&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
