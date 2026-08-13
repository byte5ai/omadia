import { describe, expect, it } from 'vitest';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { isSendKey } from '../composerKeys';

/**
 * The predicate is deliberately dumb, but it guards two regressions that are
 * invisible to a typecheck: plain Enter must send (OM-21/37) and an in-flight
 * IME composition must never be mistaken for a send.
 */
type NativeOverrides = {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
};

function keyEvent(
  key: string,
  modifiers: Partial<
    Pick<ReactKeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>
  > = {},
  native: NativeOverrides = {},
): ReactKeyboardEvent {
  return {
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...modifiers,
    nativeEvent: { isComposing: false, keyCode: 13, ...native },
  } as unknown as ReactKeyboardEvent;
}

describe('isSendKey', () => {
  it('treats plain Enter as a send', () => {
    expect(isSendKey(keyEvent('Enter'))).toBe(true);
  });

  it('does not send on Shift+Enter (native newline)', () => {
    expect(isSendKey(keyEvent('Enter', { shiftKey: true }))).toBe(false);
  });

  it('does not send on Alt+Enter', () => {
    expect(isSendKey(keyEvent('Enter', { altKey: true }))).toBe(false);
  });

  it('does not send while an IME composition is active', () => {
    expect(isSendKey(keyEvent('Enter', {}, { isComposing: true }))).toBe(false);
  });

  it('does not send on the Safari composition keyCode 229', () => {
    expect(isSendKey(keyEvent('Enter', {}, { keyCode: 229 }))).toBe(false);
  });

  it('keeps Cmd+Enter as an accepted alias', () => {
    expect(isSendKey(keyEvent('Enter', { metaKey: true }))).toBe(true);
  });

  it('keeps Ctrl+Enter as an accepted alias', () => {
    expect(isSendKey(keyEvent('Enter', { ctrlKey: true }))).toBe(true);
  });

  it('ignores every other key', () => {
    expect(isSendKey(keyEvent('a'))).toBe(false);
    expect(isSendKey(keyEvent('Escape'))).toBe(false);
  });
});
