import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  assertAgentProviderModelPair,
  buildAgentProviderCatalog,
  agentProvidersForBackendType,
  inferAgentProviderFromModel,
  isModelCompatibleWithProvider,
  resolveAgentBackendType,
  resolveAgentProviderSelection,
  resolveCompatibleProviderModelPair,
} from '../modules/agent/provider-interface.mjs';

describe('Agent provider interface', () => {
  it('infers Claude for bare Claude model aliases before OpenAI o-series models', () => {
    assert.equal(inferAgentProviderFromModel('opus 5'), 'claude');
    assert.equal(inferAgentProviderFromModel('opus 4.8'), 'claude');
    assert.equal(inferAgentProviderFromModel('sonnet 4.6'), 'claude');
    assert.equal(inferAgentProviderFromModel('o3'), 'codex');
  });

  it('resolves Claude aliases to Claude sessions with canonical model ids', () => {
    assert.equal(
      resolveAgentProviderSelection({ provider: 'claude' }).model,
      'claude-opus-5-5',
    );

    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'claude', model: 'opus 4.8' })),
      {
        provider: 'claude',
        backendType: 'claude',
        runtime: 'claude',
        backendProvider: 'claude',
        model: 'claude-opus-4-8',
      },
    );

    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ fallbackProvider: 'claude', model: 'sonnet 4.6' })),
      {
        provider: 'claude',
        backendType: 'claude',
        runtime: 'claude',
        backendProvider: 'claude',
        model: 'claude-sonnet-4-6',
      },
    );
  });

  it('keeps Pi provider and model identities separate', () => {
    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'openai', model: 'gpt-5.5' })),
      {
        provider: 'codex',
        backendType: 'codex',
        runtime: 'codex',
        backendProvider: 'codex',
        model: 'gpt-5.5',
      },
    );
    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'xai', model: 'grok-4.3' })),
      {
        provider: 'xai',
        backendType: 'pi',
        runtime: 'pi',
        backendProvider: 'xai',
        model: 'grok-4.3',
      },
    );
    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'gemini', model: 'gemini-3.5-flash' })),
      {
        provider: 'google',
        backendType: 'pi',
        runtime: 'pi',
        backendProvider: 'google',
        model: 'gemini-3.5-flash',
      },
    );
    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'opencode', model: 'kimi-k3' })),
      {
        provider: 'opencode-go',
        backendType: 'pi',
        runtime: 'pi',
        backendProvider: 'opencode-go',
        model: 'kimi-k3',
      },
    );
    assert.deepEqual(
      pickProviderFields(resolveAgentProviderSelection({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' })),
      {
        provider: 'openrouter',
        backendType: 'pi',
        runtime: 'pi',
        backendProvider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
      },
    );
    assert.equal(inferAgentProviderFromModel('glm-5.2'), 'opencode-go');
    assert.equal(inferAgentProviderFromModel('kimi-k3'), 'opencode-go');
  });

  it('separates backend types from provider ids', () => {
    assert.deepEqual(agentProvidersForBackendType('pi'), ['xai', 'google', 'opencode-go', 'openrouter']);
    assert.deepEqual(agentProvidersForBackendType('claude'), ['claude']);
    assert.deepEqual(agentProvidersForBackendType('gsd'), []);

    assert.equal(resolveAgentBackendType('pi'), 'pi');
    assert.equal(resolveAgentBackendType('xai'), 'pi');
    assert.equal(resolveAgentBackendType('gemini'), 'pi');
    assert.equal(resolveAgentBackendType('anthropic'), 'claude');
    assert.equal(resolveAgentBackendType('gsd'), '');

    // `pi` stays an invalid provider id: it names a backend, not one of its providers.
    assert.throws(() => resolveAgentProviderSelection({ provider: 'pi' }), /deepseek, xai, google, opencode-go, or openrouter/);
  });

  it('rejects unknown Pi provider typos', () => {
    assert.throws(
      () => resolveAgentProviderSelection({ provider: 'gooogle', model: 'gemini-3.5-flash' }),
      (error) => error?.statusCode === 400 && /opencode-go, or openrouter/.test(error.message),
    );
  });

  it('publishes DeepSeek Harness as an ACP-backed interactive provider', () => {
    const selection = resolveAgentProviderSelection({ provider: 'dsh' });
    assert.deepEqual(pickProviderFields(selection), {
      provider: 'deepseek',
      backendType: 'deepseek',
      runtime: 'deepseek',
      backendProvider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    const catalog = buildAgentProviderCatalog();
    const deepseek = catalog.find((entry) => entry.id === 'deepseek');
    assert.equal(deepseek.supportsInteractiveSessions, true);
    assert.equal(deepseek.supportsCollaboration, true);
    assert.equal(deepseek.supportsOneOffTasks, false);
    assert.equal(deepseek.experimental, true);
    assert.equal(deepseek.enabled, false);
    assert.equal(deepseek.oneOffExecutionMode, 'unsupported');
    assert.equal(deepseek.transportCapabilities.mcpAttachment, 'launch_time_mcp_client');
    assert.deepEqual(deepseek.transportCapabilities.mcpFeatures, { tools: true, resources: false, prompts: false });
    assert.equal(deepseek.transportCapabilities.busParticipation, 'authenticated_scoped');
    assert.deepEqual(deepseek.transportCapabilities.promptCapabilities.types, ['text', 'resource_link']);
    const unproven = buildAgentProviderCatalog({}, { deepSeekE2eEvidence: { proven: false } })
      .find((entry) => entry.id === 'deepseek');
    assert.equal(unproven.supportsCollaboration, false);
    assert.equal(unproven.transportCapabilities.busParticipation, 'none');
  });

  it('publishes tmux image references as an honest degraded prompt capability', () => {
    const catalog = buildAgentProviderCatalog();
    for (const provider of ['codex', 'claude', 'xai', 'google', 'opencode-go', 'openrouter']) {
      const descriptor = catalog.find((entry) => entry.id === provider);
      assert.equal(descriptor.transportCapabilities.delivery, 'keystroke');
      assert.equal(descriptor.transportCapabilities.promptCapabilities.deliveryMode, 'reference');
      assert.deepEqual(descriptor.transportCapabilities.promptCapabilities.types, ['text', 'image']);
    }
  });

  it('publishes the evidence-gated Claude stream-json contract when opted in', () => {
    const options = { claudeStreamJsonEnabled: true, claudeStreamJsonE2eEvidence: { proven: true } };
    const claude = buildAgentProviderCatalog({}, options).find((entry) => entry.id === 'claude');
    assert.equal(claude.transportCapabilities.protocol.name, 'claude-stream-json');
    assert.equal(claude.transportCapabilities.interaction.permissions, 'structured_options');
    assert.equal(claude.transportCapabilities.mcpAttachment, 'launch_time_mcp_client');
    assert.equal(claude.transportCapabilities.busParticipation, 'authenticated_scoped');
    assert.equal(claude.supportsCollaboration, true);
    const unproven = buildAgentProviderCatalog({}, {
      claudeStreamJsonEnabled: true, claudeStreamJsonE2eEvidence: { proven: false },
    }).find((entry) => entry.id === 'claude');
    assert.equal(unproven.transportCapabilities.busParticipation, 'none');
    assert.equal(unproven.supportsCollaboration, false);
  });

  it('publishes Pi providers as one backend and honors the backend preference', () => {
    const enabled = buildAgentProviderCatalog({ claude: true, codex: true });
    assert.deepEqual(
      enabled.filter((entry) => entry.backendType === 'pi').map((entry) => ({
        id: entry.id,
        backendType: entry.backendType,
        sessionKind: entry.sessionKind,
        runtime: entry.runtime,
        backendProvider: entry.backendProvider,
      })),
      [
        { id: 'xai', backendType: 'pi', sessionKind: 'pi', runtime: 'pi', backendProvider: 'xai' },
        { id: 'google', backendType: 'pi', sessionKind: 'pi', runtime: 'pi', backendProvider: 'google' },
        { id: 'opencode-go', backendType: 'pi', sessionKind: 'pi', runtime: 'pi', backendProvider: 'opencode-go' },
        { id: 'openrouter', backendType: 'pi', sessionKind: 'pi', runtime: 'pi', backendProvider: 'openrouter' },
      ],
    );
    assert.equal(buildAgentProviderCatalog({ pi: false }).every((entry) => entry.backendType !== 'pi' || !entry.enabled), true);
  });

  it('treats cross-backend provider/model pairs as incompatible',
    () => {
      assert.equal(isModelCompatibleWithProvider('codex', 'grok-4.6'), false);
      assert.equal(isModelCompatibleWithProvider('xai', 'gpt-5.6-sol'), false);
      assert.equal(isModelCompatibleWithProvider('claude', 'grok-4.6'), false);
      assert.equal(isModelCompatibleWithProvider('codex', 'gpt-5.6-sol'), true);
      assert.equal(isModelCompatibleWithProvider('xai', 'grok-4.6'), true);
      assert.equal(isModelCompatibleWithProvider('codex', 'gpt-test'), false);
      assert.equal(isModelCompatibleWithProvider('codex', 'fable'), false);
      assert.equal(isModelCompatibleWithProvider('claude', 'fable'), false);
      assert.equal(isModelCompatibleWithProvider('claude', 'claude-fable-5-1'), true);
    });

  it('accepts GPT-6 Sol/Luna, Opus 5.5, and Grok 4.7', () => {
    assert.equal(isModelCompatibleWithProvider('codex', 'gpt-6-astra'), true);
    assert.equal(isModelCompatibleWithProvider('codex', 'gpt-6-sol'), true);
    assert.equal(isModelCompatibleWithProvider('codex', 'gpt-6-luna'), true);
    assert.equal(isModelCompatibleWithProvider('claude', 'claude-opus-5-5'), true);
    assert.equal(isModelCompatibleWithProvider('xai', 'grok-4.7'), true);
  });

  it('derives the model default and falls back on an incompatible explicit pair', () => {
    const logs = [];
    const logger = { error: (...args) => logs.push(args.join(' ')) };

    assert.deepEqual(
      resolveCompatibleProviderModelPair({ provider: 'codex', model: '', logger }),
      { provider: 'codex', model: 'gpt-6-sol' },
    );
    assert.deepEqual(
      resolveCompatibleProviderModelPair({ provider: 'xai', model: '', logger }),
      { provider: 'xai', model: 'grok-4.6' },
    );
    assert.deepEqual(
      resolveCompatibleProviderModelPair({
        provider: 'codex',
        model: 'grok-4.6',
        label: 'githubAgents',
        logger,
      }),
      { provider: 'codex', model: 'gpt-6-sol' },
    );
    assert.match(logs[0], /githubAgents: incompatible provider\/model pair codex\/grok-4\.6/);
    assert.deepEqual(
      resolveCompatibleProviderModelPair({ provider: '', model: '', allowEmpty: true, logger }),
      { provider: '', model: '' },
    );
    assert.deepEqual(
      resolveCompatibleProviderModelPair({
        provider: '',
        model: 'grok-4.6',
        allowEmpty: true,
        logger,
      }),
      { provider: '', model: 'grok-4.6' },
    );
    assert.equal(logs.length, 1);
  });

  it('reuses backend assertions for an explicit incompatible pair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-provider-pair-'));
    try {
      await assert.rejects(
        () => assertAgentProviderModelPair('codex', 'grok-4.6', {
          forceRefresh: true,
          env: {},
          cacheFile: join(dir, 'model-cache.json'),
          fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
        }),
        /Unsupported Codex model "grok-4.6"/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('assertAgentProviderModelPair backend branches', () => {
  it('accepts a supported DeepSeek Harness model and the dsh alias default', async () => {
    const explicit = await assertAgentProviderModelPair('deepseek', 'deepseek-v4-flash');
    assert.equal(explicit.provider, 'deepseek');
    assert.equal(explicit.backendType, 'deepseek');
    assert.equal(explicit.model, 'deepseek-v4-flash');

    const aliased = await assertAgentProviderModelPair('dsh');
    assert.equal(aliased.provider, 'deepseek');
    assert.equal(aliased.model, 'deepseek-v4-pro');
  });

  it('rejects an unsupported DeepSeek Harness model with a 400', async () => {
    await assert.rejects(
      () => assertAgentProviderModelPair('deepseek', 'deepseek-v9'),
      (error) => error?.statusCode === 400
        && /Unsupported DeepSeek Harness model "deepseek-v9"/.test(error.message)
        && /deepseek-v4-pro, deepseek-v4-flash/.test(error.message),
    );
  });

  it('routes claude and pi providers to their backend assertions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-provider-pair-branches-'));
    try {
      await assert.rejects(
        () => assertAgentProviderModelPair('claude', 'grok-4.6', {
          forceRefresh: true,
          env: {},
          cacheFile: join(dir, 'claude-model-cache.json'),
          fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
        }),
        (error) => error?.statusCode === 400 && /grok-4\.6/.test(error?.message || ''),
      );
      await assert.rejects(
        () => assertAgentProviderModelPair('xai', 'grok-4.6', {
          binary: '/missing/pi',
          cacheFile: join(dir, 'pi-model-cache.json'),
          env: {},
          execImpl: async () => ({ code: 'ENOENT', stdout: '', stderr: '' }),
        }),
        (error) => error?.code === 'pi_binary_missing' && error?.statusCode === 503,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function pickProviderFields(selection) {
  return {
    provider: selection.provider,
    backendType: selection.backendType,
    runtime: selection.runtime,
    backendProvider: selection.backendProvider,
    model: selection.model,
  };
}
