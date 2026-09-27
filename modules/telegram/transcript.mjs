import { open, stat } from 'node:fs/promises';

function parseJsonLines(content = '') {
  const records = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore partial or malformed transcript lines.
    }
  }
  return records;
}

function textFromClaudeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function choiceLabel(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return firstNonEmptyString(value.label, value.text, value.title, value.value, value.name);
}

function findPromptText(value) {
  if (!value || typeof value !== 'object') return '';
  const direct = firstNonEmptyString(
    value.question,
    value.prompt,
    value.message,
    value.text,
    value.content,
    value.title,
  );
  if (direct) return direct;
  for (const key of ['notification', 'data', 'input', 'request']) {
    const nested = findPromptText(value[key]);
    if (nested) return nested;
  }
  return '';
}

function findChoiceValues(value) {
  if (!value || typeof value !== 'object') return [];
  for (const key of ['choices', 'options', 'selections', 'actions']) {
    const raw = value[key];
    if (!Array.isArray(raw)) continue;
    const labels = raw.map(choiceLabel).filter(Boolean);
    if (labels.length) return labels;
  }
  for (const key of ['notification', 'data', 'input', 'request']) {
    const nested = findChoiceValues(value[key]);
    if (nested.length) return nested;
  }
  return [];
}

function operatorQuestionFromClaudeToolUse(block = {}) {
  if (!block || block.type !== 'tool_use' || block.name !== 'AskUserQuestion') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const firstQuestion = Array.isArray(input.questions) ? input.questions[0] : input;
  if (!firstQuestion || typeof firstQuestion !== 'object') return null;
  const text = findPromptText(firstQuestion);
  const choices = findChoiceValues(firstQuestion);
  if (!text || choices.length === 0) return null;
  return { text, choices };
}

function textFromCodexContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => ['input_text', 'output_text', 'text'].includes(block?.type) && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function renderConversation(messages = []) {
  return messages
    .map(({ role, text }) => `## ${role === 'user' ? 'User' : 'AI'}\n\n${text}`)
    .join('\n\n---\n\n');
}

export function extractClaudeConversationText(content = '') {
  const messages = [];
  for (const record of parseJsonLines(content)) {
    const message = record?.message && typeof record.message === 'object' ? record.message : record;
    const role = message?.role || record?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const body = message?.content ?? record?.content;
    const text = textFromClaudeContent(body).trim();
    if (text) messages.push({ role, text });
  }
  return renderConversation(messages);
}

export function extractClaudeAssistantText(content = '') {
  const messages = [];
  for (const record of parseJsonLines(content)) {
    const message = record?.message && typeof record.message === 'object' ? record.message : record;
    const role = message?.role || record?.role;
    if (role !== 'assistant' && record?.type !== 'assistant') continue;
    const body = message?.content ?? record?.content;
    const text = textFromClaudeContent(body).trim();
    if (text) messages.push(text);
  }
  return messages.join('\n\n');
}

export function extractClaudeOperatorQuestion(content = '') {
  let latest = null;
  for (const record of parseJsonLines(content)) {
    const message = record?.message && typeof record.message === 'object' ? record.message : record;
    const role = message?.role || record?.role;
    if (role !== 'assistant' && record?.type !== 'assistant') continue;
    const body = message?.content ?? record?.content;
    if (!Array.isArray(body)) continue;
    for (const block of body) {
      const question = operatorQuestionFromClaudeToolUse(block);
      if (question) latest = question;
    }
  }
  return latest;
}

export function extractCodexAssistantText(content = '') {
  const messages = [];
  for (const record of parseJsonLines(content)) {
    const payload = record?.payload || {};
    if (record?.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'assistant') continue;
    const text = textFromCodexContent(payload.content).trim();
    if (text) messages.push(text);
  }
  return messages.join('\n\n');
}

export function extractCodexConversationText(content = '') {
  const messages = [];
  for (const record of parseJsonLines(content)) {
    const payload = record?.payload || {};
    if (record?.type !== 'response_item' || payload.type !== 'message') continue;
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;
    const text = textFromCodexContent(payload.content).trim();
    if (text) messages.push({ role: payload.role, text });
  }
  return renderConversation(messages);
}

export async function readTranscriptDelta(filePath, prevOffset = 0, runtime = 'claude') {
  const fileStat = await stat(filePath);
  const len = fileStat.size;
  const requestedOffset = Math.max(Number(prevOffset) || 0, 0);
  const handle = await open(filePath, 'r');
  try {
    let start = requestedOffset > len ? 0 : requestedOffset;
    if (start > 0) {
      const prior = Buffer.alloc(1);
      await handle.read(prior, 0, 1, start - 1);
      if (prior[0] !== 0x0a) {
        // Older relay versions could checkpoint the middle of an incomplete
        // JSONL record. Rewind to its beginning so the completed record is not
        // lost forever.
        const chunkSize = 64 * 1024;
        let cursor = start;
        while (cursor > 0) {
          const chunkStart = Math.max(cursor - chunkSize, 0);
          const chunk = Buffer.alloc(cursor - chunkStart);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, chunkStart);
          const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
          if (newline >= 0) {
            start = chunkStart + newline + 1;
            break;
          }
          cursor = chunkStart;
          start = 0;
        }
      }
    }
    const size = len - start;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    const bytes = buffer.subarray(0, bytesRead);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeBytes = lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    const content = completeBytes.toString('utf8');
    const isCodex = String(runtime || '').toLowerCase() === 'codex';
    const text = isCodex ? extractCodexAssistantText(content) : extractClaudeAssistantText(content);
    const operatorQuestion = isCodex ? null : extractClaudeOperatorQuestion(content);
    return {
      text,
      operatorQuestion,
      startOffset: start,
      nextOffset: start + completeBytes.length,
      pendingBytes: bytes.length - completeBytes.length,
      path: filePath,
    };
  } finally {
    await handle.close();
  }
}
