import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slugifySkillName } from '../public/pages/skills.mjs';

const controlBar = await readFile(new URL('../public/components/agent-control-bar.mjs', import.meta.url), 'utf8');
const agents = await readFile(new URL('../public/pages/agents.mjs', import.meta.url), 'utf8');
const appShell = await readFile(new URL('../public/app/app.mjs', import.meta.url), 'utf8');
const nav = await readFile(new URL('../public/components/nav.mjs', import.meta.url), 'utf8');
const page = await readFile(new URL('../public/pages/skills.mjs', import.meta.url), 'utf8');

describe('save as skill', () => {
  it('offers the button beside the skill picker in both prompt windows', () => {
    for (const [label, source] of [['session control bar', controlBar], ['new agent form', agents]]) {
      assert.match(source, /openSkillWriterWithDraft/, `${label} must hand the draft to the writer`);
      assert.match(source, /Save as skill/, `${label} must expose the button`);
    }
    // An empty composer has nothing to save, so the button stays disabled.
    assert.match(controlBar, /disabled=\$\{!inputText\.value\.trim\(\)\}/);
    assert.match(agents, /disabled=\$\{!newPrompt\.value\.trim\(\)\}/);
  });

  it('routes /skills to the writer and links it from the nav', () => {
    assert.match(appShell, /<\$\{SkillsPage\} path="\/skills" \/>/);
    assert.match(nav, /\{ label: 'Skills', path: '\/skills' \}/);
  });

  it('picks up a handed-off draft exactly once', () => {
    assert.match(page, /params\.get\('draft'\)/);
    assert.match(page, /takeSkillDraft\(\)/);
  });

  it('opens the writer tab without the noopener feature footgun', async () => {
    const drafts = await readFile(new URL('../public/app/skill-drafts.mjs', import.meta.url), 'utf8');
    // window.open with a 'noopener' feature string returns null by spec, which
    // would trip the same-tab fallback and navigate the composer away too.
    assert.doesNotMatch(drafts, /window\.open\([^)]*noopener/);
    assert.match(drafts, /opened\.opener = null/);
  });

  it('offers the replace-existing toggle during a rename', () => {
    assert.match(page, /!isEditing \|\| slugifySkillName\(name\.value\) !== editingName\.value/);
  });

  it('hides delete for stock skills and labels override deletion as revert', () => {
    assert.match(page, /skill\.source === 'stock' \|\| skill\.source === 'custom' \? null/);
    assert.match(page, /\$\{skill\.hasStock \? 'Revert' : 'Delete'\}/);
  });
});

describe('skill name slugs', () => {
  it('normalizes typed names to on-disk skill ids', () => {
    assert.equal(slugifySkillName('Deploy Checklist'), 'deploy-checklist');
    assert.equal(slugifySkillName('  ../weird  name!! '), 'weird-name');
    assert.equal(slugifySkillName('already-fine.v2'), 'already-fine.v2');
    // The server rejects '..' anywhere in a name; the client collapses it.
    assert.equal(slugifySkillName('a..b'), 'a.b');
    assert.equal(slugifySkillName('x'.repeat(80)).length, 64);
  });
});
