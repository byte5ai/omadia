/**
 * In-memory store for in-flight GitHub device-flow authorizations,
 * keyed by the operator's session `sub`.
 *
 * Holds the server-only `device_code` (the secret half — never sent to
 * the browser) plus the poll interval and an absolute expiry. One active
 * flow per operator (starting a new one replaces the old), so the map is
 * naturally bounded by the number of operators. Expiry is lazy (checked
 * on `get`), so no timers are needed.
 *
 * Single-process by design; becomes a shared table if the middleware ever
 * scales to >=2 instances. API stays the same.
 */

export interface DeviceFlow {
  sub: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  /** Epoch ms of the last poll — used to throttle polling server-side so
   *  our clients can't hammer GitHub faster than the advertised interval. */
  lastPolledAt: number;
}

export interface DeviceFlowStoreOptions {
  now?: () => number;
}

export class DeviceFlowStore {
  private readonly entries = new Map<string, DeviceFlow>();
  private readonly now: () => number;

  constructor(opts: DeviceFlowStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  start(
    sub: string,
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number,
  ): void {
    this.entries.set(sub, {
      sub,
      deviceCode,
      intervalMs: Math.max(1, intervalSec) * 1000,
      expiresAt: this.now() + expiresInSec * 1000,
      lastPolledAt: 0,
    });
  }

  /** Read a non-expired flow (deletes + returns undefined when expired). */
  get(sub: string): DeviceFlow | undefined {
    const flow = this.entries.get(sub);
    if (!flow) return undefined;
    if (this.now() > flow.expiresAt) {
      this.entries.delete(sub);
      return undefined;
    }
    return flow;
  }

  /** True when the caller is polling faster than the advertised interval. */
  isTooSoon(sub: string): boolean {
    const flow = this.entries.get(sub);
    if (!flow) return false;
    return this.now() - flow.lastPolledAt < flow.intervalMs * 0.8;
  }

  markPolled(sub: string): void {
    const flow = this.entries.get(sub);
    if (flow) flow.lastPolledAt = this.now();
  }

  bumpInterval(sub: string, intervalSec: number): void {
    const flow = this.entries.get(sub);
    if (flow) flow.intervalMs = Math.max(1, intervalSec) * 1000;
  }

  delete(sub: string): void {
    this.entries.delete(sub);
  }

  size(): number {
    return this.entries.size;
  }
}
