/**
 * Pace: how an agent behaves like a colleague while work takes time (spec 2042
 * §5.8 "Pace", criterion 10, ADR-0021).
 *
 * - The typing indicator, where the channel has one, from the start of the turn.
 * - A short acknowledgement ONLY when the work clearly takes longer than a normal
 *   answer (`ackThresholdMs`), once, as the agent's own words from a registered
 *   template: no progress chatter, no model call.
 * - When the work outlives the channel's reply window (`replyWindowMs`, for
 *   example a webhook that must answer within seconds) the result is delivered as
 *   a FOLLOW-UP message instead of a reply to a request that has timed out: never
 *   a silent timeout.
 *
 * A channel runs its agent call through {@link runPacedTurn} and acts on the
 * outcome; the SDK owns the timing so every channel behaves the same.
 */

export interface ChannelPaceProfile {
  /** After this long without an answer the agent acknowledges once. Default 8 s. */
  readonly ackThresholdMs: number;
  /**
   * How long the channel can still reply to the inbound request itself. Past
   * it the answer is a follow-up message. Absent: the channel has no window.
   */
  readonly replyWindowMs?: number;
  /** Re-send the typing indicator this often. Absent: once at the start. */
  readonly typingIntervalMs?: number;
}

export const DEFAULT_PACE_PROFILE: ChannelPaceProfile = Object.freeze({
  ackThresholdMs: 8_000,
});

/** The acknowledgement, by locale. A registered template: fixed text, no model. */
export function paceAckText(locale: string | undefined): string {
  return locale !== undefined && /^en\b/i.test(locale)
    ? 'On it. This will take a moment.'
    : 'Ich kümmere mich darum, das dauert einen Moment.';
}

export interface PaceHooks {
  /** Show the channel's typing indicator. Optional: channels without one omit it. */
  sendTyping?(): Promise<void> | void;
  /** Post the one acknowledgement, as the agent. */
  sendAck(text: string): Promise<void> | void;
  /** Report a hook that threw; pacing itself never fails the turn. */
  onHookError?(hook: 'typing' | 'ack', error: unknown): void;
}

/** Timer seam for tests. */
export interface PaceClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_CLOCK: PaceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface PacedOutcome<T> {
  readonly result: T;
  /** The acknowledgement was sent. */
  readonly acknowledged: boolean;
  /**
   * The work finished after the reply window: deliver `result` as a follow-up
   * message, not as the reply to the inbound request.
   */
  readonly deliverAsFollowUp: boolean;
  readonly elapsedMs: number;
}

/**
 * Run `work` with the pace behaviour of `profile`. Rejects exactly when `work`
 * rejects (the caller turns that into a `system` notice); hook failures are
 * reported through `onHookError` and never fail the turn.
 */
export async function runPacedTurn<T>(
  work: () => Promise<T>,
  profile: ChannelPaceProfile,
  hooks: PaceHooks,
  opts: { readonly locale?: string; readonly clock?: PaceClock } = {},
): Promise<PacedOutcome<T>> {
  const clock = opts.clock ?? REAL_CLOCK;
  const startedAt = clock.now();
  let acknowledged = false;
  const fire = (hook: 'typing' | 'ack', fn: () => Promise<void> | void): void => {
    try {
      const out = fn();
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((error: unknown) => hooks.onHookError?.(hook, error));
      }
    } catch (error) {
      hooks.onHookError?.(hook, error);
    }
  };

  if (hooks.sendTyping) fire('typing', () => hooks.sendTyping?.());
  const typingTimer =
    hooks.sendTyping && profile.typingIntervalMs !== undefined
      ? clock.setInterval(() => fire('typing', () => hooks.sendTyping?.()), profile.typingIntervalMs)
      : undefined;
  const ackTimer = clock.setTimeout(() => {
    acknowledged = true;
    fire('ack', () => hooks.sendAck(paceAckText(opts.locale)));
  }, profile.ackThresholdMs);

  try {
    const result = await work();
    const elapsedMs = clock.now() - startedAt;
    return {
      result,
      acknowledged,
      deliverAsFollowUp: profile.replyWindowMs !== undefined && elapsedMs > profile.replyWindowMs,
      elapsedMs,
    };
  } finally {
    clock.clearTimeout(ackTimer);
    if (typingTimer !== undefined) clock.clearInterval(typingTimer);
  }
}
