import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCommandCenterModelCatalog,
  acknowledgeHumanQueueItem,
  addHumanQueueItem,
  answerHumanQueueItem,
  dismissHumanQueueItem,
  getDefaultCommandCenterTarget,
  launchCommandCenterAI,
  launchFleetSupervisorAI,
  normalizeCommandCenterProvider,
  resetCommandCenterRuntimeStateForTests,
  resolveCommandCenterTarget,
  serializeWorkQueue,
} from '../modules/integrations/command-center-ai.mjs';
import { runtimeStatePath } from '../modules/ops/runtime-state.mjs';

const execFileAsync = promisify(execFile);

describe('command center AI', () => {
  it('routes automated terminal input through the canonical session command gate', async () => {
    const source = await readFile(new URL('../modules/integrations/command-center-ai.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sendTmuxText|sendStartupPromptToReadyAgent/);
    assert.match(source, /enqueueAgentSessionCommand/);
    assert.match(source, /command_center_auto_compact/);
    assert.match(source, /fleet_supervisor_startup/);
    assert.doesNotMatch(source, /'--mcp-config'/);
    assert.doesNotMatch(source, /function writeMcpConfig/);
    assert.doesNotMatch(source, /'--system-prompt-file'/);
  });

  it('normalizes only supported provider ids', () => {
    assert.equal(normalizeCommandCenterProvider('openai'), '');
    assert.equal(normalizeCommandCenterProvider('chatgpt'), '');
    assert.equal(normalizeCommandCenterProvider('anthropic'), 'claude');
    assert.equal(normalizeCommandCenterProvider('codex'), 'codex');
  });

  it('defaults to flagship Codex GPT-6.1 Sol medium when codex is enabled', () => {
    const result = getDefaultCommandCenterTarget({
      codexEnabled: true,
      claudeEnabled: false,
    });

    assert.deepEqual(result, {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      backendType: 'codex',
      runtime: 'codex',
      thinkingLevel: 'medium',
    });
  });

  it('falls back from disabled claude to codex', () => {
    const result = resolveCommandCenterTarget(
      { provider: 'claude', model: 'claude-opus-4-6' },
      { codexEnabled: true, claudeEnabled: false },
    );

    assert.deepEqual(result, {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      backendType: 'codex',
      runtime: 'codex',
      thinkingLevel: 'medium',
    });
  });

  it('falls back from removed openai provider selections to codex', () => {
    const result = resolveCommandCenterTarget(
      { provider: 'openai', model: 'gpt-5.4' },
      { codexEnabled: true, claudeEnabled: false },
    );

    assert.deepEqual(result, {
      provider: 'codex',
      model: 'gpt-5.4',
      backendType: 'codex',
      runtime: 'codex',
      thinkingLevel: 'medium',
    });
  });

  it('lists only enabled interactive providers in the command center model catalog', () => {
    const result = buildCommandCenterModelCatalog({
      preferences: { codexEnabled: true, claudeEnabled: false },
      codexModels: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
      claudeModels: [{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }],
    });

    assert.deepEqual(result, {
      defaultProvider: 'codex',
      defaultModel: 'gpt-6.1-sol',
      providers: [{ id: 'codex', label: 'Codex' }],
      available: [{ id: 'gpt-5.4', label: 'GPT-5.4', provider: 'codex' }],
    });
  });

  it('normalizes persisted queue delivery states through the public serializer', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-command-center-'));
    const queueDir = join(stateDir, 'command_center');
    const moduleUrl = new URL('../modules/integrations/command-center-ai.mjs', import.meta.url).href;
    const items = [
      {
        id: 'ccq_routed', status: 'answered', passThrough: true,
        answer: { delivery: { routed: true } }, events: [], updatedAt: '2026-01-06T00:00:00.000Z',
      },
      {
        id: 'ccq_failed', status: 'answered', passThrough: true,
        answer: { delivery: { error: 'session_missing' } }, events: [], updatedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        id: 'ccq_supervisor', status: 'answered', passThrough: false,
        answer: null, events: [], updatedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        id: 'ccq_explicit', status: 'open', delivery_status: ' pending ',
        events: [], updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'ccq_open', status: 'open', passThrough: true,
        events: [], updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'ccq_events', status: 'open', events: 'invalid', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    try {
      await mkdir(queueDir, { recursive: true });
      await writeFile(join(queueDir, 'work-queue.json'), JSON.stringify({ seq: 6, items }));
      const script = [
        `const module = await import(${JSON.stringify(moduleUrl)});`,
        "const result = await module.serializeWorkQueue({ status: 'all' });",
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n');
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CADRE_STATE_DIR: stateDir,
        },
      });
      const result = JSON.parse(stdout);
      const byId = new Map(result.items.map((item) => [item.id, item]));

      assert.deepEqual(result.items.map((item) => item.id), items.map((item) => item.id));
      assert.equal(byId.get('ccq_routed').status, 'routed');
      assert.equal(byId.get('ccq_routed').deliveryStatus, 'routed');
      assert.equal(byId.get('ccq_failed').status, 'delivery_failed');
      assert.equal(byId.get('ccq_failed').deliveryStatus, 'failed');
      assert.equal(byId.get('ccq_supervisor').deliveryStatus, 'supervisor');
      assert.equal(byId.get('ccq_explicit').deliveryStatus, 'pending');
      assert.equal(byId.get('ccq_open').deliveryStatus, 'none');
      assert.deepEqual(byId.get('ccq_events').events, []);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('launches command-center and supervisor sessions through isolated dependencies', async () => {
    const creations = [];
    const discoveries = [];
    const scheduled = [];
    const enqueued = [];
    const createSession = async (backendType, options) => {
      creations.push({ backendType, options });
      return {
        id: backendType === 'codex' ? 'codex-command' : 'claude-supervisor',
        sessionName: backendType === 'codex' ? 'codex-command-session' : 'claude-supervisor-session',
      };
    };
    const scheduleStartup = (callback, delay) => scheduled.push({ callback, delay });

    try {
    const command = await launchCommandCenterAI({
      model: '',
      provider: 'codex',
      enqueueSessionCommand: async (backendType, id, input) => {
        enqueued.push({ backendType, id, input });
      },
    }, {
      createSession,
      scheduleStartup,
      getPreferences: () => ({ codexEnabled: true, claudeEnabled: false }),
      getPreferredModel: async (...args) => {
        discoveries.push(args);
        return 'gpt-5.4';
      },
    });

    assert.deepEqual(command, {
      id: 'codex-command',
      sessionName: 'codex-command-session',
      model: 'gpt-5.4',
      provider: 'codex',
      backendType: 'codex',
      runtime: 'codex',
      thinkingLevel: 'medium',
      startedAt: command.startedAt,
    });
    assert.deepEqual(discoveries, [['codex']]);
    assert.deepEqual(creations[0], {
      backendType: 'codex',
      options: {
        workDir: runtimeStatePath('command_center'),
        model: 'gpt-5.4',
        provider: 'codex',
        thinkingLevel: 'medium',
        source: 'command-center-ai',
        displayName: 'Command Center AI',
        promptProfile: 'command-center',
        mcpProfile: 'dueno',
      },
    });

    const alreadyRunning = await launchCommandCenterAI({}, {
      createSession: async () => assert.fail('an active command-center session must not be recreated'),
      getPreferences: () => assert.fail('an active command-center session must not rediscover preferences'),
    });
    assert.equal(alreadyRunning.alreadyRunning, true);
    assert.equal(alreadyRunning.id, command.id);
    assert.equal(creations.length, 1);

    const supervisor = await launchFleetSupervisorAI({
      model: '',
      provider: 'claude',
      enqueueSessionCommand: async (backendType, id, input) => {
        enqueued.push({ backendType, id, input });
        throw new Error('startup delivery unavailable');
      },
    }, {
      createSession,
      scheduleStartup,
      getPreferences: () => ({ codexEnabled: false, claudeEnabled: true }),
      getPreferredModel: async (...args) => {
        discoveries.push(args);
        throw new Error('model catalog unavailable');
      },
    });

    assert.equal(supervisor.model, 'claude-opus-5-5');
    assert.equal(supervisor.provider, 'claude');
    assert.equal(supervisor.backendType, 'claude');
    assert.equal(supervisor.thinkingLevel, '');
    assert.deepEqual(discoveries[1], ['claude', { fast: false }]);
    assert.deepEqual(creations[1], {
      backendType: 'claude',
      options: {
        workDir: process.cwd(),
        model: 'claude-opus-5-5',
        provider: 'claude',
        thinkingLevel: '',
        source: 'fleet-supervisor-ai',
        displayName: 'Fleet Supervisor AI',
        promptProfile: 'fleet-supervisor',
        mcpProfile: 'dueno',
        mcpCredentialProfile: 'fleet-supervisor',
      },
    });

    assert.deepEqual(scheduled.map(({ delay }) => delay), [4000, 4000]);
    await scheduled[0].callback();
    await scheduled[1].callback();
    assert.equal(enqueued.length, 2);
    assert.deepEqual(enqueued.map(({ backendType, id, input }) => ({
      backendType,
      id,
      source: input.source,
      operation: input.operation,
      enter: input.enter,
      hasPrompt: input.text.length > 0,
    })), [
      {
        backendType: 'codex', id: 'codex-command', source: 'command_center_startup',
        operation: 'startup', enter: true, hasPrompt: true,
      },
      {
        backendType: 'claude', id: 'claude-supervisor', source: 'fleet_supervisor_startup',
        operation: 'startup', enter: true, hasPrompt: true,
      },
    ]);

    const item = await addHumanQueueItem({ question: 'Continue the review?' }, { persist: false });
    const notifications = [];
    const answered = await answerHumanQueueItem(item.id, { answer: 'Continue' }, {
      persist: false,
      enqueueSessionCommand: async (backendType, id, input) => {
        notifications.push({ backendType, id, input });
        throw new Error('supervisor exited');
      },
    });
    assert.equal(answered.status, 'answered');
    assert.deepEqual(notifications, [{
      backendType: 'claude',
      id: 'claude-supervisor',
      input: {
        source: 'fleet_supervisor_human_answer',
        operation: 'message',
        text: `Human queue answered. Item ${item.id}: Continue`,
        enter: true,
      },
    }]);
    } finally {
      resetCommandCenterRuntimeStateForTests();
    }
  });

  it('adds and answers human queue items for fleet supervisor decisions', async () => {
    const broadcasts = [];
    const wsManager = {
      broadcast(channel, type, data) {
        broadcasts.push({ channel, type, data });
      },
    };

    const item = await addHumanQueueItem({
      title: 'Choose next step',
      question: 'How should the worker continue?',
      options: [{ id: 'fix', label: 'Fix it' }],
      sessionKind: 'codex',
      sessionId: 'sess_1',
    }, { wsManager, persist: false });

    assert.equal(item.status, 'open');
    assert.equal(item.options[0].value, 'Fix it');
    assert.equal(broadcasts[0].channel, 'command-center:work-queue');
    assert.equal(broadcasts[0].type, 'item_created');

    const answered = await answerHumanQueueItem(item.id, { optionId: 'fix' }, {
      wsManager,
      persist: false,
      enqueueSessionCommand: async () => {},
    });
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer.text, 'Fix it');
    assert.equal(answered.answer.delivery.mode, 'supervisor');
    assert.equal(broadcasts[1].type, 'item_answered');
  });

  it('routes pass-through queue answers directly to the target session', async () => {
    const sent = [];
    const item = await addHumanQueueItem({
      question: 'Approve direct instruction?',
      options: [{ id: 'go', label: 'Proceed' }],
      sessionKind: 'codex',
      sessionId: 'sess_direct',
      passThrough: true,
    }, { persist: false });

    const answered = await answerHumanQueueItem(item.id, { optionId: 'go' }, {
      persist: false,
      sendSessionInput: async (payload) => {
        sent.push(payload);
      },
    });

    assert.equal(answered.status, 'routed');
    assert.equal(answered.deliveryStatus, 'routed');
    assert.ok(answered.routedAt);
    assert.equal(answered.updatedAt, answered.routedAt);
    assert.equal(answered.events.some((event) => event.type === 'routed'), true);
    assert.equal(answered.answer.delivery.mode, 'pass_through');
    assert.equal(answered.answer.delivery.routed, true);
    assert.equal(answered.answer.delivery.result, null);
    assert.deepEqual(sent, [{
      kind: 'codex',
      sessionId: 'sess_direct',
      text: `Answer for Command Center queue item ${item.id}:\nProceed`,
    }]);

    const openQueue = await serializeWorkQueue({ status: 'open' });
    assert.equal(openQueue.items.some((entry) => entry.id === item.id), false);

    await assert.rejects(
      () => answerHumanQueueItem(item.id, { optionId: 'go' }, {
        persist: false,
        sendSessionInput: async () => {
          throw new Error('must_not_resend');
        },
      }),
      (error) => error.statusCode === 409 && /already routed/.test(error.message),
    );
  });

  it('records pass-through delivery failures without claiming routed delivery', async () => {
    const item = await addHumanQueueItem({
      question: 'Approve direct instruction?',
      sessionKind: 'codex',
      sessionId: 'sess_missing',
      passThrough: true,
    }, { persist: false });

    const answered = await answerHumanQueueItem(item.id, { answer: 'Proceed' }, {
      persist: false,
      sendSessionInput: async () => {
        throw new Error('session_input_404');
      },
      enqueueSessionCommand: async () => {},
    });

    assert.equal(answered.status, 'delivery_failed');
    assert.equal(answered.deliveryStatus, 'failed');
    assert.equal(answered.deliveryError, 'session_input_404');
    assert.equal(answered.updatedAt, answered.deliveryFailedAt);
    assert.equal(answered.answer.delivery.routed, false);
    assert.equal(answered.answer.delivery.error, 'session_input_404');
    assert.equal(answered.events.some((event) => event.type === 'delivery_failed'), true);
  });

  it('rejects missing queue items and empty answers with explicit client errors', async () => {
    await assert.rejects(
      () => answerHumanQueueItem('ccq_missing', { answer: 'Proceed' }, { persist: false }),
      (error) => error.statusCode === 404 && error.message === 'Queue item not found',
    );

    const item = await addHumanQueueItem({
      question: 'Choose an option',
      options: [{ id: 'go', label: 'Proceed' }],
    }, { persist: false });

    await assert.rejects(
      () => answerHumanQueueItem(item.id, { optionId: 'missing' }, { persist: false }),
      (error) => error.statusCode === 400 && error.message === 'answer or optionId is required',
    );
    assert.equal(item.status, 'open');
    assert.equal(item.answer, null);
  });

  it('records an unroutable pass-through target without invoking a sender', async () => {
    const broadcasts = [];
    const item = await addHumanQueueItem({
      question: 'Send this answer?',
      sessionKind: 'unsupported',
      sessionId: 'sess_unreachable',
      passThrough: true,
    }, { persist: false });

    const answered = await answerHumanQueueItem(item.id, { answer: 'Proceed' }, {
      persist: false,
      wsManager: { broadcast: (...args) => broadcasts.push(args) },
      sendSessionInput: async () => assert.fail('sender must not be called for an invalid target'),
      enqueueSessionCommand: async () => {},
    });

    assert.equal(answered.status, 'delivery_failed');
    assert.equal(answered.deliveryStatus, 'failed');
    assert.equal(answered.deliveryError, 'missing_target_session');
    assert.equal(answered.answer.delivery.mode, 'pass_through');
    assert.equal(answered.answer.delivery.routed, false);
    assert.equal(answered.events.at(-1).type, 'delivery_failed');
    assert.equal(broadcasts.at(-1)[1], 'item_delivery_failed');
  });

  it('can mark routed queue items acknowledged after action is verified', async () => {
    const item = await addHumanQueueItem({
      question: 'Approve direct instruction?',
      sessionKind: 'codex',
      sessionId: 'sess_ack',
      passThrough: true,
    }, { persist: false });

    const routed = await answerHumanQueueItem(item.id, { answer: 'Proceed' }, {
      persist: false,
      sendSessionInput: async () => {},
    });

    const acknowledged = await acknowledgeHumanQueueItem(routed.id, { note: 'Session acted' }, { persist: false });

    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal(acknowledged.deliveryStatus, 'acknowledged');
    assert.equal(acknowledged.acknowledgement.text, 'Session acted');
    assert.equal(acknowledged.events.some((event) => event.type === 'acknowledged'), true);

    await assert.rejects(
      () => answerHumanQueueItem(item.id, { answer: 'Send again' }, {
        persist: false,
        sendSessionInput: async () => {
          throw new Error('must_not_resend');
        },
      }),
      (error) => error.statusCode === 409 && /already acknowledged/.test(error.message),
    );
  });

  it('dismisses queue items, tells a waiting pass-through session, and drops them from the open count', async () => {
    const sent = [];
    const broadcasts = [];
    const item = await addHumanQueueItem({
      question: 'Pick a migration strategy?',
      sessionKind: 'pi',
      sessionId: 'sess_coordinator',
      passThrough: true,
    }, { persist: false });
    const openBefore = (await serializeWorkQueue()).openCount;

    const dismissed = await dismissHumanQueueItem(item.id, {
      persist: false,
      wsManager: { broadcast: (...args) => broadcasts.push(args) },
      sendSessionInput: async (input) => { sent.push(input); },
    });

    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.events.at(-1).type, 'dismissed');
    assert.equal(broadcasts.at(-1)[1], 'item_dismissed');
    assert.equal((await serializeWorkQueue()).openCount, openBefore - 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'pi');
    assert.equal(sent[0].sessionId, 'sess_coordinator');
    assert.match(sent[0].text, /Dismissed by the operator without an answer/);

    await dismissHumanQueueItem(item.id, {
      persist: false,
      sendSessionInput: async () => assert.fail('a dismissed item must not notify again'),
    });
    await assert.rejects(
      () => answerHumanQueueItem(item.id, { answer: 'Late answer' }, { persist: false }),
      (error) => error.statusCode === 409 && /already dismissed/.test(error.message),
    );
    await assert.rejects(
      () => dismissHumanQueueItem('ccq_missing', { persist: false }),
      (error) => error.statusCode === 404,
    );
  });
});
