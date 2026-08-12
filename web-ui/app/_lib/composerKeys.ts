import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Shared "does this keystroke send the message?" predicate for every chat
 * composer in the app (main chat, conductor, builder intake/chat/preview).
 *
 * Two bugs motivated pulling this out of the individual panes:
 *
 *   1. The main chat composer only accepted ⌘/Ctrl+↵, so plain Enter did
 *      nothing at all (OM-21/37) while the four other composers already used
 *      the plain-Enter convention. One predicate keeps them from drifting again.
 *   2. None of the five handled IME composition. While a Japanese/Chinese/
 *      Korean candidate window is open, Enter *commits the candidate* — it must
 *      not send. `KeyboardEvent.isComposing` covers Chrome/Firefox; Safari
 *      historically reports `keyCode === 229` during composition without ever
 *      setting `isComposing`, so both are checked.
 *
 * Shift+Enter and Alt+Enter fall through untouched so the browser inserts its
 * native newline. ⌘/Ctrl+Enter stays an accepted alias — it was the only
 * documented shortcut in the main chat, and existing muscle memory should not
 * break just because plain Enter now works too.
 */
export function isSendKey(e: ReactKeyboardEvent): boolean {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey || e.altKey) return false;
  const native = e.nativeEvent as KeyboardEvent | undefined;
  if (native?.isComposing) return false;
  // Safari fires keyCode 229 during composition without setting isComposing.
  if (native?.keyCode === 229) return false;
  return true;
}
