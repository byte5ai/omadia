/**
 * #1018 W1 — `chatPeerAgents@1` is a kernel-published service the orchestrator
 * plugin resolves per call. `ctx.services.getOptional` is declaration-gated on
 * the same terms as `get`: an undeclared name throws `ServiceNotDeclaredError`
 * out of the tool call. So the literal the plugin resolves and the manifest's
 * `optional_requires` entry must agree — pinned here, like #1016's guard.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseDocument } from 'yaml';
import { parseCapabilityRef } from '@omadia/plugin-api';

import { CHAT_PEER_AGENTS_SERVICE } from '../packages/harness-orchestrator/src/plugin.js';

const MANIFEST = path.resolve(
  import.meta.dirname,
  '..',
  'packages/harness-orchestrator/manifest.yaml',
);

test('the orchestrator manifest declares chatPeerAgents@1 as optional_requires', () => {
  const doc = parseDocument(readFileSync(MANIFEST, 'utf8'));
  const raw = doc.get('optional_requires');
  const list = (raw as { toJSON: () => unknown }).toJSON() as unknown[];
  const names = list
    .filter((e): e is string => typeof e === 'string')
    .map((e) => parseCapabilityRef(e).name);
  assert.ok(
    names.includes(CHAT_PEER_AGENTS_SERVICE),
    `manifest optional_requires must list '${CHAT_PEER_AGENTS_SERVICE}@1' (found: ${names.join(', ')})`,
  );
  assert.equal(CHAT_PEER_AGENTS_SERVICE, 'chatPeerAgents');
});
