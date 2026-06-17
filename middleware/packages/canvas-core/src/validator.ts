// Validators are pre-compiled at build time (npm run gen:validator): Ajv's
// runtime new Function() compilation violates the packaged renderer's CSP
// (default-src 'self', no unsafe-eval) and would blank the app on launch.
// Single source of truth stays docs/protocol/schema/*.json.
import {
  validateSurfaceEvent as surfaceValidate,
  validateTree as treeValidate,
  validateLumen as lumenValidate,
  validateScene as sceneValidate,
  validateLxNode as lxNodeValidate,
  type StandaloneValidate,
} from './validators.generated.mjs';
import { validateLumenSemantics } from './lx/validate.js';

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

// ── omadia-canvas-protocol/1.1 — Lumens (Live Interactivity) ──
// Structural whitelist parsers. The L1 static validator (lx/validate.ts) layers
// on the semantic checks JSON Schema cannot express: state/event path
// resolution, gas + bounded-iteration proof, transition/event coherence.

/** Validate a full Lumen (state schema + transitions + view + events + …). */
export function validateLumen(lumen: unknown): ValidationResult {
  return run(lumenValidate, lumen);
}

/** Validate a `scene` primitive (draw-list, theme-token styling). */
export function validateScene(scene: unknown): ValidationResult {
  return run(sceneValidate, scene);
}

/** Validate a single LX AST node against the §2.2/§2.3 whitelist. */
export function validateLxNode(node: unknown): ValidationResult {
  return run(lxNodeValidate, node);
}

/** The COMPLETE Lumen gate (§1, §2.5): structural whitelist AND the semantic
 *  layer (path resolution, var scoping, transition/event coherence). Library
 *  consumers should call this, never `validateLumen` alone — the structural
 *  check by itself accepts Lumens the interpreter would crash or misbehave on. */
export function validateLumenFull(lumen: unknown): ValidationResult {
  const structural = run(lumenValidate, lumen);
  if (!structural.ok) return structural;
  const semantic = validateLumenSemantics(lumen);
  return semantic.ok ? { ok: true, errors: null } : { ok: false, errors: semantic.errors.join('; ') };
}
