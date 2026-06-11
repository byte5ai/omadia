import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/**
 * Server-side whitelist validator over the omadia-canvas-protocol/1.0 schemas.
 *
 * The schemas are the canonical set owned by @omadia/canvas-core (the single
 * source of truth). Loaded at module init via fs (not JSON imports)
 * so the same path works from `src/` (tests, tsx) and `dist/` (production
 * entry) — both resolve `../schema/` to the package root.
 */

// Canonical schemas now live in the sibling @omadia/canvas-core package
// (single source of truth). Workspace-relative so it resolves from both
// src/ (tests, tsx) and dist/ (production) — packages/<pkg>/{src,dist} are
// the same depth, so '../../canvas-core/schema/' lands on the package root.
const schemaDir = new URL('../../canvas-core/schema/', import.meta.url);

function loadSchema(file: string): object {
  return JSON.parse(readFileSync(new URL(file, schemaDir), 'utf8')) as object;
}

// strict:false + logger:false — the vendored schemas use draft-2020 idioms and
// the `date-time` format annotation (validated client-side); no stderr noise.
const ajv = new Ajv2020({ allErrors: true, strict: false, logger: false });
for (const file of [
  'data-ref.schema.json',
  'target-ref.schema.json',
  'canvas-tree.schema.json',
  'handshake.schema.json',
  'sentinels.schema.json',
  'surface-events.schema.json',
]) {
  ajv.addSchema(loadSchema(file));
}

function mustGetSchema(id: string): ValidateFunction {
  const validate = ajv.getSchema(id);
  if (!validate) {
    throw new Error(`protocol schema failed to compile: ${id}`);
  }
  return validate as ValidateFunction;
}

const treeValidate = mustGetSchema('https://omadia.ai/protocol/1.0/canvas-tree.schema.json');

export interface TreeValidationResult {
  ok: boolean;
  /** human-readable Ajv error summary; null when ok */
  errors: string | null;
}

/** The whitelist parser — unknown primitive type or prop is rejected hard. */
export function validateTree(tree: unknown): TreeValidationResult {
  const ok = treeValidate(tree) as boolean;
  return {
    ok,
    errors: ok
      ? null
      : (treeValidate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '),
  };
}
