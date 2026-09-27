import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildSkillsUpstreamIntegrationPrompt,
  groupChangedByUpstreamPath,
  isLiveFleetCheckout,
  parseUpstreamManifest,
  parseUpstreamManifestRepos,
} from '../modules/integrations/skills-upstream.mjs';

const MANIFEST = [
  '# header',
  'grilling\tmattpocock/skills\tskills/productivity/grilling/SKILL.md\t885e2ca',
  'technote\thameefy/claude-latex-skill\tSKILL.md\tc594f5a\tadapted',
  'latex-math\thameefy/claude-latex-skill\tSKILL.md\tc594f5a\tSteps 3,6,7 slice',
].join('\n');

describe('skills upstream helpers', () => {
  it('parses the pin manifest and distinct repos', () => {
    const rows = parseUpstreamManifest(MANIFEST);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].note, 'adapted');
    assert.deepEqual(parseUpstreamManifestRepos(MANIFEST), [
      'mattpocock/skills',
      'hameefy/claude-latex-skill',
    ]);
  });

  it('groups changed locals that share one upstream path', () => {
    const groups = groupChangedByUpstreamPath([
      { local: 'technote', repo: 'hameefy/claude-latex-skill', path: 'SKILL.md', headSha: 'abc', commits: ['c1'] },
      { local: 'latex-math', repo: 'hameefy/claude-latex-skill', path: 'SKILL.md', commits: ['c1', 'c2'] },
      { local: 'grilling', repo: 'mattpocock/skills', path: 'skills/productivity/grilling/SKILL.md' },
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].locals, ['technote', 'latex-math']);
    assert.deepEqual(groups[0].commits, ['c1', 'c2']);
    assert.deepEqual(groups[1].locals, ['grilling']);
  });

  it('refuses the live deploy checkout and writes a per-group brief', () => {
    assert.equal(isLiveFleetCheckout('/home/dev/projects/dueno-fleet-live'), true);
    assert.equal(isLiveFleetCheckout('/repo/fleet'), false);
    const prompt = buildSkillsUpstreamIntegrationPrompt({
      repo: 'hameefy/claude-latex-skill',
      path: 'SKILL.md',
      locals: ['technote', 'latex-math'],
    }, { deferredCount: 2 });
    assert.match(prompt, /technote, latex-math/);
    assert.match(prompt, /Work only in this worktree/);
    assert.match(prompt, /2 additional upstream path/);
    assert.match(prompt, /skill:name without braces/);
  });

  it('exits 2 when --repo has no manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skills-upstream-'));
    await writeFile(join(dir, 'README.md'), 'no manifest');
    const result = spawnSync(process.execPath, [
      'scripts/skills-upstream-check.mjs',
      '--repo',
      dir,
      '--json',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /manifest not found/);
  });
});
