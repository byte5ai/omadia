/**
 * Spec 005 (#371) — AgentSpec accepts `type:oauth` + an `oauth_providers`
 * descriptor; manifestLinter cross-references the two. Covers the issue's
 * repro Zod-fails plus the linter rules that keep the broker wiring honest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentSpecSchema } from '../../src/plugins/builder/agentSpec.js';
import { validateSpec } from '../../src/plugins/builder/manifestLinter.js';
import type { AgentSpecSkeleton } from '../../src/plugins/builder/types.js';

const baseSpec = (): Record<string, unknown> => ({
  template: 'agent-integration',
  id: 'de.byte5.agent.gmailsummary',
  name: 'Gmail Summary',
  version: '0.1.0',
  description: 'summarises Gmail via the kernel OAuth broker',
  category: 'communication',
  domain: 'gmail',
  depends_on: [],
  tools: [],
  skill: { role: 'helper' },
  setup_fields: [],
  jobs: [],
  playbook: { when_to_use: 'use it', not_for: [], example_prompts: [] },
  network: { outbound: ['gmail.googleapis.com'] },
  slots: {},
});

const googleProvider = () => ({
  id: 'google',
  authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  token_auth_style: 'body_form',
  client_id_field: 'google_client_id',
  client_secret_field: 'google_client_secret',
});

const credFields = () => [
  { key: 'google_client_id', type: 'string', required: true },
  { key: 'google_client_secret', type: 'secret', required: true },
];

// --- Schema: the three repro Zod-fails from #371 are now accepted ----------

test('setup_fields[].type accepts oauth with provider + scopes (#371)', () => {
  const spec = AgentSpecSchema.parse({
    ...baseSpec(),
    setup_fields: [
      ...credFields(),
      {
        key: 'gmail_oauth',
        type: 'oauth',
        required: true,
        provider: 'google',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      },
    ],
    oauth_providers: [googleProvider()],
  });
  const field = spec.setup_fields.find((f) => f.key === 'gmail_oauth');
  assert.equal(field?.provider, 'google');
  assert.deepEqual(field?.scopes, [
    'https://www.googleapis.com/auth/gmail.readonly',
  ]);
});

test('AgentSpecSchema accepts a top-level oauth_providers descriptor (#371)', () => {
  const spec = AgentSpecSchema.parse({
    ...baseSpec(),
    oauth_providers: [googleProvider()],
  });
  assert.equal(spec.oauth_providers.length, 1);
  // pkce defaults to true (mirrors manifestLoader).
  assert.equal(spec.oauth_providers[0]?.pkce, true);
});

test('AgentSpecSchema defaults oauth_providers to [] for legacy drafts', () => {
  const spec = AgentSpecSchema.parse(baseSpec());
  assert.deepEqual(spec.oauth_providers, []);
});

test('AgentSpecSchema rejects an unknown token_auth_style', () => {
  assert.throws(() =>
    AgentSpecSchema.parse({
      ...baseSpec(),
      oauth_providers: [{ ...googleProvider(), token_auth_style: 'header' }],
    }),
  );
});

// --- Linter: cross-reference rules keep the broker wiring honest -----------

test('manifestLinter accepts a fully-wired OAuth spec', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: [
      ...credFields(),
      { key: 'gmail_oauth', type: 'oauth', required: true, provider: 'google' },
    ],
    oauth_providers: [googleProvider()],
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('manifestLinter rejects a type:oauth field whose provider is unresolved', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: [
      ...credFields(),
      { key: 'gmail_oauth', type: 'oauth', required: true, provider: 'gmail' },
    ],
    oauth_providers: [googleProvider()], // id is 'google', not 'gmail'
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.kind === 'oauth_field_provider_unresolved'),
  );
});

test('manifestLinter rejects a descriptor whose client field does not exist', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: [
      { key: 'google_client_id', type: 'string', required: true },
      // google_client_secret intentionally missing
      { key: 'gmail_oauth', type: 'oauth', required: true, provider: 'google' },
    ],
    oauth_providers: [googleProvider()],
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some(
      (v) => v.kind === 'oauth_provider_client_field_missing',
    ),
  );
});

test('manifestLinter rejects an orphan descriptor no type:oauth field references', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: credFields(), // no type:oauth field references 'google'
    oauth_providers: [googleProvider()],
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.kind === 'oauth_provider_unreferenced'),
  );
});

test('manifestLinter rejects a client_secret_field that is not type:secret', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: [
      { key: 'google_client_id', type: 'string', required: true },
      // secret declared as plaintext string instead of type:secret
      { key: 'google_client_secret', type: 'string', required: true },
      { key: 'gmail_oauth', type: 'oauth', required: true, provider: 'google' },
    ],
    oauth_providers: [googleProvider()],
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some(
      (v) => v.kind === 'oauth_provider_client_secret_not_secret',
    ),
  );
});

test('manifestLinter rejects duplicate oauth_providers ids', () => {
  const skel = {
    ...baseSpec(),
    setup_fields: credFields(),
    oauth_providers: [googleProvider(), googleProvider()],
  } as unknown as AgentSpecSkeleton;
  const result = validateSpec(skel);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.kind === 'oauth_provider_id_duplicate'),
  );
});
