/**
 * How often the VISIBLE AI-disclosure markers appear (#2087, spec 2042 §5.14,
 * OD-5). The structured `SemanticAnswer.aiDisclosure` field and the machine
 * readable markings stay on every answer whatever the setting; only the
 * visible markers (the text line folded into `text`, channel chips such as
 * the Teams card chip) follow it.
 *
 * - `channel_default` (the default until OD-5 is settled): today's behaviour,
 *   the text line on the first answer of a conversation scope, channel chips
 *   on every answer.
 * - `per_answer`: every visible marker on every answer.
 * - `per_conversation`: the first answer of an agent in a conversation, again
 *   when a different agent speaks, and after a pause.
 *
 * Fail-safe direction as everywhere in the disclosure code: any doubt (no
 * scope, no store, a throwing store) shows the marker.
 */

export const AI_DISCLOSURE_FREQUENCIES = [
  'channel_default',
  'per_answer',
  'per_conversation',
] as const;

export type AiDisclosureFrequency = (typeof AI_DISCLOSURE_FREQUENCIES)[number];

export const DEFAULT_AI_DISCLOSURE_FREQUENCY: AiDisclosureFrequency = 'channel_default';

/** Pause after which `per_conversation` shows the marker again. */
export const DEFAULT_DISCLOSURE_PAUSE_MINUTES = 60;

export function isAiDisclosureFrequency(value: unknown): value is AiDisclosureFrequency {
  return (
    typeof value === 'string' &&
    (AI_DISCLOSURE_FREQUENCIES as readonly string[]).includes(value)
  );
}

/** Which visible markers are due on this answer. */
export interface DisclosureMarkers {
  /** The disclosure line is folded into the answer text. */
  readonly textLine: boolean;
  /** Channel chips / native AI labels are rendered for this answer. */
  readonly chip: boolean;
}

/** What `per_conversation` remembers about the last answer of a scope. */
export interface DisclosureMarkerState {
  readonly agentId: string | undefined;
  /** Epoch ms of the last answer in the scope. */
  readonly at: number;
}

export interface DisclosureMarkerStore {
  getMarker(scope: string): DisclosureMarkerState | undefined;
  setMarker(scope: string, state: DisclosureMarkerState): void;
}

/** Process-local store; a restart shows the marker again (fail-safe). */
export class InMemoryDisclosureMarkerStore implements DisclosureMarkerStore {
  readonly #state = new Map<string, DisclosureMarkerState>();
  getMarker(scope: string): DisclosureMarkerState | undefined {
    return this.#state.get(scope);
  }
  setMarker(scope: string, state: DisclosureMarkerState): void {
    this.#state.set(scope, state);
  }
}

export interface DecideDisclosureMarkersInput {
  readonly frequency: AiDisclosureFrequency;
  /** Whether this is the first answer of the scope (today's text-line rule). */
  readonly firstTurnOfScope: boolean;
  readonly scope: string | undefined;
  /** The speaking agent, for `per_conversation`. */
  readonly agentId: string | undefined;
  readonly now: number;
  readonly pauseMinutes?: number;
  readonly store?: DisclosureMarkerStore;
}

const ALL_MARKERS: DisclosureMarkers = Object.freeze({ textLine: true, chip: true });
const NO_MARKERS: DisclosureMarkers = Object.freeze({ textLine: false, chip: false });

function perConversationDue(input: DecideDisclosureMarkersInput): boolean {
  const { scope, store } = input;
  if (scope === undefined || store === undefined) return true;
  try {
    const previous = store.getMarker(scope);
    const pauseMs = (input.pauseMinutes ?? DEFAULT_DISCLOSURE_PAUSE_MINUTES) * 60_000;
    const due =
      previous === undefined ||
      previous.agentId !== input.agentId ||
      input.now - previous.at > pauseMs;
    // The pause measures inactivity, so every answer refreshes the clock.
    store.setMarker(scope, { agentId: input.agentId, at: input.now });
    return due;
  } catch {
    return true;
  }
}

/** Decide which visible markers this answer carries. Pure apart from the store. */
export function decideDisclosureMarkers(input: DecideDisclosureMarkersInput): DisclosureMarkers {
  switch (input.frequency) {
    case 'channel_default':
      return input.firstTurnOfScope ? ALL_MARKERS : Object.freeze({ textLine: false, chip: true });
    case 'per_answer':
      return ALL_MARKERS;
    case 'per_conversation':
      return perConversationDue(input) ? ALL_MARKERS : NO_MARKERS;
  }
}
