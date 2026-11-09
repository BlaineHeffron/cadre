import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeTrend, parseGrade, promptChanges } from '../modules/sessions/session-grading.mjs';

const committed = (text) => [{ type: 'message.committed', blocks: [{ type: 'text', text }] }];

test('parseGrade takes the last fenced json block and rejects output without valid scores', () => {
  const grade = { session: 's', pr: 1, scores: { efficiency: { score: 0.5, pass: false, reason: 'r', evidence: [] } } };
  assert.deepEqual(parseGrade(committed(`draft:\n\`\`\`json\n{"scores":{}}\n\`\`\`\nfinal:\n\`\`\`json\n${JSON.stringify(grade)}\n\`\`\``)), grade);
  assert.throws(() => parseGrade(committed('no block here')), /no fenced json/);
  assert.throws(() => parseGrade(committed('```json\n{not json\n```')), SyntaxError);
  assert.throws(() => parseGrade(committed('```json\n{"scores":{"efficiency":{"score":"high","pass":true}}}\n```')), /numeric score/);
});

test('gradeTrend reports per-day, per-rubric pass rate and mean score over graded entries', () => {
  const scores = (efficiency, verbosity) => ({ efficiency: { score: efficiency, pass: efficiency >= 0.7 }, verbosity: { score: verbosity, pass: verbosity >= 0.7 } });
  assert.deepEqual(gradeTrend([
    { mergedAt: '2026-11-02T10:00:00Z', grade: { scores: scores(1, 0.5) } },
    { mergedAt: '2026-11-01T23:00:00Z', grade: { scores: scores(0.5, 1) } },
    { mergedAt: '2026-11-01T01:00:00Z', grade: { scores: scores(1, 0.5) } },
    { mergedAt: '2026-11-01T02:00:00Z', grade: null, gradeError: 'malformed' },
    { mergedAt: '2026-11-03T02:00:00Z' },
  ]), [
    { day: '2026-11-01', rubrics: { efficiency: { count: 2, passRate: 0.5, meanScore: 0.75 }, verbosity: { count: 2, passRate: 0.5, meanScore: 0.75 } } },
    { day: '2026-11-02', rubrics: { efficiency: { count: 1, passRate: 1, meanScore: 1 }, verbosity: { count: 1, passRate: 0, meanScore: 0.5 } } },
  ]);
});

test('promptChanges lists mainline commits that touched skills, AGENTS.md, prompt profiles or bus protocol', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-changes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' } }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const commit = async (path, subject) => {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), subject);
    git('add', '.');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const skill = await commit('config/skills/x.md', 'skill change');
  await commit('src/app.mjs', 'unrelated change');
  const agents = await commit('AGENTS.md', 'rules change');
  assert.deepEqual(await promptChanges(dir), [
    { sha: agents, mergedAt: '2026-11-01T00:00:00.000Z', subject: 'rules change' },
    { sha: skill, mergedAt: '2026-11-01T00:00:00.000Z', subject: 'skill change' },
  ]);
  assert.deepEqual(await promptChanges(join(dir, 'missing')), []);
});
