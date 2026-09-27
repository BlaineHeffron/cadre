import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DeepSeekAcpClient } from '../modules/sessions/deepseek-acp-client.mjs';

const FAKE_SERVER = `
process.stdin.setEncoding('utf8');
let buf = '';
const mode = process.argv[1] || 'ok';
if (mode === 'exit-early') process.exit(0);
if (mode === 'hang-no-newline') {
  process.stdout.write('x'.repeat(100));
  setInterval(() => {}, 1000);
}
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (mode === 'unknown-method-first' && msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: {} }) + '\\n');
    }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
    }
  }
});
`;

const liveChildren = [];

function spawnFake(mode = 'ok') {
  const child = spawn(process.execPath, ['-e', FAKE_SERVER, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  liveChildren.push(child);
  return child;
}

function killLiveChildren() {
  while (liveChildren.length) {
    const child = liveChildren.pop();
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

afterEach(() => {
  killLiveChildren();
});

describe('DeepSeekAcpClient', () => {
  it('starts, prompts, and closes a fake ACP server', { timeout: 15000 }, async () => {
    const client = new DeepSeekAcpClient({
      binary: process.execPath,
      configPath: '/tmp/deepseek.yml',
      env: { PATH: process.env.PATH },
      spawnImpl: () => spawnFake('ok'),
    });
    const sessionId = await client.start(process.cwd());
    assert.equal(sessionId, 's1');
    const result = await client.prompt('hello');
    assert.equal(result.stopReason, 'end_turn');
    const closed = await client.close();
    assert.equal(closed.ok, true);
  });

  it('does not crash the process on EPIPE after child exit', { timeout: 15000 }, async () => {
    const client = new DeepSeekAcpClient({
      binary: process.execPath,
      configPath: '/tmp/deepseek.yml',
      env: { PATH: process.env.PATH },
      spawnImpl: () => spawnFake('exit-early'),
      startTimeoutMs: 500,
    });
    await assert.rejects(() => client.start(process.cwd()));
    assert.equal(client.connectionState, 'closed');
  });

  it('rejects unknown inbound requests and oversized frames', { timeout: 15000 }, async () => {
    const client = new DeepSeekAcpClient({
      binary: process.execPath,
      configPath: '/tmp/deepseek.yml',
      env: { PATH: process.env.PATH },
      spawnImpl: () => spawnFake('unknown-method-first'),
    });
    await client.start(process.cwd());
    const hung = new DeepSeekAcpClient({
      binary: process.execPath,
      configPath: '/tmp/deepseek.yml',
      env: { PATH: process.env.PATH },
      spawnImpl: () => spawnFake('hang-no-newline'),
      maxStdoutBuffer: 32,
      startTimeoutMs: 400,
    });
    await assert.rejects(() => hung.start(process.cwd()), /frame exceeded|no newline|timed out|not writable/i);
    await client.close({ graceMs: 200 });
    const hungClose = await hung.close({ graceMs: 200 });
    assert.equal(typeof hungClose.ok, 'boolean');
  });
});
