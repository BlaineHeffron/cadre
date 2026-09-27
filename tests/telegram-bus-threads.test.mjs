import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBusThreadIndex,
  BusThreadIndex,
  busThreadParticipantKey,
  normalizeParticipantKind,
} from '../modules/telegram/bus-threads.mjs';

describe('telegram bus thread index', () => {
  it('normalizes participant kinds for index keys', () => {
    assert.equal(normalizeParticipantKind('anthropic'), 'claude');
    assert.equal(normalizeParticipantKind('openai'), 'codex');
    assert.equal(busThreadParticipantKey('Anthropic', '77e575cd'), 'claude:77e575cd');
  });

  it('indexes direct agent-bus state by normalized kind and session id', () => {
    const index = buildBusThreadIndex({
      threads: [{
        id: 'thr_direct',
        title: 'Direct State',
        status: 'open',
        updatedAt: 100,
        participants: [
          { kind: 'claude', sessionId: '77e575cd' },
          { kind: 'openai', sessionId: '84325d24' },
        ],
      }],
    });

    assert.deepEqual(index.get('claude:77e575cd'), {
      id: 'thr_direct',
      title: 'Direct State',
      updatedAt: 100,
      status: 'open',
    });
    assert.equal(index.get('codex:84325d24').id, 'thr_direct');
  });

  it('indexes API agent-bus state entries with nested thread objects', () => {
    const index = buildBusThreadIndex({
      threads: [{
        thread: {
          id: 'thr_api',
          title: 'API State',
          status: 'open',
          updatedAt: 200,
          participants: [{ kind: 'anthropic', sessionId: '77e575cd' }],
        },
      }],
    });

    assert.equal(index.get('claude:77e575cd').id, 'thr_api');
  });

  it('ignores DM rooms so a later DM cannot steal a named session topic', () => {
    const index = buildBusThreadIndex({
      threads: [
        {
          id: 'thr_room',
          title: 'Release room',
          status: 'open',
          updatedAt: 100,
          participants: [{ kind: 'codex', sessionId: '84325d24' }],
        },
        {
          id: 'thr_dm',
          title: 'DM: claude:77e575cd|codex:84325d24',
          status: 'open',
          updatedAt: 500,
          metadata: { dm: true, dmKey: 'claude:77e575cd|codex:84325d24' },
          participants: [
            { kind: 'claude', sessionId: '77e575cd' },
            { kind: 'codex', sessionId: '84325d24' },
          ],
        },
      ],
    });

    assert.equal(index.get('codex:84325d24').id, 'thr_room');
    assert.equal(index.get('claude:77e575cd'), undefined);
  });

  it('selects open, then newest, then lowest id deterministically', () => {
    const index = buildBusThreadIndex({
      threads: [
        {
          id: 'thr_closed_newer',
          title: 'Closed newer',
          status: 'closed',
          updatedAt: 500,
          participants: [{ kind: 'codex', sessionId: '84325d24' }],
        },
        {
          id: 'thr_z',
          title: 'Open tie z',
          status: 'open',
          updatedAt: 400,
          participants: [{ kind: 'codex', sessionId: '84325d24' }],
        },
        {
          id: 'thr_a',
          title: 'Open tie a',
          status: 'open',
          updatedAt: 400,
          participants: [{ kind: 'codex', sessionId: '84325d24' }],
        },
      ],
    });

    assert.equal(index.get('codex:84325d24').id, 'thr_a');
  });

  it('keeps the last good index on read failure and clears on a successful empty read', () => {
    const wrapper = new BusThreadIndex();
    wrapper.update({
      threads: [{
        id: 'thr_good',
        title: 'Good',
        status: 'open',
        updatedAt: 1,
        participants: [{ kind: 'claude', sessionId: '77e575cd' }],
      }],
    });
    wrapper.update(null);
    assert.equal(wrapper.get('claude:77e575cd').id, 'thr_good');

    wrapper.update({ threads: [] });

    assert.equal(wrapper.get('claude:77e575cd'), undefined);
  });
});
