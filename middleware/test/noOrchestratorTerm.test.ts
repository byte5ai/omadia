/**
 * Spec 2042 §6 criterion 12 — no user- or operator-facing string says
 * "Orchestrator" (`docs/terminology.md`: retired as a product term; say
 * "agent" or "agent runtime"). The web-ui guards its own messages
 * (`web-ui/app/_lib/noOrchestratorTerm.test.ts`); this guards what the
 * middleware shows operators: the bundled manifests (store, install wizard,
 * plugin settings) and the LLM readiness labels (providers page).
 *
 * Identifiers stay: package ids (`@omadia/orchestrator`,
 * `orchestrator-extras`), config keys (`orchestrator_model`) and environment
 * variables (`ORCHESTRATOR_MODEL`) are names an operator types, not prose.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { LLM_PLUGINS } from '../src/platform/pluginLlmReadiness.js';

const MIDDLEWARE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Manifest keys whose string values (and everything below them) are shown
 *  to operators or users. */
const USER_FACING_KEYS = new Set([
  'name',
  'description',
  'label',
  'help',
  'placeholder',
  'title',
  'summary',
  'hint',
  'playbook',
  'guide',
  'when_to_use',
  'not_for',
  'example_prompts',
]);

/** "Orchestrator" as a word of prose; identifiers around it do not count. */
export function proseMentions(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(/orchestrator/gi)) {
    const at = match.index;
    const before = at > 0 ? text[at - 1]! : ' ';
    const after = text.slice(at + match[0].length);
    // `@omadia/orchestrator`, `harness-orchestrator`, `ui-orchestrator`,
    // `core.orchestrator`, `ORCHESTRATOR_MODEL`, `orchestrator_model`.
    if (/[\w@/.\-]/.test(before)) continue;
    if (/^\w/.test(after) && !/^s(?!\w)/.test(after)) continue;
    // The package `orchestrator-extras` by its id (lowercase only).
    if (match[0] === 'orchestrator' && after.startsWith('-extras')) continue;
    hits.push(text.slice(Math.max(0, at - 30), at + match[0].length + 30).replace(/\s+/g, ' '));
  }
  return hits;
}

function userFacingStrings(node: unknown, within: boolean, trail: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') {
    if (within) out.push([trail, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => userFacingStrings(item, within, `${trail}[${String(i)}]`, out));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      userFacingStrings(value, within || USER_FACING_KEYS.has(key), trail ? `${trail}.${key}` : key, out);
    }
  }
}

function bundledManifests(): string[] {
  const dirs = [path.join(MIDDLEWARE, 'packages'), path.join(MIDDLEWARE, 'assets', 'boilerplate')];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .map((name) => path.join(dir, name, 'manifest.yaml'))
      .filter((file) => existsSync(file)),
  );
}

describe('spec 2042 criterion 12 — no operator-facing "Orchestrator" in the middleware', () => {
  it('the word check skips identifiers and catches prose', () => {
    assert.deepEqual(
      proseMentions('Set ORCHESTRATOR_MODEL, `orchestrator_model`, @omadia/orchestrator, orchestrator-extras, core.orchestrator'),
      [],
    );
    assert.equal(proseMentions('Chat Orchestrator').length, 1);
    assert.equal(proseMentions('the orchestrator’s main loop').length, 1);
    assert.equal(proseMentions('Orchestrator-Modell').length, 1);
    assert.equal(proseMentions('Orchestrator-Extras: ContextRetriever').length, 1);
    assert.equal(proseMentions('alle Orchestrators nutzen es').length, 1);
  });

  it('criterion 12: no bundled manifest says "Orchestrator" in a name, label, description, guide or playbook', () => {
    const manifests = bundledManifests();
    assert.ok(manifests.length > 10, `found ${String(manifests.length)} bundled manifests`);
    const hits: string[] = [];
    for (const file of manifests) {
      const strings: Array<[string, string]> = [];
      userFacingStrings(YAML.parse(readFileSync(file, 'utf8')), false, '', strings);
      for (const [where, text] of strings) {
        for (const hit of proseMentions(text)) hits.push(`${path.relative(MIDDLEWARE, file)} ${where}: …${hit}…`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('criterion 12: no LLM readiness label (providers page) says "Orchestrator"', () => {
    const hits = LLM_PLUGINS.filter((p) => proseMentions(p.label).length > 0).map((p) => `${p.id}: ${p.label}`);
    assert.deepEqual(hits, []);
  });
});
