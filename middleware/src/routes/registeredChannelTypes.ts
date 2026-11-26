/**
 * #1879 — the channel types this instance routes, as the operator routes
 * accept them.
 *
 * The same list the dashboard offers (`GET /plugin-catalog` → `channel_types`,
 * read by `web-ui/app/_lib/channelTypes.ts`): the types every installed
 * channel plugin acts for. A binding under any other type never matches a
 * turn (the agents page once stored `channel-api` for the API channel, whose
 * type is `@omadia/channel-api`), so the binding and routing-tester routes
 * refuse it instead of storing or answering for it.
 */

interface CatalogLike {
  list(): ReadonlyArray<{ readonly plugin: { readonly id: string; readonly kind: string; readonly is_reference_only?: boolean } }>;
}

interface InstalledLike {
  list(): ReadonlyArray<{ readonly id: string }>;
}

export interface RegisteredChannelTypeSources {
  readonly catalog: CatalogLike | undefined;
  readonly installed: InstalledLike | undefined;
  readonly channelTypesOf: ((pluginId: string) => readonly string[]) | undefined;
}

/**
 * The channel types of the installed channel plugins, or `undefined` when
 * the router was mounted without the catalog wiring (tests, minimal mounts):
 * then nothing is known and the caller does not check.
 */
export function registeredChannelTypes(sources: RegisteredChannelTypeSources): ReadonlySet<string> | undefined {
  const { catalog, installed, channelTypesOf } = sources;
  if (!catalog || !installed || !channelTypesOf) return undefined;
  const installedIds = new Set(installed.list().map((e) => e.id));
  return new Set(
    catalog
      .list()
      .filter((e) => e.plugin.kind === 'channel' && e.plugin.is_reference_only !== true)
      .filter((e) => installedIds.has(e.plugin.id))
      .flatMap((e) => channelTypesOf(e.plugin.id)),
  );
}

/** The `400 unknown_channel_type` body: what was sent and what is accepted. */
export function unknownChannelTypeBody(
  channelType: string,
  known: ReadonlySet<string>,
): { error: 'unknown_channel_type'; message: string; channel_type: string; known_channel_types: string[] } {
  const knownList = [...known].sort();
  return {
    error: 'unknown_channel_type',
    message: `no installed channel uses the channel type '${channelType}'${knownList.length > 0 ? `; known: ${knownList.join(', ')}` : '; no channel plugin is installed'}`,
    channel_type: channelType,
    known_channel_types: knownList,
  };
}
