import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  SKILL_LIFECYCLE_STATUSES,
  SkillAutomationWriteBlocked,
  SkillManifestError,
  assertHumanActor,
  canPublishSkill,
  canTransitionSkillLifecycle,
  canonicalSkillManifest,
  isSkillOwnerScope,
  missingRequiredCapabilities,
  requiredCapabilitiesFromFrontmatter,
  signSkillManifest,
  transitionSkillLifecycle,
  verifySkillManifestSignature,
  type SkillManifestInput,
} from '../src/services/skillLifecycle.js';

// ── Ownership ──────────────────────────────────────────────────────────────

describe('isSkillOwnerScope', () => {
  it('accepts personal, group and org scopes', () => {
    assert.equal(isSkillOwnerScope({ kind: 'personal', userId: 'u1' }), true);
    assert.equal(isSkillOwnerScope({ kind: 'group', groupRef: 'team-a' }), true);
    assert.equal(isSkillOwnerScope({ kind: 'org', orgId: 'byte5' }), true);
  });

  it('rejects conversation, system and unscoped scopes', () => {
    assert.equal(isSkillOwnerScope({ kind: 'conversation', conversationId: 'c1' }), false);
    assert.equal(isSkillOwnerScope({ kind: 'system', origin: 'routine', id: 'r1' }), false);
    assert.equal(isSkillOwnerScope({ kind: 'unscoped', reason: 'absent' }), false);
  });
});

// ── Lifecycle transition matrix ─────────────────────────────────────────────

describe('canTransitionSkillLifecycle', () => {
  const LEGAL: ReadonlySet<string> = new Set([
    'draft->reviewed',
    'reviewed->draft',
    'reviewed->published',
    'published->archived',
  ]);

  it('allows exactly the documented edges and rejects every other pair in the full matrix', () => {
    for (const from of SKILL_LIFECYCLE_STATUSES) {
      for (const to of SKILL_LIFECYCLE_STATUSES) {
        const expected = LEGAL.has(`${from}->${to}`);
        assert.equal(
          canTransitionSkillLifecycle(from, to),
          expected,
          `${from} -> ${to} should be ${expected ? 'legal' : 'illegal'}`,
        );
      }
    }
  });

  it('has no self-transitions', () => {
    for (const status of SKILL_LIFECYCLE_STATUSES) {
      assert.equal(canTransitionSkillLifecycle(status, status), false, `${status} -> ${status}`);
    }
  });

  it('archived is terminal — no edge leaves it', () => {
    for (const to of SKILL_LIFECYCLE_STATUSES) {
      assert.equal(canTransitionSkillLifecycle('archived', to), false, `archived -> ${to}`);
    }
  });

  it('draft cannot jump straight to published or archived', () => {
    assert.equal(canTransitionSkillLifecycle('draft', 'published'), false);
    assert.equal(canTransitionSkillLifecycle('draft', 'archived'), false);
  });
});

// ── requiredCapabilities parsing — #690 silent-drop guard ──────────────────

describe('requiredCapabilitiesFromFrontmatter', () => {
  it('returns [] when the key is absent', () => {
    assert.deepEqual(requiredCapabilitiesFromFrontmatter({}), []);
  });

  it('trims and dedupes valid entries, preserving first-seen order', () => {
    assert.deepEqual(
      requiredCapabilitiesFromFrontmatter({ requiredCapabilities: [' foo ', 'bar', 'foo'] }),
      ['foo', 'bar'],
    );
  });

  it('throws SkillManifestError with a field-naming message when the key is not an array', () => {
    assert.throws(
      () => requiredCapabilitiesFromFrontmatter({ requiredCapabilities: 'foo' }),
      (err: unknown) => {
        assert.ok(err instanceof SkillManifestError);
        assert.match(err.message, /frontmatter\.requiredCapabilities must be an array of strings, got string/);
        return true;
      },
    );
  });

  it('throws SkillManifestError naming the exact index and value for a non-string entry', () => {
    assert.throws(
      () => requiredCapabilitiesFromFrontmatter({ requiredCapabilities: ['ok', 123, 'also-ok'] }),
      (err: unknown) => {
        assert.ok(err instanceof SkillManifestError);
        assert.match(
          err.message,
          /frontmatter\.requiredCapabilities\[1\] must be a non-empty string, got 123/,
        );
        return true;
      },
    );
  });

  it('throws SkillManifestError for a blank-string entry rather than silently keeping it', () => {
    assert.throws(
      () => requiredCapabilitiesFromFrontmatter({ requiredCapabilities: ['ok', '   '] }),
      (err: unknown) => {
        assert.ok(err instanceof SkillManifestError);
        assert.match(err.message, /frontmatter\.requiredCapabilities\[1\]/);
        return true;
      },
    );
  });
});

describe('missingRequiredCapabilities / canPublishSkill', () => {
  it('reports nothing missing when everything required is granted', () => {
    assert.deepEqual(missingRequiredCapabilities(['a', 'b'], new Set(['a', 'b', 'c'])), []);
    assert.equal(canPublishSkill(['a', 'b'], new Set(['a', 'b', 'c'])), true);
  });

  it('reports exactly the ungranted capabilities', () => {
    assert.deepEqual(missingRequiredCapabilities(['a', 'b', 'c'], new Set(['b'])), ['a', 'c']);
    assert.equal(canPublishSkill(['a', 'b', 'c'], new Set(['b'])), false);
  });

  it('is case-sensitive — granting the lowercase form does not satisfy an uppercase requirement', () => {
    assert.deepEqual(missingRequiredCapabilities(['Foo'], new Set(['foo'])), ['Foo']);
  });
});

// ── Canonical manifest — byte-exact lock ────────────────────────────────────

const BASE_MANIFEST: SkillManifestInput = {
  slug: 'incident-runbook',
  name: 'Incident Runbook',
  ownerScope: 'personal:u-42',
  status: 'draft',
  contentHash: 'deadbeef',
  requiredCapabilities: ['mcp.web-search', 'mcp.email-send'],
};

describe('canonicalSkillManifest', () => {
  it('produces the exact locked byte form for a fixed input', () => {
    assert.equal(
      canonicalSkillManifest(BASE_MANIFEST),
      'slug=incident-runbook\n' +
        'name=Incident Runbook\n' +
        'ownerScope=personal:u-42\n' +
        'status=draft\n' +
        'contentHash=deadbeef\n' +
        'requiredCapabilities=mcp.email-send,mcp.web-search',
    );
  });

  it('is independent of requiredCapabilities input order', () => {
    const reordered: SkillManifestInput = {
      ...BASE_MANIFEST,
      requiredCapabilities: ['mcp.email-send', 'mcp.web-search'],
    };
    assert.equal(canonicalSkillManifest(BASE_MANIFEST), canonicalSkillManifest(reordered));
  });

  it('dedupes repeated capabilities', () => {
    const withDupe: SkillManifestInput = {
      ...BASE_MANIFEST,
      requiredCapabilities: ['mcp.web-search', 'mcp.email-send', 'mcp.web-search'],
    };
    assert.equal(canonicalSkillManifest(BASE_MANIFEST), canonicalSkillManifest(withDupe));
  });

  it('does NOT case-fold capabilities — "Foo" and "foo" stay distinct entries', () => {
    const manifest: SkillManifestInput = { ...BASE_MANIFEST, requiredCapabilities: ['Foo', 'foo'] };
    assert.match(canonicalSkillManifest(manifest), /requiredCapabilities=Foo,foo/);
  });

  it('changes output when any single field changes (differential mutation check)', () => {
    const baseline = canonicalSkillManifest(BASE_MANIFEST);
    const variants: SkillManifestInput[] = [
      { ...BASE_MANIFEST, slug: 'other-slug' },
      { ...BASE_MANIFEST, name: 'Other Name' },
      { ...BASE_MANIFEST, ownerScope: 'org:byte5' },
      { ...BASE_MANIFEST, status: 'reviewed' },
      { ...BASE_MANIFEST, contentHash: 'cafebabe' },
      { ...BASE_MANIFEST, requiredCapabilities: ['mcp.web-search'] },
    ];
    for (const variant of variants) {
      assert.notEqual(canonicalSkillManifest(variant), baseline, JSON.stringify(variant));
    }
  });
});

// ── HMAC signature ───────────────────────────────────────────────────────

describe('signSkillManifest / verifySkillManifestSignature', () => {
  const KEY = 'test-signing-key';

  it('round-trips: a fresh signature verifies against the same manifest + key', () => {
    const sig = signSkillManifest(BASE_MANIFEST, KEY);
    assert.equal(verifySkillManifestSignature(BASE_MANIFEST, sig, KEY), true);
  });

  it('is deterministic for the same input', () => {
    assert.equal(signSkillManifest(BASE_MANIFEST, KEY), signSkillManifest(BASE_MANIFEST, KEY));
  });

  it('rejects a signature computed with a different key', () => {
    const sig = signSkillManifest(BASE_MANIFEST, KEY);
    assert.equal(verifySkillManifestSignature(BASE_MANIFEST, sig, 'wrong-key'), false);
  });

  it('rejects when ANY manifest field is tampered after signing (tamper-evidence)', () => {
    const sig = signSkillManifest(BASE_MANIFEST, KEY);
    const tampered: SkillManifestInput[] = [
      { ...BASE_MANIFEST, status: 'published' },
      { ...BASE_MANIFEST, ownerScope: 'org:someone-else' },
      { ...BASE_MANIFEST, contentHash: 'tampered-hash' },
      { ...BASE_MANIFEST, requiredCapabilities: [] },
    ];
    for (const variant of tampered) {
      assert.equal(verifySkillManifestSignature(variant, sig, KEY), false, JSON.stringify(variant));
    }
  });

  it('rejects a malformed (non-hex / wrong-length) signature without throwing', () => {
    assert.equal(verifySkillManifestSignature(BASE_MANIFEST, 'not-hex-!!', KEY), false);
    assert.equal(verifySkillManifestSignature(BASE_MANIFEST, 'ab', KEY), false);
    assert.equal(verifySkillManifestSignature(BASE_MANIFEST, '', KEY), false);
  });
});

// ── Automation write-guard (#577 P3, Kernkonzept #6) ────────────────────

describe('assertHumanActor', () => {
  it('does not throw for any non-system ScopeId kind', () => {
    assert.doesNotThrow(() => assertHumanActor({ kind: 'personal', userId: 'u1' }));
    assert.doesNotThrow(() => assertHumanActor({ kind: 'group', groupRef: 'team-a' }));
    assert.doesNotThrow(() => assertHumanActor({ kind: 'org', orgId: 'byte5' }));
    assert.doesNotThrow(() => assertHumanActor({ kind: 'conversation', conversationId: 'c1' }));
    assert.doesNotThrow(() => assertHumanActor({ kind: 'unscoped', reason: 'absent' }));
  });

  it('throws SkillAutomationWriteBlocked for every system origin', () => {
    for (const origin of ['routine', 'schedule', 'conductor', 'conductor-builder'] as const) {
      assert.throws(
        () => assertHumanActor({ kind: 'system', origin, id: 'run-1' }),
        (err: unknown) => {
          assert.ok(err instanceof SkillAutomationWriteBlocked);
          assert.match(err.message, /machine origin/);
          assert.match(err.message, new RegExp(origin));
          assert.deepEqual(err.actorScope, { kind: 'system', origin, id: 'run-1' });
          return true;
        },
        origin,
      );
    }
  });
});

// ── Combined transition decision ────────────────────────────────────────

describe('transitionSkillLifecycle', () => {
  const manifest: Omit<SkillManifestInput, 'status'> = {
    slug: 'incident-runbook',
    name: 'Incident Runbook',
    ownerScope: 'personal:u-42',
    contentHash: 'deadbeef',
    requiredCapabilities: ['mcp.web-search'],
  };
  const KEY = 'test-signing-key';

  it('rejects an illegal status move before even looking at capabilities', () => {
    const result = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'personal', userId: 'u-42' },
      currentStatus: 'draft',
      targetStatus: 'published',
      granted: new Set(['mcp.web-search']),
      signingKey: KEY,
    });
    assert.deepEqual(result, { ok: false, reason: 'invalid-transition' });
  });

  it('rejects an invalid owner scope even for an otherwise-legal move', () => {
    const result = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'conversation', conversationId: 'c1' },
      currentStatus: 'draft',
      targetStatus: 'reviewed',
      granted: new Set(),
      signingKey: KEY,
    });
    assert.deepEqual(result, { ok: false, reason: 'invalid-owner-scope' });
  });

  it('blocks publish when a required capability is not granted, naming it', () => {
    const result = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'personal', userId: 'u-42' },
      currentStatus: 'reviewed',
      targetStatus: 'published',
      granted: new Set(),
      signingKey: KEY,
    });
    assert.deepEqual(result, { ok: false, reason: 'missing-capabilities', missing: ['mcp.web-search'] });
  });

  it('does not require capabilities for a non-publish move (draft -> reviewed)', () => {
    const result = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'personal', userId: 'u-42' },
      currentStatus: 'draft',
      targetStatus: 'reviewed',
      granted: new Set(),
      signingKey: KEY,
    });
    assert.equal(result.ok, true);
  });

  it('on success, re-signs the manifest AT THE NEW status — the signature is not reusable across statuses', () => {
    const toReviewed = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'personal', userId: 'u-42' },
      currentStatus: 'draft',
      targetStatus: 'reviewed',
      granted: new Set(),
      signingKey: KEY,
    });
    assert.equal(toReviewed.ok, true);
    if (!toReviewed.ok) return;

    const expectedDraftSig = signSkillManifest({ ...manifest, status: 'draft' }, KEY);
    const expectedReviewedSig = signSkillManifest({ ...manifest, status: 'reviewed' }, KEY);
    assert.notEqual(toReviewed.signature, expectedDraftSig);
    assert.equal(toReviewed.signature, expectedReviewedSig);
  });

  it('succeeds publishing once every required capability is granted', () => {
    const result = transitionSkillLifecycle({
      manifest,
      ownerScope: { kind: 'personal', userId: 'u-42' },
      currentStatus: 'reviewed',
      targetStatus: 'published',
      granted: new Set(['mcp.web-search']),
      signingKey: KEY,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 'published');
      assert.ok(result.signedAt instanceof Date);
    }
  });
});
