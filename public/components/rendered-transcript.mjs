import { h } from 'preact';
import { MarkdownMath } from './markdown-math.mjs';
import { stripAnsi } from './terminal.mjs';

const USER_PROMPT = /^\s*[›❯]\s?(.*)$/u;

export function parseRenderedTranscript(content = '') {
  const lines = stripAnsi(String(content)).replace(/\r/g, '').split('\n');
  const prelude = [];
  const turns = [];
  let turn = null;
  let readingUser = false;

  for (const line of lines) {
    const prompt = line.match(USER_PROMPT);
    if (prompt) {
      if (turn) turns.push(turn);
      turn = { user: [prompt[1]], assistant: [] };
      readingUser = true;
      continue;
    }

    if (!turn) {
      prelude.push(line);
      continue;
    }

    if (readingUser && line.trim() === '') {
      readingUser = false;
      continue;
    }

    if (readingUser) {
      turn.user.push(line.replace(/^\s{2}/, ''));
    } else {
      turn.assistant.push(line);
    }
  }

  if (turn) turns.push(turn);
  const clean = (value) => value.join('\n').trim();
  return {
    prelude: clean(prelude),
    turns: turns.map(({ user, assistant }) => ({
      user: clean(user),
      assistant: clean(assistant),
    })),
  };
}

export function RenderedTranscript({ content = '' }) {
  const transcript = parseRenderedTranscript(content);

  return h('div', {
    class: 'rendered-transcript',
    'aria-label': 'Rendered session transcript',
  },
  transcript.prelude
    ? h(MarkdownMath, { content: transcript.prelude, className: 'transcript-prelude' })
    : null,
  ...transcript.turns.map((turn, index) =>
    h('section', { class: 'transcript-turn', key: `turn-${index}` },
      h('div', { class: 'transcript-speaker transcript-user-label' }, 'User'),
      h(MarkdownMath, { content: turn.user, className: 'transcript-user' }),
      turn.assistant
        ? h('hr', { class: 'transcript-speaker-divider', 'aria-hidden': 'true' })
        : null,
      turn.assistant
        ? h('div', { class: 'transcript-speaker transcript-ai-label' }, 'AI')
        : null,
      turn.assistant
        ? h(MarkdownMath, { content: turn.assistant, className: 'transcript-ai' })
        : null,
    )
  ));
}
