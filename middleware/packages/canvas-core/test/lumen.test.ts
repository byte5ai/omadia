import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateLumen, validateScene, validateLxNode } from '../src/validator.js';
import type { ValidationResult } from '../src/validator.js';

// omadia-canvas-protocol/1.1 — Lumens conformance (lumens-spec.md §14).
// Accept/reject fixtures are the conformance contract for the structural
// whitelist parsers. The L1 static validator adds the semantic checks JSON
// Schema cannot express (tested separately in lx-interpreter.test.ts).
const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

type Validate = (v: unknown) => ValidationResult;

function fixtures(sub: string): string[] {
  return readdirSync(join(fixturesRoot, sub))
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(sub, f));
}

function suite(name: string, validate: Validate) {
  describe(`${name} — accept fixtures`, () => {
    const accept = fixtures(`${name}/accept`);
    it('has fixtures', () => expect(accept.length).toBeGreaterThan(0));
    for (const file of accept) {
      it(`accepts ${file}`, () => {
        const node: unknown = JSON.parse(readFileSync(join(fixturesRoot, file), 'utf8'));
        const result = validate(node);
        expect(result.errors).toBeNull();
        expect(result.ok).toBe(true);
      });
    }
  });

  describe(`${name} — reject fixtures`, () => {
    const reject = fixtures(`${name}/reject`);
    it('has fixtures', () => expect(reject.length).toBeGreaterThan(0));
    for (const file of reject) {
      it(`rejects ${file}`, () => {
        const node: unknown = JSON.parse(readFileSync(join(fixturesRoot, file), 'utf8'));
        expect(validate(node).ok).toBe(false);
      });
    }
  });
}

suite('lx', validateLxNode);
suite('scene', validateScene);
suite('lumen', validateLumen);

describe('Lumen whitelist parser — targeted', () => {
  it('rejects arbitrary code disguised as a literal-keyed node', () => {
    expect(validateLxNode({ eval: '1+1' }).ok).toBe(false);
  });
  it('a scene fill must be a theme token, never a raw colour', () => {
    expect(
      validateScene({ type: 'scene', width: 4, height: 4, draw: [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'rgb(0,0,0)' }] }).ok,
    ).toBe(false);
  });
  it('a Lumen never partially validates — one bad field rejects the whole', () => {
    expect(
      validateLumen({
        type: 'lumen', id: 'x', state: {}, transitions: {}, view: { lit: 1 }, events: [],
        cadence: { tick: 999 },
      }).ok,
    ).toBe(false);
  });
});
