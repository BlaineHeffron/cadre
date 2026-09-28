import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscript } from '../public/components/voice-input.mjs';

describe('voice input transcript append', () => {
  it('appends dictated text after the draft with one separating space', () => {
    assert.equal(appendTranscript('', '  hello  '), 'hello');
    assert.equal(appendTranscript('fix the', 'tests'), 'fix the tests');
    assert.equal(appendTranscript('line one\n', 'line two'), 'line one\nline two');
    assert.equal(appendTranscript('keep me', '   '), 'keep me');
    assert.equal(appendTranscript(null, undefined), '');
  });

  it('caps the combined draft at the max length', () => {
    assert.equal(appendTranscript('abc', 'defgh', 6), 'abc de');
  });
});
