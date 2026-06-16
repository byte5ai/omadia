/**
 * omadia-canvas-protocol/1.1 — import consent for shared/preset Lumens (lumens-spec.md §6, §9).
 *
 * An imported or shared Lumen surfaces its capability manifest for consent
 * BEFORE first run. This pure module computes, from a manifest, what to show and
 * which capabilities require explicit user consent (anything that can reach
 * outside the host — worst-case external-effect). Determinism + per-user grants
 * mean a shared game saves *your* score, not the author's.
 */
import { classifyEffect, isKnownCapability, type CapabilityName, type EffectClass } from './effects.js';

export interface CapabilityRequest {
  cap: string;
  effect?: EffectClass;
  scope?: Record<string, unknown>;
}

export interface ConsentItem {
  cap: CapabilityName;
  /** worst-case effect (assume state-derived egress, not pre-approved). */
  worstCase: EffectClass;
  requiresConsent: boolean;
}

export interface ConsentReport {
  /** every declared capability, surfaced to the user. */
  shown: ConsentItem[];
  /** the subset the user must explicitly approve before first run. */
  requiresConsent: CapabilityName[];
  /** an unknown capability name in the manifest ⇒ reject the import wholesale. */
  unknown: string[];
}

/** Compute the consent report for a Lumen's capability manifest. */
export function consentForManifest(manifest: CapabilityRequest[]): ConsentReport {
  const shown: ConsentItem[] = [];
  const requiresConsent: CapabilityName[] = [];
  const unknown: string[] = [];

  for (const req of manifest) {
    if (!isKnownCapability(req.cap)) {
      unknown.push(req.cap);
      continue;
    }
    // worst case at consent time: assume the call WILL carry state-derived data
    // and was NOT pre-approved — the most cautious classification (§6).
    const worstCase = classifyEffect(req.cap, { stateDerived: true, preApproved: false }).effect;
    const needs = worstCase === 'external-effect';
    shown.push({ cap: req.cap, worstCase, requiresConsent: needs });
    if (needs) requiresConsent.push(req.cap);
  }

  return { shown, requiresConsent, unknown };
}

/** An imported Lumen is safe to run only if no capability is unknown (the
 *  whitelist discipline) — consent on the external-effect subset is then
 *  collected interactively. */
export function manifestIsImportable(manifest: CapabilityRequest[]): boolean {
  return consentForManifest(manifest).unknown.length === 0;
}
