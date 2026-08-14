/**
 * AI-Act Art. 50 marking posture on `/health` (#648, epic #642).
 *
 * ## Why this is on a health endpoint at all
 *
 * The operator can grade the marking down per channel and switch it off — that
 * is their decision to make, omadia is self-hosted. #648's concern is narrower
 * and practical: a reduced marking is visible NOWHERE, so an operator who set
 * it by accident (a copied config, a leftover from a test setup) never finds
 * out. Same motivation as the KG snapshot next door: a silently-degraded
 * deployment should be observable at a glance instead of diagnosed by
 * archaeology through boot logs.
 *
 * ## Structural contract
 *
 * `@omadia/orchestrator` publishes a plain object under
 * `aiDisclosurePosture`; this module only reads it. Neither side imports the
 * other's types — the same arrangement `EMBEDDING_GATE_STATUS_SERVICE` uses,
 * and the reason the service name is spelled as a literal on both sides.
 *
 * ## Privacy
 *
 * #648's sharpest acceptance criterion is that nothing here may permit
 * conclusions about content or users. The published posture carries levels,
 * sources and booleans only; the assistant name, the operator note and any
 * composed disclosure line are deliberately absent at the source. This module
 * narrows further rather than widening: it forwards the fields as published
 * and adds no lookup of its own.
 */

/**
 * ServiceRegistry name `@omadia/orchestrator` publishes the posture under.
 * Structural contract — the literal is spelled in
 * `packages/harness-orchestrator/src/aiDisclosurePosture.ts` too; keep the two
 * in sync.
 */
export const AI_DISCLOSURE_POSTURE_SERVICE = 'aiDisclosurePosture';

/** Marking verbosity, as published. */
export type DisclosureLevel = 'standard' | 'concise' | 'off';

/** One channel's resolved posture, as published. `readonly` throughout: this
 *  module only ever reads the published object, and the publisher freezes it. */
export interface DisclosureChannelPosture {
  readonly channel: string;
  readonly level: DisclosureLevel;
  readonly overridden: boolean;
  readonly deviates: boolean;
  /** `false` when this channel never carries a `channelKind` into a turn, so a
   *  configured override cannot take effect yet. */
  readonly effective: boolean;
}

/** The posture object the orchestrator plugin publishes. */
export interface AiDisclosurePostureStatus {
  readonly source: 'default' | 'operator';
  readonly defaultLevel: DisclosureLevel;
  readonly shippedLevel: DisclosureLevel;
  readonly deviates: boolean;
  readonly channels: readonly DisclosureChannelPosture[];
  readonly localeConfigured: boolean;
  readonly assistantNameConfigured: boolean;
  readonly operatorNoteConfigured: boolean;
}

/** The `/health` projection. */
export interface DisclosureHealth {
  /** `false` when no orchestrator is active to publish a posture — reported
   *  rather than guessed, since "we could not read it" and "it is at the
   *  delivered state" are different facts and only one of them is reassuring. */
  known: boolean;
  /** Where the effective policy came from. */
  source: 'default' | 'operator' | 'unknown';
  /** `true` when any channel deviates from the delivered state. */
  deviates: boolean;
  /** Resolved level per channel, `{ teams: 'standard', … }`. Empty when
   *  unknown. */
  channels: Record<string, DisclosureLevel>;
  /** Channels whose configured override cannot fire yet because no turn
   *  carries their `channelKind`. Only listed when actually overridden — an
   *  un-overridden channel is not a surprise worth reporting. */
  inertOverrides: string[];
  /** Operator-facing notes, empty at the delivered state. */
  warnings: string[];
}

const UNKNOWN: DisclosureHealth = {
  known: false,
  source: 'unknown',
  deviates: false,
  channels: {},
  inertOverrides: [],
  warnings: [
    'no orchestrator is active, so the AI-marking posture could not be read',
  ],
};

/**
 * Project the published posture for `/health`.
 *
 * A missing service is NOT reported as healthy. That is the specific lie the
 * neighbouring KG snapshot exists to prevent, and repeating it here would mean
 * an instance with no orchestrator answers "marking at the delivered state"
 * when in truth nothing was asked.
 */
export function buildDisclosureHealth(
  posture: AiDisclosurePostureStatus | undefined,
): DisclosureHealth {
  if (!posture || !Array.isArray(posture.channels)) return UNKNOWN;

  const channels: Record<string, DisclosureLevel> = {};
  for (const c of posture.channels) channels[c.channel] = c.level;

  const inertOverrides = posture.channels
    .filter((c) => c.overridden && !c.effective)
    .map((c) => c.channel);

  const warnings: string[] = [];
  if (posture.deviates) {
    const changed = posture.channels
      .filter((c) => c.deviates)
      .map((c) => `${c.channel}=${c.level}`)
      .join(', ');
    warnings.push(
      `AI marking deviates from the delivered state (${posture.shippedLevel}): ${changed || `default=${posture.defaultLevel}`}`,
    );
  }
  if (inertOverrides.length > 0) {
    // Worth a line of its own: an operator who set `web=off` and still sees the
    // marking is looking at a correct system and a stale expectation. Silence
    // here reads as "your override is in force".
    warnings.push(
      `override configured but not yet dispatched for: ${inertOverrides.join(', ')} — turns on these channels carry no channelKind, so they use the global level`,
    );
  }

  return {
    known: true,
    source: posture.source,
    deviates: Boolean(posture.deviates),
    channels,
    inertOverrides,
    warnings,
  };
}
