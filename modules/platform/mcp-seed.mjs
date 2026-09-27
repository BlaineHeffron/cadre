import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { config } from '../../config.mjs';

export function buildAgentBusMcpUrl(sourceConfig = config) {
  const mcp = sourceConfig.agentBusMcpHttp || {};
  return `http://${mcp.host}:${mcp.port}${mcp.path}`;
}

function warnSeed(code, logger = console) {
  if (logger && typeof logger.warn === 'function') logger.warn({ code }, 'MCP seed skipped');
}

function logSeed(logger, payload) {
  if (!logger || logger === console || typeof logger.info !== 'function') return;
  logger.info(payload, 'MCP seed');
}

let claudeConfigWriteQueue = Promise.resolve();
const CLAUDE_CONFIG_LOCK_TIMEOUT_MS = 10000;
const CLAUDE_CONFIG_STALE_LOCK_MS = 30000;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function isSeedableWorkDir(workDir = '') {
  const text = String(workDir || '').trim();
  if (!text) return false;

  let resolved;
  try {
    const info = await stat(text);
    if (!info.isDirectory()) return false;
    await access(text, constants.W_OK);
    resolved = await realpath(text);
  } catch {
    return false;
  }

  const cwd = await realpath(process.cwd()).catch(() => resolve(process.cwd()));
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  return resolved !== cwd && resolved !== home;
}

async function readJsonFile(filePath, fallback, logger) {
  const raw = await readFile(filePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    warnSeed('mcp_seed_json_unparseable', logger);
    return null;
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonFileAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

async function withDirectoryLock(lockPath, fn) {
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > CLAUDE_CONFIG_STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > CLAUDE_CONFIG_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function acceptTrust(projects, key) {
  const existing = projects[key] && typeof projects[key] === 'object' && !Array.isArray(projects[key])
    ? projects[key]
    : {};
  return { ...existing, hasTrustDialogAccepted: true };
}

export async function seedClaudeWorkspaceTrust(workDir, { logger = console } = {}) {
  const trimmed = String(workDir || '').trim();
  if (!trimmed) return;
  const resolvedWorkDir = await realpath(trimmed).catch(() => resolve(trimmed));
  const keys = [...new Set([resolvedWorkDir, trimmed].filter(Boolean))];
  const home = process.env.HOME || homedir();
  const configPath = join(home, '.claude.json');
  const lockPath = `${configPath}.lock`;

  const writeTrust = async () => {
    await withDirectoryLock(lockPath, async () => {
      const config = await readJsonFile(configPath, {}, logger);
      if (!config || Array.isArray(config) || typeof config !== 'object') {
        warnSeed('claude_trust_config_unparseable', logger);
        return;
      }

      const projects = config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
        ? config.projects
        : {};
      const nextProjects = { ...projects };
      for (const key of keys) nextProjects[key] = acceptTrust(nextProjects, key);

      await writeJsonFileAtomic(configPath, {
        ...config,
        projects: nextProjects,
      });
    });
  };

  claudeConfigWriteQueue = claudeConfigWriteQueue.then(writeTrust, writeTrust);
  return claudeConfigWriteQueue;
}

async function finishSeed(logger, provider, workDir, result) {
  logSeed(logger, { code: 'mcp_seed', provider, workDir, ...result });
  return result;
}

export async function seedClaudeMcp(workDir, { sourceConfig = config, logger = console } = {}) {
  if (!sourceConfig.mcpSeed?.enabled) return finishSeed(logger, 'claude', workDir, { seeded: false, reason: 'disabled' });
  if (!(await isSeedableWorkDir(workDir))) return finishSeed(logger, 'claude', workDir, { seeded: false, reason: 'invalid_workdir' });

  const mcpUrl = buildAgentBusMcpUrl(sourceConfig);
  const mcpPath = join(workDir, '.mcp.json');
  const mcpConfig = await readJsonFile(mcpPath, { mcpServers: {} }, logger);
  if (mcpConfig) {
    const next = {
      ...mcpConfig,
      mcpServers: {
        ...(mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object' ? mcpConfig.mcpServers : {}),
        dueno: { type: 'http', url: mcpUrl },
      },
    };
    await writeJsonFile(mcpPath, next);
  }

  const settingsPath = join(workDir, '.claude', 'settings.local.json');
  const settings = await readJsonFile(settingsPath, {}, logger);
  if (settings) {
    const existing = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
    const enabledMcpjsonServers = Array.from(new Set([
      ...existing,
      'dueno',
    ]));
    await writeJsonFile(settingsPath, { ...settings, enabledMcpjsonServers });
  }

  await seedClaudeWorkspaceTrust(workDir, { logger });

  return finishSeed(logger, 'claude', workDir, { seeded: true });
}

export async function seedSessionMcp(provider, workDir, opts = {}) {
  const id = String(provider || '').toLowerCase();
  if (id === 'claude') return seedClaudeMcp(workDir, opts);
  if (id === 'codex') return seedCodexMcp(workDir, opts);
  return finishSeed(opts.logger || console, id, workDir, { seeded: false, reason: 'unsupported_provider' });
}

function httpTomlBlock(name, mcpUrl, { enabled = true } = {}) {
  return [
    `[mcp_servers.${name}]`,
    `url = ${JSON.stringify(mcpUrl)}`,
    `enabled = ${enabled ? 'true' : 'false'}`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
  ].join('\n');
}

function mergeCodexServerToml(content = '', name, mcpUrl, logger) {
  const text = String(content || '');
  const tablePattern = new RegExp(`^\\s*\\[mcp_servers\\.${name}\\]\\s*$`, 'gm');
  const matches = [...text.matchAll(tablePattern)];
  const block = httpTomlBlock(name, mcpUrl, { enabled: true });
  if (matches.length > 1) {
    warnSeed('mcp_seed_toml_unparseable', logger);
    return null;
  }
  if (matches.length === 0) {
    const trimmed = text.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
  }

  const start = matches[0].index;
  const afterHeader = start + matches[0][0].length;
  const nextTable = text.slice(afterHeader).search(/^\s*\[/m);
  const end = nextTable === -1 ? text.length : afterHeader + nextTable;
  return `${text.slice(0, start)}${block}\n${text.slice(end).replace(/^\n+/, '')}`;
}

function mergeCodexToml(content = '', mcpUrl, logger) {
  return mergeCodexServerToml(content, 'dueno', mcpUrl, logger);
}

export async function seedCodexMcp(workDir, { sourceConfig = config, logger = console } = {}) {
  if (!sourceConfig.mcpSeed?.enabled) return finishSeed(logger, 'codex', workDir, { seeded: false, reason: 'disabled' });
  if (!(await isSeedableWorkDir(workDir))) return finishSeed(logger, 'codex', workDir, { seeded: false, reason: 'invalid_workdir' });

  const configPath = join(workDir, '.codex', 'config.toml');
  const raw = await readFile(configPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const merged = mergeCodexToml(raw, buildAgentBusMcpUrl(sourceConfig), logger);
  if (merged == null) return finishSeed(logger, 'codex', workDir, { seeded: false, reason: 'unparseable' });

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, merged);
  return finishSeed(logger, 'codex', workDir, { seeded: true });
}
