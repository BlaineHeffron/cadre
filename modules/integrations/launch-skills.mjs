/**
 * Fleet-owned launch skills.
 *
 * These are named text aliases, not harness skills. Selecting one injects its
 * body as startup user text. Unused skills stay out of the agent context.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { config } from '../../config.mjs';

function text(value) {
  return String(value || '').trim();
}

function skillsDir(sourceConfig = config) {
  return resolve(text(sourceConfig?.launchSkills?.dir) || resolve('config/skills'));
}

/**
 * Writable overlay directory. Stock skills in `config/skills` are git-tracked
 * and the live deploy resets to origin/main on restart, so UI edits there
 * would be silently reverted. All writes go to this git-ignored directory
 * instead; a local file shadows a stock skill with the same id.
 */
function localSkillsDir(sourceConfig = config) {
  return resolve(text(sourceConfig?.launchSkills?.localDir) || resolve('state/skills'));
}

function customSkillsDirs(sourceConfig = config) {
  return String(sourceConfig?.launchSkills?.customDirs || '')
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => resolve(dir));
}

function parseSkillFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const name = basename(filePath, extname(filePath));
  let description = '';
  let body = raw;

  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontmatter = raw.substring(3, endIdx).trim();
      body = raw.substring(endIdx + 3).trim();
      for (const line of frontmatter.split('\n')) {
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match && match[1] === 'description') description = match[2].trim();
      }
    }
  }

  // A leading license comment stays on disk for attribution but is not
  // injected into agent prompts or shown as the skills-page preview.
  body = body.replace(/^<!--[\s\S]*?-->\s*/, '').trim();

  if (!description) {
    const firstLine = body.split('\n')[0]?.trim();
    if (firstLine && firstLine.length < 200) description = firstLine.replace(/^#\s*/, '');
  }

  return {
    id: name,
    name,
    description,
    body: body.trim(),
    preview: body.trim().slice(0, 500),
    file: filePath,
    size: raw.length,
  };
}

export class LaunchSkillError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchSkillError';
    this.code = code;
    this.statusCode = 400;
    this.details = details;
  }
}

function scanSkillsDir(dir, { source, log } = {}) {
  const skills = [];
  if (!existsSync(dir)) return skills;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (log?.debug) log.debug({ err, path: dir }, 'Skipping unreadable launch skills dir');
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = join(dir, entry.name);
    try {
      const skill = parseSkillFile(fullPath);
      if (!skill.body) continue;
      const stat = statSync(fullPath);
      skill.modified = stat.mtime.toISOString();
      skill.location = 'fleet';
      skill.source = source;
      skills.push(skill);
    } catch (err) {
      if (log?.debug) log.debug({ err, path: fullPath }, 'Skipping unreadable launch skill');
    }
  }
  return skills;
}

export function discoverLaunchSkills({ sourceConfig = config, log } = {}) {
  const stock = scanSkillsDir(skillsDir(sourceConfig), { source: 'stock', log });
  const custom = customSkillsDirs(sourceConfig).flatMap((dir) => scanSkillsDir(dir, { source: 'custom', log }));
  const local = scanSkillsDir(localSkillsDir(sourceConfig), { source: 'local', log });
  const stockIds = new Set([...stock, ...custom].map((skill) => skill.id));
  const byId = new Map(stock.map((skill) => [skill.id, skill]));
  for (const skill of custom) byId.set(skill.id, skill);
  for (const skill of local) {
    skill.hasStock = stockIds.has(skill.id);
    byId.set(skill.id, skill);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function publicLaunchSkills(skills = discoverLaunchSkills()) {
  return skills.map(({ file, body, ...publicSkill }) => publicSkill);
}

export function resolveLaunchSkills({
  skillIds = [],
  sourceConfig = config,
} = {}) {
  const requested = [];
  const seen = new Set();
  for (const raw of Array.isArray(skillIds) ? skillIds : []) {
    if (typeof raw !== 'string' || !raw.trim() || raw !== raw.trim()) {
      throw new LaunchSkillError('launch_skill_id_invalid', 'skills contains an invalid skill ID');
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      requested.push(raw);
    }
  }
  if (!requested.length) return Object.freeze([]);

  const byId = new Map(discoverLaunchSkills({ sourceConfig }).map((skill) => [skill.id, skill]));
  return Object.freeze(requested.map((id) => {
    const skill = byId.get(id);
    if (!skill) {
      throw new LaunchSkillError('launch_skill_unknown', `Unknown launch skill: ${id}`, { skillId: id });
    }
    return Object.freeze({ id: skill.id, body: skill.body });
  }));
}

export const SKILL_TOKEN_RE = /\{\{skill:([A-Za-z0-9._-]+)\}\}/g;

export const MAX_SKILL_EXPANSION_DEPTH = 10;

/**
 * Expands `{{skill:name}}` tokens, including tokens inside expanded skill
 * bodies (a saved prompt often contains inserted skill tokens). Bounded depth
 * guards against self-referential skills.
 */
export function expandSkillTokens(value = '', { sourceConfig = config } = {}) {
  const source = String(value || '');
  if (!source.includes('{{skill:')) return source;
  const byId = new Map(discoverLaunchSkills({ sourceConfig }).map((skill) => [skill.id, skill.body]));
  const expand = (input, path = []) => input.replace(SKILL_TOKEN_RE, (_match, id) => {
      if (path.includes(id)) {
        const cycle = [...path.slice(path.indexOf(id)), id];
        throw new LaunchSkillError(
          'launch_skill_cycle',
          `Launch skill cycle detected: ${cycle.join(' -> ')}`,
          { skillId: id, cycle }
        );
      }
      if (path.length >= MAX_SKILL_EXPANSION_DEPTH) {
        throw new LaunchSkillError(
          'launch_skill_depth_exceeded',
          `Launch skill expansion exceeds maximum depth ${MAX_SKILL_EXPANSION_DEPTH}`,
          { skillId: id, maxDepth: MAX_SKILL_EXPANSION_DEPTH, path: [...path, id] }
        );
      }
      const body = byId.get(id);
      if (!body) {
        throw new LaunchSkillError('launch_skill_unknown', `Unknown launch skill: ${id}`, { skillId: id });
      }
      return expand(body, [...path, id]);
    });
  return expand(source);
}

export function composeLaunchUserPrompt({ skillIds = [], initialPrompt = '', sourceConfig = config } = {}) {
  const skills = resolveLaunchSkills({ skillIds, sourceConfig });
  const sections = skills.map((skill) => skill.body);
  const prompt = text(initialPrompt);
  if (prompt) sections.push(prompt);
  // Expand after joining so tokens inside selected skill bodies resolve too.
  return expandSkillTokens(sections.join('\n\n'), { sourceConfig }).trim();
}

export function composeLaunchSourcePrompt({ skillIds = [], initialPrompt = '', sourceConfig = config } = {}) {
  const skills = resolveLaunchSkills({ skillIds, sourceConfig });
  const sections = skills.map((skill) => `{{skill:${skill.id}}}`);
  const prompt = text(initialPrompt);
  if (prompt) sections.push(prompt);
  return sections.join('\n\n').trim();
}

export function skillDeliveryResolution(sourceText = '', resolvedText = '') {
  const source = String(sourceText ?? '');
  const resolved = String(resolvedText ?? '');
  const digest = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  return Object.freeze({
    sourceTextHash: digest(source),
    deliveredTextHash: digest(resolved),
    sourceTextLength: source.length,
    deliveredTextLength: resolved.length,
    skillTokensResolved: source !== resolved,
    unresolvedSkillTokenCount: [...resolved.matchAll(SKILL_TOKEN_RE)].length,
  });
}

export function sanitizedSkillSnapshot(skillIds = []) {
  return Object.freeze((Array.isArray(skillIds) ? skillIds : [])
    .filter((id) => typeof id === 'string' && id.trim() && id === id.trim()));
}

export const LAUNCH_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeLaunchSkillName(value) {
  const name = text(value).toLowerCase();
  if (!LAUNCH_SKILL_NAME_RE.test(name) || name.includes('..')) {
    throw new LaunchSkillError(
      'launch_skill_name_invalid',
      'Skill name must be lowercase letters, digits, dot, dash, or underscore (max 64 chars)',
      { name: text(value) }
    );
  }
  return name;
}

function skillPathIn(dir, name) {
  const full = resolve(join(dir, `${name}.md`));
  if (full !== join(resolve(dir), `${name}.md`)) {
    throw new LaunchSkillError('launch_skill_name_invalid', 'Resolved skill path escaped the skills directory', { name });
  }
  return full;
}

function serializeSkill({ name, description, body }) {
  const front = [`name: ${name}`];
  const desc = text(description).replace(/[\r\n]+/g, ' ').trim();
  if (desc) front.push(`description: ${desc}`);
  return `---\n${front.join('\n')}\n---\n\n${text(body)}\n`;
}

/**
 * Create or replace a fleet launch skill.
 * `mode`: 'create' rejects an existing skill, 'update' requires one, 'upsert' accepts either.
 *
 * Writes always land in the local overlay dir. A save over a stock skill
 * creates a shadowing local file; the tracked stock file is never touched, so
 * the deploy worktree stays clean and edits survive `git reset --hard`.
 */
export function saveLaunchSkill({
  name,
  description = '',
  body = '',
  mode = 'upsert',
  sourceConfig = config,
} = {}) {
  const skillName = normalizeLaunchSkillName(name);
  if (!text(body)) {
    throw new LaunchSkillError('launch_skill_body_required', 'Skill body cannot be empty', { name: skillName });
  }
  const localPath = skillPathIn(localSkillsDir(sourceConfig), skillName);
  const hasStock = [skillsDir(sourceConfig), ...customSkillsDirs(sourceConfig)]
    .some((dir) => existsSync(skillPathIn(dir, skillName)));
  const exists = existsSync(localPath) || hasStock;
  if (mode === 'create' && exists) {
    const err = new LaunchSkillError('launch_skill_exists', `Skill already exists: ${skillName}`, { name: skillName });
    err.statusCode = 409;
    throw err;
  }
  if (mode === 'update' && !exists) {
    const err = new LaunchSkillError('launch_skill_unknown', `Unknown launch skill: ${skillName}`, { name: skillName });
    err.statusCode = 404;
    throw err;
  }
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, serializeSkill({ name: skillName, description, body }), 'utf8');
  const skill = parseSkillFile(localPath);
  skill.modified = statSync(localPath).mtime.toISOString();
  skill.location = 'fleet';
  skill.source = 'local';
  skill.hasStock = hasStock;
  const { file, ...publicSkill } = skill;
  return { ...publicSkill, body: skill.body, created: !exists };
}

/**
 * Removes the local overlay file. Deleting a shadowed stock skill reverts it
 * to the stock body; a stock-only skill is refused because the tracked file
 * would just come back on the next deploy sync.
 */
export function deleteLaunchSkill({ name, sourceConfig = config } = {}) {
  const skillName = normalizeLaunchSkillName(name);
  const localPath = skillPathIn(localSkillsDir(sourceConfig), skillName);
  const hasStock = [skillsDir(sourceConfig), ...customSkillsDirs(sourceConfig)]
    .some((dir) => existsSync(skillPathIn(dir, skillName)));
  if (!existsSync(localPath)) {
    if (hasStock) {
      const err = new LaunchSkillError(
        'launch_skill_readonly',
        `Skill ${skillName} is read-only; edit it to override instead of deleting`,
        { name: skillName }
      );
      err.statusCode = 409;
      throw err;
    }
    const err = new LaunchSkillError('launch_skill_unknown', `Unknown launch skill: ${skillName}`, { name: skillName });
    err.statusCode = 404;
    throw err;
  }
  rmSync(localPath);
  return { deleted: skillName, revertedToStock: hasStock };
}
