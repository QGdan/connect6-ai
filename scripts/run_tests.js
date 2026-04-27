import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = 'tests';
const tests = readdirSync(testDir)
  .filter(name => name.endsWith('.ts'))
  .sort();

let failed = 0;

for (const test of tests) {
  const file = join(testDir, test);
  console.log(`RUN ${file}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`${failed} test file(s) failed.`);
  process.exit(1);
}

console.log(`${tests.length} test file(s) passed.`);
