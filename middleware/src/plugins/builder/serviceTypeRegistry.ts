/**
 * serviceTypeRegistry — Theme A. Maps from `ctx.services.get(...)`
 * service-name → providing plugin id + TypeScript type-import. Used by
 * codegen to synthesise a typed lookup block + matching
 * `peerDependencies` entry from a `spec.external_reads` entry alone,
 * and by manifestLinter to gate `external_reads` against the known
 * surface.
 *
 * Phase 5B: runtime-mutable map. Pre-5B this file shipped a hardcoded
 * `Object.freeze({...})` map keyed against the five byte5-internal
 * integration plugins (odoo, confluence, microsoft365 + the two
 * channel plugins). With the OSS-decoupling those packages no longer
 * live in this repo, so the map is empty by default — third-party
 * integration plugins (or first-party ones living in a separate repo
 * like `byte5ai/omadia-byte5-plugins`) register their entries via
 * `registerServiceType(...)` from a kernel-side bootstrap or from a
 * dedicated registration plugin. `manifestLinter` and `codegen` now
 * surface "unknown service" for any `external_reads` whose name is not
 * registered — which is the correct behaviour: codegen cannot synthesise
 * a typed lookup block without a `typeImport` to point at.
 *
 * Method existence is NOT validated here; `manifestLinter` only checks
 * that `service` is a known name, not that `method` exists on the typed
 * surface. Method-typos surface at the tsc gate (B.7) once codegen emits
 * the typed `__svc.method(...)` call — that's the right place: it has
 * the typeImport in scope and runs against the real TypeScript types.
 */

import { parseCapabilityRef } from '@omadia/plugin-api';

export interface ServiceTypeImport {
  /** npm package id, used both for `import type` and for the
   *  `peerDependencies` entry codegen injects into the agent's
   *  package.json. */
  from: string;
  /** Exported type name to import. */
  name: string;
}

export interface ServiceTypeRegistration {
  /** Plugin id that registers this service in `ctx.services`. Must be in
   *  `spec.depends_on` for the lookup to resolve at runtime. */
  providedBy: string;
  typeImport: ServiceTypeImport;
  /** #1779 — the major the provider declares for this service under its
   *  manifest `provides:` (`odoo.client@1` → 1). Codegen writes
   *  `requires: ['<service>@^<major>']` from it, so the generated manifest
   *  declares every service its `external_reads` look up (ADR-0053). Absent
   *  when the provider does not declare the service under `provides:`. */
  major?: number;
}

const REGISTRY = new Map<string, ServiceTypeRegistration>();

/**
 * Register (or replace) the type-import metadata for a service name.
 * Called once per service at kernel-bootstrap or when a runtime
 * registration plugin lights up its surface. Replacement is tolerated
 * (later registrations win) because installation order is operator-
 * controlled and reasoning about "first wins" hides shadow bugs.
 */
export function registerServiceType(
  name: string,
  registration: ServiceTypeRegistration,
): void {
  REGISTRY.set(name, registration);
}

/**
 * Remove a previously registered service-type. Called on plugin
 * deactivation when the registration was scoped to that plugin's
 * lifetime. No-ops on unknown names.
 */
export function unregisterServiceType(name: string): void {
  REGISTRY.delete(name);
}

export function lookupServiceType(
  name: string,
): ServiceTypeRegistration | undefined {
  return REGISTRY.get(name);
}

/**
 * The major `provides` declares for `service` (`['odoo.client@1']` → 1), or
 * undefined when the list has no well-formed entry for it.
 */
export function serviceMajorFromProvides(
  service: string,
  provides: readonly string[] | undefined,
): number | undefined {
  for (const raw of provides ?? []) {
    try {
      const ref = parseCapabilityRef(raw);
      if (ref.name === service) return ref.major;
    } catch {
      // Not a capability string; the manifest loader reports it elsewhere.
    }
  }
  return undefined;
}

export function getKnownServiceNames(): readonly string[] {
  return Object.freeze([...REGISTRY.keys()].sort());
}

/**
 * Unique set of npm/workspace package ids that any service in this
 * registry may pull in via `import type`. Codegen needs these in
 * peerDependencies of generated agent package.json; the build-template
 * needs them symlinked in `node_modules` so generated agents typecheck
 * against the real surfaces (Theme A — production gap closed 2026-05-04).
 */
export function getKnownServicePackages(): readonly string[] {
  const set = new Set<string>();
  for (const reg of REGISTRY.values()) {
    set.add(reg.typeImport.from);
  }
  return Object.freeze([...set].sort());
}

/**
 * Test/diagnostic helper — drop every registration. Production code
 * never calls this; the integration test suite uses it to isolate
 * cases.
 */
export function _resetServiceTypeRegistryForTests(): void {
  REGISTRY.clear();
}
