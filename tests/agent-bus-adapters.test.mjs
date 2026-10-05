import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.mjs';
import { createAgentAdapters } from '../modules/agent-bus/adapters.mjs';
import { onAgentSessionDeleted } from '../modules/agent/session-delete-events.mjs';
import { registerProtocolSessionProvider } from '../modules/sessions/protocol-session-registry.mjs';

describe('Agent bus adapters', () => {
  it('treats 200 sessionEnded payloads as missing sessions', async () => {
    const adapters = createAgentAdapters();
    const app = {
      async inject() {
        return {
          statusCode: 200,
          body: JSON.stringify({
            id: 'claude-ended',
            sessionEnded: true,
            code: 'session_not_found',
            error: "can't find pane: claude-ended",
            state: { state: 'ended', status: 'ended' },
          }),
        };
      },
    };

    await assert.rejects(
      () => adapters.claude.getSession(app, 'claude-ended'),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'session_not_found');
        assert.match(err.message, /can't find pane/);
        return true;
      },
    );
  });

  it('forwards the per-spawn sandbox field to the session route', async () => {
    const adapters = createAgentAdapters();
    const requests = [];
    const app = {
      async inject(request) {
        requests.push(request);
        return { statusCode: 200, body: JSON.stringify({ id: 'abcd1234' }) };
      },
    };

    await adapters.codex.createSession(app, { workDir: '/repo', sandbox: 'nono' });
    assert.equal(requests[0].url, '/api/codex/sessions');
    assert.equal(requests[0].payload.sandbox, 'nono');
  });

  it('rejects a 2xx delete response without a verified terminal status', async () => {
    const adapters = createAgentAdapters();
    const app = {
      async inject() {
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      },
    };

    await assert.rejects(
      () => adapters.codex.deleteSession(app, 'codex-1'),
      (err) => {
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, 'invalid_termination_result');
        return true;
      },
    );
  });

  it('preserves refused delete details for thread-level accounting', async () => {
    const adapters = createAgentAdapters();
    const payload = {
      ok: false,
      status: 'refused',
      reason: 'foreign_owned',
      residual: [{ type: 'process', pid: 88 }],
    };
    const app = {
      async inject() {
        return { statusCode: 403, body: JSON.stringify(payload) };
      },
    };

    await assert.rejects(
      () => adapters.claude.deleteSession(app, 'claude-1'),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.deepEqual(err.payload, payload);
        return true;
      },
    );
  });

  it('notifies session deletion for protocol-backed adapters', async () => {
    const events = [];
    const stop = onAgentSessionDeleted((event) => { events.push(event); });
    const unregister = registerProtocolSessionProvider('deepseek', {
      service: { async terminate() { return { ok: true, status: 'terminated', residual: [] }; } },
    });
    try {
      const result = await createAgentAdapters().deepseek.deleteSession({}, 'deepseek-1');
      assert.equal(result.status, 'terminated');
      assert.deepEqual(events, [{ kind: 'deepseek', sessionId: 'deepseek-1' }]);
    } finally {
      unregister();
      stop();
    }
  });

  it('submits Claude input atomically through the canonical command gate', async () => {
    const adapters = createAgentAdapters();
    const calls = [];
    const app = {
      async inject(options) {
        calls.push(options);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      },
    };

    await adapters.claude.injectText(app, 'claude-1', 'x'.repeat(901));

    const inputCalls = calls.filter((call) => call.url === '/api/claude/sessions/claude-1/input');
    assert.equal(inputCalls.length, 1);
    assert.deepEqual(inputCalls[0].payload, {
      text: 'x'.repeat(901),
      enter: true,
      source: 'agent_bus',
      deadlineAt: inputCalls[0].payload.deadlineAt,
    });
    assert.equal(typeof inputCalls[0].payload.deadlineAt, 'number');
  });

  it('submits Codex multiline input atomically through the canonical command gate', async () => {
    const adapters = createAgentAdapters();
    const calls = [];
    const app = {
      async inject(options) {
        calls.push(options);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      },
    };
    const input = `${'a'.repeat(200)}\n${'b'.repeat(200)}\n${'c'.repeat(50)}`;

    await adapters.codex.injectText(app, 'codex-1', input);

    const inputCalls = calls.filter((call) => call.url === '/api/codex/sessions/codex-1/input');
    assert.equal(inputCalls.length, 1);
    assert.deepEqual(inputCalls[0].payload, {
      text: input,
      enter: true,
      source: 'agent_bus',
      deadlineAt: inputCalls[0].payload.deadlineAt,
    });
  });

  it('routes Pi input through the Pi session backend', async () => {
    const adapters = createAgentAdapters();
    const calls = [];
    const app = {
      async inject(options) {
        calls.push(options);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      },
    };

    await adapters.pi.injectText(app, 'pi-1', 'continue');

    assert.equal(adapters.pi.kind, 'pi');
    assert.equal(calls[0].url, '/api/pi/sessions/pi-1/input');
    assert.deepEqual(calls[0].payload, {
      text: 'continue',
      enter: true,
      source: 'agent_bus',
      deadlineAt: calls[0].payload.deadlineAt,
    });
  });

  it('routes solo-thread input through the DeepSeek ACP backend', async () => {
    const adapters = createAgentAdapters();
    const calls = [];
    const app = {
      async inject(options) {
        calls.push(options);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      },
    };

    await adapters.deepseek.injectText(app, 'dsh-1', 'continue');

    assert.equal(adapters.deepseek.kind, 'deepseek');
    assert.equal(calls[0].url, '/api/deepseek/sessions/dsh-1/input');
    assert.equal(calls[0].payload.text, 'continue');
  });

  it('passes an injection deadline and surfaces command deadline errors', async () => {
    const adapters = createAgentAdapters();
    const startedAt = Date.now();
    let request = null;
    const app = {
      async inject(options) {
        request = options;
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'Command gate deadline expired',
            code: 'command_deadline_expired',
          }),
        };
      },
    };

    await assert.rejects(
      () => adapters.codex.injectText(app, 'codex-blocked', 'deliver later'),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'command_deadline_expired');
        return true;
      },
    );
    assert.equal(request.payload.deadlineAt >= startedAt + config.agentBus.injectDeadlineMs, true);
    assert.equal(request.payload.deadlineAt <= Date.now() + config.agentBus.injectDeadlineMs, true);
  });
});
