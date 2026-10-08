import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileToolArguments } from '../modules/agent-bus/mcp-validation.mjs';

const child = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
};
const validate = compileToolArguments([{
  name: 'spawn', inputSchema: {
    type: 'object', additionalProperties: false, required: ['title'],
    properties: {
      title: { type: 'string' }, parentThreadId: { type: 'string' },
      count: { type: 'integer' }, enabled: { type: 'boolean' },
      config: child, children: { type: 'array', items: child },
    },
  },
}]);

test('optional null arguments are absent so handler defaults apply', () => {
  const args = { title: 'task', parentThreadId: null, count: null, enabled: null, config: null, children: null };
  validate('spawn', args);
  assert.deepEqual(args, { title: 'task' });
  const { parentThreadId = 'default' } = args;
  assert.equal(parentThreadId, 'default');
});

test('normalizes declared optional nulls inside objects and array items', () => {
  const args = { title: 'task', config: { name: 'a', enabled: null }, children: [{ name: 'b', enabled: null }] };
  validate('spawn', args);
  assert.deepEqual(args.config, { name: 'a' });
  assert.deepEqual(args.children, [{ name: 'b' }]);
});

test('required null and unknown null arguments remain invalid', () => {
  for (const args of [{ title: null }, { title: 'task', typo: null }, { title: 'task', config: { name: null } }]) {
    assert.throws(() => validate('spawn', args), { code: 'mcp_invalid_arguments' });
  }
});

test('preserves falsy values and invalid non-null optional types', () => {
  const args = { title: '', count: 0, enabled: false };
  validate('spawn', args);
  assert.deepEqual(args, { title: '', count: 0, enabled: false });
  assert.throws(() => validate('spawn', { title: 'task', enabled: 'false' }), { code: 'mcp_invalid_arguments' });
});
