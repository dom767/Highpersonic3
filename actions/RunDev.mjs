#!/usr/bin/env node
import { openWindow } from './lib/build.mjs';
try {
  openWindow('Highpersonic3 Run Dev', 'StartServer.cmd');
  console.log(`Working tree: http://localhost:${Number(process.env.PORT) || 8080}/ (close the server window to stop).`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
