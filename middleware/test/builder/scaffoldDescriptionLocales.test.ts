/**
 * #1022 — a scaffolded plugin must be correct in BOTH locales without a
 * manual translation step.
 *
 * #885 gave `identity.description` a locale map and fixed the 22 bundled
 * manifests by hand. The generator was left feeding one input into both
 * locales, so every plugin the BuilderAgent scaffolded shipped its German
 * text in the `en:` slot — the exact defect, one `create plugin` away.
 *
 * These tests drive the real `generate()` against the real on-disk
 * boilerplate and read the manifest it produces. No copy of the
 * substitution logic, so a change to the template mapping or to
 * `resolveSource` shows up here.
 */

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'yaml';

import { generate } from '../../src/plugins/builder/codegen.js';
import { parseAgentSpec, type AgentSpec } from '../../src/plugins/builder/agentSpec.js';
import { _resetCacheForTests } from '../../src/plugins/builder/boilerplateSource.js';
import {
  _resetServiceTypeRegistryForTests,
  registerServiceType,
} from '../../src/plugins/builder/serviceTypeRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'minimal-spec.json');
/** `middleware/` — `test/builder/` is two levels down. */
const MIDDLEWARE_ROOT = path.resolve(HERE, '..', '..');

const GERMAN = 'Agent für Wetter-Forecasts via OpenWeather API';
const ENGLISH = 'Fetches weather forecasts from the OpenWeather API.';

function loadFixture(): { raw: Record<string, unknown>; slots: Record<string, string> } {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
  const slots = raw['slots'] as Record<string, string>;
  const { slots: _ignored, ...specInput } = raw;
  void _ignored;
  return { raw: specInput, slots };
}

/** The `identity.description` map out of a generated manifest.yaml. */
function describedLocales(out: Map<string, Buffer>): Record<string, unknown> {
  const text = out.get('manifest.yaml')?.toString('utf-8');
  assert.ok(text, 'generate() must produce a manifest.yaml');
  const doc = yaml.parse(text) as Record<string, unknown>;
  const identity = doc['identity'] as Record<string, unknown> | undefined;
  const description = identity?.['description'];
  assert.ok(
    description && typeof description === 'object' && !Array.isArray(description),
    'identity.description must be a locale map in the generated manifest',
  );
  return description as Record<string, unknown>;
}

/** Every text file the generator emitted, so residue checks cover all of them. */
function textFiles(out: Map<string, Buffer>): Array<[string, string]> {
  const exts = new Set(['.ts', '.tsx', '.md', '.yaml', '.yml', '.json', '.txt']);
  return [...out.entries()]
    .filter(([name]) => exts.has(path.extname(name)))
    .map(([name, buf]) => [name, buf.toString('utf-8')] as [string, string]);
}

describe('scaffolded description locales (#1022)', () => {
  beforeEach(() => {
    _resetCacheForTests();
    _resetServiceTypeRegistryForTests();
    registerServiceType('odoo.client', {
      providedBy: 'de.byte5.integration.odoo',
      typeImport: { from: '@omadia/integration-odoo', name: 'OdooAccessor' },
    });
  });

  for (const template of ['agent-integration', 'agent-pure-llm'] as const) {
    it(`${template}: fills each locale from its own spec field`, async () => {
      const { raw, slots } = loadFixture();
      const spec: AgentSpec = parseAgentSpec({
        ...raw,
        template,
        description: GERMAN,
        description_en: ENGLISH,
      });

      const out = await generate({ spec, slots });
      const map = describedLocales(out);

      assert.equal(map['de'], GERMAN, 'de must carry spec.description');
      assert.equal(map['en'], ENGLISH, 'en must carry spec.description_en');
      assert.notEqual(
        map['en'],
        map['de'],
        'the two locales must not resolve from the same field',
      );
    });
  }

  it('leaves no placeholder residue in any generated text file', async () => {
    const { raw, slots } = loadFixture();
    const spec = parseAgentSpec({
      ...raw,
      description: GERMAN,
      description_en: ENGLISH,
    });

    const out = await generate({ spec, slots });
    const residue = textFiles(out)
      .filter(([, text]) => /\{\{AGENT_DESCRIPTION_(?:EN|DE)\}\}/.test(text))
      .map(([name]) => name);

    assert.deepEqual(residue, [], `unsubstituted description placeholders in: ${residue.join(', ')}`);
  });

  // The fallback exists so a spec written before `description_en` — or a
  // clone-from-installed of one — still generates instead of failing on an
  // unresolved placeholder. It ships German in both slots, which is why
  // `lint_spec` warns; see lintSpec.test.ts.
  it('falls back to the German description when the English one is absent', async () => {
    const { raw, slots } = loadFixture();
    const spec = parseAgentSpec({ ...raw, description: GERMAN });
    assert.equal(spec.description_en, undefined, 'fixture must exercise the fallback');

    const out = await generate({ spec, slots });
    const map = describedLocales(out);

    assert.equal(map['de'], GERMAN);
    assert.equal(map['en'], GERMAN, 'the fallback fills en rather than leaving a placeholder');

    // The point of the fallback: no residue, no CodegenError.
    const residue = textFiles(out).filter(([, t]) => t.includes('{{AGENT_DESCRIPTION_EN}}'));
    assert.deepEqual(residue.map(([n]) => n), []);
  });

  it('rejects a blank English description at the spec boundary', async () => {
    const { raw, slots } = loadFixture();
    // The fallback chain falls through on `undefined`, not on ''. That is
    // deliberate — `spec.author` defaults to '' and must stay resolvable
    // (#225) — so the guard against a blank English locale lives in the
    // schema: `description_en` is `.min(1)`.
    assert.throws(() => parseAgentSpec({ ...raw, description: GERMAN, description_en: '' }));
    // Whitespace only is the same defect wearing a space: bare `.min(1)`
    // accepted `'   '` and the lint's trim-compare did not flag it either, so
    // an all-blank `en:` reached the manifest. Hence `.trim().min(1)`.
    assert.throws(() => parseAgentSpec({ ...raw, description: GERMAN, description_en: '   ' }));
    // And a padded real value is accepted, trimmed.
    const padded = parseAgentSpec({ ...raw, description: GERMAN, description_en: `  ${ENGLISH}  ` });
    assert.equal(padded.description_en, ENGLISH);

    // Omitted (the real-world case) still yields a filled locale.
    const spec = parseAgentSpec({ ...raw, description: GERMAN });
    const out = await generate({ spec, slots });
    const map = describedLocales(out);
    assert.ok(String(map['en']).length > 0, 'en locale must never be blank');
  });

  /**
   * The untested link. Everything above proves the GENERATOR maps two spec
   * fields into two locales — but nothing populates `description_en` unless
   * the builder prompt tells the model to. Deleting that prompt block keeps
   * every other test here green while each scaffolded plugin regresses to
   * German in `en:`, because the spec field is optional by design and codegen
   * then falls back to the German text.
   *
   * Same idiom `manifestDescriptionLocalized.test.ts` uses on `template.yaml`:
   * assert the shape of the artifact that carries the behaviour, since the
   * behaviour itself lives in a model.
   */
  it('the builder prompt still instructs the model to write both locales', () => {
    const promptPath = path.join(
      MIDDLEWARE_ROOT,
      'src/plugins/builder/prompts/builder-system.md',
    );
    const prompt = readFileSync(promptPath, 'utf-8');

    assert.match(
      prompt,
      /\*\*`spec\.description_en`\*\*/,
      'builder-system.md must list spec.description_en among the required spec fields',
    );
    assert.match(
      prompt,
      /description_en[\s\S]{0,400}?Englisch/,
      'the prompt must say the English field is English',
    );
    assert.match(
      prompt,
      /description_en[\s\S]{0,400}?keine Kopie/,
      'the prompt must forbid copying the German text into the English field, ' +
        'which is the #885 defect the generator cannot detect',
    );
    // The prompt and both boilerplate CLAUDE.md files must agree on who
    // writes the English text; they contradicted each other before.
    assert.match(
      prompt,
      /frag den User nicht\s*\n?\s*danach/,
      'the prompt must keep saying the model writes the English text itself',
    );
  });

  // #225 regression guard. The chain must not reinterpret an empty string as
  // "unresolved": `spec.author` defaults to '' and an author-less spec has to
  // keep generating. This failed while #1022 was being built.
  it('still resolves an empty-string source such as the default author', async () => {
    const { raw, slots } = loadFixture();
    const spec = parseAgentSpec({ ...raw, description: GERMAN, description_en: ENGLISH });
    assert.equal(spec.author, '', 'fixture must exercise the empty-author default');

    const out = await generate({ spec, slots });
    const manifestText = out.get('manifest.yaml')!.toString('utf-8');
    assert.match(manifestText, /authors:\s*\n\s*-\s*name:\s*""/);
  });
});
