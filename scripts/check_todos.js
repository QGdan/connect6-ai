import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'scripts', 'tests'];
const markers = /\b(TODO|FIXME|HACK)\b/;
const ignoredDirs = new Set(['node_modules', 'dist', '.git']);
const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|md|json|css)$/.test(entry)) continue;
    if (full.endsWith('scripts\\check_todos.js') || full.endsWith('scripts/check_todos.js')) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (markers.test(line)) {
        hits.push(`${full}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

for (const root of roots) {
  walk(root);
}

if (hits.length > 0) {
  console.error('Outstanding TODO markers found:');
  for (const hit of hits) console.error(hit);
  process.exit(1);
}

console.log('No TODO/FIXME/HACK markers found.');
