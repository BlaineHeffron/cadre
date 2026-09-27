import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyLineParts,
  hasSeen,
  lineHash,
  lineHashesForText,
  normalizeLine,
  transcriptHash,
  unsentSuffixText,
  withCurrentHash,
  withCurrentLineHashes,
} from '../modules/telegram/relay-dedup.mjs';

describe('telegram relay dedup', () => {
  it('matches sha256 hash vectors', () => {
    assert.equal(lineHash('hello world'), 'b94d27b9934d3e08a52e52d7');
    assert.equal(
      transcriptHash('session-1', '  hello world\n'),
      'dad861e9e7c1cccdd3fb2cef86eb46b9bc9e94719de75056e3ffa431c95d441e'
    );
  });

  it('normalizes lines and strips a bracket prefix from body lines', () => {
    assert.equal(normalizeLine(' one\t two   three '), 'one two three');
    assert.equal(normalizeLine(' \t '), null);
    assert.deepEqual(bodyLineParts('[codex:abc] first line\nsecond'), {
      prefix: '[codex:abc] ',
      lines: ['first line', 'second'],
    });
  });

  it('detects exact transcript hashes and covered line subsets', () => {
    const text = '[codex:abc] first line\nsecond line';
    const hash = transcriptHash('session-1', text);
    const entry = {
      transcript_hash: 'older',
      recent_transcript_hashes: [hash],
      recent_transcript_line_hashes: [],
    };
    assert.equal(hasSeen(entry, hash, text), true);

    const lineEntry = {
      transcript_hash: 'older',
      recent_transcript_hashes: [],
      recent_transcript_line_hashes: lineHashesForText(text),
    };
    assert.equal(hasSeen(lineEntry, 'new-hash', 'first   line'), true);
    assert.equal(hasSeen(lineEntry, 'new-hash', 'third line'), false);
  });

  it('returns only the unsent suffix and preserves the bracket prefix', () => {
    const sent = lineHashesForText('[codex:abc] first line\nsecond line');
    const entry = { recent_transcript_line_hashes: sent };

    assert.equal(
      unsentSuffixText(entry, '[codex:abc] first line\nsecond line\nthird line\nfourth line'),
      '[codex:abc] third line\nfourth line'
    );
    assert.equal(unsentSuffixText(entry, '[codex:abc] first line\nsecond line'), null);
  });

  it('keeps rolling transcript hashes newest-first, unique, and capped at 8', () => {
    const previous = {
      transcript_hash: 'h0',
      recent_transcript_hashes: ['h1', 'h2', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'],
    };
    assert.deepEqual(withCurrentHash(previous, 'h-new'), ['h-new', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    assert.deepEqual(withCurrentHash(previous, 'h0'), ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']);
  });

  it('keeps rolling line hashes newest-first, unique, and capped at 256', () => {
    const previousHashes = Array.from({ length: 300 }, (_, index) => `old-${index}`);
    const result = withCurrentLineHashes(
      { recent_transcript_line_hashes: previousHashes },
      'new line\nold duplicate\nnew line'
    );

    assert.equal(result.length, 256);
    assert.equal(result[0], lineHash('new line'));
    assert.equal(result[1], lineHash('old duplicate'));
    assert.equal(result[2], 'old-0');
    assert.equal(new Set(result).size, result.length);
  });
});
