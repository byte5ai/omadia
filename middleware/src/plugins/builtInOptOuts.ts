import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * #1481 — built-in plugins the operator uninstalled on purpose.
 *
 * Built-ins ship inside the image and `bootstrapBuiltInPackages` seeds every
 * one that is missing from the registry. Before this store, an uninstall
 * therefore lasted until the next restart: the entry was gone, so the seeder
 * put it back with manifest defaults. The uninstall now records the id here,
 * the boot seeders skip recorded ids, and installing the plugin again (store,
 * profile apply) clears the mark.
 *
 * Lives next to `installed.json` (same volume, same backup set) as its own
 * file rather than inside the registry: the registry holds INSTALLED entries,
 * and every reader of it (store, profiles, bundles, readiness) would otherwise
 * have to learn to skip a second kind of record.
 */
export interface BuiltInOptOutStore {
  has(pluginId: string): boolean;
  list(): readonly string[];
  /** Record an operator uninstall. Idempotent. */
  add(pluginId: string): Promise<void>;
  /** Forget the mark (reinstall). Idempotent. */
  remove(pluginId: string): Promise<void>;
}

interface OptOutFile {
  version: 1;
  /** Plugin id → ISO8601 of the uninstall. */
  uninstalled: Record<string, string>;
}

/**
 * #1481 — memory, knowledge-graph, embeddings and the orchestrator are
 * selected by the boot from the environment (`bootstrap*FromEnv` in `bootstrap.ts`): the host
 * needs them to run, so an operator uninstall of one of them does NOT stick —
 * the next boot installs the selected provider again. The store tells the
 * operator so in the uninstall dialog; every other built-in stays uninstalled.
 */
export const BOOT_MANAGED_BUILT_IN_IDS: ReadonlySet<string> = new Set([
  '@omadia/orchestrator',
  '@omadia/memory',
  '@omadia/memory-postgres',
  '@omadia/embeddings',
  '@omadia/knowledge-graph-inmemory',
  '@omadia/knowledge-graph-neon',
]);

export const BUILT_IN_OPT_OUTS_FILENAME = 'builtin-uninstalls.json';

/** The opt-out file that belongs to a given `installed.json` path. */
export function builtInOptOutsPathFor(installedRegistryPath: string): string {
  return path.join(path.dirname(installedRegistryPath), BUILT_IN_OPT_OUTS_FILENAME);
}

export class FileBuiltInOptOutStore implements BuiltInOptOutStore {
  private entries = new Map<string, string>();

  constructor(private readonly filePath: string) {}

  /**
   * Never throws for an unreadable file: this is a preference list, and a
   * broken one must not stop the boot. The file is moved aside to
   * `<file>.corrupt` (kept for the operator) and the store starts empty, i.e.
   * built-ins are seeded as before #1481.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          `[builtin-uninstalls] cannot read ${this.filePath} — starting without uninstall marks:`,
          err instanceof Error ? err.message : err,
        );
      }
      this.entries = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as OptOutFile;
      if (parsed.version !== 1 || typeof parsed.uninstalled !== 'object') {
        throw new Error(`unknown file version: ${String(parsed.version)}`);
      }
      this.entries = new Map(Object.entries(parsed.uninstalled ?? {}));
    } catch (err) {
      const aside = `${this.filePath}.corrupt`;
      console.error(
        `[builtin-uninstalls] ${this.filePath} is unreadable (${err instanceof Error ? err.message : String(err)}) — moved to ${aside}, starting without uninstall marks`,
      );
      await fs.rename(this.filePath, aside).catch(() => undefined);
      this.entries = new Map();
    }
  }

  has(pluginId: string): boolean {
    return this.entries.has(pluginId);
  }

  list(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  async add(pluginId: string): Promise<void> {
    if (this.entries.has(pluginId)) return;
    this.entries.set(pluginId, new Date().toISOString());
    await this.persist();
  }

  async remove(pluginId: string): Promise<void> {
    if (!this.entries.delete(pluginId)) return;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const body: OptOutFile = {
      version: 1,
      uninstalled: Object.fromEntries(this.entries),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Unique per write: two concurrent requests must not rename the same tmp.
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

/** In-memory variant for tests and hosts without a data volume. */
export class InMemoryBuiltInOptOutStore implements BuiltInOptOutStore {
  private readonly ids = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const id of initial) this.ids.add(id);
  }

  has(pluginId: string): boolean {
    return this.ids.has(pluginId);
  }

  list(): readonly string[] {
    return [...this.ids].sort();
  }

  async add(pluginId: string): Promise<void> {
    this.ids.add(pluginId);
  }

  async remove(pluginId: string): Promise<void> {
    this.ids.delete(pluginId);
  }
}
