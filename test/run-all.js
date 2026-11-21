// Runs every unit/integration test file in sequence and prints a summary.
//   node test/run-all.js            # all fast suites
//   node test/run-all.js --slow     # also the lag-proxy suite (timing-sensitive) and the browser e2e
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = [
  'sim', 'server', 'interp', 'local', 'replay', 'chat', 'stats', 'couch', 'fight',
  'achievements', 'settings', 'tutorial', 'logos',
].map((n) => `test/${n}.test.js`);
const SLOW = ['test/netem.test.js', 'test/e2e.js'];
const files = process.argv.includes('--slow') ? [...FAST, ...SLOW] : FAST;

const results = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: root, encoding: 'utf8', timeout: 600000 });
  const ok = r.status === 0;
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/);
  const tail = out.filter((l) => /pass|fail|ok\b|error/i.test(l)).slice(-1)[0] || out.slice(-1)[0] || '';
  results.push({ f, ok, ms: Date.now() - t0, tail: tail.trim().slice(0, 90) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(28)} ${String(Date.now() - t0).padStart(6)} ms  ${tail.trim().slice(0, 90)}`);
  if (!ok) console.log(out.slice(-25).map((l) => '      ' + l).join('\n'));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
