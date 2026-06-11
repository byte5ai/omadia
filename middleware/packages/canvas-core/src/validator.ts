// Validators are pre-compiled at build time (npm run gen:validator): Ajv's
// runtime new Function() compilation violates the packaged renderer's CSP
// (default-src 'self', no unsafe-eval) and would blank the app on launch.
// Single source of truth stays docs/protocol/schema/*.json.
import {
  validateSurfaceEvent as surfaceValidate,
  validateTree as treeValidate,
  type StandaloneValidate,
} from './validators.generated.mjs';

export interface ValidationResult {
  ok: boolean;
  /** human-readable Ajv error summary; null when ok */
  errors: string | null;
}

function run(validate: StandaloneValidate, value: unknown): ValidationResult {
  const ok = validate(value);
  return {
    ok,
    errors: ok ? null : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '),
  };
}

/** The whitelist parser — unknown primitive type or prop is rejected hard. */
export function validateTree(tree: unknown): ValidationResult {
  return run(treeValidate, tree);
}

export function validateSurfaceEvent(event: unknown): ValidationResult {
  return run(surfaceValidate, event);
}
