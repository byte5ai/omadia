/**
 * omadia-canvas-protocol/1.1 — capability effect classification (lumens-spec.md §6).
 *
 * Default-deny, brokered capabilities. This pure module decides a capability
 * call's effect class (local / internal / external-effect) and whether it needs
 * a per-call user confirmation — the policy the Tier-2 broker enforces. The key
 * rule (§6, Codex rev 2): egress carrying data DERIVED from Lumen state or a
 * DataRef is `external-effect` (confirmed) UNLESS the endpoint+shape were
 * pre-approved at grant time — a bare `internal` fetch may not smuggle
 * state-derived data past the confirmation gate. Tier-2 may UPGRADE the class,
 * never downgrade it.
 */
export type CapabilityName =
  | 'persist' | 'loadData' | 'writeData' | 'tiles' | 'fetch' | 'generateAsset' | 'clipboard' | 'share' | 'savePreset';

export type EffectClass = 'local' | 'internal' | 'external-effect';

/** Base effect class per capability (CONCEPT.md §Security Surface). */
const BASE_EFFECT: Record<CapabilityName, EffectClass> = {
  persist: 'internal',
  loadData: 'internal',
  writeData: 'internal',
  tiles: 'internal',
  fetch: 'internal',
  generateAsset: 'internal',
  clipboard: 'external-effect',
  share: 'external-effect',
  savePreset: 'external-effect',
};

/** Capabilities whose egress can carry data out of the host. */
const EGRESS_CAPS: ReadonlySet<CapabilityName> = new Set(['fetch', 'writeData', 'generateAsset']);

export interface ClassifyInput {
  /** the call carries data derived from Lumen state or a DataRef. */
  stateDerived?: boolean;
  /** the endpoint AND request shape were pre-approved at grant time. */
  preApproved?: boolean;
}

export interface EffectDecision {
  effect: EffectClass;
  /** a per-call confirmation modal is required before the real call. */
  needsConfirmation: boolean;
  reason: string;
}

const ORDER: Record<EffectClass, number> = { local: 0, internal: 1, 'external-effect': 2 };

/** Classify a capability call. The result is the class the broker enforces;
 *  external-effect always requires confirmation. */
export function classifyEffect(cap: CapabilityName, input: ClassifyInput = {}): EffectDecision {
  let effect = BASE_EFFECT[cap];
  let reason = `base class for ${cap}`;

  // state/DataRef-derived egress escalates to external-effect unless pre-approved.
  if (EGRESS_CAPS.has(cap) && input.stateDerived && !input.preApproved) {
    if (ORDER['external-effect'] > ORDER[effect]) {
      effect = 'external-effect';
      reason = `${cap} carries state/DataRef-derived data and was not pre-approved at grant`;
    }
  }

  return { effect, needsConfirmation: effect === 'external-effect', reason };
}

/** Tier-2 may UPGRADE an agent's declared class, never downgrade it (§0.5). */
export function reconcileDeclared(declared: EffectClass | undefined, derived: EffectClass): EffectClass {
  if (!declared) return derived;
  return ORDER[declared] >= ORDER[derived] ? declared : derived;
}

export function isKnownCapability(cap: string): cap is CapabilityName {
  return cap in BASE_EFFECT;
}
