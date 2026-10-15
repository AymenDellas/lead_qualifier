import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('tests/copy-studio').filter(name => name.endsWith('.test.ts')).map(name => `tests/copy-studio/${name}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
