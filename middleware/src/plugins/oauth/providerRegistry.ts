/**
 * Registry of OAuth-provider factories (HANDOFF §5.3).
 *
 * Boot-time: each integration plugin (e.g. `de.byte5.integration.microsoft365`)
 * registers a factory under its provider-id. The factory takes a config
 * payload — for v1 this is the integration-plugin's installed config —
 * and returns a concrete `PluginOAuthProvider`.
 *
 * Install-route: when an oauth-field's manifest says `provider:
 * microsoft365`, the route looks up the factory, fetches the integration
 * config from the dependency-graph, and instantiates a provider for THIS
 * job. No global mutable state, no provider singletons that capture stale
 * config.
 *
 * The registry has no knowledge of any specific provider — same
 * design-stance as `auth/providerRegistry.ts` (login providers).
 */

import type { PluginOAuthProvider, ProviderFactory } from './types.js';

export class OAuthProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(providerId: string, factory: ProviderFactory): void {
    if (this.factories.has(providerId)) {
      throw new Error(
        `oauth-provider id collision: ${providerId} already registered`,
      );
    }
    this.factories.set(providerId, factory);
  }

  has(providerId: string): boolean {
    return this.factories.has(providerId);
  }

  /** Build a concrete provider instance for a single install-job. The
   *  config payload must match what the registered factory expects —
   *  the registry stays type-erased to keep multi-provider extensibility
   *  open without generic gymnastics on the registry itself. */
  instantiate(providerId: string, config: unknown): PluginOAuthProvider {
    const factory = this.factories.get(providerId);
    if (!factory) {
      throw new Error(`oauth-provider not registered: ${providerId}`);
    }
    return factory(config);
  }

  /** Sorted list of registered provider-ids — for diagnostics + the
   *  setup-drawer's "supported providers" hint. */
  list(): string[] {
    return Array.from(this.factories.keys()).sort();
  }
}
