import {
  deleteLaunchSkill,
  discoverLaunchSkills,
  publicLaunchSkills,
  saveLaunchSkill,
} from './launch-skills.mjs';

/** @deprecated Use discoverLaunchSkills. Fleet markdown aliases only; no longer scans ~/.claude/commands. */
export function discoverSkills(options = {}) {
  return discoverLaunchSkills(options);
}

function sendSkillError(reply, error, log) {
  const expected = error?.name === 'LaunchSkillError';
  const statusCode = (expected && Number(error?.statusCode)) || 500;
  if (!expected && log?.error) log.error({ err: error }, 'Skill write failed');
  return reply.code(statusCode).send({
    // Unexpected errors (fs failures) can carry paths; keep those out of the response.
    error: expected ? error.message : 'Skill write failed',
    code: (expected && error.code) || 'launch_skill_error',
  });
}

export async function skillsPlugin(app) {
  app.get('/api/skills', async () => ({
    skills: publicLaunchSkills(discoverLaunchSkills({ log: app.log })),
  }));

  app.get('/api/skills/:name', async (req, reply) => {
    const { name } = req.params;
    const skills = discoverLaunchSkills({ log: app.log });
    const skill = skills.find((entry) => entry.name === name);
    if (!skill) return reply.code(404).send({ error: `Skill not found: ${name}` });
    const { file, ...publicSkill } = skill;
    return { ...publicSkill, body: skill.body };
  });

  app.post('/api/skills', async (req, reply) => {
    const { name, description, body, overwrite } = req.body || {};
    try {
      return { skill: saveLaunchSkill({ name, description, body, mode: overwrite ? 'upsert' : 'create' }) };
    } catch (error) {
      return sendSkillError(reply, error, req.log);
    }
  });

  app.put('/api/skills/:name', async (req, reply) => {
    const { description, body } = req.body || {};
    try {
      return { skill: saveLaunchSkill({ name: req.params.name, description, body, mode: 'update' }) };
    } catch (error) {
      return sendSkillError(reply, error, req.log);
    }
  });

  app.delete('/api/skills/:name', async (req, reply) => {
    try {
      return deleteLaunchSkill({ name: req.params.name });
    } catch (error) {
      return sendSkillError(reply, error, req.log);
    }
  });
}
