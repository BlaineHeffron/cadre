import { h } from 'preact';
import { MAX_RENDERED_MARKDOWN_CHARS, MarkdownMath } from './markdown-math.mjs';
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

// Splits text into Markdown documents under the render cap, at paragraph
// breaks where possible, so no part of a long message is truncated.
export function markdownChunks(text = '') {
  const chunks = [];
  let rest = String(text);
  while (rest.length > MAX_RENDERED_MARKDOWN_CHARS) {
    const paragraph = rest.lastIndexOf('\n\n', MAX_RENDERED_MARKDOWN_CHARS);
    const cut = paragraph > 0 ? paragraph : MAX_RENDERED_MARKDOWN_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

// `messages` is a page of the session log whose earliest line is at byte
// offset `start`. Messages render separately, in cap-sized chunks, so the
// per-document Markdown cap cannot cut off a long conversation.
export function RenderedTranscript({ content = '', messages = null, start = 0, onLoadEarlier }) {
  if (messages) {
    return h('div', {
      class: 'rendered-transcript',
      'aria-label': 'Rendered session transcript',
    },
    start > 0
      ? h('button', { class: 'ctrl-btn ctrl-default', onClick: onLoadEarlier, style: 'padding:4px 8px; font-size:12px' }, 'Load earlier messages')
      : null,
    ...messages.map((message, index) => {
      const speaker = message.role === 'user' ? 'user' : 'ai';
      return h('section', { class: 'transcript-turn', key: `message-${start + index}` },
        h('div', { class: `transcript-speaker transcript-${speaker}-label` }, speaker === 'user' ? 'User' : 'AI'),
        ...markdownChunks(message.text).map((chunk, part) =>
          h(MarkdownMath, { content: chunk, className: `transcript-${speaker}`, key: part })),
      );
    }));
  }

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
