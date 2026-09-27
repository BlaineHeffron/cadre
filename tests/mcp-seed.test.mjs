import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { seedClaudeMcp, seedClaudeWorkspaceTrust, seedCodexMcp, seedSessionMcp } from '../modules/platform/mcp-seed.mjs';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempWorkDir(prefix = 'dueno-mcp-seed-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function withTempHome(fn) {
  const previousHome = process.env.HOME;
  const home = await tempWorkDir('dueno-mcp-home-');
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

function testConfig({ enabled = true } = {}) {
  return {
    mcpSeed: { enabled },
    agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' },
  };
}

describe('MCP seed', () => {
  it('writes Claude MCP config and enables dueno in settings', async () => {
    await withTempHome(async (home) => {
      const workDir = await tempWorkDir();

      const result = await seedClaudeMcp(workDir, { sourceConfig: testConfig() });

      assert.equal(result.seeded, true);
      assert.deepEqual(JSON.parse(await readFile(join(workDir, '.mcp.json'), 'utf8')), {
        mcpServers: {
          dueno: { type: 'http', url: 'http://127.0.0.1:9876/mcp' },
        },
      });
      assert.deepEqual(JSON.parse(await readFile(join(workDir, '.claude', 'settings.local.json'), 'utf8')), {
        enabledMcpjsonServers: ['dueno'],
      });
      assert.equal(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).projects[workDir].hasTrustDialogAccepted, true);
    });
  });

  it('preserves Claude settings and is idempotent', async () => {
    await withTempHome(async (home) => {
      const workDir = await tempWorkDir();
      await mkdir(join(workDir, '.claude'), { recursive: true });
      await writeFile(join(workDir, '.mcp.json'), JSON.stringify({ keep: true, mcpServers: { other: { url: 'x' } } }));
      await writeFile(join(workDir, '.claude', 'settings.local.json'), JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        enabledMcpjsonServers: ['other', 'dueno'],
      }));
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        keep: true,
        projects: {
          '/tmp/other': { hasTrustDialogAccepted: false },
          [workDir]: { lastAPIDuration: 123, hasTrustDialogAccepted: false },
        },
      }));

      await seedClaudeMcp(workDir, { sourceConfig: testConfig() });
      await seedClaudeMcp(workDir, { sourceConfig: testConfig() });

      const mcp = JSON.parse(await readFile(join(workDir, '.mcp.json'), 'utf8'));
      const settings = JSON.parse(await readFile(join(workDir, '.claude', 'settings.local.json'), 'utf8'));
      const claude = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
      assert.equal(mcp.keep, true);
      assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['dueno', 'other']);
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
      assert.deepEqual(settings.enabledMcpjsonServers, ['other', 'dueno']);
      assert.equal(claude.keep, true);
      assert.equal(claude.projects['/tmp/other'].hasTrustDialogAccepted, false);
      assert.deepEqual(claude.projects[workDir], { lastAPIDuration: 123, hasTrustDialogAccepted: true });
    });
  });

  it('preserves Claude trust entries across concurrent seed processes', async () => {
    await withTempHome(async (home) => {
      const workDirs = await Promise.all(Array.from({ length: 6 }, () => tempWorkDir('dueno-mcp-concurrent-')));
      const moduleUrl = pathToFileURL(resolve('modules/platform/mcp-seed.mjs')).href;
      const childScript = (workDir) => `
        import { seedClaudeMcp } from ${JSON.stringify(moduleUrl)};
        await seedClaudeMcp(${JSON.stringify(workDir)}, {
          sourceConfig: {
            mcpSeed: { enabled: true },
            agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' },
          },
        });
      `;

      await Promise.all(workDirs.map((workDir) => execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', childScript(workDir)],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            HOME: home,
            LOG_LEVEL: 'error',
          },
        },
      )));

      const claude = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
      for (const workDir of workDirs) {
        assert.equal(claude.projects[workDir].hasTrustDialogAccepted, true);
      }
    });
  });

  it('writes Codex MCP table and preserves existing keys idempotently', async () => {
    const workDir = await tempWorkDir();
    await mkdir(join(workDir, '.codex'), { recursive: true });
    await writeFile(join(workDir, '.codex', 'config.toml'), [
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'url = "http://other"',
      '',
    ].join('\n'));

    await seedCodexMcp(workDir, { sourceConfig: testConfig() });
    await seedCodexMcp(workDir, { sourceConfig: testConfig() });

    const toml = await readFile(join(workDir, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /^model = "gpt-5"/);
    assert.match(toml, /\[mcp_servers\.other\]\nurl = "http:\/\/other"/);
    assert.match(toml, /\[mcp_servers\.dueno\]\nurl = "http:\/\/127\.0\.0\.1:9876\/mcp"\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 60/);
    assert.equal(toml.includes('businessos'), false);
    assert.equal((toml.match(/\[mcp_servers\.dueno\]/g) || []).length, 1);
  });

  it('does not persist BusinessOS MCP into workspace-global seed files', async () => {
    await withTempHome(async () => {
      const token = 'bos-token-never-in-workdir';
      const workDir = await tempWorkDir();
      const businessOsMcp = { url: 'http://127.0.0.1:9876/businessos-test/capability' };

      await seedClaudeMcp(workDir, { sourceConfig: testConfig(), businessOsMcp });
      await seedCodexMcp(workDir, { sourceConfig: testConfig(), businessOsMcp });

      const mcp = JSON.parse(await readFile(join(workDir, '.mcp.json'), 'utf8'));
      const settings = JSON.parse(await readFile(join(workDir, '.claude', 'settings.local.json'), 'utf8'));
      const toml = await readFile(join(workDir, '.codex', 'config.toml'), 'utf8');
      assert.equal(mcp.mcpServers.businessos, undefined);
      assert.equal(settings.enabledMcpjsonServers.includes('businessos'), false);
      assert.equal(toml.includes('[mcp_servers.businessos]'), false);
      assert.equal(JSON.stringify(mcp).includes(businessOsMcp.url), false);
      assert.equal(JSON.stringify(settings).includes(businessOsMcp.url), false);
      assert.equal(toml.includes(businessOsMcp.url), false);
      assert.equal(JSON.stringify(mcp).includes(token), false);
      assert.equal(JSON.stringify(settings).includes(token), false);
      assert.equal(toml.includes(token), false);
      assert.equal(toml.includes('alwaysLoad'), false);
    });
  });

  it('does not write without workDir, for home/cwd, or when disabled', async () => {
    const workDir = await tempWorkDir();

    assert.deepEqual(await seedClaudeMcp('', { sourceConfig: testConfig() }), { seeded: false, reason: 'invalid_workdir' });
    assert.deepEqual(await seedCodexMcp(homedir(), { sourceConfig: testConfig() }), { seeded: false, reason: 'invalid_workdir' });
    assert.deepEqual(await seedClaudeMcp(process.cwd(), { sourceConfig: testConfig() }), { seeded: false, reason: 'invalid_workdir' });
    assert.deepEqual(await seedCodexMcp(workDir, { sourceConfig: testConfig({ enabled: false }) }), { seeded: false, reason: 'disabled' });

    await assert.rejects(readFile(join(workDir, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
  });

  it('does not write Claude folder trust for an empty workDir', async () => {
    await withTempHome(async (home) => {
      await seedClaudeWorkspaceTrust('');
      await assert.rejects(readFile(join(home, '.claude.json'), 'utf8'), /ENOENT/);
    });
  });

  it('seeds Claude trust on both realpath and the given workDir string', async () => {
    await withTempHome(async (home) => {
      const workDir = await tempWorkDir();
      const aliased = `${workDir}/`;
      const logs = [];
      const result = await seedSessionMcp('claude', aliased, {
        sourceConfig: testConfig(),
        logger: { info: (payload) => logs.push(payload), warn() {} },
      });
      assert.equal(result.seeded, true);
      assert.equal(logs.at(-1)?.seeded, true);
      const projects = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).projects;
      assert.equal(projects[workDir].hasTrustDialogAccepted, true);
      assert.equal(projects[aliased].hasTrustDialogAccepted, true);
    });
  });
});
