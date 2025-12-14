import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distTestDir = path.join(projectRoot, 'dist-test');

if (existsSync(distTestDir)) {
  rmSync(distTestDir, { recursive: true, force: true });
}

execSync('node ./node_modules/typescript/bin/tsc -p tsconfig.test.json', {
  cwd: projectRoot,
  stdio: 'inherit',
});

execSync('node --test "dist-test/tests/**/*.js"', {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true,
});
