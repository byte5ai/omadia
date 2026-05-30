import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CANVAS_OUTPUT_CAPABILITY,
  isCanvasOutputAuthorized,
  parseToolEmittedStructuredPayload,
  parseToolEmittedCanvasTree,
  parseToolEmittedMutation,
} from '../packages/harness-orchestrator/src/canvasSentinels.js';

/**
 * PR-7a — pure canvas-sentinel parsers + the deny-by-default `canvas-output`
 * gate. Mirrors the tolerance contract of `parseToolEmittedChoice`: malformed
 * JSON or a shape mismatch yields `undefined`.
 */

describe('isCanvasOutputAuthorized (deny-by-default)', () => {
  it('denies undefined / empty / unrelated capabilities', () => {
    assert.equal(isCanvasOutputAuthorized(undefined), false);
    assert.equal(isCanvasOutputAuthorized([]), false);
    assert.equal(isCanvasOutputAuthorized(['memoryStore@1']), false);
  });
  it('allows only when canvas-output is declared', () => {
    assert.equal(isCanvasOutputAuthorized([CANVAS_OUTPUT_CAPABILITY]), true);
    assert.equal(isCanvasOutputAuthorized(['x', 'canvas-output']), true);
  });
});

describe('parseToolEmittedStructuredPayload', () => {
  it('parses a well-formed payload', () => {
    const out = parseToolEmittedStructuredPayload(
      JSON.stringify({
        _pendingStructuredPayload: {
          prose: '12 open tickets',
          data: { rows: [{ owner: 'Anna' }] },
          dataRefId: 'jira-q1',
        },
      }),
    );
    assert.deepEqual(out, {
      prose: '12 open tickets',
      data: { rows: [{ owner: 'Anna' }] },
      dataRefId: 'jira-q1',
    });
  });
  it('keeps an actions array when present', () => {
    const out = parseToolEmittedStructuredPayload(
      JSON.stringify({
        _pendingStructuredPayload: { prose: 'p', data: null, dataRefId: 'd', actions: [{ id: 'a' }] },
      }),
    );
    assert.deepEqual(out?.actions, [{ id: 'a' }]);
  });
  it('returns undefined on malformed JSON / wrong key / missing fields', () => {
    assert.equal(parseToolEmittedStructuredPayload('not json'), undefined);
    assert.equal(parseToolEmittedStructuredPayload(JSON.stringify({ other: 1 })), undefined);
    assert.equal(
      parseToolEmittedStructuredPayload(JSON.stringify({ _pendingStructuredPayload: { prose: 'p', dataRefId: 'd' } })),
      undefined, // no `data`
    );
    assert.equal(
      parseToolEmittedStructuredPayload(JSON.stringify({ _pendingStructuredPayload: { data: 1, dataRefId: 'd' } })),
      undefined, // no prose
    );
  });
});

describe('parseToolEmittedCanvasTree', () => {
  it('parses a tree object', () => {
    const out = parseToolEmittedCanvasTree(
      JSON.stringify({ _pendingCanvasTree: { tree: { type: 'container', children: [] } } }),
    );
    assert.deepEqual(out, { tree: { type: 'container', children: [] } });
  });
  it('returns undefined when tree is missing or not an object', () => {
    assert.equal(parseToolEmittedCanvasTree(JSON.stringify({ _pendingCanvasTree: {} })), undefined);
    assert.equal(parseToolEmittedCanvasTree(JSON.stringify({ _pendingCanvasTree: { tree: 'x' } })), undefined);
    assert.equal(parseToolEmittedCanvasTree('{'), undefined);
  });
});

describe('parseToolEmittedMutation', () => {
  it('parses a well-formed mutation', () => {
    const out = parseToolEmittedMutation(
      JSON.stringify({
        _pendingMutation: {
          mutationId: 'm1',
          target: { kind: 'rowField', containerId: 'c', rowKey: 'anna', fieldKey: 'status' },
          oldValue: 'open',
          newValue: 'done',
          basedOnRevision: 'R3',
        },
      }),
    );
    assert.equal(out?.mutationId, 'm1');
    assert.equal(out?.basedOnRevision, 'R3');
    assert.deepEqual(out?.newValue, 'done');
  });
  it('accepts a null newValue (clearing a field) when both keys are present', () => {
    const out = parseToolEmittedMutation(
      JSON.stringify({
        _pendingMutation: { mutationId: 'm', target: {}, oldValue: 'x', newValue: null, basedOnRevision: 'R1' },
      }),
    );
    assert.equal(out?.mutationId, 'm');
    assert.equal(out?.newValue, null);
  });
  it('returns undefined on malformed JSON / wrong key / missing fields', () => {
    const both = { oldValue: 1, newValue: 2 };
    assert.equal(parseToolEmittedMutation('}{'), undefined); // malformed JSON
    assert.equal(parseToolEmittedMutation(JSON.stringify({ other: {} })), undefined); // wrong key
    assert.equal(
      parseToolEmittedMutation(JSON.stringify({ _pendingMutation: { target: {}, basedOnRevision: 'R1', ...both } })),
      undefined, // no mutationId
    );
    assert.equal(
      parseToolEmittedMutation(JSON.stringify({ _pendingMutation: { mutationId: 'm', target: {}, ...both } })),
      undefined, // no basedOnRevision
    );
    assert.equal(
      parseToolEmittedMutation(JSON.stringify({ _pendingMutation: { mutationId: 'm', target: null, basedOnRevision: 'R1', ...both } })),
      undefined, // null target
    );
    assert.equal(
      parseToolEmittedMutation(JSON.stringify({ _pendingMutation: { mutationId: 'm', target: {}, newValue: 2, basedOnRevision: 'R1' } })),
      undefined, // no oldValue
    );
    assert.equal(
      parseToolEmittedMutation(JSON.stringify({ _pendingMutation: { mutationId: 'm', target: {}, oldValue: 1, basedOnRevision: 'R1' } })),
      undefined, // no newValue
    );
  });
});
