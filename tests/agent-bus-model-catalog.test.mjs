import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentModelCatalog } from '../modules/agent-bus/routes.mjs';

describe('agent-bus model catalog route data', () => {
  it('exposes Pi provider identities with one Pi backend/session kind', async () => {
    const catalog = await buildAgentModelCatalog({
      listCodexModelsImpl: async () => [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
      listProviderModelsImpl: async (provider) => {
        assert.equal(provider, 'anthropic');
        return {
          models: [
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
            { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
          ],
        };
      },
      listPiModelsImpl: async () => ({
        providers: [
          { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5' },
          { id: 'xai', label: 'xAI', defaultModel: 'grok-4.3' },
          { id: 'google', label: 'Google', defaultModel: 'gemini-3.5-flash' },
          { id: 'opencode-go', label: 'OpenCode Go', defaultModel: 'glm-5.2' },
        ],
        models: {
          openai: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
          xai: [{ id: 'grok-4.3', label: 'Grok 4.3' }],
          google: [{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }],
          'opencode-go': [{ id: 'glm-5.2', label: 'GLM-5.2' }],
        },
      }),
    });

    assert.deepEqual(catalog.providers.map((entry) => entry.id), [
      'codex',
      'claude',
      'openai',
      'xai',
      'google',
      'opencode-go',
    ]);
    assert.equal(catalog.providers.find((entry) => entry.id === 'claude')?.defaultModel, 'claude-opus-5');
    assert.deepEqual(catalog.providers.slice(2).map((entry) => ({
      id: entry.id,
      backendType: entry.backendType,
      runtime: entry.runtime,
      sessionKind: entry.sessionKind,
      defaultModel: entry.defaultModel,
    })), [
      { id: 'openai', backendType: 'pi', runtime: 'pi', sessionKind: 'pi', defaultModel: 'gpt-5.5' },
      { id: 'xai', backendType: 'pi', runtime: 'pi', sessionKind: 'pi', defaultModel: 'grok-4.3' },
      { id: 'google', backendType: 'pi', runtime: 'pi', sessionKind: 'pi', defaultModel: 'gemini-3.5-flash' },
      { id: 'opencode-go', backendType: 'pi', runtime: 'pi', sessionKind: 'pi', defaultModel: 'glm-5.2' },
    ]);
    assert.deepEqual(Object.keys(catalog.models), ['codex', 'claude', 'openai', 'xai', 'google', 'opencode-go']);
  });

  it('keeps other provider results when one discovery source fails', async () => {
    const warnings = [];
    const catalog = await buildAgentModelCatalog({
      listCodexModelsImpl: async () => {
        throw new Error('codex unavailable');
      },
      listProviderModelsImpl: async () => ({
        models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }],
      }),
      listPiModelsImpl: async () => ({
        providers: [{ id: 'xai', label: 'xAI', defaultModel: 'grok-4.3' }],
        models: { xai: [{ id: 'grok-4.3', label: 'Grok 4.3' }] },
      }),
      logger: { warn(message) { warnings.push(message); } },
    });

    assert.deepEqual(catalog.models.codex, []);
    assert.deepEqual(catalog.models.claude.map((entry) => entry.id), ['claude-opus-4-8']);
    assert.deepEqual(catalog.models.xai.map((entry) => entry.id), ['grok-4.3']);
    assert.match(warnings[0], /codex unavailable/);
  });

  it('keeps known xAI launch candidates when fresh Pi discovery omits xAI', async () => {
    const catalog = await buildAgentModelCatalog({
      listCodexModelsImpl: async () => [],
      listProviderModelsImpl: async () => ({ models: [] }),
      listPiModelsImpl: async () => ({
        source: 'pi',
        providers: [{ id: 'google', label: 'Google', defaultModel: 'gemini-3.5-flash' }],
        models: {
          xai: [],
          google: [{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }],
          'opencode-go': [],
        },
      }),
    });

    assert.equal(catalog.providers.find((entry) => entry.id === 'xai')?.defaultModel, 'grok-4.6');
    assert.equal(catalog.models.xai.some((entry) => entry.id === 'grok-4.6'), true);
    assert.equal(catalog.models.xai.some((entry) => entry.id === 'grok-4.7'), true);
  });

  it('prefers provider flagship defaults over alphabetically first catalog ids', async () => {
    const catalog = await buildAgentModelCatalog({
      listCodexModelsImpl: async () => [
        { id: 'gpt-5.4', label: 'GPT-5.4' },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      ],
      listProviderModelsImpl: async () => ({
        models: [
          { id: 'claude-fable-5-1', label: 'Fable 5.1' },
          { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        ],
      }),
      listPiModelsImpl: async () => ({
        providers: [{ id: 'xai', label: 'xAI', defaultModel: 'grok-4.6' }],
        models: {
          xai: [
            { id: 'grok-4.3', label: 'Grok 4.3' },
            { id: 'grok-4.6', label: 'Grok 4.6' },
            { id: 'grok-4.7', label: 'Grok 4.7' },
          ],
        },
      }),
    });

    assert.equal(catalog.providers.find((entry) => entry.id === 'codex')?.defaultModel, 'gpt-6.1-sol');
    assert.equal(catalog.providers.find((entry) => entry.id === 'claude')?.defaultModel, 'claude-opus-5-5');
    assert.equal(catalog.providers.find((entry) => entry.id === 'xai')?.defaultModel, 'grok-4.6');
  });
});
