import type {
  ChannelKeyDirectory,
  ChannelKeyEntry,
} from '@omadia/channel-sdk';

/**
 * Aggregator over every channel-plugin's `ChannelKeyDirectory`. One
 * singleton per process; populated by `channelRegistry.activate(...)` when
 * a channel plugin's `register()` (or its install handler) hands a
 * directory to the kernel. Read by `/api/v1/operator/channels`.
 *
 * Why not a `serviceRegistry.provide('channelKeyDirectory@1', ...)`-style
 * single capability: there is one directory PER channel type, not one
 * total. The ServiceRegistry is keyed by capability name; the second
 * plugin to register would silently replace the first. A dedicated
 * registry preserves the union and lets each entry carry its
 * `originPluginId` for the dashboard's "via …" hint.
 *
 * Per-plugin failures (offline backend, missing config) are isolated:
 * `listAll()` catches per-plugin throws and degrades to "no entries from
 * this plugin" rather than failing the whole page.
 */
export class ChannelDirectoryRegistry {
  private readonly directories = new Map<string, ChannelKeyDirectory>();

  /** Plugin handle string for telemetry. */
  constructor(
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () =>
      undefined,
  ) {}

  /**
   * Register a directory contribution. If the same channel-type is
   * already registered (e.g. two Teams instances), the new one replaces
   * the old — channel types are unique by design (one plugin owns the
   * routing for "teams", another can own "telegram", but two plugins
   * cannot both own "teams" since `channel_bindings.channel_type` is the
   * routing selector).
   */
  register(directory: ChannelKeyDirectory): void {
    const before = this.directories.get(directory.channelType);
    this.directories.set(directory.channelType, directory);
    this.log(
      before
        ? `channelDirectoryRegistry: replaced directory for ${directory.channelType}`
        : `channelDirectoryRegistry: registered directory for ${directory.channelType}`,
      {
        channelType: directory.channelType,
        originPluginId: directory.originPluginId,
        replaced: !!before,
      },
    );
  }

  /**
   * Drop a directory contribution. Called when a channel plugin
   * deactivates (uninstall, restart with new config). Idempotent — a
   * second unregister for the same type is a no-op.
   */
  unregister(channelType: string): void {
    const removed = this.directories.delete(channelType);
    if (removed) {
      this.log(`channelDirectoryRegistry: unregistered ${channelType}`, {
        channelType,
      });
    }
  }

  /** Number of known channel types. */
  size(): number {
    return this.directories.size;
  }

  /** Snapshot of currently-registered channel types. */
  types(): readonly string[] {
    return Array.from(this.directories.keys()).sort();
  }

  /**
   * Walk every registered directory and return the union of their keys.
   * Each entry is annotated with `channelType` (for binding lookup) and
   * `originPluginId` (for the dashboard's per-row hint).
   *
   * Per-plugin failures are caught + logged. The page degrades to "fewer
   * entries" rather than "page broken" if one plugin's directory throws.
   */
  async listAll(): Promise<readonly EnrichedChannelKey[]> {
    const out: EnrichedChannelKey[] = [];
    for (const directory of this.directories.values()) {
      try {
        const entries = await directory.listKeys();
        for (const entry of entries) {
          out.push({
            channelType: directory.channelType,
            originPluginId: directory.originPluginId,
            key: entry.key,
            label: entry.label,
            ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
          });
        }
      } catch (err) {
        this.log(
          `channelDirectoryRegistry: ${directory.channelType} listKeys() FAILED — skipping`,
          {
            channelType: directory.channelType,
            originPluginId: directory.originPluginId,
            error: (err as Error).message,
          },
        );
      }
    }
    out.sort((a, b) => {
      const t = a.channelType.localeCompare(b.channelType);
      return t !== 0 ? t : a.label.localeCompare(b.label);
    });
    return out;
  }
}

/** A channel-key enriched with its origin metadata. */
export interface EnrichedChannelKey extends ChannelKeyEntry {
  readonly channelType: string;
  readonly originPluginId: string;
}
