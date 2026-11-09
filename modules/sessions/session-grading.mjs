import { exec } from '../../lib/exec.mjs';
import { expandSkillTokens } from '../integrations/launch-skills.mjs';

// Files whose changes can move session grades; their merges are plotted against the score trend.
export const PROMPT_PATHS = ['config/skills', 'AGENTS.md', 'modules/integrations/prompt-profile-catalog.mjs', 'modules/agent-bus/protocol.mjs'];

export function buildGradePrompt(entry) {
  return expandSkillTokens([
    '{{skill:session-grade}}',
    '',
    `Grade the session that produced PR ${entry.repo}#${entry.number} (merge commit ${entry.mergeSha || 'unknown'}).`,
    `Transcript: ${entry.rollup.transcriptPath}`,
    `Use \`gh pr diff ${entry.number} -R ${entry.repo}\` and \`gh pr view ${entry.number} -R ${entry.repo}\`. Do not edit files, push, or comment.`,
  ].join('\n'));
}

export function buildImprovePrompt(grades) {
  return expandSkillTokens(`{{skill:session-improve}}\n\nGrade JSONs from the last 24 hours with a failing rubric, each with its repo, PR and merge commit:\n\n${grades.map((grade) => `\`\`\`json\n${JSON.stringify(grade)}\n\`\`\``).join('\n\n')}`);
}

// Text the grader's work turns committed; the grade is the last fenced json block in it.
export function parseGrade(output = []) {
  const text = output.flatMap((entry) => entry.blocks || [entry]).map((block) => block.text || '').join('\n');
  const block = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block) throw new Error('no fenced json block in grader output');
  const grade = JSON.parse(block);
  const scores = Object.values(grade?.scores || {});
  if (!scores.length || scores.some((item) => typeof item?.score !== 'number' || typeof item?.pass !== 'boolean')) {
    throw new Error('grade json lacks scores with numeric score and boolean pass');
  }
  return grade;
}

export const hasFailingRubric = (entry) => Object.values(entry.grade?.scores || {}).some((item) => item.pass === false);

// Per merge day: per rubric graded count, pass rate and mean score.
export function gradeTrend(entries = []) {
  const days = new Map();
  for (const entry of entries) {
    const day = String(entry.mergedAt || entry.gradedAt || '').slice(0, 10);
    if (!entry.grade?.scores || !day) continue;
    if (!days.has(day)) days.set(day, {});
    for (const [rubric, { score, pass }] of Object.entries(entry.grade.scores)) {
      const sum = (days.get(day)[rubric] ||= { count: 0, passed: 0, total: 0 });
      sum.count += 1;
      sum.passed += pass ? 1 : 0;
      sum.total += score;
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, rubrics]) => ({
    day,
    rubrics: Object.fromEntries(Object.entries(rubrics).map(([rubric, sum]) => [rubric, { count: sum.count, passRate: sum.passed / sum.count, meanScore: sum.total / sum.count }])),
  }));
}

// Mainline (first-parent) commits touching PROMPT_PATHS: one per merged PR.
export async function promptChanges(repoDir) {
  const result = await exec('git', ['-C', repoDir, 'log', '--first-parent', '-n', '200', '--format=%H%x09%cI%x09%s', 'HEAD', '--', ...PROMPT_PATHS], { timeout: 30_000 });
  if (result.code !== 0) return [];
  return String(result.stdout).split('\n').filter(Boolean).map((line) => {
    const [sha, mergedAt, subject] = line.split('\t');
    return { sha, mergedAt: new Date(mergedAt).toISOString(), subject };
  });
}
