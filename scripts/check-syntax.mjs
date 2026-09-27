import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const skippedDirectories = new Set(['.git', 'node_modules']);
const checkedExtensions = new Set(['.js', '.mjs']);

function collectJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      files.push(...collectJavaScriptFiles(join(directory, entry.name)));
      continue;
    }

    if (!entry.isFile()) continue;

    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    if (checkedExtensions.has(extension)) {
      files.push(join(directory, entry.name));
    }
  }

  return files;
}

const files = collectJavaScriptFiles('.').sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
    env: process.env,
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
}
