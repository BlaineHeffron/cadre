#!/usr/bin/env node
/**
 * Detect upstream drift in ported fleet skills.
 *
 * Reads config/skills/UPSTREAM.tsv (local_skill, repo, upstream_path, pinned_sha, note),
 * caches a blob-less clone of each distinct upstream repo, and for each row reports
 * whether the upstream path changed since its pinned sha. It compares upstream against
 * its own past (pinned..HEAD for that path), never the fleet file against upstream:
 * the fleet files are deliberately adapted, so that diff would be noise.
 *
 * This never writes to any skill file. It only reads throwaway clones and prints.
 *
 * Usage:
 *   node scripts/skills-upstream-check.mjs            # human report
 *   node scripts/skills-upstream-check.mjs --json     # machine report (for the integration agent)
 *   node scripts/skills-upstream-check.mjs --diff     # include the per-path upstream diff
 *   node scripts/skills-upstream-check.mjs --skill X  # limit to one local skill
 *   node scripts/skills-upstream-check.mjs --repo DIR # fleet checkout that holds the manifest
 *
 * Exit code: 0 if no drift, 1 if drift detected, 2 on error. --json always exits 0
 * so a caller can parse the payload; read `.changed` and `.groups`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import {
  groupChangedByUpstreamPath,
  parseUpstreamManifest,
  SKILLS_UPSTREAM_MANIFEST_REL,
} from '../modules/integrations/skills-upstream.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.SKILLS_UPSTREAM_CACHE
  || join(tmpdir(), 'dueno-skills-upstream-cache');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const withDiff = args.includes('--diff');
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const skillFilter = argValue('--skill');
const REPO_ROOT = resolve(argValue('--repo') || process.env.SKILLS_UPSTREAM_REPO || DEFAULT_REPO_ROOT);
const MANIFEST = join(REPO_ROOT, SKILLS_UPSTREAM_MANIFEST_REL);

async function git(cwd, gitArgs, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...gitArgs], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

async function ensureRepo(repo) {
  const safe = repo.replace(/[^A-Za-z0-9._-]+/g, '__');
  const dir = join(CACHE_DIR, safe);
  const url = `https://github.com/${repo}.git`;
  if (existsSync(join(dir, 'HEAD')) || existsSync(join(dir, '.git'))) {
    try {
      await git(dir, ['fetch', '--quiet', '--filter=blob:none', 'origin']);
    } catch (err) {
      const error = new Error(`fetch failed for ${repo}: ${err.message || err}`);
      error.code = 'git_fetch_failed';
      throw error;
    }
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  // Blob-less partial clone: full commit/tree history, blobs fetched on demand.
  await execFileAsync('git', [
    'clone', '--filter=blob:none', '--no-checkout', '--quiet', url, dir,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return dir;
}

function headRef(dir) {
  // Prefer the remote default branch; fall back to FETCH_HEAD / HEAD.
  return git(dir, ['rev-parse', 'origin/HEAD'], { allowFail: true })
    .then((out) => (out ? 'origin/HEAD' : 'HEAD'));
}

async function checkRow(row, repoDir) {
  const ref = await headRef(repoDir);
  const headSha = (await git(repoDir, ['rev-parse', ref], { allowFail: true }) || '').trim();
  // Does the pinned sha exist in this clone? (Short shas resolve fine.)
  const pinnedResolved = (await git(repoDir, ['rev-parse', '--verify', `${row.sha}^{commit}`], { allowFail: true }) || '').trim();
  if (!pinnedResolved) {
    return { ...row, status: 'error', headSha, reason: `pinned sha ${row.sha} not found in ${row.repo}` };
  }
  const log = (await git(repoDir, [
    'log', '--oneline', `${row.sha}..${ref}`, '--', row.path,
  ], { allowFail: true })) || '';
  const commits = log.trim() ? log.trim().split('\n') : [];
  if (commits.length === 0) {
    return { ...row, status: 'unchanged', headSha };
  }
  const result = { ...row, status: 'changed', headSha, commits };
  if (withDiff) {
    result.diff = (await git(repoDir, [
      'diff', `${row.sha}..${ref}`, '--', row.path,
    ], { allowFail: true })) || '';
  }
  return result;
}

async function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`manifest not found: ${MANIFEST}`);
    process.exit(2);
  }
  let rows = parseUpstreamManifest(readFileSync(MANIFEST, 'utf8'));
  if (skillFilter) rows = rows.filter((r) => r.local === skillFilter);
  if (rows.length === 0) {
    console.error(skillFilter ? `no manifest row for skill: ${skillFilter}` : 'manifest is empty');
    process.exit(2);
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const repoDirs = new Map();
  const repos = [...new Set(rows.map((r) => r.repo))];
  for (const repo of repos) {
    try {
      repoDirs.set(repo, await ensureRepo(repo));
    } catch (err) {
      repoDirs.set(repo, { error: err.message || String(err) });
    }
  }

  const results = [];
  for (const row of rows) {
    const dir = repoDirs.get(row.repo);
    if (dir && typeof dir === 'object' && dir.error) {
      results.push({ ...row, status: 'error', reason: `clone/fetch failed: ${dir.error}` });
      continue;
    }
    try {
      results.push(await checkRow(row, dir));
    } catch (err) {
      results.push({ ...row, status: 'error', reason: err.message || String(err) });
    }
  }

  const changed = results.filter((r) => r.status === 'changed');
  const errored = results.filter((r) => r.status === 'error');
  const groups = groupChangedByUpstreamPath(changed);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      generatedFromPins: true,
      repoRoot: REPO_ROOT,
      total: results.length,
      changed: changed.map(({ diff, ...r }) => (withDiff ? { ...r, diff } : r)),
      groups,
      errored,
      results,
    }, null, 2)}\n`);
    process.exit(0);
  }

  console.log(`Checked ${results.length} ported skills across ${repos.length} upstreams.\n`);
  if (changed.length === 0 && errored.length === 0) {
    console.log('All in sync. Nothing to integrate.');
    process.exit(0);
  }
  for (const r of changed) {
    console.log(`CHANGED  ${r.local}  (${r.repo} ${r.path})`);
    console.log(`         pinned ${r.sha} -> HEAD ${r.headSha.slice(0, 7)}, ${r.commits.length} commit(s):`);
    for (const c of r.commits.slice(0, 10)) console.log(`           ${c}`);
    if (withDiff && r.diff) {
      console.log('         --- upstream diff (pinned..HEAD) ---');
      console.log(r.diff.split('\n').map((l) => `         ${l}`).join('\n'));
    }
    console.log('');
  }
  for (const r of errored) {
    console.log(`ERROR    ${r.local}  (${r.repo})  ${r.reason}`);
  }
  console.log(`\n${changed.length} changed, ${groups.length} upstream path(s), ${errored.length} errored.`);
  if (changed.length > 0) {
    console.log('To integrate: see docs/skills-upstream-integration.md');
  }
  process.exit(changed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(2);
});
