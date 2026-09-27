import { createHash } from 'node:crypto';

// Legacy content-hash helpers. Transcript relay delivery must use byte-range
// identity instead: identical text in two different transcript records is two
// legitimate messages.

const RECENT_SENT_HASH_LIMIT = 8;
const RECENT_SENT_LINE_HASH_LIMIT = 256;

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function pushUnique(items, item) {
  if (!item || items.includes(item)) return;
  items.push(item);
}

export function lineHash(line = '') {
  return sha256Hex(line).slice(0, 24);
}

export function transcriptHash(sessionId = '', text = '') {
  return sha256Hex(`${sessionId}\0${String(text ?? '').trim()}`);
}

export function normalizeLine(line = '') {
  const normalized = String(line ?? '').split(/\s+/).filter(Boolean).join(' ');
  return normalized ? normalized : null;
}

export function bodyLineParts(text = '') {
  let prefix = '';
  const lines = String(text ?? '').split(/\r?\n/).map((line, index) => {
    if (index !== 0) return line;
    const splitAt = line.indexOf('] ');
    if (line.startsWith('[') && splitAt >= 0) {
      prefix = `${line.slice(0, splitAt)}] `;
      return line.slice(splitAt + 2);
    }
    return line;
  });
  return { prefix, lines };
}

export function lineHashesForText(text = '') {
  const hashes = [];
  for (const line of bodyLineParts(text).lines) {
    const normalized = normalizeLine(line);
    if (!normalized) continue;
    pushUnique(hashes, lineHash(normalized));
  }
  return hashes;
}

export function hasSeen(entry = {}, hash = '', text = '') {
  if (!entry) return false;
  if (entry.transcript_hash === hash) return true;
  if (Array.isArray(entry.recent_transcript_hashes) && entry.recent_transcript_hashes.includes(hash)) return true;

  const candidate = lineHashesForText(text);
  if (candidate.length === 0) return false;
  const recentLineHashes = Array.isArray(entry.recent_transcript_line_hashes)
    ? entry.recent_transcript_line_hashes
    : [];
  return candidate.every((item) => recentLineHashes.includes(item));
}

export function unsentSuffixText(entry = {}, text = '') {
  const recentLineHashes = Array.isArray(entry?.recent_transcript_line_hashes)
    ? entry.recent_transcript_line_hashes
    : [];
  const { prefix, lines } = bodyLineParts(text);
  const firstUnsent = lines.findIndex((line) => {
    const normalized = normalizeLine(line);
    if (!normalized) return false;
    return !recentLineHashes.includes(lineHash(normalized));
  });
  if (firstUnsent < 0) return null;

  const suffix = lines.slice(firstUnsent).join('\n').trim();
  return suffix ? `${prefix}${suffix}` : null;
}

export function withCurrentHash(previous = null, currentHash = '') {
  const hashes = [];
  pushUnique(hashes, currentHash);
  if (previous) {
    pushUnique(hashes, previous.transcript_hash);
    for (const hash of previous.recent_transcript_hashes || []) {
      pushUnique(hashes, hash);
      if (hashes.length >= RECENT_SENT_HASH_LIMIT) break;
    }
  }
  return hashes.slice(0, RECENT_SENT_HASH_LIMIT);
}

export function withCurrentLineHashes(previous = null, text = '') {
  const hashes = [];
  for (const hash of lineHashesForText(text)) {
    pushUnique(hashes, hash);
  }
  if (previous) {
    for (const hash of previous.recent_transcript_line_hashes || []) {
      pushUnique(hashes, hash);
      if (hashes.length >= RECENT_SENT_LINE_HASH_LIMIT) break;
    }
  }
  return hashes.slice(0, RECENT_SENT_LINE_HASH_LIMIT);
}
