/**
 * Public surface of `@omadia/plugin-privacy-guard` — Privacy Shield v4
 * Data-Plane Boundary.
 *
 * The plugin's primary export is `activate` — invoked by the harness
 * runtime when an operator installs the plugin. `createPrivacyGuardService`
 * is re-exported for tests. The v4 engine modules (Dataset Store, Shape
 * Classifier, Digest, Verb API, Materializer) are imported directly from
 * their `./v4/*` paths by tests and have no public re-export here.
 */

export { activate } from './plugin.js';
export type { PrivacyGuardPluginHandle } from './plugin.js';

export { createPrivacyGuardService } from './service.js';

// #361 — C1 transformer detector (GLiNER sidecar client), re-exported for
// tests and for hosts that wire the seam manually.
export { createC1HttpDetector, C1_DETECTOR_ID } from './c1Detector.js';
export type { C1HttpDetectorOptions } from './c1Detector.js';
