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

// jsdom DECLARES matchMedia but leaves it unimplemented, so `'matchMedia' in
// window` is true while the value is not callable — check callability. A
// component that reads the OS colour
// scheme (PluginUiFrame) throws on mount without it. Reports "light" so a test
// asserting appearance-dependent output has a stated default rather than an
// implicit one; a test that cares can override `window.matchMedia` itself.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
