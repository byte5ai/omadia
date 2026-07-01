import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; stub it so components that observe element
// size (e.g. MarkdownTable's overflow detection) can mount in tests.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
