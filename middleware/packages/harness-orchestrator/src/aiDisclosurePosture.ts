/**
 * AI-Act Art. 50 (#648, epic #642) — the operator's RESOLVED marking posture,
 * per channel, as a readable value.
 *
 * ## Why this exists
 *
 * The operator can grade the disclosure down per channel and switch it off
 * entirely — omadia is self-hosted, that is their call. #648's point is that
 * today the decision is invisible: a reduced marking shows up nowhere, so a
 * copy-paste error in a config or a leftover from a test setup is never
 * noticed. This module turns the same resolution the hot path performs into a
 * value `/health`, the boot log and the operator dashboard can all read.
 *
 * ## Why the level resolution lives HERE and not in the Orchestrator
 *
 * A posture view that recomputes the level with its own copy of the precedence
 * rules is a view that can disagree with what turns actually do — and it would
 * disagree silently, which is the exact failure #648 exists to prevent. So
 * {@link resolveDisclosureLevelForChannel} is the single derivation:
 * `Orchestrator.resolveTurnDisclosure` calls it per turn, and
 * {@link describeAiDisclosurePosture} calls it per channel. Same reason
 * `deriveAgentsConsulted` and `resolveAiDisclosure` were extracted.
 *
 * ## What must NOT be in here
 *
 * #648's sharpest acceptance criterion: no field that permits conclusions about
 * content or users. The posture therefore carries levels, sources and booleans
 * only — never the assistant name, never the operator note, never a composed
 * disclosure line. Whether those are SET is the operator-relevant fact; their
 * text is not, and the operator note in particular is free-form.
 */

import {
  DEFAULT_AI_DISCLOSURE_POLICY,
  type AiDisclosureLevel,
} from '@omadia/channel-sdk';
import type { AiDisclosureSetup } from './orchestrator.js';

/**
 * The channel kinds a per-channel override may key on — the full `ChannelKind`
 * set. Single source of truth for BOTH the setup-field parser (which rejects
 * anything else, so a typo cannot silently disable the marking) and the posture
 * view (which reports one row per entry). Two lists would drift into a posture
 * that omits a channel the parser accepts.
 *
 * NOTE, and it is the honest caveat this whole feature has to carry: only
 * `teams` / `slack` / `telegram` are ever produced as a per-turn `channelKind`
 * (`orchestratorDispatcher.toChannelKind` is the sole setter). `email` and
 * `web` turns carry none yet, as do discord / whatsapp / canvas-custom / the
 * HTTP dev path — those all resolve to the global level regardless of what an
 * override says. {@link ChannelPosture.effective} says so per row rather than
 * letting a dashboard imply an override is doing something it is not.
 */
export const AI_DISCLOSURE_CHANNEL_KINDS = [
  'teams',
  'telegram',
  'slack',
  'email',
  'web',
] as const;

export type AiDisclosureChannelKind =
  (typeof AI_DISCLOSURE_CHANNEL_KINDS)[number];

/**
 * Channel kinds that actually reach `resolveTurnDisclosure` with a
 * `channelIdentity.channelKind` set. An override for any other kind parses,
 * stores and displays — but never fires.
 */
const DISPATCHED_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  'teams',
  'telegram',
  'slack',
]);

/**
 * Resolve the disclosure level for one channel: a per-channel override wins
 * over the operator's global default, which wins over the shipping default. A
 * turn whose channel does not resolve to a `ChannelKind` uses the global level
 * — the safe direction, since the marking stays active.
 *
 * THE single derivation. `Orchestrator.resolveTurnDisclosure` and the posture
 * view below both call it; neither reimplements the precedence.
 */
export function resolveDisclosureLevelForChannel(
  setup: AiDisclosureSetup | undefined,
  channelKind: string | undefined,
): AiDisclosureLevel {
  const override =
    channelKind !== undefined ? setup?.overrides?.[channelKind] : undefined;
  return override ?? setup?.level ?? DEFAULT_AI_DISCLOSURE_POLICY.level;
}

/** The resolved marking posture for one channel. */
export interface ChannelPosture {
  readonly channel: AiDisclosureChannelKind;
  /** Resolved verbosity for this channel. */
  readonly level: AiDisclosureLevel;
  /** `true` when this channel's level came from a per-channel override rather
   *  than the global level. */
  readonly overridden: boolean;
  /** `true` when this level differs from the SHIPPING default (`standard`) —
   *  i.e. the thing an operator would want to be told about. */
  readonly deviates: boolean;
  /**
   * `false` when this channel never carries a `channelKind` into a turn, so an
   * override configured for it cannot take effect today. Reported rather than
   * hidden: an operator who set `web=off` and still sees the marking deserves
   * the reason, not a mystery.
   */
  readonly effective: boolean;
}

/**
 * The whole instance's marking posture. Levels, sources and booleans only —
 * see the note on omitted fields in this file's header.
 */
export interface AiDisclosurePosture {
  /** Where the effective policy came from. `'default'` means the operator set
   *  no disclosure field at all. */
  readonly source: 'default' | 'operator';
  /** The global level per-channel overrides fall back to. */
  readonly defaultLevel: AiDisclosureLevel;
  /** The delivered level, for comparison. Always `standard`. */
  readonly shippedLevel: AiDisclosureLevel;
  /** `true` when ANY channel deviates from the delivered state. The single
   *  flag a dashboard or a boot log branches on. */
  readonly deviates: boolean;
  /** One row per channel kind, in a stable order. */
  readonly channels: readonly ChannelPosture[];
  /** Operator pinned a wording language rather than letting the turn decide. */
  readonly localeConfigured: boolean;
  /** Operator gave the assistant a name woven into the marking. The name
   *  itself is deliberately NOT reported. */
  readonly assistantNameConfigured: boolean;
  /** Operator attached a verbatim addendum. Its text is deliberately NOT
   *  reported — it is free-form. */
  readonly operatorNoteConfigured: boolean;
}

/** ServiceRegistry name the orchestrator plugin publishes the posture under.
 *  Structural contract — the plugin publishes a plain object and the kernel
 *  only reads it, so neither side imports the other. Spelled again in
 *  `middleware/src/health/disclosureHealth.ts`; keep the two in sync. */
export const AI_DISCLOSURE_POSTURE_SERVICE = 'aiDisclosurePosture';

/**
 * Project the operator's resolved setup into the posture view.
 *
 * `setup === undefined` is the zero-config instance: shipping default on every
 * channel, `source: 'default'`, nothing deviating. That is exactly the state
 * #648 requires the UI to stay quiet for.
 */
export function describeAiDisclosurePosture(
  setup: AiDisclosureSetup | undefined,
): AiDisclosurePosture {
  const shippedLevel = DEFAULT_AI_DISCLOSURE_POLICY.level;
  const defaultLevel = setup?.level ?? shippedLevel;
  const channels = AI_DISCLOSURE_CHANNEL_KINDS.map((channel) => {
    const level = resolveDisclosureLevelForChannel(setup, channel);
    return Object.freeze({
      channel,
      level,
      overridden: setup?.overrides?.[channel] !== undefined,
      deviates: level !== shippedLevel,
      effective: DISPATCHED_CHANNEL_KINDS.has(channel),
    });
  });
  return Object.freeze({
    // Mirrors `resolveTurnDisclosure`: a resolved setup object exists ONLY when
    // the operator set at least one disclosure field, so its mere presence
    // makes the policy operator-sourced.
    source: setup !== undefined ? 'operator' : DEFAULT_AI_DISCLOSURE_POLICY.source,
    defaultLevel,
    shippedLevel,
    // The global level counts too: an operator who set `ai_disclosure_level=off`
    // and no overrides has deviated on every channel at once.
    deviates:
      defaultLevel !== shippedLevel || channels.some((c) => c.deviates),
    channels: Object.freeze(channels),
    localeConfigured: setup?.locale !== undefined,
    assistantNameConfigured: setup?.assistantName !== undefined,
    operatorNoteConfigured: setup?.operatorNote !== undefined,
  });
}

/**
 * The boot line. Returns `undefined` for a delivered-state instance — #648
 * wants a warning ONLY on deviation, so a default deployment's log stays clean
 * and the line keeps its signal.
 */
export function formatDisclosureBootWarning(
  posture: AiDisclosurePosture,
): string | undefined {
  if (!posture.deviates) return undefined;
  const changed = posture.channels
    .filter((c) => c.deviates)
    .map((c) => `${c.channel}=${c.level}${c.effective ? '' : ' (not dispatched yet)'}`)
    .join(', ');
  return (
    `[orchestrator] AI-Act marking deviates from the delivered state: ` +
    `default=${posture.defaultLevel} (shipped ${posture.shippedLevel}); ${changed}. ` +
    `This is an operator decision and nothing is blocked — logged so a config ` +
    `left over from a test setup does not go unnoticed.`
  );
}
