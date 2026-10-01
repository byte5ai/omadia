/**
 * Fakes for the `ChannelSessionTracker` unit suites: the slice of a `ws`
 * socket the tracker touches, a synthetic upgrade request, a session built
 * around any `exp`, and helpers for checks a test resolves by hand. The
 * suites run with `mock.timers` on `setTimeout` and `Date`, so `settle` waits
 * on `setImmediate`, which stays real.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import type { SessionEvaluation } from '../../src/auth/requireAuth.js';
import type { VerifiedSession } from '../../src/auth/sessionJwt.js';
import type { AuthenticatedChannelSession } from '../../src/channels/channelSessionLifetime.js';

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;

/** The slice of a `ws` socket the tracker touches. */
export class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  closedWith: { code?: number; reason?: string } | undefined;
  /** Reading from the peer is paused (`ws` stops pulling from the TCP socket). */
  isPaused = false;

  send(): void {
    /* frames to the peer are not under test here */
  }

  pause(): void {
    if (this.readyState !== 3) this.isPaused = true;
  }

  resume(): void {
    if (this.readyState !== 3) this.isPaused = false;
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 2; // CLOSING
    this.closedWith = { code, reason };
  }

  /** The peer went away (its close frame arrived, or the TCP socket ended). */
  finishClose(): void {
    this.readyState = 3; // CLOSED
    this.emit('close', this.closedWith?.code ?? 1005, Buffer.alloc(0));
  }

  /** A text frame from the peer. */
  frame(text: string): void {
    this.emit('message', Buffer.from(text), false);
  }
}

export const REQ = { url: '/canvas', headers: {} } as unknown as IncomingMessage;
export const OK: SessionEvaluation = { ok: true, claims: {} as VerifiedSession };
export const REVOKED: SessionEvaluation = {
  ok: false,
  code: 'auth.revoked',
  message: 'session revoked',
};
export const UNAVAILABLE: SessionEvaluation = {
  ok: false,
  code: 'auth.unavailable',
  message: 'session check unavailable, try again',
};

export function session(expiresAt: number, sub = 'u1'): AuthenticatedChannelSession {
  return {
    token: `token-of-${sub}`,
    expiresAt,
    claims: {
      subject: sub,
      email: `${sub}@example.com`,
      displayName: sub,
      provider: 'local',
      expiresAt,
    },
  };
}

/** Let every pending promise continuation run (the mocked clock stays put). */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** A promise the test resolves by hand. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
