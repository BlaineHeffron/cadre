import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

// config.mjs snapshots env at import, so the skills dirs must be redirected first.
const skillsDir = await mkdtemp(join(tmpdir(), 'dueno-skills-api-'));
const localSkillsDir = join(skillsDir, 'local');
process.env.CADRE_LAUNCH_SKILLS_DIR = skillsDir;
process.env.CADRE_LAUNCH_SKILLS_LOCAL_DIR = localSkillsDir;

let app;

before(async () => {
  const { skillsPlugin } = await import('../modules/integrations/skills.mjs');
  app = Fastify();
  await app.register(skillsPlugin);
  await app.ready();
});

describe('skills API', () => {
  it('creates, lists, reads, updates, and deletes a skill', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'deploy-checklist', description: 'Deploy steps', body: 'Smoke, then restart.' },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().skill.name, 'deploy-checklist');
    // Writes land in the git-ignored local overlay, never the tracked stock dir.
    assert.match(await readFile(join(localSkillsDir, 'deploy-checklist.md'), 'utf8'), /description: Deploy steps/);

    const listed = await app.inject({ method: 'GET', url: '/api/skills' });
    assert.deepEqual(listed.json().skills.map((skill) => skill.id), ['deploy-checklist']);
    // The list stays body-free so unused skills never leak into a page payload.
    assert.equal(listed.json().skills[0].body, undefined);

    const read = await app.inject({ method: 'GET', url: '/api/skills/deploy-checklist' });
    assert.equal(read.json().body, 'Smoke, then restart.');

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/skills/deploy-checklist',
      payload: { description: 'Deploy steps', body: 'Smoke, restart, then verify.' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().skill.body, 'Smoke, restart, then verify.');

    const removed = await app.inject({ method: 'DELETE', url: '/api/skills/deploy-checklist' });
    assert.equal(removed.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills' })).json().skills.length, 0);
  });

  it('reports conflicts, unknown updates, and invalid names', async () => {
    await app.inject({ method: 'POST', url: '/api/skills', payload: { name: 'plan', body: 'First.' } });

    const conflict = await app.inject({ method: 'POST', url: '/api/skills', payload: { name: 'plan', body: 'Second.' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'launch_skill_exists');

    const forced = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'plan', body: 'Second.', overwrite: true },
    });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().skill.body, 'Second.');

    const missing = await app.inject({ method: 'PUT', url: '/api/skills/nope', payload: { body: 'text' } });
    assert.equal(missing.statusCode, 404);

    const invalid = await app.inject({ method: 'POST', url: '/api/skills', payload: { name: '../escape', body: 'text' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, 'launch_skill_name_invalid');

    const emptyBody = await app.inject({ method: 'POST', url: '/api/skills', payload: { name: 'blank', body: '  ' } });
    assert.equal(emptyBody.statusCode, 400);
    assert.equal(emptyBody.json().code, 'launch_skill_body_required');

    await app.inject({ method: 'DELETE', url: '/api/skills/plan' });
  });
});
