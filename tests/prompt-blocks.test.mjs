import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertPromptBlocksSupported,
  mapPromptBlocksForClaude,
  mapPromptBlocksForCodex,
  negotiatePromptCapabilities,
} from '../modules/agent/prompt-blocks.mjs';

describe('typed prompt blocks', () => {
  it('admits the complete typed vocabulary and rejects unknown tags explicitly', () => {
    const capabilities = {
      types: ['text', 'image', 'audio', 'embedded_resource', 'resource_link'],
      deliveryMode: 'inline', mimeAllowlist: ['image/png', 'audio/wav', 'text/plain'],
      maxBytes: 100, maxCount: 3, maxSessionBytes: 300,
    };
    assert.doesNotThrow(() => assertPromptBlocksSupported([
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA' },
      { type: 'audio', mimeType: 'audio/wav', data: 'UklGRgAAAAA=' },
      { type: 'embedded_resource', resource: { uri: 'urn:test', mimeType: 'text/plain', text: 'context' } },
      { type: 'resource_link', uri: 'https://example.test' },
    ], capabilities));
    assert.throws(
      () => assertPromptBlocksSupported([{ type: 'tool_call' }], capabilities),
      (error) => error.code === 'unsupported_capability' && error.capability === 'prompt.tool_call',
    );
  });

  it('rejects malformed binary blocks, unsafe resource URIs, and decoded quota excess', () => {
    const capabilities = {
      types: ['text', 'image', 'embedded_resource', 'resource_link'],
      deliveryMode: 'inline', mimeAllowlist: ['image/png', 'text/plain'],
      maxBytes: 4, maxCount: 2, maxSessionBytes: 8,
    };
    const rejected = [
      [{ type: 'image', mimeType: 'image/png', data: '' }],
      [{ type: 'image', mimeType: 'image/png', data: 'not base64' }],
      [{ type: 'image', mimeType: 'text/plain', data: 'YWJj' }],
      [{ type: 'image', mimeType: 'image/png', data: 'YWJjZGU=' }],
      [{ type: 'embedded_resource', resource: { uri: 'urn:test', mimeType: 'text/plain', text: 'a', blob: 'YQ==' } }],
      [{ type: 'resource_link', uri: '../../secret' }],
      [{ type: 'resource_link', uri: 'file:///etc/passwd' }],
    ];
    for (const blocks of rejected) assert.throws(() => assertPromptBlocksSupported(blocks, capabilities));
    assert.doesNotThrow(() => assertPromptBlocksSupported([
      { type: 'resource_link', uri: 'urn:document:1' },
      { type: 'resource_link', uri: 'http://example.test/context' },
    ], capabilities));
  });

  it('negotiates the exact type, MIME, and numeric-limit intersection', () => {
    const negotiated = negotiatePromptCapabilities({
      types: ['text', 'image', 'audio'], deliveryMode: 'inline',
      mimeAllowlist: ['image/png', 'image/jpeg', 'audio/wav'],
      maxBytes: 10, maxCount: 5, maxSessionBytes: 100,
    }, {
      types: ['text', 'image', 'embedded_resource'], deliveryMode: 'inline',
      mimeAllowlist: ['image/png', 'application/pdf'],
      maxBytes: 8, maxCount: 6, maxSessionBytes: 80,
    });
    assert.deepEqual(negotiated, {
      types: ['text', 'image'], deliveryMode: 'inline', mimeAllowlist: ['image/png'],
      maxBytes: 8, maxCount: 5, maxSessionBytes: 80,
    });
  });

  it('maps image blocks to Codex app-server data URLs without local paths', () => {
    const mapped = mapPromptBlocksForCodex([
      { type: 'text', text: 'inspect' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw==' },
    ]);
    assert.deepEqual(mapped, [
      { type: 'text', text: 'inspect', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,iVBORw==' },
    ]);
    assert.equal(JSON.stringify(mapped).includes('path'), false);
  });

  it('does not upgrade a reference-only transport to inline delivery', () => {
    const negotiated = negotiatePromptCapabilities({
      types: ['text', 'image'], deliveryMode: 'reference', mimeAllowlist: ['image/png'],
      maxBytes: 10, maxCount: 1, maxSessionBytes: 10,
    }, {
      types: ['text', 'image'], deliveryMode: 'inline', mimeAllowlist: ['image/png'],
      maxBytes: 10, maxCount: 1, maxSessionBytes: 10,
    });
    assert.deepEqual(negotiated, {
      types: ['text'], deliveryMode: 'inline', mimeAllowlist: [],
      maxBytes: 0, maxCount: 0, maxSessionBytes: 0,
    });
  });

  it('maps image blocks to Claude base64 sources without local paths', () => {
    const mapped = mapPromptBlocksForClaude([
      { type: 'text', text: 'inspect' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
    ]);
    assert.deepEqual(mapped, [
      { type: 'text', text: 'inspect' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
    ]);
    assert.equal(JSON.stringify(mapped).includes('path'), false);
  });
});
