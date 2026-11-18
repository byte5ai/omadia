import { ApiError } from './api';
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
  'channel_binding',
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

/**
 * Why a bound engine cannot run facilitations — `EngineUnusableReason` in
 * `middleware/src/platform/facilitatorRuntimeService.ts`, without the three
 * codes that are states of their own here. `unknown` is a code this client
 * has no copy for yet.
 */
export const FACILITATION_ENGINE_UNUSABLE_REASONS = [
  'inactive',
  'not_reported',
  'engine_reported',
] as const;

export type FacilitationEngineUnusableReason =
  | (typeof FACILITATION_ENGINE_UNUSABLE_REASONS)[number]
  | 'unknown';

/**
 * Whether this instance can run a facilitation at all, as the kernel reports
 * it on `GET /v1/operator/agents/facilitation-engine`
 * (`middleware/src/routes/facilitationEngineStatus.ts`). The route answers
 * with CODES; the sentences are this app's catalogue.
 *
 *  - `none`: no installed plugin declares `facilitationEngine@1`.
 *  - `ambiguous`: more than one does; nothing takes effect until all but one
 *    are removed.
 *  - `ungranted`: one plugin declares it but the operator has not granted its
 *    SQL access. It is not the engine yet: nothing is attached to it.
 *  - `unusable`: the engine is bound but cannot run facilitations. `reason`
 *    is the kernel's code; `engineReason` is the plugin's own untranslated
 *    sentence (only with `engine_reported`) and is shown on its own, never
 *    inside a translated sentence.
 *  - `ready`: bound and usable.
 */
export type FacilitationEngineStatus =
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous'; readonly pluginIds: readonly string[] }
  | { readonly state: 'ungranted'; readonly pluginId: string }
  | {
      readonly state: 'unusable';
      readonly pluginId: string;
      readonly reason: FacilitationEngineUnusableReason;
      readonly engineReason: string | null;
    }
  | { readonly state: 'ready'; readonly pluginId: string };

/** The BOUND engine's id — the plugin the kernel attaches to facilitators.
 *  An ungranted candidate is not bound, so it has none. */
export function facilitationEnginePluginId(
  status: FacilitationEngineStatus,
): string | null {
  return status.state === 'ready' || status.state === 'unusable'
    ? status.pluginId
    : null;
}

/**
 * Narrow the wire body. Anything that is not the documented shape is `null`:
 * the caller then says "could not be checked", which must never read as
 * "no engine installed".
 */
export function parseFacilitationEngineStatus(
  body: unknown,
): FacilitationEngineStatus | null {
  if (!isRecord(body)) return null;
  if (body.state === 'none') return { state: 'none' };
  if (body.state === 'ambiguous') {
    const ids = Array.isArray(body.plugin_ids)
      ? body.plugin_ids.filter((id): id is string => typeof id === 'string')
      : [];
    return { state: 'ambiguous', pluginIds: ids };
  }
  if (typeof body.plugin_id !== 'string') return null;
  if (body.state === 'ungranted') {
    return { state: 'ungranted', pluginId: body.plugin_id };
  }
  if (body.state !== 'bound') return null;
  if (body.available === true) return { state: 'ready', pluginId: body.plugin_id };
  const reason = (FACILITATION_ENGINE_UNUSABLE_REASONS as readonly string[]).includes(
    String(body.reason_code),
  )
    ? (body.reason_code as FacilitationEngineUnusableReason)
    : 'unknown';
  return {
    state: 'unusable',
    pluginId: body.plugin_id,
    reason,
    engineReason:
      reason === 'engine_reported' &&
      typeof body.engine_reason === 'string' &&
      body.engine_reason.trim().length > 0
        ? body.engine_reason
        : null,
  };
}

const FACILITATION_ENGINE_PATH = '/bot-api/v1/operator/agents/facilitation-engine';

/** Browser-side read through the same-origin proxy. Rejects when the route
 *  does not answer with the documented body. */
export async function loadFacilitationEngineStatus(): Promise<FacilitationEngineStatus> {
  const res = await fetch(FACILITATION_ENGINE_PATH, {
    headers: { accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `GET ${FACILITATION_ENGINE_PATH} failed: ${String(res.status)}`,
      text,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const status = parseFacilitationEngineStatus(body);
  if (status === null) {
    throw new ApiError(res.status, 'unexpected facilitation-engine body', text);
  }
  return status;
}
