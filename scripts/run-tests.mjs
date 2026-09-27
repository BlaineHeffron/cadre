import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function listDefaultTests() {
  return readdirSync('tests', { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join('tests', entry.name))
    .sort();
}

const forwardedArgs = process.argv.slice(2);
const nodeTestFlags = [];
const explicitTestTargets = [];

for (let index = 0; index < forwardedArgs.length; index += 1) {
  const arg = forwardedArgs[index];
  if (!arg) continue;
  if (arg.startsWith('--')) {
    nodeTestFlags.push(arg);
    const next = forwardedArgs[index + 1];
    if (next && !next.startsWith('--')) {
      nodeTestFlags.push(next);
      index += 1;
    }
    continue;
  }
  explicitTestTargets.push(arg);
}

const testArgs = explicitTestTargets.length > 0 ? explicitTestTargets : listDefaultTests();

function runNodeTests(targets, extraFlags = []) {
  return spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    ...nodeTestFlags,
    ...extraFlags,
    ...targets,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
    },
  });
}

function exitForResult(result) {
  if (typeof result.status === 'number') {
    if (result.status !== 0) process.exit(result.status);
    return;
  }
  if (result.error) throw result.error;
  process.exit(1);
}

if (testArgs.length > 0) exitForResult(runNodeTests(testArgs));
