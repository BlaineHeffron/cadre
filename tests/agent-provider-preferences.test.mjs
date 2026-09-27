import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAgentProviderPreferences,
  availableInteractiveProviders,
  resolveCollabModels,
  resolveSpawnType,
  updateAgentProviderPreferences,
} from '../modules/agent/provider-preferences.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStoreFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-agent-provider-pref-test-'));
  tempDirs.push(dir);
  return join(dir, 'agent-provider-preferences.json');
}

describe('agent provider preferences', () => {
  it('persists provider toggles and disables collab when one provider is unavailable', async () => {
    const storeFile = await makeStoreFile();
    const updated = await updateAgentProviderPreferences({ claudeEnabled: false, codexEnabled: true, deepseekEnabled: false, piEnabled: false }, { storeFile });
    assert.equal(updated.claudeEnabled, false);
    assert.equal(updated.codexEnabled, true);
    assert.equal(updated.piEnabled, false);
    assert.equal(updated.collabEnabled, false);
    assert.deepEqual(updated.availableSpawnTypes, ['codex']);
    assert.deepEqual(updated.availableProviders, ['codex']);
    assert.equal(resolveSpawnType('claude', updated), 'codex');
    assert.equal(resolveSpawnType('collab', updated), 'codex');
    assert.equal(resolveSpawnType('deepseek', updated), 'codex');

    const loaded = await getAgentProviderPreferences({ storeFile });
    assert.equal(loaded.preferredSingleAgent, 'codex');
    assert.equal(loaded.preferredSingleProvider, 'codex');
    assert.deepEqual(loaded.availableSpawnTypes, ['codex']);
    assert.deepEqual(loaded.availableProviders, ['codex']);
  });

  it('uses one preference switch for all Pi-backed providers', async () => {
    const storeFile = await makeStoreFile();
    const updated = await updateAgentProviderPreferences({ piEnabled: true }, { storeFile });
    assert.equal(updated.piEnabled, true);
    assert.deepEqual(
      updated.providerCatalog.filter((entry) => entry.backendType === 'pi').map((entry) => entry.id),
      ['xai', 'google', 'opencode-go', 'openrouter'],
    );
  });

  it('supports Pi as the only enabled backend', async () => {
    const storeFile = await makeStoreFile();
    const updated = await updateAgentProviderPreferences({
      claudeEnabled: false,
      codexEnabled: false,
      deepseekEnabled: false,
      piEnabled: true,
    }, { storeFile });
    assert.deepEqual(updated.availableSpawnTypes, ['pi', 'collab']);
    assert.deepEqual(updated.availableProviders, ['xai', 'google', 'opencode-go', 'openrouter']);
    assert.equal(updated.preferredSingleAgent, 'pi');
    assert.equal(updated.preferredSingleProvider, 'xai');
    assert.equal(updated.collabEnabled, true);
    assert.equal(resolveSpawnType('codex', updated), 'pi');
  });

  it('can enable DeepSeek as the only spawn type', async () => {
    const storeFile = await makeStoreFile();
    const updated = await updateAgentProviderPreferences({
      claudeEnabled: false,
      codexEnabled: false,
      deepseekEnabled: true,
      piEnabled: false,
    }, { storeFile });
    assert.deepEqual(updated.availableSpawnTypes, ['deepseek']);
    assert.equal(updated.preferredSingleAgent, 'deepseek');
    assert.equal(resolveSpawnType('claude', updated), 'deepseek');
  });
});

describe('resolveCollabModels', () => {
  it('returns default collab models and enables collab when claude and codex are on', () => {
    const resolved = resolveCollabModels();
    assert.equal(typeof resolved.codexModel, 'string');
    assert.ok(resolved.codexModel.length > 0);
    assert.equal(typeof resolved.claudeModel, 'string');
    assert.ok(resolved.claudeModel.length > 0);
    assert.equal(resolved.enabled, true);
  });

  it('trims requested overrides and keeps defaults for blank values', () => {
    const defaults = resolveCollabModels();
    const resolved = resolveCollabModels(
      { claudeEnabled: true, codexEnabled: true },
      { codexModel: '  gpt-5.6-terra  ', claudeModel: '   ' },
    );
    assert.equal(resolved.codexModel, 'gpt-5.6-terra');
    assert.equal(resolved.claudeModel, defaults.claudeModel);
    assert.equal(resolved.enabled, true);
  });

  it('derives collab availability from enabled providers with proven collaboration grades', () => {
    assert.equal(resolveCollabModels({ claudeEnabled: false, codexEnabled: true, deepseekEnabled: false, piEnabled: false }).enabled, false);
    assert.equal(resolveCollabModels({ claudeEnabled: true, codexEnabled: false, deepseekEnabled: true, piEnabled: false }).enabled, true);
    const unproven = { deepSeekE2eEvidence: { proven: false } };
    assert.deepEqual(
      availableInteractiveProviders({ claudeEnabled: true, codexEnabled: false, deepseekEnabled: true, piEnabled: false }, unproven),
      ['claude'],
    );
    assert.equal(
      resolveCollabModels(
        { claudeEnabled: true, codexEnabled: false, deepseekEnabled: true, piEnabled: false },
        {},
        unproven,
      ).enabled,
      false,
    );
  });

  it('enables collab from shorthand claude and codex keys while deepseek is on', () => {
    assert.equal(resolveCollabModels({ claude: true, codex: true, deepseek: true }).enabled, true);
  });
});
