/**
 * Plugin manifest contract — declarative plugin metadata for the
 * multi-orchestrator runtime (US1).
 *
 * The manifest is validated against the JSON Schema at
 * `schemas/manifest.schema.json`. `validateManifest` below is the
 * single runtime validation path consumers (the `OrchestratorRegistry`,
 * the Agent Builder's builder-ready gate) call. The TypeScript
 * interface, the JSON Schema, and `validateManifest` are maintained
 * together — the schema is the declarative twin of the checks here,
 * and a test guards them against drift.
 *
 * See `specs/001-multi-orchestrator-runtime/contracts/plugin-lifecycle.md`.
 */

import { readFileSync } from 'node:fs';

/** Declarative plugin metadata. Every plugin ships exactly one. */
export interface PluginManifest {
  /** Stable plugin identifier. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** SemVer version string, e.g. `"1.2.3"`. */
  version: string;

  /**
   * May this plugin run as more than one instance in a single
   * process? Multi-instance is the default expectation; a plugin that
   * genuinely cannot (singleton hardware, exclusive lock) sets this
   * `false` and MUST supply `multiInstanceJustification`.
   */
  multiInstance: boolean;
  /** Required (non-empty) when `multiInstance` is `false` — why it cannot. */
  multiInstanceJustification?: string;

  /** Memory partitions this plugin contributes. `[]` ⇒ uses only `core`. */
  memoryNamespaces: string[];
  /** Capabilities the plugin needs from its scope, e.g. `"llm:chat"`. */
  requiredCapabilities: string[];
  /** Data-handling class. Builder-generated plugins default to `strict`. */
  privacyClass: 'strict' | 'default';
}

/** A single manifest validation failure. */
export interface ManifestValidationError {
  /** The offending field, e.g. `"version"`; `"(root)"` for the whole value. */
  readonly field: string;
  /** Human-readable, precise description of what is wrong. */
  readonly message: string;
}

/** Outcome of {@link validateManifest}. */
export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ManifestValidationError[];
}

const SEMVER = /^\d+\.\d+\.\d+([-+].+)?$/;

/**
 * Validate an untrusted value against the plugin manifest contract.
 *
 * Mirrors `schemas/manifest.schema.json` exactly: the same required
 * fields, types, SemVer pattern, and the conditional rule that
 * `multiInstanceJustification` is mandatory (non-empty) whenever
 * `multiInstance` is `false`. Returns every failure with a precise
 * message; never throws.
 */
export function validateManifest(value: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];
  const fail = (field: string, message: string): void => {
    errors.push({ field, message });
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: '(root)', message: 'manifest must be a JSON object' }],
    };
  }
  const m = value as Record<string, unknown>;

  for (const key of ['id', 'name'] as const) {
    const v = m[key];
    if (typeof v !== 'string' || v.length === 0) {
      fail(key, `${key} is required and must be a non-empty string`);
    }
  }

  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    fail('version', 'version is required and must be a SemVer string, e.g. "1.2.3"');
  }

  if (typeof m.multiInstance !== 'boolean') {
    fail('multiInstance', 'multiInstance is required and must be a boolean');
  }

  for (const key of ['memoryNamespaces', 'requiredCapabilities'] as const) {
    const v = m[key];
    if (!Array.isArray(v)) {
      fail(key, `${key} is required and must be an array of non-empty strings`);
    } else if (v.some((e) => typeof e !== 'string' || e.length === 0)) {
      fail(key, `${key} must contain only non-empty strings`);
    }
  }

  if (m.privacyClass !== 'strict' && m.privacyClass !== 'default') {
    fail('privacyClass', 'privacyClass is required and must be "strict" or "default"');
  }

  const justification = m.multiInstanceJustification;
  const justificationOk =
    typeof justification === 'string' && justification.length > 0;
  if (justification !== undefined && !justificationOk) {
    fail(
      'multiInstanceJustification',
      'multiInstanceJustification, when present, must be a non-empty string',
    );
  }
  if (m.multiInstance === false && !justificationOk) {
    fail(
      'multiInstanceJustification',
      'multiInstanceJustification is required (non-empty) when multiInstance is false',
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Load the declarative JSON Schema that {@link validateManifest}
 * mirrors. Provided for tooling (the builder-ready gate, editors)
 * that wants the schema document itself. Resolved relative to this
 * module, so it works from both `src/` (dev) and `dist/` (built) —
 * which is why `schemas/` ships in the package `files` list.
 */
export function loadManifestJsonSchema(): unknown {
  const url = new URL('../schemas/manifest.schema.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf-8'));
}
