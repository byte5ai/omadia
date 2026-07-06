import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { describe, expect, it } from 'vitest';

import { useStickToBottom } from './useStickToBottom';

/**
 * jsdom does no layout, so scrollHeight/clientHeight/scrollTop are stubbed
 * manually. scrollTop is a getter/setter pair so assignments made by the
 * hook (`el.scrollTop = el.scrollHeight`) are observable in assertions.
 */
function createScrollEl(opts: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): HTMLDivElement {
  const el = document.createElement('div');
  let scrollTop = opts.scrollTop;
  Object.defineProperty(el, 'scrollHeight', {
    value: opts.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    value: opts.clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  return el;
}

function renderStickToBottom(el: HTMLDivElement) {
  const ref: RefObject<HTMLDivElement | null> = { current: el };
  return renderHook(
    ({ deps }: { deps: readonly unknown[] }) => useStickToBottom(ref, deps),
    { initialProps: { deps: [0] } },
  );
}

describe('useStickToBottom', () => {
  it('follows to the bottom on deps change while already at the bottom', () => {
    const el = createScrollEl({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const { result, rerender } = renderStickToBottom(el);

    expect(result.current.isAtBottom).toBe(true);

    act(() => {
      Object.defineProperty(el, 'scrollHeight', { value: 1200, configurable: true });
      rerender({ deps: [1] });
    });

    expect(el.scrollTop).toBe(1200);
  });

  it('detaches on scroll-up and stops force-scrolling on deps change', () => {
    const el = createScrollEl({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const { result, rerender } = renderStickToBottom(el);

    act(() => {
      el.scrollTop = 200; // scrolled well above the bottom threshold
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    act(() => {
      Object.defineProperty(el, 'scrollHeight', { value: 1400, configurable: true });
      rerender({ deps: [1] });
    });

    // Position held — the effect must not have forced scrollTop to scrollHeight.
    expect(el.scrollTop).toBe(200);
  });

  it('re-attaches once the user scrolls back within the bottom threshold', () => {
    const el = createScrollEl({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const { result, rerender } = renderStickToBottom(el);

    act(() => {
      el.scrollTop = 200; // mount already jumped to the bottom — scroll up explicitly
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    act(() => {
      el.scrollTop = 940; // within the 64px default tolerance of 1000
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    act(() => {
      Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true });
      rerender({ deps: [1] });
    });
    expect(el.scrollTop).toBe(1500);
  });

  it('scrollToBottom() forces re-attach and jumps regardless of prior detached state', () => {
    const el = createScrollEl({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
    const { result } = renderStickToBottom(el);

    act(() => {
      el.scrollTop = 100; // mount already jumped to the bottom — scroll up explicitly
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(false);

    act(() => {
      result.current.scrollToBottom();
    });

    expect(result.current.isAtBottom).toBe(true);
    expect(el.scrollTop).toBe(1000);
  });

  it('treats a short transcript with no scrollbar as always at the bottom', () => {
    const el = createScrollEl({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 });
    const { result, rerender } = renderStickToBottom(el);

    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isAtBottom).toBe(true);

    act(() => {
      Object.defineProperty(el, 'scrollHeight', { value: 260, configurable: true });
      rerender({ deps: [1] });
    });
    expect(el.scrollTop).toBe(260);
  });
});
