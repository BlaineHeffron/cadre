import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SKILLS_UPSTREAM_TASK_ID = 'sched_skills_upstream_watch';
export const SKILLS_UPSTREAM_MANIFEST_REL = 'config/skills/UPSTREAM.tsv';
export const DEFAULT_SKILLS_UPSTREAM_INTERVAL_SECONDS = 604800;
export const DEFAULT_SKILLS_UPSTREAM_MAX_FANOUT = 3;
export const DEFAULT_SKILLS_UPSTREAM_WORKTREE_BASE = '~/.dueno-fleet/agent-worktrees';
export const LIVE_FLEET_CHECKOUT = join(homedir(), 'projects/dueno-fleet-live');

function text(value) {
  return String(value || '').trim();
}

export function expandUserPath(value = '') {
  const raw = text(value);
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

export function isLiveFleetCheckout(repoPath = '') {
  const resolved = resolve(expandUserPath(repoPath) || '.');
  return resolved === LIVE_FLEET_CHECKOUT || resolved.endsWith('/dueno-fleet-live');
}

export function parseUpstreamManifest(textValue = '') {
  const rows = [];
  for (const raw of String(textValue || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const [local, repo, path, sha, ...noteParts] = line.split('\t');
    if (!local || !repo || !path || !sha) continue;
    rows.push({ local, repo, path, sha, note: noteParts.join('\t') || '' });
  }
  return rows;
}

export function parseUpstreamManifestRepos(textValue = '') {
  const repos = [];
  const seen = new Set();
  for (const row of parseUpstreamManifest(textValue)) {
    if (!seen.has(row.repo)) {
      seen.add(row.repo);
      repos.push(row.repo);
    }
  }
  return repos;
}

export function groupChangedByUpstreamPath(changed = []) {
  const groups = [];
  const index = new Map();
  for (const row of Array.isArray(changed) ? changed : []) {
    const repo = text(row.repo);
    const path = text(row.path || row.upstream_path);
    const local = text(row.local);
    if (!repo || !path || !local) continue;
    const key = `${repo}\t${path}`;
    let group = index.get(key);
    if (!group) {
      group = {
        repo,
        path,
        headSha: text(row.headSha),
        locals: [],
        commits: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    if (!group.locals.includes(local)) group.locals.push(local);
    if (!group.headSha && row.headSha) group.headSha = text(row.headSha);
    for (const commit of Array.isArray(row.commits) ? row.commits : []) {
      const line = text(commit);
      if (line && !group.commits.includes(line)) group.commits.push(line);
    }
  }
  return groups;
}

export function buildSkillsUpstreamIntegrationPrompt(group = {}, { deferredCount = 0 } = {}) {
  const locals = Array.isArray(group.locals) ? group.locals.filter(Boolean) : [];
  const names = locals.join(', ') || 'unknown';
  const primary = locals[0] || 'skill';
  const files = locals.map((name) => `config/skills/${name}.md`).join(', ');
  const deferred = Number(deferredCount) > 0
    ? `\n${Number(deferredCount)} additional upstream path(s) were deferred this tick because of the fan-out cap. Do not integrate them.\n`
    : '';
  return [
    `Integrate upstream changes for fleet skill(s): ${names}.`,
    `They share one upstream file: ${group.repo || 'unknown'} ${group.path || 'unknown'}.`,
    'Follow docs/skills-upstream-integration.md.',
    '',
    'Work only in this worktree. Do not edit any other checkout, especially the live deploy tree.',
    '',
    `1. Run: node scripts/skills-upstream-check.mjs --skill ${primary} --diff`,
    `2. Fold only the substantive upstream delta into ${files}, preserving description frontmatter, the leading license comment, repo-relative config/skills/<id>.md pointers, skill tokens, embedded scripts, deliberately dropped content, and the trailing upstream provenance comment.`,
    `3. Bump pinned_sha for ${names} in config/skills/UPSTREAM.tsv, and the sha in each file provenance comment, to the new HEAD — even for changes you judged cosmetic and skipped.`,
    '4. Verify: npm test -- tests/launch-skills.test.mjs tests/skills-api.test.mjs tests/skills.test.mjs tests/ui-skill-writer.test.mjs. Confirm skill tokens still resolve. To mention token syntax in prose, write skill:name without braces (angle-bracket placeholders such as skill:<name> are also safe).',
    `5. Open ONE PR from this worktree branch titled "chore(skills): sync ${primary} with upstream"${locals.length > 1 ? ` covering ${names}` : ''}, listing the commits folded in and anything skipped with why. Do not merge to main yourself.`,
    'If the upstream restructured the skill so the delta cannot be folded mechanically, open a draft PR describing the divergence and re-pin nothing.',
    'Never modify the fleet-native skills (experiment, custody, client-update, bootstrap, visual-design-it-twice); they have no upstream.',
    deferred,
  ].join('\n');
}

export function buildSkillsUpstreamTaskPrompt() {
  return [
    'Ported-skill upstream integration.',
    'The scheduler detects drift and fans out one isolated worktree agent per changed upstream path (not per local skill).',
    'This task prompt is bookkeeping only; integration agents receive a per-path brief.',
  ].join('\n');
}
