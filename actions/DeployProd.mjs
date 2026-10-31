#!/usr/bin/env node
// Humans only. Deploys an existing Build; never invokes the packager.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, exportRoot, latestBuild, describe, highestRelease, stampCopy } from './lib/build.mjs';
import { claimVersion } from '../scripts/release-version.mjs';
const s3 = 's3://baffledcat.com/highpersonic3/';
const publicUrl = 'https://baffledcat.com/highpersonic3/';
function aws(args) {
  console.log(`aws ${args.map(arg => JSON.stringify(arg)).join(' ')}`);
  const result = spawnSync('aws', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('AWS command failed. Check AWS CLI v2 and authentication (aws login).');
}
try {
  const build = latestBuild();
  console.log(`Deploy Prod: ${describe(build)}`);
  if (process.argv.length > 2) throw new Error('Deploy Prod takes no options; run Build separately first.');
  aws(['sts', 'get-caller-identity']);
  const version = claimVersion(root, { floor: highestRelease() });
  const dir = stampCopy(build, path.join(exportRoot, `Version${version}`), version);
  const longCache = 'public, max-age=31536000, immutable';
  aws(['s3', 'sync', dir, s3, '--delete', '--exclude', 'index.html', '--exclude', '*.json.gz', '--cache-control', longCache]);
  aws(['s3', 'sync', dir, s3, '--exclude', '*', '--include', '*.json.gz', '--content-type', 'application/gzip', '--cache-control', longCache]);
  aws(['s3', 'cp', path.join(dir, 'index.html'), `${s3}index.html`, '--cache-control', 'public, max-age=60']);
  let verified = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${publicUrl}?deploycheck=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const html = response.ok ? await response.text() : '';
      const live = /self\.__HIGHPERSONIC3_ASSET_VERSION__\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
      if (live === String(version)) { verified = true; break; }
    } catch (err) { console.log(`Verification attempt ${attempt + 1}: ${err.message}`); }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (!verified) throw new Error('Live asset version does not match the release; check the prefix and edge cache.');
  console.log(`Version${version} verified at ${publicUrl}`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
