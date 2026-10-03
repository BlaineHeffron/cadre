import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptProfileCatalog,
  buildPromptProfileFieldSchema,
  getPublicPromptProfileCatalog,
  resolvePromptProfile,
  PromptProfileError,
} from '../modules/integrations/prompt-profile-catalog.mjs';
import {
  buildPromptLaunchArgs,
  preparePromptProfileLaunch,
  cleanupPromptProfileLaunch,
} from '../modules/integrations/prompt-profile-launch.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';

describe('prompt profile catalog', () => {
  it('defaults to no style and publishes command-center as a catalog entry', () => {
    const catalog = getPublicPromptProfileCatalog();
    assert.equal(catalog.defaultProfileId, 'none');
    assert.deepEqual(catalog.profiles.map((entry) => entry.id), [
      'none', 'command-center', 'fleet-supervisor', 'coordinator', 'research', 'caveman', 'asd-ste100',
    ]);
    assert.equal(catalog.profiles.find((entry) => entry.id === 'none').hasBody, false);
    assert.equal(catalog.profiles.find((entry) => entry.id === 'command-center').hasBody, true);
    assert.equal(JSON.stringify(catalog).includes('Blaine'), false);
  });

  it('appends a coordinator system prompt whose Command Queue tools exist', () => {
    const resolved = resolvePromptProfile({ promptProfile: 'coordinator' });
    const named = [...new Set(resolved.body.match(/monitor_[a-z_]+/g))];
    const tools = new Set(buildMonitorMcpServer({ requestImpl: async () => ({}) }).listTools().map((tool) => tool.name));

    assert.equal(resolved.placement, 'append');
    assert.deepEqual(buildPromptLaunchArgs({ runtime: 'pi', promptLaunch: resolved }), ['--append-system-prompt', resolved.body]);
    assert.ok(named.includes('monitor_add_human_queue_item'));
    assert.ok(named.includes('monitor_dismiss_human_queue_item'));
    assert.deepEqual(named.filter((name) => !tools.has(name)), []);
  });

  it('renders the command-center body only when selected', () => {
    const none = resolvePromptProfile({ promptProfile: 'none', now: new Date('2026-08-18T12:00:00') });
    assert.equal(none.body, '');
    assert.equal(none.attached || none.body, '');

    const selected = resolvePromptProfile({
      promptProfile: 'command-center',
      now: new Date('2026-08-18T16:00:00'),
    });
    assert.match(selected.body, /Command Center AI/);
    assert.match(selected.body, /August 18, 2026/);
    assert.equal(selected.placement, 'replace');
    assert.match(selected.startupTask, /health check/);
  });

  it('uses an explicit private profile body for an existing profile ID', () => {
    const catalog = buildPromptProfileCatalog({ sourceConfig: {
      promptProfiles: { profiles: { 'command-center': {
        label: 'Command Center', placement: 'replace', template: 'Private operator prompt for {{date}}.',
        startupTask: 'Check the private deployment.',
      } } },
    } });
    const resolved = resolvePromptProfile({
      promptProfile: 'command-center',
      catalog,
    });
    assert.match(resolved.body, /Private operator prompt/);
    assert.equal(resolved.startupTask, 'Check the private deployment.');
  });

  it('exposes profile IDs as MCP options without dumping bodies', () => {
    const schema = buildPromptProfileFieldSchema();
    assert.ok(schema.enum.includes('caveman'));
    assert.ok(schema.enum.includes('asd-ste100'));
    assert.match(schema.description, /asd-ste100/);
    assert.doesNotMatch(JSON.stringify(schema), /Reply in caveman mode/);
    assert.doesNotMatch(JSON.stringify(schema), /Keep procedural sentences/);
    assert.doesNotMatch(JSON.stringify(schema), /subject-verb-object/);

  });

  it('publishes caveman and ASD-STE100 as append styles', () => {
    const caveman = resolvePromptProfile({ promptProfile: 'caveman' });
    assert.equal(caveman.placement, 'append');
    assert.match(caveman.body, /caveman mode/i);
    const ste = resolvePromptProfile({ promptProfile: 'asd-ste100' });
    assert.equal(ste.placement, 'append');
    assert.match(ste.body, /ASD-STE100/);
    assert.match(ste.body, /20 words/);
  });

  it('rejects unknown profiles', () => {
    assert.throws(
      () => resolvePromptProfile({ promptProfile: 'missing' }),
      (error) => error instanceof PromptProfileError && error.code === 'prompt_profile_unknown',
    );
  });
});

describe('prompt profile launch args', () => {
  it('adds append or replace flags per runtime', () => {
    assert.deepEqual(buildPromptLaunchArgs({ runtime: 'pi', promptLaunch: { body: '', placement: 'append' } }), []);
    assert.deepEqual(buildPromptLaunchArgs({
      runtime: 'pi',
      promptLaunch: { body: 'Be terse.', placement: 'append' },
    }), ['--append-system-prompt', 'Be terse.']);
    assert.deepEqual(buildPromptLaunchArgs({
      runtime: 'claude',
      promptLaunch: { body: 'Be terse.', placement: 'replace', filePath: '/tmp/style.txt' },
    }), ['--system-prompt-file', '/tmp/style.txt']);
    assert.deepEqual(buildPromptLaunchArgs({
      runtime: 'codex',
      promptLaunch: { body: 'Be terse.', placement: 'append' },
    }), ['-c', 'developer_instructions="Be terse."']);
  });

  it('writes a session file for selected profiles and cleans it up', async () => {
    const prepared = await preparePromptProfileLaunch({
      promptProfile: 'research',
      backendType: 'claude',
      sessionId: 'styletest',
    });
    assert.equal(prepared.resolved.profileId, 'research');
    assert.match(prepared.prepared.body, /research agent/i);
    assert.ok(prepared.prepared.filePath);
    await cleanupPromptProfileLaunch({ backendType: 'claude', sessionId: 'styletest' });
  });
});
