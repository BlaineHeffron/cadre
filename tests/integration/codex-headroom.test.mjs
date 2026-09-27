// CODEX_BIN=/absolute/path/to/codex node --test tests/integration/codex-headroom.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { headroomLaunchOverrides } from '../../modules/agent/headroom.mjs';
import { renderAgentSessionLaunch } from '../../modules/sessions/index.mjs';

test('installed Codex accepts Fleet Headroom config and sends authenticated Responses traffic', {
  skip: !process.env.CODEX_BIN, timeout: 30000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-headroom-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    requests.push({ path: req.url, headers: req.headers, body: input ? JSON.parse(input) : null });
    if (req.method !== 'POST') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'headroom-cli-ok', annotations: [] }] };
    for (const event of [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: output },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [output],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headroom = headroomLaunchOverrides('codex', origin);
  const { allArgs } = renderAgentSessionLaunch({
    backendType: 'codex', provider: 'codex', sessionBinary: process.env.CODEX_BIN, headroom,
    buildOptions: { workDir: dir, model: 'gpt-6-astra' },
  });
  const execution = promisify(execFile)(process.env.CODEX_BIN, [
    ...allArgs, 'exec', '--skip-git-repo-check', '--json', 'Reply with the fixture text. Do not use tools.',
  ], {
    cwd: dir, timeout: 20000,
    env: { PATH: process.env.PATH, CODEX_HOME: dir, CODEX_API_KEY: 'fixture-only', ...headroom.env },
  });
  execution.child.stdin.end();
  const { stdout, stderr } = await execution;
  assert.ok(stdout.includes('headroom-cli-ok'), JSON.stringify({ stdout, stderr, paths: requests.map((request) => request.path) }));
  const request = requests.find((entry) => entry.path === '/v1/responses' && entry.body);
  assert.ok(request, 'Codex must make an actual Responses request to the local proxy endpoint');
  assert.equal(request.headers.authorization, 'Bearer fixture-only');
  assert.equal(request.headers['x-headroom-base-url'], 'https://api.openai.com');
  assert.equal(request.body.model, 'gpt-6-astra');
});
