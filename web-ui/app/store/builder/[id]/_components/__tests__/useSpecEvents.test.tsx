import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpecBusEvent } from '../../../../../_lib/builderTypes';
import { SPEC_BUS_EVENT_TYPES, useSpecEvents } from '../useSpecEvents';

/**
 * #1730 — the server sends every spec-bus event as a named SSE event, and
 * `EventSource` hands a named event only to a listener for that name. Pin
 * that the hook listens for every type, in particular the three the
 * workspace handled but never received.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

describe('useSpecEvents', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = null;
  });

  it('lists the smoke, auto-fix and agent-stuck events', () => {
    expect(SPEC_BUS_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'runtime_smoke_status',
        'auto_fix_status',
        'agent_stuck',
        'build_status',
      ]),
    );
  });

  it('registers a listener for every spec-bus event type', () => {
    renderHook(() => useSpecEvents('d1', () => {}));
    const source = FakeEventSource.last;
    expect(source).not.toBeNull();
    for (const type of SPEC_BUS_EVENT_TYPES) {
      expect(source?.listeners.get(type)?.length, type).toBe(1);
    }
  });

  it('delivers runtime_smoke_status and auto_fix_status to the handler', () => {
    const seen: SpecBusEvent[] = [];
    renderHook(() => useSpecEvents('d1', (ev) => seen.push(ev)));
    const source = FakeEventSource.last;
    source?.emit('runtime_smoke_status', {
      type: 'runtime_smoke_status',
      phase: 'ok',
      buildN: 13,
    });
    source?.emit('auto_fix_status', {
      type: 'auto_fix_status',
      phase: 'triggered',
      kind: 'build_failed',
      buildN: 14,
    });
    expect(seen.map((e) => e.type)).toEqual([
      'runtime_smoke_status',
      'auto_fix_status',
    ]);
  });

  it('removes every listener on unmount', () => {
    const { unmount } = renderHook(() => useSpecEvents('d1', () => {}));
    const source = FakeEventSource.last;
    unmount();
    for (const type of SPEC_BUS_EVENT_TYPES) {
      expect(source?.listeners.get(type)?.length ?? 0, type).toBe(0);
    }
    expect(source?.readyState).toBe(2);
  });
});
