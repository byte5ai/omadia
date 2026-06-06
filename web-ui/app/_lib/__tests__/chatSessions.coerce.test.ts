import { describe, expect, it } from 'vitest';

import { coerceSession } from '../chatSessions';

/**
 * Regression: chat sessions persisted by an older schema crashed the whole
 * app. `isSession` only checked the top-level `messages` array, so a message
 * missing `content` slipped through and the render threw
 * `Cannot read properties of undefined (reading 'length')` on
 * `message.content.length` — surfacing as the browser's cryptic
 * "This page couldn't load" page. `coerceSession` normalises on read so stale
 * localStorage / a foreign backend payload can never take the render down.
 */
describe('coerceSession', () => {
  it('returns null for non-objects and entries without an id', () => {
    expect(coerceSession(null)).toBeNull();
    expect(coerceSession('nope')).toBeNull();
    expect(coerceSession({ title: 'x' })).toBeNull();
  });

  it('defaults a message missing `content` to an empty string', () => {
    const out = coerceSession({
      id: 's1',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: 'm1', role: 'assistant', startedAt: 1 }], // no content
    });
    expect(out).not.toBeNull();
    expect(out?.messages[0]?.content).toBe('');
    // The exact access that used to throw must now be safe.
    expect(out?.messages[0]?.content.length).toBe(0);
  });

  it('coerces a non-array `tools`/`nudges` field to []', () => {
    const out = coerceSession({
      id: 's1',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'm1', role: 'user', content: 'hi', startedAt: 1, tools: 'oops' },
      ],
    });
    expect(out?.messages[0]?.tools).toEqual([]);
  });

  it('defaults a missing `messages` array to []', () => {
    const out = coerceSession({ id: 's1', title: 't', createdAt: 1, updatedAt: 2 });
    expect(out?.messages).toEqual([]);
  });

  it('drops malformed messages (no id) but keeps valid ones', () => {
    const out = coerceSession({
      id: 's1',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: 'user', content: 'no id' },
        { id: 'm2', role: 'user', content: 'ok', startedAt: 1 },
      ],
    });
    expect(out?.messages).toHaveLength(1);
    expect(out?.messages[0]?.id).toBe('m2');
  });

  it('preserves a valid session and normalises role', () => {
    const out = coerceSession({
      id: 's1',
      title: 'Hello',
      createdAt: 10,
      updatedAt: 20,
      messages: [{ id: 'm1', role: 'weird', content: 'x', startedAt: 5 }],
      snapshot: { agentSlug: 'fallback', capturedAt: 1 },
    });
    expect(out?.title).toBe('Hello');
    expect(out?.messages[0]?.role).toBe('user'); // unknown role → 'user'
    expect(out?.snapshot?.agentSlug).toBe('fallback');
  });
});
