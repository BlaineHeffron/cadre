import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function effectBody(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing effect marker ${marker}`);
  const start = source.lastIndexOf('useEffect(() =>', markerIndex);
  assert.notEqual(start, -1, `missing enclosing useEffect for ${marker}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`unclosed effect near ${marker}`);
}

describe('agent session detail provider switching', () => {
  it('keys detail loading, seen state, and websocket subscription by provider', async () => {
    const source = await readFile('public/pages/agent-session-detail.mjs', 'utf8');
    const body = effectBody(source, 'markSessionSeenForKind(providerKind, id)');

    assert.match(body, /content\.value\s*=\s*''/);
    assert.match(body, /sessionInfo\.value\s*=\s*\{[\s\S]*provider:\s*providerKind[\s\S]*runtime:\s*providerKind/);
    assert.match(body, /markSessionSeenForKind\(providerKind,\s*id\)/);
    assert.match(body, /const initialLines\s*=\s*shouldReduceNetworkActivity\(\)\s*\?\s*INITIAL_LINES\s*:\s*FULL_LINES/);
    assert.match(body, /loadContent\(id,\s*initialLines,\s*descriptor,\s*\(\)\s*=>\s*!cancelled\)/);
    assert.match(body, /subscribe\(`\$\{providerKind\}:session:\$\{id\}`/);
    assert.match(body, /markSessionAttentionSeen\(providerKind,\s*data\)/);
    assert.match(source, /\},\s*\[id,\s*providerKind,\s*providerApiBase\]\);/);
  });
});
