#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, exportRoot, nextBuild, findPython } from './lib/build.mjs';
import { sourceOf } from '../scripts/release-version.mjs';
try {
  const python = findPython();
  const build = nextBuild();
  const source = sourceOf(root);
  const dir = `Export/Build${build}`;
  const result = spawnSync(python.cmd, [...python.args, 'export-static.py', '--output', dir], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Packaging failed (exit ${result.status ?? 'unknown'}).`);
  fs.writeFileSync(path.join(exportRoot, 'latest.json'), JSON.stringify({ build, dir, exportedAt: new Date().toISOString(), source }, null, 2) + '\n');
  console.log(`Build${build} ready (${source.commit}${source.uncommittedChanges ? ', uncommitted changes' : ''}). No release claimed or upload performed.`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
