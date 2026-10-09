#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { recordHookPayload } from '../../modules/agent/hook-events.mjs';
import { readEnv } from '../../modules/platform/cadre-env.mjs';

function parseArgs(argv = []) {
  const result = { provider: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') {
      result.provider = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { provider } = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const envProvider = String(readEnv('DUENO_PROVIDER') || '').trim();
  const duenoSessionId = String(readEnv('DUENO_SESSION_ID') || '').trim();
  const { stopDecision } = await recordHookPayload(payload, {
    provider: provider || envProvider,
    duenoSessionId: duenoSessionId || undefined,
    workDir: readEnv('DUENO_SESSION_WORK_DIR'),
  });
  if (stopDecision) {
    process.stdout.write(`${JSON.stringify(stopDecision)}\n`);
  }
}

main().catch(async (error) => {
  try {
    await readFile('/dev/null');
  } catch {}
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
