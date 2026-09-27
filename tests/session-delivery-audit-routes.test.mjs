import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function runAuditFailureInputScenario(kind, { source = 'monitor_send_to_session', paneText = '' } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `dueno-${kind}-audit-input-`));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, 'bin');
  const mutationLog = join(tempDir, 'tmux.log');
  const bufferFile = join(tempDir, 'buffer.txt');
  const sessionId = `${kind}-audit-1`;
  const sessionName = `${kind}-audit-session`;
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'printf "%s %s\\n" "$cmd" "$*" >> "$TMUX_TEST_MUTATION_LOG"',
    'case "$cmd" in',
    '  capture-pane)',
    `    printf ${JSON.stringify(paneText || (kind === 'claude' ? '❯ \n' : '› \n'))}`,
    '    exit 0',
    '    ;;',
    '  list-panes)',
    '    echo "$PPID"',
    '    exit 0',
    '    ;;',
    '  load-buffer)',
    '    cat > "$TMUX_TEST_BUFFER"',
    '    exit 0',
    '    ;;',
    '  paste-buffer|send-keys)',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);

  await writeFile(join(tempDir, `.${kind}_sessions.json`), JSON.stringify([{
    id: sessionId,
    tmuxSession: sessionName,
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve(`modules/sessions/${kind}-sessions.mjs`)).href;
  const pluginExport = `${kind}SessionsPlugin`;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef[${JSON.stringify(pluginExport)}], {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
      sessionDeliveryAuditStore: {
        async record() { throw new Error('audit store down'); },
      },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: ${JSON.stringify(`/api/${kind}/sessions/${sessionId}/input`)},
      payload: { text: 'Do one thing', enter: true, source: ${JSON.stringify(source)} },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const buffered = await readFile(${JSON.stringify(bufferFile)}, 'utf8').catch(() => '');
      if (buffered === 'Do one thing') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const mutationLog = await readFile(${JSON.stringify(mutationLog)}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), mutationLog }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      TMUX_TEST_BUFFER: bufferFile,
      TMUX_TEST_MUTATION_LOG: mutationLog,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runRestartRecoveryScenario(kind, { beyondPublicLimit = false } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `dueno-${kind}-audit-restart-`));
  tempDirs.push(tempDir);
  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve(`modules/sessions/${kind}-sessions.mjs`)).href;
  const pluginExport = `${kind}SessionsPlugin`;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const recorded = [];
    const interrupted = {
      source: 'agent-bus',
      target: { kind: ${JSON.stringify(kind)}, sessionId: 'restart-session' },
      status: 'sending',
      enter: true,
      metadata: { transactionId: 'restart-transaction', operation: 'message' },
    };
    const app = Fastify();
    await app.register(pluginRef[${JSON.stringify(pluginExport)}], {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
      sessionDeliveryAuditStore: {
        async init() {},
        list() { return [interrupted]; },
        listAll() {
          return ${beyondPublicLimit
            ? "[...Array.from({ length: 500 }, (_, index) => ({ ...interrupted, status: 'sent', metadata: { transactionId: `completed-${index}` } })), interrupted]"
            : '[interrupted]'};
        },
        async record(entry) { recorded.push(entry); return entry; },
      },
    });
    await app.ready();
    await app.close();
    console.log(JSON.stringify(recorded));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

describe('session input delivery audit route behavior', () => {
  it('sends Claude UI input directly to the active harness', async () => {
    const result = await runAuditFailureInputScenario('claude', {
      source: 'ui',
      paneText: '• Working (1m 2s • esc to interrupt)\n',
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.state, undefined);
    assert.match(result.mutationLog, /load-buffer/);
    assert.match(result.mutationLog, /paste-buffer/);
    assert.match(result.mutationLog, /send-keys/);
  });

  for (const kind of ['claude', 'codex', 'pi']) {
    it(`sends ${kind} Telegram input to the provider while the harness is active`, async () => {
      const result = await runAuditFailureInputScenario(kind, {
        source: 'telegram_answer',
        paneText: kind === 'pi'
          ? '⠋ Working... (escape to interrupt)\n'
          : '• Working (1m 2s • esc to interrupt)\n',
      });

      assert.equal(result.statusCode, 202, JSON.stringify(result));
      assert.equal(result.body.ok, true);
      assert.equal(result.body.accepted, true);
      assert.equal(result.body.state, 'queued');
      assert.equal(result.mutationLog.includes('load-buffer'), false);
    });
  }

  for (const kind of ['claude', 'codex']) {
    it(`keeps ${kind} input successful when success-path audit persistence fails`, async () => {
      const result = await runAuditFailureInputScenario(kind);

      assert.equal(result.statusCode, 202);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.accepted, true);
      assert.match(result.body.transactionId, /^cmd_/);
      assert.equal(result.body.state, 'queued');
      assert.equal(Boolean(result.body.error), false);
    });

    it(`audits interrupted ${kind} transactions as dropped after restart`, async () => {
      const records = await runRestartRecoveryScenario(kind);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'dropped');
      assert.equal(records[0].error, 'server_restart_interrupted_transaction');
      assert.equal(records[0].metadata.transactionId, 'restart-transaction');
      assert.equal(records[0].metadata.recoveredFromStatus, 'sending');
      assert.equal(records[0].metadata.droppedAtStartup, true);
    });

    it(`audits interrupted ${kind} transactions beyond the public history limit`, async () => {
      const records = await runRestartRecoveryScenario(kind, { beyondPublicLimit: true });
      assert.equal(records.length, 1);
      assert.equal(records[0].metadata.transactionId, 'restart-transaction');
      assert.equal(records[0].status, 'dropped');
    });
  }
});
