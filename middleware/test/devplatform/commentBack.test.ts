import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CommentBack,
  buildClarifyBody,
  buildFailedBody,
  buildPrBody,
  commentMarker,
  type CommentBackDeps,
  type CommentKind,
  type CommentTarget,
} from '../../src/devplatform/tracker/commentBack.js';

const target: CommentTarget = { owner: 'byte5ai', repo: 'omadia', number: 123 };

describe('devplatform/commentBack — body composition', () => {
  it('clarify body carries the marker, the plan, and numbered questions', () => {
    const body = buildClarifyBody('job-1', {
      planSummary: 'Refactor the widget',
      questions: [{ id: 'q1', text: 'Keep the old API?' }, { id: 'q2', text: 'Add a migration?' }],
      gateUrl: 'https://omadia.example.com/admin/dev-platform',
    });
    assert.ok(body.includes(commentMarker('job-1', 'clarify')));
    assert.ok(body.includes('1. Keep the old API?'));
    assert.ok(body.includes('2. Add a migration?'));
    assert.ok(body.includes('https://omadia.example.com/admin/dev-platform'));
  });

  it('clarify with no questions says so explicitly', () => {
    const body = buildClarifyBody('job-1', { planSummary: 'p', questions: [], gateUrl: 'u' });
    assert.ok(body.includes('No open questions'));
  });

  it('pr body carries the link and review status', () => {
    const body = buildPrBody('job-1', { prUrl: 'https://github.com/x/pr/9', summary: 'Fixes it', reviewStatus: 'Approved on attempt 1' });
    assert.ok(body.includes(commentMarker('job-1', 'pr')));
    assert.ok(body.includes('https://github.com/x/pr/9'));
    assert.ok(body.includes('Approved on attempt 1'));
  });

  it('failed body is neutral — no error text or internals', () => {
    const body = buildFailedBody('job-1');
    assert.ok(body.includes(commentMarker('job-1', 'failed')));
    assert.ok(!/stack|trace|Error:|exception/i.test(body), 'a public thread must not leak internals');
  });
});

interface Fakes {
  deps: CommentBackDeps;
  events: Set<string>;
  posted: Array<{ target: CommentTarget; body: string }>;
  existingComments: string[];
}

function fakes(over: Partial<{ existingComments: string[] }> = {}): Fakes {
  const events = new Set<string>();
  const posted: Array<{ target: CommentTarget; body: string }> = [];
  const existingComments = over.existingComments ?? [];
  const key = (jobId: string, kind: CommentKind) => `${jobId}:${kind}`;
  const deps: CommentBackDeps = {
    hasPostedEvent: async (jobId, kind) => events.has(key(jobId, kind)),
    recordPostedEvent: async (jobId, kind) => {
      const k = key(jobId, kind);
      if (events.has(k)) return false; // unique conflict
      events.add(k);
      return true;
    },
    listRecentComments: async () => existingComments,
    postComment: async (t, body) => void posted.push({ target: t, body }),
  };
  return { deps, events, posted, existingComments };
}

describe('devplatform/commentBack — idempotency', () => {
  it('posts once, then the recorded event guard makes a retry a no-op', async () => {
    const f = fakes();
    const cb = new CommentBack(f.deps);
    const body = buildClarifyBody('job-1', { planSummary: 'p', questions: [], gateUrl: 'u' });

    assert.equal(await cb.post('job-1', 'clarify', target, body), true, 'first post lands');
    assert.equal(await cb.post('job-1', 'clarify', target, body), false, 'second is a no-op');
    assert.equal(f.posted.length, 1, 'exactly one HTTP post');
  });

  it('marker-scan fallback: skips when the marker is already on the issue (posted-then-crashed)', async () => {
    // The event guard was NOT recorded (crash before recording), but the comment
    // IS on the issue. The marker scan must catch it.
    const existing = ['some unrelated comment', `${commentMarker('job-1', 'pr')}\nPR opened`];
    const f = fakes({ existingComments: existing });
    const cb = new CommentBack(f.deps);
    const body = buildPrBody('job-1', { prUrl: 'x', summary: 's', reviewStatus: 'r' });

    assert.equal(await cb.post('job-1', 'pr', target, body), false, 'the marker scan finds the prior post');
    assert.equal(f.posted.length, 0, 'no duplicate post');
    assert.equal(f.events.has('job-1:pr'), true, 'and the guard is backfilled so future retries skip fast');
  });

  it('does nothing when the job is not bound to a ticket', async () => {
    const f = fakes();
    const cb = new CommentBack(f.deps);
    assert.equal(await cb.post('job-1', 'failed', null, buildFailedBody('job-1')), false);
    assert.equal(f.posted.length, 0);
  });

  it('a different kind for the same job still posts (dedupe is per (job, kind))', async () => {
    const f = fakes();
    const cb = new CommentBack(f.deps);
    await cb.post('job-1', 'clarify', target, 'a');
    assert.equal(await cb.post('job-1', 'pr', target, 'b'), true, 'a different kind is a different comment');
    assert.equal(f.posted.length, 2);
  });
});
