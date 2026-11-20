/**
 * Disclosure levels (spec 2042 §5.11 "How much"): a grant carries, per data
 * classification, how much of an information may flow.
 *
 * | Level | Meaning |
 * |---|---|
 * | `full` | The information itself. |
 * | `redacted` | Classified fields masked by the privacy shield. |
 * | `aggregate` | Only results of deterministic aggregate operations. |
 * | `existence` | Only that a colleague knows something, and whom to ask. |
 * | `none` | Nothing, not even existence. |
 *
 * Applied to a consultation: B's contribution carries B's turn label set. What
 * B adds that A could not know itself (a label A's turn does not carry and A's
 * grants do not cover) is "novel"; the lowest level of the novel labels caps
 * the contribution. A contribution that fails the flow rule is never delivered;
 * its outcome is `existence` or `none` by the same levels.
 *
 * `aggregate` has no deterministic aggregate path for prose yet, so a prose
 * contribution capped at `aggregate` is treated as `existence` (never more).
 */

import { labelId, type DiscretionLabel, type LabelSet } from './labels.js';
import type { FlowDecision } from './flowRule.js';

export const DISCLOSURE_LEVELS = ['full', 'redacted', 'aggregate', 'existence', 'none'] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export function isDisclosureLevel(value: unknown): value is DisclosureLevel {
  return typeof value === 'string' && (DISCLOSURE_LEVELS as readonly string[]).includes(value);
}

/**
 * Levels per classification key. Keys, most specific first:
 * - `context`: knowledge from another conversation or memory context;
 * - `source:<system>` / `source`: data from a connected system;
 * - `classification:<class>` / `classification`: classified data seen unmasked;
 * - `default`: everything else.
 * A key that is absent falls through to the next; the final default is `none`
 * (consultation grants default to `none`, spec §5.11 "Defaults").
 */
export type DisclosurePolicy = Readonly<Record<string, DisclosureLevel>>;

export const MAX_DISCLOSURE_KEYS = 64;

/** Validate an operator-supplied policy; returns undefined when malformed. */
export function parseDisclosurePolicy(value: unknown): DisclosurePolicy | undefined {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_DISCLOSURE_KEYS) return undefined;
  const out: Record<string, DisclosureLevel> = {};
  for (const [key, level] of entries) {
    if (!/^[a-z][a-z0-9_.:@/-]{0,199}$/i.test(key) || !isDisclosureLevel(level)) return undefined;
    out[key] = level;
  }
  return out;
}

function lookupKeys(label: DiscretionLabel): string[] {
  switch (label.kind) {
    case 'context':
      return ['context'];
    case 'source':
      return [`source:${label.system}`, 'source'];
    case 'classification':
      return [`classification:${label.class}`, 'classification'];
  }
}

export function levelFor(policy: DisclosurePolicy, label: DiscretionLabel): DisclosureLevel {
  for (const key of [...lookupKeys(label), 'default']) {
    const level = policy[key];
    if (level !== undefined) return level;
  }
  return 'none';
}

function rank(level: DisclosureLevel): number {
  return DISCLOSURE_LEVELS.indexOf(level);
}

/** The lower (more restrictive) of two levels. */
export function lowerLevel(a: DisclosureLevel, b: DisclosureLevel): DisclosureLevel {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * Labels of `contribution` the requester could not know by itself: not in its
 * own turn label set, and not a source system its own grants cover.
 */
export function novelLabels(
  contribution: LabelSet,
  requester: LabelSet,
  requesterSystems: ReadonlySet<string>,
): DiscretionLabel[] {
  const known = new Set(requester.labels.map(labelId));
  return contribution.labels.filter((label) => {
    if (known.has(labelId(label))) return false;
    return !(label.kind === 'source' && requesterSystems.has(label.system));
  });
}

export type DisclosureOutcome =
  | { readonly kind: 'deliver'; readonly view: 'full' | 'redacted' }
  | { readonly kind: 'existence' }
  | { readonly kind: 'none' };

export interface DisclosureInput {
  readonly contribution: LabelSet;
  readonly requester: LabelSet;
  readonly requesterSystems: ReadonlySet<string>;
  readonly policy: DisclosurePolicy;
  /** The flow rule's verdict for the contribution towards the requester. */
  readonly flow: FlowDecision;
}

/** Decide what of a contribution may reach the requester. Deterministic. */
export function decideDisclosure(input: DisclosureInput): DisclosureOutcome {
  if (!input.flow.allowed) {
    // Never delivered. `none` on any violating label hides even existence.
    const levels = input.flow.violations.map((v) => levelFor(input.policy, v.label));
    return levels.includes('none') ? { kind: 'none' } : { kind: 'existence' };
  }
  const novel = novelLabels(input.contribution, input.requester, input.requesterSystems);
  if (novel.length === 0) return { kind: 'deliver', view: 'full' };
  const level = novel
    .map((label) => levelFor(input.policy, label))
    .reduce<DisclosureLevel>(lowerLevel, 'full');
  switch (level) {
    case 'full':
      return { kind: 'deliver', view: 'full' };
    case 'redacted':
      return { kind: 'deliver', view: 'redacted' };
    case 'aggregate':
    case 'existence':
      return { kind: 'existence' };
    case 'none':
      return { kind: 'none' };
  }
}

/**
 * The text a person sees for an `existence` outcome: that a colleague knows
 * something and can be asked directly, without revealing what. Kernel-authored.
 */
export function existenceText(colleague: string, locale: string | undefined): string {
  if (locale?.toLowerCase().startsWith('de')) {
    return `${colleague} kann dazu etwas beitragen, aber nicht hier. Frag ${colleague} am besten direkt.`;
  }
  return `${colleague} can help with this, but not here. Best ask ${colleague} directly.`;
}

/**
 * The line that replaces an answer refused as a whole at the people egress:
 * honest that something cannot be shared here, revealing nothing of it.
 */
export function answerWithheldText(locale: string | undefined): string {
  if (locale?.toLowerCase().startsWith('de')) {
    return 'Dazu kann ich in dieser Runde nichts sagen, weil nicht alle hier diese Informationen kennen dürfen. Frag mich gern direkt.';
  }
  return 'I cannot answer that in this conversation, because not everyone here may know the information involved. Feel free to ask me directly.';
}

/**
 * Is `text` an answer refused at the people egress ({@link answerWithheldText}
 * in any locale, disclosure folded on or not)? A proactive sender drops it:
 * nobody asked, so there is nothing to decline.
 */
export function isAnswerWithheldText(text: string): boolean {
  return [answerWithheldText('de'), answerWithheldText('en')].some((line) => text.includes(line));
}
