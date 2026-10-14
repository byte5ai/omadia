/**
 * #1210 — the orchestrator / sub-agent output budgets are sized for THINKING
 * PLUS the reply, and the provider seam clamps them per model.
 *
 * Nothing asserted these numbers before, which is how `.env.example` came to
 * ship `ORCHESTRATOR_MAX_TOKENS=4096` against a code default of `8192` and a
 * manifest help text claiming `4096` — three answers to one question, none of
 * them the one the running code used.
 *
 * The budget still lives in four places, and it has to: the plugin's
 * `DEFAULT_MAX_TOKENS` (the value the running orchestrator uses, and its floor),
 * the host's `ORCHESTRATOR_MAX_TOKENS` schema default, `.env.example` and the
 * manifest help text. They cannot be collapsed into one import — the plugin
 * package is imported BY the app layer and may not import it back, and the env
 * example and manifest are text operators read. So each copy is pinned here,
 * against the plugin's exported constant and against the frontier class's
 * registry `maxTokens` the number is derived from.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { DEFAULT_MAX_TOKENS } from '../packages/harness-orchestrator/src/plugin.js';
import { ConfigSchema } from '../src/config.js';
import { BUILTIN_LLM_PROVIDERS } from '../src/platform/builtinLlmProviders.js';

const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIDDLEWARE_ROOT = join(TEST_ROOT, '..');

/** The budget a turn on the default `class:frontier` model gets. */
const ORCHESTRATOR_BUDGET = 32_000;
/** Sub-agents answer one delegated question — half the orchestrator's. */
const SUB_AGENT_BUDGET = 16_000;

function schemaDefault(key: 'ORCHESTRATOR_MAX_TOKENS' | 'SUB_AGENT_MAX_TOKENS'): number {
  return ConfigSchema.shape[key].parse(undefined) as number;
}

describe('#1210 orchestrator + sub-agent output budgets', () => {
  it('the schema defaults are sized for thinking plus the reply', () => {
    assert.equal(schemaDefault('ORCHESTRATOR_MAX_TOKENS'), ORCHESTRATOR_BUDGET);
    assert.equal(schemaDefault('SUB_AGENT_MAX_TOKENS'), SUB_AGENT_BUDGET);
  });

  it('the plugin default (and its floor) is the same budget as the env default', () => {
    // The plugin's copy is the one a turn actually runs on: it floors whatever
    // the installed config says, so a drift here silently overrides the host's
    // schema default rather than conflicting with it visibly.
    assert.equal(DEFAULT_MAX_TOKENS, ORCHESTRATOR_BUDGET);
    assert.equal(DEFAULT_MAX_TOKENS, schemaDefault('ORCHESTRATOR_MAX_TOKENS'));
  });

  it('the orchestrator budget never overshoots the frontier class it resolves to', () => {
    // `ORCHESTRATOR_MODEL` defaults to `class:frontier`; the budget is taken
    // from that class's own registry ceiling, so the default config asks for
    // everything the default model can give without ever overshooting it.
    assert.equal(ConfigSchema.shape.ORCHESTRATOR_MODEL.parse(undefined), 'class:frontier');
    const anthropic = BUILTIN_LLM_PROVIDERS.find((p) => p.id === 'anthropic');
    assert.ok(anthropic, 'the bundled anthropic provider must exist');
    const seeded = (anthropic.models ?? []).filter((m) => m.class === 'frontier');
    assert.ok(seeded.length > 0, 'the anthropic seed must list a frontier model');
    for (const m of seeded) {
      // `>=`, not `===`: the invariant is that the default never OVERSHOOTS the
      // frontier ceiling (overshooting is the 400 the clamp exists to avoid).
      // A vendor raising Opus's output cap is not a defect in a config default.
      assert.ok(
        m.maxTokens >= ORCHESTRATOR_BUDGET,
        `${m.id} caps output at ${m.maxTokens}, below the default ORCHESTRATOR_MAX_TOKENS of ${ORCHESTRATOR_BUDGET}`,
      );
    }
    // The seed is only what a cold boot uses; live discovery replaces it with
    // whatever `GET /v1/models` reports, filling gaps from these family rules.
    // They must carry the same ceiling or the budget goes stale on the next
    // Opus generation — the failure mode the class ref exists to avoid.
    const rules = (anthropic.discovery?.classify ?? []).filter((r) => r.class === 'frontier');
    assert.ok(rules.length > 0, 'the anthropic discovery rules must classify a frontier family');
    for (const r of rules) {
      assert.ok(
        r.maxTokens !== undefined && r.maxTokens >= ORCHESTRATOR_BUDGET,
        `discovery rule '${r.match}' fills in ${String(r.maxTokens)}, below the default ORCHESTRATOR_MAX_TOKENS of ${ORCHESTRATOR_BUDGET}`,
      );
    }
  });

  it('.env.example ships the schema defaults, not stale smaller ones', () => {
    const env = readFileSync(join(MIDDLEWARE_ROOT, '.env.example'), 'utf8');
    assert.match(env, new RegExp(`^ORCHESTRATOR_MAX_TOKENS=${ORCHESTRATOR_BUDGET}$`, 'm'));
    assert.match(env, new RegExp(`^SUB_AGENT_MAX_TOKENS=${SUB_AGENT_BUDGET}$`, 'm'));
  });

  it('the manifest help text names the shipping default', () => {
    // Parsed, not grepped: the help text is operator-facing prose that may be
    // reflowed into a folded scalar at any time, and a line-based match would
    // then pass or fail for reasons that have nothing to do with the number.
    const manifest = YAML.parse(
      readFileSync(
        join(MIDDLEWARE_ROOT, 'packages', 'harness-orchestrator', 'manifest.yaml'),
        'utf8',
      ),
    ) as { setup?: { fields?: Array<{ key?: string; help?: string }> } };
    const field = (manifest.setup?.fields ?? []).find(
      (f) => f.key === 'orchestrator_max_tokens',
    );
    assert.ok(field, 'the manifest must declare the orchestrator_max_tokens setup field');
    assert.ok(
      field.help?.includes(String(ORCHESTRATOR_BUDGET)),
      `the help text must name ${ORCHESTRATOR_BUDGET}, it said: ${String(field.help)}`,
    );
  });
});
