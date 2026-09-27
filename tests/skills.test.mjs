import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Skills module', () => {
  it('should be importable without errors', async () => {
    const mod = await import('../modules/integrations/skills.mjs');
    assert.equal(typeof mod.skillsPlugin, 'function');
  });

  it('exports discoverSkills without requiring an app-scoped logger', async () => {
    const mod = await import('../modules/integrations/skills.mjs');
    assert.equal(typeof mod.discoverSkills, 'function');
    const skills = mod.discoverSkills();
    assert.ok(Array.isArray(skills));
  });
});
