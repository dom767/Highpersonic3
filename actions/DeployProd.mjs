#!/usr/bin/env node
// @ts-check
/**
 * Deploy Prod — claim N on GitHub, package a fresh build into Export/VersionN stamped 0.N.C,
 * upload it (assets first, HTML last) and verify the live asset version equals 0.N.C.
 * Humans only (dashboard confirms). Agents must never run this.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  compareToLocal,
  describe,
  exportRoot,
  highestRelease,
  packageBuild,
  prepareDir,
  requireClean,
  root,
  writeManifest,
} from "./lib/build.mjs";
import {
  assertHeadOnUpstream,
  claimVersion,
  commitCount,
  formatVersion,
  sourceOf,
} from "../scripts/release-version.mjs";

const s3 = "s3://baffledcat.com/highpersonic3/";
const publicUrl = "https://baffledcat.com/highpersonic3/";
const ASSET_VERSION_RE = /self\.__HIGHPERSONIC3_ASSET_VERSION__\s*=\s*["']([^"']+)["']/;

/** @param {string[]} args */
function aws(args) {
  console.log(`aws ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  const result = spawnSync("aws", args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error("AWS command failed. Check AWS CLI v2 and authentication (aws login).");
  }
}

/**
 * @param {string} expected
 */
async function verifyLive(expected) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${publicUrl}?deploycheck=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const html = response.ok ? await response.text() : "";
      const live = ASSET_VERSION_RE.exec(html)?.[1];
      if (live === expected) return;
      console.log(`Verification attempt ${attempt + 1}: live=${live ?? "(missing)"} expected=${expected}`);
    } catch (err) {
      console.log(`Verification attempt ${attempt + 1}: ${err instanceof Error ? err.message : err}`);
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Live asset version does not match the release; check the prefix and edge cache.");
}

try {
  const source = sourceOf(root);
  requireClean(source);
  assertHeadOnUpstream(root);
  const c = commitCount(root);
  const n = claimVersion(root, { floor: highestRelease() });
  const version = formatVersion(n, c);
  console.log(`Deploy Prod: ${describe(version, source)}`);

  const dir = prepareDir(path.join(exportRoot, `Version${n}`));
  await packageBuild({ dir, version });
  const manifest = writeManifest(dir, { version, n, c, source });
  compareToLocal(manifest);

  aws(["sts", "get-caller-identity"]);
  const longCache = "public, max-age=31536000, immutable";
  aws(["s3", "sync", dir, s3, "--delete", "--exclude", "index.html", "--exclude", "*.json.gz", "--cache-control", longCache]);
  aws(["s3", "sync", dir, s3, "--exclude", "*", "--include", "*.json.gz", "--content-type", "application/gzip", "--cache-control", longCache]);
  aws(["s3", "cp", path.join(dir, "index.html"), `${s3}index.html`, "--cache-control", "public, max-age=60"]);

  await verifyLive(version);
  console.log(`Version${n} (${version}) verified at ${publicUrl}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
