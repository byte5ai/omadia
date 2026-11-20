import type { PluginCatalogEntryDto } from './agents';

/**
 * The channel types an operator can pick (default-agent table, bindings,
 * routing tester): exactly the ones the server names for the installed
 * channel plugins (`discord`, `teams`). A type is never guessed from a plugin
 * id: `@omadia/channel-discord` is not a channel type, and a guess offered
 * it as one (the S6 rollout finding).
 */
export function channelTypesOfCatalog(catalog: readonly PluginCatalogEntryDto[] | null | undefined): string[] {
  return Array.from(
    new Set(
      (catalog ?? [])
        .filter((p) => p.kind === 'channel')
        .flatMap((p) => p.channel_types ?? [])
        .filter((t) => typeof t === 'string' && t.trim() !== ''),
    ),
  ).sort();
}
