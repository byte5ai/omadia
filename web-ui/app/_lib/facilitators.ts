import { ApiError, getPluginGrants, listStorePlugins } from './api';
import {
  ALL_PERSONA_AXES,
  PERSONA_AXIS_NEUTRAL,
  type PersonaAxes,
  type PersonaAxisKey,
} from './personaTypes';

/**
 * #2066 — what the operator UI knows about facilitator-kind agents
 * (spec 2043 §2.3, §2.4).
 *
 * THE KERNEL ENFORCES, THIS FILE MIRRORS. Every bound and every refusal below
 * is decided in the middleware (`services/facilitatorContract.ts`,
 * `platform/facilitatorGuard.ts`). The copies here exist so the editor can
 * stop an operator before the save instead of after it; a drift only costs a
 * round trip, because the server answers 422 with the findings either way.
 */

/** Upper bounds per persona axis (0–100). An axis not listed is free. */
export const FACILITATOR_PERSONA_MAX: Readonly<
  Partial<Record<PersonaAxisKey, number>>
> = {
  sarcasm: 20,
  drama: 30,
  humor: 60,
  risk_tolerance: 60,
};

/** Lower bounds per persona axis. */
export const FACILITATOR_PERSONA_MIN: Readonly<
  Partial<Record<PersonaAxisKey, number>>
> = {
  warmth: 30,
};

/** What an unset sycophancy level compiles to for a facilitator. */
export const FACILITATOR_DEFAULT_SYCOPHANCY = 'medium';

const AXIS_FLOOR = 0;
const AXIS_CEILING = 100;

export interface PersonaAxisBound {
  readonly min: number;
  readonly max: number;
}

/** The bound of one axis, or `null` when a facilitator may set it freely. */
export function facilitatorAxisBound(
  axis: PersonaAxisKey,
): PersonaAxisBound | null {
  const min = FACILITATOR_PERSONA_MIN[axis];
  const max = FACILITATOR_PERSONA_MAX[axis];
  if (min === undefined && max === undefined) return null;
  return { min: min ?? AXIS_FLOOR, max: max ?? AXIS_CEILING };
}

export function clampFacilitatorAxis(axis: PersonaAxisKey, value: number): number {
  const bound = facilitatorAxisBound(axis);
  if (!bound) return value;
  return Math.min(bound.max, Math.max(bound.min, value));
}

/** Clamp every SET axis into its bound. Unset axes stay unset. */
export function clampFacilitatorAxes(axes: PersonaAxes | undefined): PersonaAxes {
  const out: PersonaAxes = {};
  for (const axis of ALL_PERSONA_AXES) {
    const value = axes?.[axis];
    if (value !== undefined) out[axis] = clampFacilitatorAxis(axis, value);
  }
  return out;
}

/** What a slider shows for an axis nobody set: neutral, pulled into the bound. */
export function facilitatorAxisDisplayValue(
  axis: PersonaAxisKey,
  value: number | undefined,
): number {
  return clampFacilitatorAxis(axis, value ?? PERSONA_AXIS_NEUTRAL);
}

// ── refusals ─────────────────────────────────────────────────────────────

/** One code per omission of spec 2043 §2.3 — `FacilitatorOmission` in the
 *  orchestrator package. */
export const FACILITATOR_OMISSIONS = [
  'plugin_grant',
  'tool_grant',
  'memory',
  'default_agent',
  'persona_skill',
  'fast_path',
  'agent_to_agent',
  'consultation',
  'sub_agent',
  'assistance',
] as const;

export type FacilitatorOmission = (typeof FACILITATOR_OMISSIONS)[number];

/** Rule ids of `FacilitatorContractIssue.rule` the catalogue has copy for. */
export const FACILITATOR_ISSUE_RULES = [
  'persona_axis_above_bound',
  'persona_axis_below_bound',
  'sycophancy_guard_off',
  'partiality',
  'takes_sides',
  'votes_or_decides',
  'gives_opinion',
  'hidden_channel',
  'lifts_contract',
  'ignores_stop',
  'acts_as_assistant',
] as const;

export type FacilitatorIssueRule = (typeof FACILITATOR_ISSUE_RULES)[number];

export function isFacilitatorIssueRule(raw: string): raw is FacilitatorIssueRule {
  return (FACILITATOR_ISSUE_RULES as readonly string[]).includes(raw);
}

export interface FacilitatorContractIssue {
  /** `persona.axes.sarcasm`, `quality.sycophancy`, `instructions`,
   *  `persona.custom_notes`. */
  readonly path: string;
  readonly rule: string;
  /** Server prose (English). Detail only — never the primary UI text. */
  readonly message: string;
  readonly excerpt?: string;
}

export type FacilitatorRefusal =
  | {
      readonly kind: 'omission';
      /** `null` when the server named an omission this client does not know. */
      readonly omission: FacilitatorOmission | null;
      readonly refusedPlugins: readonly string[];
    }
  | {
      readonly kind: 'contract';
      readonly issues: readonly FacilitatorContractIssue[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseIssue(raw: unknown): FacilitatorContractIssue | null {
  if (!isRecord(raw)) return null;
  const { path, rule, message, excerpt } = raw;
  if (typeof path !== 'string' || typeof rule !== 'string') return null;
  return {
    path,
    rule,
    message: typeof message === 'string' ? message : '',
    ...(typeof excerpt === 'string' ? { excerpt } : {}),
  };
}

/**
 * Narrow a failed write to a facilitator refusal: 409 `facilitator_omission`
 * or 422 `facilitator_contract_violation`. `null` for everything else, so a
 * caller falls through to its ordinary error mapping. Total by construction —
 * a proxy's HTML error page yields `null`, never a throw.
 */
export function parseFacilitatorRefusal(err: unknown): FacilitatorRefusal | null {
  if (!(err instanceof ApiError)) return null;
  let body: unknown;
  try {
    body = JSON.parse(err.body);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  if (body.error === 'facilitator_omission') {
    const omission = (FACILITATOR_OMISSIONS as readonly string[]).includes(
      String(body.omission),
    )
      ? (body.omission as FacilitatorOmission)
      : null;
    const refused = Array.isArray(body.refused_plugins)
      ? body.refused_plugins.filter((p): p is string => typeof p === 'string')
      : [];
    return { kind: 'omission', omission, refusedPlugins: refused };
  }
  if (body.error === 'facilitator_contract_violation') {
    const issues = Array.isArray(body.issues)
      ? body.issues
          .map(parseIssue)
          .filter((i): i is FacilitatorContractIssue => i !== null)
      : [];
    return { kind: 'contract', issues };
  }
  return null;
}

const AXIS_PATH_PREFIX = 'persona.axes.';

/** The axis an issue path points at, or `null` for a non-axis path. */
export function issueAxis(path: string): PersonaAxisKey | null {
  if (!path.startsWith(AXIS_PATH_PREFIX)) return null;
  const axis = path.slice(AXIS_PATH_PREFIX.length);
  return (ALL_PERSONA_AXES as readonly string[]).includes(axis)
    ? (axis as PersonaAxisKey)
    : null;
}

// ── facilitation engine ──────────────────────────────────────────────────

/** `FACILITATION_ENGINE_CAPABILITY` in `@omadia/plugin-api`. */
export const FACILITATION_ENGINE_CAPABILITY = 'facilitationEngine@1';

export interface FacilitationEnginePlugin {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether this instance can run a facilitation at all.
 *
 *  - `none`: no installed plugin provides the engine capability.
 *  - `ambiguous`: more than one does; the kernel refuses every grant until
 *    all but one are removed.
 *  - `errored`: the one engine is installed but did not start.
 *  - `sql_grant_missing`: it is installed, but the operator has not granted
 *    the database access its tables need.
 *  - `ready`: installed, granted, not errored.
 */
export type FacilitationEngineStatus =
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous'; readonly plugins: readonly FacilitationEnginePlugin[] }
  | { readonly state: 'errored'; readonly plugin: FacilitationEnginePlugin }
  | { readonly state: 'sql_grant_missing'; readonly plugin: FacilitationEnginePlugin }
  | { readonly state: 'ready'; readonly plugin: FacilitationEnginePlugin };

/**
 * Read the engine status from what the kernel already serves: the store list
 * (who is installed and provides the capability) and the per-plugin consent
 * view (is it errored, is the SQL grant outstanding).
 *
 * The kernel has no single "facilitation engine" read route; this mirrors
 * `resolveFacilitationEngine` in `platform/facilitatorGuard.ts`, including its
 * rule that an errored provider is not an engine.
 */
export async function loadFacilitationEngineStatus(): Promise<FacilitationEngineStatus> {
  const { items } = await listStorePlugins();
  const providers = items.filter(
    (p) =>
      (p.install_state === 'installed' || p.install_state === 'update-available') &&
      (p.provides ?? []).includes(FACILITATION_ENGINE_CAPABILITY),
  );
  if (providers.length === 0) return { state: 'none' };

  const views = await Promise.all(
    providers.map(async (p) => ({
      plugin: { id: p.id, name: p.name },
      grants: await getPluginGrants(p.id),
    })),
  );
  const live = views.filter((v) => v.grants.state !== 'errored');
  if (live.length > 1) {
    return { state: 'ambiguous', plugins: live.map((v) => v.plugin) };
  }
  const only = live[0];
  if (!only) {
    // Every provider is errored. A missing SQL grant is the usual reason an
    // engine does not start, and it has its own fix — say that one first.
    const first = views[0]!;
    return first.grants.missing.some((m) => m.kind === 'sql')
      ? { state: 'sql_grant_missing', plugin: first.plugin }
      : { state: 'errored', plugin: first.plugin };
  }
  return only.grants.missing.some((m) => m.kind === 'sql')
    ? { state: 'sql_grant_missing', plugin: only.plugin }
    : { state: 'ready', plugin: only.plugin };
}
