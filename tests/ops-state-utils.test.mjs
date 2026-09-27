import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  hashJson,
  sampleJsonHashes,
  sha256Hex,
  stableStringify,
  summarizeJsonValue,
} from '../modules/ops/state-utils.mjs';

describe('ops state utils', () => {
  it('hashes JSON with stable object key ordering', () => {
    const left = { b: 2, a: { z: true, m: [3, { y: 1, x: 2 }] } };
    const right = { a: { m: [3, { x: 2, y: 1 }], z: true }, b: 2 };

    assert.equal(stableStringify(left), stableStringify(right));
    assert.equal(hashJson(left), hashJson(right));
  });

  it('hashes Buffers as bytes and strings as utf8 text', () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(sha256Hex('abc'), createHash('sha256').update('abc', 'utf8').digest('hex'));
  });

  it('summarizes and samples JSON values deterministically', () => {
    assert.deepEqual(summarizeJsonValue([{ id: 1 }, { id: 2 }]), { kind: 'array', count: 2 });
    assert.deepEqual(summarizeJsonValue({ b: 2, a: 1 }), { kind: 'object', count: 2 });
    assert.deepEqual(sampleJsonHashes({ b: 2, a: 1 }, 2).map((entry) => entry.key), ['a', 'b']);
  });
});
