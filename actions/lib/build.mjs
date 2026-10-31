// Shared helpers, kept below actions/ so they are not dashboard buttons.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const exportRoot = path.join(root, 'Export');
export function findPython() {
  for (const [cmd, args] of [['py', ['-3']], ['python', []], ['python3', []]]) {
    if (spawnSync(cmd, [...args, '--version'], { stdio: 'ignore' }).status === 0) return { cmd, args };
  }
  throw new Error('Python 3 not found. Install Python 3 and retry.');
}
function highest(pattern) {
  if (!fs.existsSync(exportRoot)) return 0;
  return fs.readdirSync(exportRoot, { withFileTypes: true }).reduce((n, entry) => {
    const match = entry.isDirectory() && pattern.exec(entry.name);
    return match ? Math.max(n, Number(match[1])) : n;
  }, 0);
}
export const highestRelease = () => highest(/^Version(\d+)$/);
export const nextBuild = () => highest(/^Build(\d+)$/) + 1;
export function latestBuild() {
  let build;
  try { build = JSON.parse(fs.readFileSync(path.join(exportRoot, 'latest.json'), 'utf8')); } catch {}
  if (!build || !Number.isInteger(build.build) || build.build < 1 ||
      build.dir !== `Export/Build${build.build}` || !build.source ||
      !fs.existsSync(path.join(root, build.dir, 'index.html'))) {
    throw new Error('No completed build found; run Build first.');
  }
  return build;
}
export function describe(build) {
  return `Build${build.build}, commit ${build.source.commit || 'unknown'}${build.source.uncommittedChanges ? ' (uncommitted changes)' : ''}`;
}
export function stampCopy(build, destination, version) {
  if (!/^[\w.-]+$/.test(String(version))) throw new Error('Invalid asset version.');
  if (fs.existsSync(destination)) throw new Error(`Deployment folder already exists: ${destination}`);
  fs.cpSync(path.join(root, build.dir), destination, { recursive: true, errorOnExist: true, force: false });
  function stamp(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stamp(file);
      else {
        const bytes = fs.readFileSync(file);
        if (entry.name.endsWith('.html')) fs.writeFileSync(file, bytes.toString('utf8').replaceAll('__VERSION__', String(version)));
        else if (bytes.includes(Buffer.from('__VERSION__'))) throw new Error(`Version placeholder outside HTML: ${file}`);
      }
    }
  }
  stamp(destination);
  return destination;
}
export function openWindow(title, command, args = [], cwd = root) {
  if (process.platform !== 'win32') throw new Error('Window launch requires Windows.');
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const line = [command, ...args].map(value => /[\s"&|<>^]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value)).join(' ');
  const script = `Start-Process -FilePath $env:ComSpec -WorkingDirectory ${literal(cwd)} -ArgumentList @('/k', ${literal(`title ${title} & call ${line}`)})`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Could not open server window.');
}
