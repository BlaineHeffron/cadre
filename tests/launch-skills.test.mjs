import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  composeLaunchUserPrompt,
  deleteLaunchSkill,
  discoverLaunchSkills,
  expandSkillTokens,
  LaunchSkillError,
  MAX_SKILL_EXPANSION_DEPTH,
  resolveLaunchSkills,
  saveLaunchSkill,
  skillDeliveryResolution,
} from '../modules/integrations/launch-skills.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  expandQuickTokens,
  insertQuickToken,
  insertSkillToken,
  normalizeSkillPromptText,
  parseSkillPrompt,
  quickTokenLabel,
  serializeSkillPrompt,
} from '../public/app/skill-tokens.mjs';

async function skillDir(files = {}, localFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-skills-'));
  const dir = join(root, 'stock');
  const localDir = join(root, 'local');
  await mkdir(dir, { recursive: true });
  await mkdir(localDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  for (const [name, body] of Object.entries(localFiles)) {
    await writeFile(join(localDir, name), body);
  }
  return { launchSkills: { dir, localDir } };
}

describe('launch skills', () => {
  it('discovers fleet markdown aliases without leaking unused bodies', async () => {
    const sourceConfig = await skillDir({
      'review.md': '---\ndescription: Review a change\n---\nReview the diff and list risks.',
      'notes.txt': 'ignored',
    });
    const skills = discoverLaunchSkills({ sourceConfig });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, 'review');
    assert.equal(skills[0].description, 'Review a change');
    assert.equal(skills[0].body, 'Review the diff and list risks.');
  });

  it('strips a leading license comment from the body, preview, and description fallback', async () => {
    const sourceConfig = await skillDir({
      'licensed.md': '<!--\nCopyright 2026 Example\nMIT License\n-->\n\n# Do The Thing\n\nSteps here.',
    });
    const skills = discoverLaunchSkills({ sourceConfig });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].body, '# Do The Thing\n\nSteps here.');
    assert.match(skills[0].preview, /^# Do The Thing/);
    assert.doesNotMatch(skills[0].preview, /Copyright/);
    assert.equal(skills[0].description, 'Do The Thing');
  });

  it('injects only selected skill text plus the user prompt', async () => {
    const sourceConfig = await skillDir({
      'review.md': 'Review the diff.',
      'ship.md': 'Prepare the merge.',
    });
    const prompt = composeLaunchUserPrompt({
      sourceConfig,
      skillIds: ['review'],
      initialPrompt: 'Focus on tests.',
    });
    assert.equal(prompt, 'Review the diff.\n\nFocus on tests.');
    assert.equal(prompt.includes('Prepare the merge'), false);
    assert.deepEqual(resolveLaunchSkills({ sourceConfig, skillIds: [] }), []);
  });

  it('expands highlighted skill tokens only at send time', async () => {
    const sourceConfig = await skillDir({
      'review.md': 'Review the diff.',
    });
    assert.equal(
      expandSkillTokens('Please {{skill:review}} now.', { sourceConfig }),
      'Please Review the diff. now.',
    );
    assert.equal(
      composeLaunchUserPrompt({
        sourceConfig,
        initialPrompt: 'Start {{skill:review}}',
      }),
      'Start Review the diff.',
    );
    assert.throws(
      () => expandSkillTokens('{{skill:missing}}', { sourceConfig }),
      (error) => error instanceof LaunchSkillError && error.code === 'launch_skill_unknown',
    );
  });

  it('keeps skill names as tokens until serialization', () => {
    const inserted = insertSkillToken('Look at this', 'review');
    assert.equal(inserted.text, 'Look at this {{skill:review}}');
    assert.deepEqual(parseSkillPrompt(inserted.text), [
      { type: 'text', value: 'Look at this ' },
      { type: 'skill', id: 'review' },
    ]);
    assert.equal(serializeSkillPrompt(parseSkillPrompt(inserted.text)), inserted.text);
  });

  it('keeps quick inserts as id chips until they are sent', () => {
    const inserted = insertQuickToken('Ping', 'session::claude::ab12');
    assert.equal(inserted.text, 'Ping {{quick:session::claude::ab12}}');
    assert.deepEqual(parseSkillPrompt(inserted.text), [
      { type: 'text', value: 'Ping ' },
      { type: 'quick', key: 'session::claude::ab12' },
    ]);
    assert.equal(serializeSkillPrompt(parseSkillPrompt(inserted.text)), inserted.text);
    assert.equal(quickTokenLabel('session::claude::ab12'), 'claude:ab12');
    assert.equal(quickTokenLabel('thread::t-9'), 'thread:t-9');
  });

  it('resolves quick tokens from live state and leaves skill tokens alone', () => {
    const text = 'Ping {{quick:thread::t-9}} then {{skill:review}}';
    assert.deepEqual(
      expandQuickTokens(text, (key) => (key === 'thread::t-9' ? 'Monitor thread t-9.' : '')),
      { text: 'Ping Monitor thread t-9. then {{skill:review}}', missing: [] },
    );
  });

  it('reports unresolved quick tokens instead of dropping them', () => {
    assert.deepEqual(
      expandQuickTokens('Check {{quick:thread::gone}}', () => ''),
      { text: 'Check ', missing: ['thread::gone'] },
    );
  });

  it('never rewrites the surrounding user text', () => {
    assert.deepEqual(
      expandQuickTokens('  spacing matters\n', () => ''),
      { text: '  spacing matters\n', missing: [] },
    );
    // Only the substituted value is normalized; trailing spaces, indentation
    // and code blocks the user typed survive a chip in the same message.
    assert.deepEqual(
      expandQuickTokens('  keep   \n{{quick:thread::t-1}}\n  me  ', () => '  watch t-1  '),
      { text: '  keep   \nwatch t-1\n  me  ', missing: [] },
    );
  });

  it('keeps skill ids on the server charset so both parsers agree', () => {
    // modules/integrations/launch-skills.mjs SKILL_TOKEN_RE would not match a
    // `::` skill id, so the composer must not render one as a chip either.
    assert.deepEqual(parseSkillPrompt('{{skill:a::b}}'), [
      { type: 'text', value: '{{skill:a::b}}' },
    ]);
    assert.deepEqual(parseSkillPrompt('{{skill:plan}}'), [{ type: 'skill', id: 'plan' }]);
  });

  it('normalizes trailing newlines from contenteditable serialization', () => {
    assert.equal(normalizeSkillPromptText('plan\n\n'), 'plan');
  });

  it('expands skill tokens inside the session input try block', async () => {
    const source = await readFile(resolve('modules/sessions/index.mjs'), 'utf8');
    assert.match(source, /try \{\s*const sourceText = text == null \? text : String\(text\);\s*const resolvedText = text == null \? text : resolveHarnessUserText\(text\);/);
  });

  it('rejects unknown skill ids', async () => {
    const sourceConfig = await skillDir({ 'review.md': 'Review the diff.' });
    assert.throws(
      () => resolveLaunchSkills({ sourceConfig, skillIds: ['missing'] }),
      (error) => error instanceof LaunchSkillError && error.code === 'launch_skill_unknown',
    );
  });
});

describe('launch skill authoring', () => {
  it('creates a skill file that discovery can read back', async () => {
    const sourceConfig = await skillDir();
    const saved = saveLaunchSkill({
      name: 'Deploy-Checklist',
      description: 'Steps before a deploy',
      body: 'Run the smoke suite, then restart.',
      mode: 'create',
      sourceConfig,
    });
    assert.equal(saved.name, 'deploy-checklist');
    assert.equal(saved.created, true);
    assert.equal(saved.body, 'Run the smoke suite, then restart.');

    const [discovered] = discoverLaunchSkills({ sourceConfig });
    assert.equal(discovered.id, 'deploy-checklist');
    assert.equal(discovered.description, 'Steps before a deploy');
    assert.equal(
      composeLaunchUserPrompt({ skillIds: ['deploy-checklist'], sourceConfig }),
      'Run the smoke suite, then restart.'
    );
  });

  it('refuses to create over an existing skill but updates in place', async () => {
    const sourceConfig = await skillDir({ 'plan.md': 'Original plan text.' });
    assert.throws(
      () => saveLaunchSkill({ name: 'plan', body: 'New text', mode: 'create', sourceConfig }),
      (error) => error instanceof LaunchSkillError && error.code === 'launch_skill_exists' && error.statusCode === 409
    );
    const updated = saveLaunchSkill({ name: 'plan', body: 'New text', mode: 'update', sourceConfig });
    assert.equal(updated.created, false);
    assert.equal(updated.body, 'New text');
  });

  it('rejects unknown updates, empty bodies, and path-escaping names', async () => {
    const sourceConfig = await skillDir();
    assert.throws(
      () => saveLaunchSkill({ name: 'missing', body: 'text', mode: 'update', sourceConfig }),
      (error) => error.code === 'launch_skill_unknown' && error.statusCode === 404
    );
    assert.throws(
      () => saveLaunchSkill({ name: 'blank', body: '   ', sourceConfig }),
      (error) => error.code === 'launch_skill_body_required'
    );
    for (const name of ['../escape', 'has space', 'UP/down', '']) {
      assert.throws(
        () => saveLaunchSkill({ name, body: 'text', sourceConfig }),
        (error) => error.code === 'launch_skill_name_invalid',
        `expected ${JSON.stringify(name)} to be rejected`
      );
    }
  });

  it('deletes a skill and reports unknown deletes', async () => {
    const sourceConfig = await skillDir({}, { 'temp.md': 'Temporary text.' });
    assert.deepEqual(
      deleteLaunchSkill({ name: 'temp', sourceConfig }),
      { deleted: 'temp', revertedToStock: false }
    );
    assert.deepEqual(discoverLaunchSkills({ sourceConfig }), []);
    assert.throws(
      () => deleteLaunchSkill({ name: 'temp', sourceConfig }),
      (error) => error.code === 'launch_skill_unknown' && error.statusCode === 404
    );
  });

  it('writes into the local overlay and shadows the stock skill', async () => {
    const sourceConfig = await skillDir({ 'plan.md': 'Stock plan text.' });
    const saved = saveLaunchSkill({ name: 'plan', body: 'Edited plan text.', mode: 'update', sourceConfig });
    assert.equal(saved.source, 'local');
    assert.equal(saved.hasStock, true);
    // The tracked stock file is untouched, so a deploy reset cannot revert the edit.
    assert.equal(
      await readFile(join(sourceConfig.launchSkills.dir, 'plan.md'), 'utf8'),
      'Stock plan text.'
    );
    const skills = discoverLaunchSkills({ sourceConfig });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].body, 'Edited plan text.');
    assert.equal(skills[0].source, 'local');
  });

  it('deleting an override reverts to stock; stock-only skills refuse deletion', async () => {
    const sourceConfig = await skillDir(
      { 'plan.md': 'Stock plan text.' },
      { 'plan.md': 'Edited plan text.' }
    );
    assert.deepEqual(
      deleteLaunchSkill({ name: 'plan', sourceConfig }),
      { deleted: 'plan', revertedToStock: true }
    );
    const [reverted] = discoverLaunchSkills({ sourceConfig });
    assert.equal(reverted.body, 'Stock plan text.');
    assert.equal(reverted.source, 'stock');
    assert.throws(
      () => deleteLaunchSkill({ name: 'plan', sourceConfig }),
      (error) => error.code === 'launch_skill_readonly' && error.statusCode === 409
    );
  });

  it('expands skill tokens nested inside skill bodies, with a cycle guard', async () => {
    const sourceConfig = await skillDir({
      'outer.md': 'Before. {{skill:inner}} After.',
      'inner.md': 'Inner text.',
      'loop.md': 'Back to {{skill:loop}}.',
    });
    assert.equal(
      expandSkillTokens('Go {{skill:outer}}', { sourceConfig }),
      'Go Before. Inner text. After.'
    );
    // Bodies selected via skillIds expand too, not just prompt tokens.
    assert.equal(
      composeLaunchUserPrompt({ sourceConfig, skillIds: ['outer'], initialPrompt: 'Do it.' }),
      'Before. Inner text. After.\n\nDo it.'
    );
    assert.throws(
      () => expandSkillTokens('{{skill:loop}}', { sourceConfig }),
      (error) => error instanceof LaunchSkillError && error.code === 'launch_skill_cycle'
    );
  });

  it('distinguishes indirect cycles from acyclic depth exhaustion', async () => {
    const files = {
      'cycle-a.md': '{{skill:cycle-b}}',
      'cycle-b.md': '{{skill:cycle-a}}',
    };
    for (let index = 0; index <= MAX_SKILL_EXPANSION_DEPTH; index += 1) {
      files[`depth-${index}.md`] = index === MAX_SKILL_EXPANSION_DEPTH
        ? 'terminal'
        : `{{skill:depth-${index + 1}}}`;
    }
    const sourceConfig = await skillDir(files);
    assert.throws(
      () => expandSkillTokens('{{skill:cycle-a}}', { sourceConfig }),
      (error) => error.code === 'launch_skill_cycle' && error.details.cycle.join(' -> ') === 'cycle-a -> cycle-b -> cycle-a',
    );
    assert.throws(
      () => expandSkillTokens('{{skill:depth-0}}', { sourceConfig }),
      (error) => error.code === 'launch_skill_depth_exceeded' && error.details.maxDepth === MAX_SKILL_EXPANSION_DEPTH,
    );
  });

  it('discovers visual exploration skills and expands nested frontend review tokens', () => {
    const skills = discoverLaunchSkills();
    const ids = new Set(skills.map((skill) => skill.id));

    assert.equal(ids.has('frontend-design'), true);
    assert.equal(ids.has('visual-design-it-twice'), true);
    assert.equal(ids.has('web-design-review'), true);

    const expanded = expandSkillTokens('{{skill:visual-design-it-twice}}');
    assert.equal(expanded.includes('{{skill:'), false);
    assert.match(expanded, /# Frontend Design/);
    assert.match(expanded, /# Web Design Review/);
  });

  it('composes stock, ordered custom directories, and local overrides through real discovery and resolution', async () => {
    const sourceConfig = await skillDir({ 'shared.md': 'stock', 'stock-only.md': 'stock only' });
    const root = await mkdtemp(join(tmpdir(), 'dueno-custom-skills-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'shared.md'), 'first custom');
    await writeFile(join(first, 'custom-only.md'), 'custom only');
    await writeFile(join(second, 'shared.md'), 'second custom {{skill:custom-only}}');
    sourceConfig.launchSkills.customDirs = [first, second].join(delimiter);
    const discovered = discoverLaunchSkills({ sourceConfig });
    assert.deepEqual(discovered.map((skill) => [skill.id, skill.source]), [
      ['custom-only', 'custom'], ['shared', 'custom'], ['stock-only', 'stock'],
    ]);
    assert.deepEqual(resolveLaunchSkills({ sourceConfig, skillIds: ['custom-only'] }), [
      { id: 'custom-only', body: 'custom only' },
    ]);
    assert.equal(expandSkillTokens('{{skill:shared}}', { sourceConfig }), 'second custom custom only');
    assert.throws(() => saveLaunchSkill({ name: 'custom-only', body: 'new', mode: 'create', sourceConfig }),
      (error) => error.code === 'launch_skill_exists');
    assert.throws(() => deleteLaunchSkill({ name: 'custom-only', sourceConfig }),
      (error) => error.code === 'launch_skill_readonly');
    const saved = saveLaunchSkill({ name: 'shared', body: 'local override', mode: 'update', sourceConfig });
    assert.equal(saved.hasStock, true);
    assert.equal(await readFile(join(second, 'shared.md'), 'utf8'), 'second custom {{skill:custom-only}}');
    assert.equal(expandSkillTokens('{{skill:shared}}', { sourceConfig }), 'local override');
    assert.deepEqual(deleteLaunchSkill({ name: 'shared', sourceConfig }),
      { deleted: 'shared', revertedToStock: true });
    assert.equal(expandSkillTokens('{{skill:shared}}', { sourceConfig }), 'second custom custom only');
  });

  it('summarizes resolved delivery without exposing the resolved body', () => {
    const summary = skillDeliveryResolution('{{skill:a}}', 'terminal content');
    assert.equal(summary.skillTokensResolved, true);
    assert.equal(summary.unresolvedSkillTokenCount, 0);
    assert.match(summary.deliveredTextHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(summary, 'resolvedText'), false);
  });
});
