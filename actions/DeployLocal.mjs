#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { latestBuild, describe, stampCopy, exportRoot, findPython, openWindow } from './lib/build.mjs';
try {
  const build = latestBuild();
  console.log(`Deploy Local: ${describe(build)}`);
  if (process.argv.length > 2) throw new Error('Deploy Local takes no options; run Build separately first.');
  const python = findPython();
  const version = `b${build.build}-local`;
  const dir = path.join(exportRoot, `Build${build.build}-local`);
  if (!fs.existsSync(dir)) stampCopy(build, dir, version);
  const port = Number(process.env.PORT) || 8080;
  openWindow(`Highpersonic3 ${version}`, python.cmd, [...python.args, '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir]);
  console.log(`Serving ${dir} at http://localhost:${port}/ (close the server window to stop).`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
