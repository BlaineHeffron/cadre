import { lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { config } from '../../config.mjs';

export async function removeGithubAgentScratch(meta, baseDir = config.githubAgents.workDir) {
  const metadata = meta.metadata || {};
  const number = Number(metadata.github_number);
  if (!Number.isInteger(number) || number <= 0 || !metadata.github_repo || !['pr', 'issue'].includes(metadata.github_kind) || !meta.workDir) return;
  const root = resolve(baseDir.startsWith('~/') ? resolve(process.env.HOME, baseDir.slice(2)) : baseDir, 'scratch');
  const path = resolve(meta.workDir);
  const repo = String(metadata.github_repo).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const parts = relative(root, path).split(sep);
  if (parts.length !== 2 || parts[0] !== repo || !/^(?!\.\.?$)[a-zA-Z0-9._-]+$/.test(repo)
    || !new RegExp(`^${metadata.github_kind}-${number}-[0-9]+$`).test(parts[1])) return;
  // Check every ancestor: rm does not follow symlinks inside the directory either.
  for (let current = path; ; current = dirname(current)) {
    const entry = await lstat(current).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
    if (current === root) break;
  }
  await rm(path, { recursive: true, force: true });
  await rmdir(dirname(path)).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}
