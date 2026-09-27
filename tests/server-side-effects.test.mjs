import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempDirs = [];
const children = [];

afterEach(async () => {
  while (children.length > 0) {
    await stopChild(children.pop());
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function getOpenPort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function portAcceptsConnections(port) {
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once('error', () => resolveCheck(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveCheck(false);
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

describe('server side-effect suppression', () => {
  it('disables guarded listeners and retains passive threat routes', async () => {
    const port = await getOpenPort();
    const mcpPort = await getOpenPort();
    const stateDir = await tempDir('dueno-server-state-');
    const homeDir = await tempDir('dueno-server-home-');
    const authToken = 'server-side-effects-test-token';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: resolve('.'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        CADRE_STATE_DIR: stateDir,
        APP_STATE_STORAGE: 'file',
        DATABASE_URL: '',
        TLS_ENABLED: '0',
        LOG_LEVEL: 'error',
        AUTH_TOKEN: authToken,
        INTERNAL_BYPASS_TOKEN: `${authToken}-bypass`,
        BROWSER_SESSION_SECRET: `${authToken}-session`,
        PORT: String(port),
        HOST: '127.0.0.1',
        AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
        AGENT_BUS_MCP_HTTP_PORT: String(mcpPort),
        CADRE_DISABLE_SIDE_EFFECTS: '1',
        CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
        CADRE_GITHUB_AGENTS_ENABLED: '0',
        CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0',
        TELEGRAM_BRIDGE: '0',
      },
    });
    children.push(child);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      if (code !== null && code !== 0) stderr += `\nserver exited with code ${code}`;
      if (signal) stderr += `\nserver exited with signal ${signal}`;
    });

    const health = await waitForJson(`http://127.0.0.1:${port}/api/agent-bus/mcp-health`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }).catch((error) => {
      error.message = `${error.message}\n${stderr}`;
      throw error;
    });

    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.enabled, false);
    assert.equal(health.body.reason, 'side_effect_loops_suppressed');
    assert.equal(await portAcceptsConnections(mcpPort), false);

    const threatAlerts = await waitForJson(`http://127.0.0.1:${port}/api/threats/alerts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(threatAlerts.status, 200);
    assert.deepEqual(threatAlerts.body, { alerts: [], total: 0 });

    const threatOverview = await waitForJson(`http://127.0.0.1:${port}/api/threats/overview`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(threatOverview.status, 200);
    assert.deepEqual(threatOverview.body, {
      summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      recentAlerts: [],
    });
  });
});

describe('server auth secret startup', () => {
  it('exits when AUTH_TOKEN is reused as the bypass or session secret', async () => {
    const port = await getOpenPort();
    const mcpPort = await getOpenPort();
    const stateDir = await tempDir('dueno-server-auth-state-');
    const homeDir = await tempDir('dueno-server-auth-home-');
    const authToken = 'shared-startup-token';
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: resolve('.'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        CADRE_STATE_DIR: stateDir,
        APP_STATE_STORAGE: 'file',
        DATABASE_URL: '',
        TLS_ENABLED: '0',
        LOG_LEVEL: 'error',
        AUTH_TOKEN: authToken,
        INTERNAL_BYPASS_TOKEN: authToken,
        BROWSER_SESSION_SECRET: `${authToken}-session`,
        PORT: String(port),
        HOST: '127.0.0.1',
        AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
        AGENT_BUS_MCP_HTTP_PORT: String(mcpPort),
        CADRE_DISABLE_SIDE_EFFECTS: '1',
        CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
        CADRE_GITHUB_AGENTS_ENABLED: '0',
        CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0',
        TELEGRAM_BRIDGE: '0',
      },
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const [code] = await Promise.race([
      new Promise((resolveExit) => child.once('exit', (exitCode, signal) => resolveExit([exitCode, signal]))),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not exit\n${stderr}`)), 10000)),
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Auth secrets fail closed/);
    assert.equal(await portAcceptsConnections(port), false);
  });
});
