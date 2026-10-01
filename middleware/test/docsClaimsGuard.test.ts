/**
 * The root README, the architecture overview, the security architecture and
 * CITATION.cff state security properties in public. This guard ties the
 * load-bearing ones to the code that enforces them: a changed default or a
 * retired overclaim that comes back fails here.
 *
 * Kept narrow on purpose. Retired claims are matched as exact phrases, and the
 * positive checks look for the named control (a config key, a default, a
 * catalog field), not for the wording around it. The answer verifier is checked
 * through its config defaults only; its README wording is still moving.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isWriteCapableTool, PRIVACY_MODE_DEFAULT } from '@omadia/plugin-api';
import { MASK_USER_PROMPT_CONFIG_KEY } from '@omadia/plugin-privacy-guard/dist/service.js';
import { parse as parseYaml } from 'yaml';

import { ConfigSchema } from '../src/config.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walks up from the test file to the checkout root, so the guard reads the
 *  same files whether it runs from `test/` or from a compiled copy. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'README.md')) && existsSync(path.join(dir, 'CITATION.cff'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no checkout root (README.md + CITATION.cff) above ${start}`);
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(HERE);

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

/** Undoes Markdown line wrapping and `&nbsp;` so a phrase matches across a wrap
 *  or inside a table cell. */
function flatten(markdown: string): string {
  return markdown.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

/** Sentences (and table cells) of `markdown` that contain `token`. */
function sentencesMentioning(markdown: string, token: string): string[] {
  return flatten(markdown)
    .split(/(?<=[.!?])\s+|\s\|\s/)
    .filter((sentence) => sentence.includes(token));
}

const PUBLIC_CLAIM_FILES = [
  'README.md',
  'docs/architecture.md',
  'docs/security-architecture.md',
  'CITATION.cff',
] as const;

/** Sentences these files used to carry that the code does not back. */
const RETIRED_CLAIMS = [
  // The subscription CLI runs without the shield, and prompt masking is opt-in.
  'never leaves in clear text',
  'without running through the model',
  // Receipts exist only for turns in which the shield acted; the run trace is
  // best-effort telemetry and has no replay.
  'every action carries a receipt',
  'a receipt for every action',
  'carries a full per-run trace',
  'is your audit receipt',
  'an auditable trace for every action',
  // Plugin packages are pinned by SHA-256; nothing checks a publisher signature.
  'signed plugin distribution',
  'verifiable signed packages',
  'installed as signed ZIPs',
  'from signed plugins',
  'ship as signed ZIPs',
  'plugins are verifiable packages',
  // Preview and confirm live in the connector plugins that implement them.
  'write actions are proposed and confirmed',
  // omadia evaluates no spreadsheet formula.
  'calculated by that engine rather than produced by the model',
] as const;

describe('public security claims match the enforced behaviour', () => {
  it('retired overclaims are gone from the README, the architecture docs and CITATION.cff', () => {
    const hits: string[] = [];
    for (const file of PUBLIC_CLAIM_FILES) {
      const text = flatten(read(file)).toLowerCase();
      for (const phrase of RETIRED_CLAIMS) {
        if (text.includes(phrase.toLowerCase())) hits.push(`${file}: "${phrase}"`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('the README names the Privacy Shield defaults the code ships, and its limits', () => {
    const readme = read('README.md');

    assert.equal(PRIVACY_MODE_DEFAULT, 'guarded');
    assert.ok(
      /`guarded` (?:by default|is the default)/.test(flatten(readme)),
      'README must name `guarded` as the default privacy mode',
    );

    // Prompt masking is a privacy-guard setting that ships switched off.
    assert.equal(MASK_USER_PROMPT_CONFIG_KEY, 'mask_user_prompt');
    const manifest: unknown = parseYaml(
      read('middleware/packages/harness-plugin-privacy-guard/manifest.yaml'),
    );
    const fields = (manifest as { setup?: { fields?: Array<{ key?: unknown; default?: unknown }> } })
      .setup?.fields;
    const maskField = fields?.find((field) => field.key === MASK_USER_PROMPT_CONFIG_KEY);
    assert.equal(maskField?.default, 'off');
    const maskSentences = sentencesMentioning(readme, '`mask_user_prompt`');
    assert.ok(
      maskSentences.some((sentence) => /\boff\b/i.test(sentence)),
      `README must say that \`mask_user_prompt\` is off by default; mentions: ${JSON.stringify(maskSentences)}`,
    );

    // The subscription-CLI provider installs no shield (security-architecture §3a).
    const cliSentences = sentencesMentioning(readme, '`claude-cli`');
    assert.ok(
      cliSentences.some((sentence) => /shield/i.test(sentence)),
      `README must say that the \`claude-cli\` provider runs without the shield; mentions: ${JSON.stringify(cliSentences)}`,
    );
  });

  it('the answer verifier ships off, and in shadow mode once switched on', () => {
    assert.equal(ConfigSchema.shape.VERIFIER_ENABLED.parse(undefined), false);
    assert.equal(ConfigSchema.shape.VERIFIER_MODE.parse(undefined), 'shadow');
  });

  it('plugins are described as hash-pinned, matching a catalog that never reports a signature', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-claims-'));
    try {
      const manifestPath = path.join(dir, 'manifest.yaml');
      // A manifest cannot declare itself signed: the loader has no signature
      // check and reports every entry as unsigned.
      writeFileSync(
        manifestPath,
        [
          'schema_version: "1"',
          'identity:',
          '  id: "@test/claims-fixture"',
          '  name: "Claims Fixture"',
          '  version: "1.0.0"',
          '  kind: "tool"',
          '  domain: "test.claims"',
          '  description: "Synthetic fixture for the docs claims guard."',
          '  signed: true',
          '  signed_by: "publisher.example"',
          'compat:',
          '  core: ">=1.0 <2.0"',
          'lifecycle:',
          '  entry: "dist/plugin.js"',
          '',
        ].join('\n'),
        'utf-8',
      );
      const entry = await loadManifestFromPath(manifestPath, () => {});
      assert.ok(entry, 'fixture manifest must load');
      assert.equal(entry.plugin.signed, false);
      assert.equal(entry.plugin.signed_by, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    for (const file of ['README.md', 'docs/security-architecture.md'] as const) {
      assert.ok(
        /no publisher signature/i.test(flatten(read(file))),
        `${file} must say that plugin packages carry no publisher signature`,
      );
    }
  });

  it('write protection is described as the per-tool contract the core enforces', () => {
    // An unannotated tool counts as read-only, so it gets no at-most-once
    // dispatch either: the core adds no write confirmation of its own.
    assert.equal(isWriteCapableTool(undefined), false);
    assert.equal(isWriteCapableTool([]), false);
    assert.ok(
      read('docs/security-architecture.md').includes('`writeCapabilities`'),
      'docs/security-architecture.md must name the `writeCapabilities` contract',
    );
  });
});
