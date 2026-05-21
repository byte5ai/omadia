/**
 * A trivial, contract-complete reference plugin. It exists to prove
 * the `@omadia/plugin-api` lifecycle contract is implementable and
 * sufficient on its own — and to give the Agent Builder (US2) and the
 * plugin migration (US3) a known-good shape to build against.
 *
 * It creates one real active handle (an interval) in `init()` and
 * releases it in `dispose()`, so the mandatory dispose-roundtrip test
 * exercises a genuine resource lifecycle, not a no-op.
 */

import type { Plugin, PluginScope } from '../src/index.js';

/** Reference plugin configuration. */
export interface ReferenceConfig {
  readonly greeting?: string;
}

/** Reference plugin runtime handle. */
export interface ReferenceHandle {
  readonly heartbeat: NodeJS.Timeout;
  readonly greeting: string;
}

export const referencePlugin: Plugin<ReferenceConfig, ReferenceHandle> = {
  manifest: {
    id: 'reference-plugin',
    name: 'Reference Plugin',
    version: '1.0.0',
    multiInstance: true,
    memoryNamespaces: [],
    requiredCapabilities: [],
    privacyClass: 'strict',
  },

  async init(
    scope: PluginScope,
    config: ReferenceConfig,
  ): Promise<ReferenceHandle> {
    const greeting = config.greeting ?? 'hello';
    const heartbeat = setInterval(() => {}, 60_000);
    scope.registerDisposable({ dispose: () => clearInterval(heartbeat) });
    scope.logger.info('reference plugin initialised', { greeting });
    return { heartbeat, greeting };
  },

  async dispose(handle: ReferenceHandle): Promise<void> {
    clearInterval(handle.heartbeat);
  },

  async reconfigure(
    handle: ReferenceHandle,
    next: ReferenceConfig,
  ): Promise<ReferenceHandle> {
    return { heartbeat: handle.heartbeat, greeting: next.greeting ?? 'hello' };
  },
};
