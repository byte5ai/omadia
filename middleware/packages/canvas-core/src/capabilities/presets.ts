/**
 * omadia-canvas-protocol/1.1 — Lumen presets & lifecycle (lumens-spec.md §8).
 *
 * The agent authors rarely and reuses constantly. A vetted Lumen is saved once:
 * named, versioned, CONTENT-ADDRESSED (`preset-<sha256(spec)[:16]>`),
 * parameterised. Instantiation is deterministic, near-zero-LLM. Before any build,
 * Tier-2 runs resolve-then-generate: exact hit → instantiate; near hit → fork +
 * patch; miss → cold-author. Fork is copy-on-write → new content-addressed id,
 * parent recorded for provenance. All pure & deterministic (unit-testable).
 */
import { createHash } from 'node:crypto';

/** First-match-wins scope precedence (§8). */
export type PresetScope = 'first-party' | 'tenant' | 'user' | 'canvas';
const SCOPE_ORDER: PresetScope[] = ['first-party', 'tenant', 'user', 'canvas'];

/** Stable serialisation (sorted keys) so identical specs hash identically
 *  regardless of key order. */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('cannot canonicalize a cyclic value');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** The content-addressed preset id for a Lumen spec. The `preset` provenance
 *  field is excluded from the hash so lineage never changes the content id. */
export function presetId(spec: Record<string, unknown>): string {
  const { preset: _omit, ...content } = spec;
  void _omit;
  const hash = createHash('sha256').update(canonicalize(content)).digest('hex').slice(0, 16);
  return `preset-${hash}`;
}

/** A coarse structural signature for near-hit detection: same state keys +
 *  transition names + view container/scene kind ⇒ a fork+patch candidate. */
export function shapeSignature(spec: Record<string, unknown>): string {
  const state = spec.state && typeof spec.state === 'object' ? Object.keys(spec.state as object).sort() : [];
  const transitions = spec.transitions && typeof spec.transitions === 'object' ? Object.keys(spec.transitions as object).sort() : [];
  const view = spec.view as { lit?: { type?: string }; record?: { type?: { lit?: string } } } | undefined;
  const viewKind = view?.record?.type?.lit ?? view?.lit?.type ?? 'expr';
  return canonicalize({ state, transitions, viewKind });
}

export type ResolveResult =
  | { kind: 'exact'; id: string; scope: PresetScope }
  | { kind: 'near'; id: string; scope: PresetScope; signature: string }
  | { kind: 'miss' };

interface Entry {
  id: string;
  scope: PresetScope;
  signature: string;
  spec: Record<string, unknown>;
}

/** A scoped preset registry implementing resolve-then-generate (§8). */
export class PresetRegistry {
  private readonly byId = new Map<string, Entry>();

  /** Save a vetted Lumen as a preset; returns its content-addressed id. */
  register(spec: Record<string, unknown>, scope: PresetScope = 'canvas'): string {
    const id = presetId(spec);
    if (!this.byId.has(id)) this.byId.set(id, { id, scope, signature: shapeSignature(spec), spec });
    return id;
  }

  get(id: string): Record<string, unknown> | undefined {
    return this.byId.get(id)?.spec;
  }

  /** Resolve-then-generate: exact content hit → instantiate; else the
   *  highest-scope structural near-hit → fork+patch; else miss → cold-author. */
  resolve(query: Record<string, unknown>): ResolveResult {
    const exactId = presetId(query);
    const exact = this.byId.get(exactId);
    if (exact) return { kind: 'exact', id: exact.id, scope: exact.scope };

    const sig = shapeSignature(query);
    const candidates = [...this.byId.values()].filter((e) => e.signature === sig);
    if (candidates.length > 0) {
      candidates.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope));
      const best = candidates[0]!;
      return { kind: 'near', id: best.id, scope: best.scope, signature: sig };
    }
    return { kind: 'miss' };
  }
}

/** Copy-on-write fork: apply a shallow patch over the parent spec, record the
 *  parent id for provenance, and compute the child's new content-addressed id. */
export function forkPreset(
  parentSpec: Record<string, unknown>,
  patch: Record<string, unknown>,
): { spec: Record<string, unknown>; id: string; parent: string } {
  const parent = presetId(parentSpec);
  const merged: Record<string, unknown> = { ...parentSpec, ...patch };
  delete merged.preset; // recomputed below; never inherit the parent's provenance
  const id = presetId(merged);
  merged.preset = { id, parent };
  return { spec: merged, id, parent };
}
