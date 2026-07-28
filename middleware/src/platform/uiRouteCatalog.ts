import type {
  ResolvedUiNavEntry,
  UiNavEntry,
  UiNavEntryInput,
  UiRouteDescriptor,
  UiRouteDescriptorInput,
} from '@omadia/plugin-api';

/** Default ordering weight for entries that don't specify one. */
const DEFAULT_ORDER = 100;

/** Nav labels are chrome, not content — long strings break the header. */
const MAX_LABEL_LENGTH = 40;

/**
 * Bounds on everything else a plugin supplies. The whole catalogue is
 * serialised into the root-layout RSC payload of every page, so an
 * accidental or hostile plugin must not be able to bloat it.
 */
const MAX_HREF_LENGTH = 256;
const MAX_NAV_ID_LENGTH = 64;
const MAX_CLUSTER_LENGTH = 64;
const MAX_LOCALES_PER_LABEL = 32;
const MAX_NAV_ENTRIES_PER_PLUGIN = 20;

const NAV_ID = /^[A-Za-z0-9._-]+$/;
const CLUSTER_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const LOCALE_CODE = /^[a-z]{2}(?:-[A-Za-z0-9]+)*$/;

/**
 * Characters permitted in a single href path segment — the RFC 3986
 * "unreserved" set. Deliberately excludes `%`, `?`, `#`, and `\`.
 */
const HREF_SEGMENT = /^[A-Za-z0-9\-._~]+$/;

/**
 * Reject control characters and bidirectional-formatting codepoints.
 *
 * A plugin label renders adjacent to core nav entries in the trusted
 * header, so an RTL override could visually reorder or spoof the labels
 * around it (Trojan-Source style). React escapes markup for us; it does
 * not defend against this.
 *
 * Written as a codepoint scan rather than a character-class regex so the
 * source stays pure ASCII — the ranges are easier to audit as numbers
 * than as invisible literals.
 */
function hasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f) return true; // C0 controls (incl. NUL, CR, LF)
    if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1 controls
    if (code === 0x061c) return true; // ARABIC LETTER MARK
    if (code === 0x200e || code === 0x200f) return true; // LRM / RLM
    if (code >= 0x202a && code <= 0x202e) return true; // bidi embed / override
    if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
    if (code >= 0x200b && code <= 0x200d) return true; // zero-width space/joiners
    if (code === 0x2060 || code === 0xfeff) return true; // word joiner / BOM
  }
  return false;
}

/**
 * An in-app path in *canonical* form.
 *
 * Validating the raw string is not enough: the shell decides that "core
 * destinations win" by comparing hrefs for equality, so any spelling that
 * a browser resolves to a core path but that does not string-match it
 * would slip past that rule. `/x/%2e%2e/admin`, `/admin/`, `/admin?a=1`
 * and `/admin#x` all navigate to Admin while comparing unequal to
 * `/admin`.
 *
 * Rather than canonicalising (and having to keep our normaliser in step
 * with the URL parser), accept only strings that are *already* canonical:
 * a leading `/`, non-empty unreserved-charset segments, no dot-segments,
 * no trailing slash, no query, no fragment, no percent-encoding. For that
 * subset, string equality and browser resolution agree.
 */
function assertInAppHref(
  context: string,
  href: unknown,
): asserts href is string {
  if (typeof href !== 'string' || href.length === 0) {
    throw new Error(`${context}: href must be a non-empty string`);
  }
  if (href.length > MAX_HREF_LENGTH) {
    throw new Error(
      `${context}: href exceeds ${String(MAX_HREF_LENGTH)} characters`,
    );
  }
  if (!href.startsWith('/')) {
    throw new Error(
      `${context}: href must be an in-app path starting with '/' (got '${href}')`,
    );
  }
  if (href === '/') return; // the root is canonical by definition
  for (const segment of href.slice(1).split('/')) {
    if (segment.length === 0) {
      throw new Error(
        `${context}: href must not contain an empty path segment — no '//', no trailing '/' (got '${href}')`,
      );
    }
    if (segment === '.' || segment === '..') {
      throw new Error(
        `${context}: href must not contain dot-segments (got '${href}')`,
      );
    }
    if (!HREF_SEGMENT.test(segment)) {
      throw new Error(
        `${context}: href segment '${segment}' has characters outside [A-Za-z0-9-._~] — query strings, fragments, percent-encoding and backslashes are not accepted`,
      );
    }
  }
}

/**
 * Validate a locale to label map and freeze a defensive copy. `en` is
 * required so every locale has a fallback; without it a plugin that ships
 * only `de` would render an empty nav entry for English operators.
 */
function normalizeLabels(
  context: string,
  label: unknown,
): Readonly<Record<string, string>> {
  if (typeof label !== 'object' || label === null || Array.isArray(label)) {
    throw new Error(`${context}: label must be an object of locale to string`);
  }
  const entries = Object.entries(label as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${context}: label must contain at least one locale`);
  }
  if (entries.length > MAX_LOCALES_PER_LABEL) {
    throw new Error(
      `${context}: label declares more than ${String(MAX_LOCALES_PER_LABEL)} locales`,
    );
  }
  const out: Record<string, string> = {};
  for (const [locale, value] of entries) {
    if (!LOCALE_CODE.test(locale)) {
      throw new Error(`${context}: '${locale}' is not a valid locale code`);
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `${context}: label['${locale}'] must be a non-empty string`,
      );
    }
    if (value.length > MAX_LABEL_LENGTH) {
      throw new Error(
        `${context}: label['${locale}'] exceeds ${MAX_LABEL_LENGTH} characters`,
      );
    }
    if (hasUnsafeChars(value)) {
      throw new Error(
        `${context}: label['${locale}'] contains control or bidirectional-formatting characters`,
      );
    }
    out[locale] = value;
  }
  if (out['en'] === undefined) {
    throw new Error(
      `${context}: label must include an 'en' entry as the fallback`,
    );
  }
  return Object.freeze(out);
}

/**
 * Resolve a label for a locale: exact match, then the base language
 * (`de-AT` to `de`), then `en`.
 */
function resolveLabel(
  label: Readonly<Record<string, string>>,
  locale: string,
): string {
  const exact = label[locale];
  if (exact !== undefined) return exact;
  const base = locale.split('-')[0];
  if (base !== undefined) {
    const byLanguage = label[base];
    if (byLanguage !== undefined) return byLanguage;
  }
  // normalizeLabels guarantees 'en' exists.
  return label['en'] as string;
}

/**
 * Kernel-side catalogue of plugin-contributed UI surfaces.
 *
 * Two related but distinct things live here, sharing one lifecycle:
 *
 *  1. **uiRoute descriptors** — plugin-served surfaces addressed relative
 *     to the plugin's `/p/<pluginId>` mount. Plugins register via
 *     `ctx.uiRoutes.register({routeId, path, title})`. Consumers:
 *       - channel-teams' `/p/channel-teams/hub` iterates `list()` to
 *         render clickable cards.
 *       - channel-teams' `/p/channel-teams/tab-config` queries `list()`
 *         to populate the Target-Route dropdown.
 *
 *  2. **nav entries** — entries in the operator web UI's top navigation,
 *     addressed by absolute in-app path. Plugins register via
 *     `ctx.uiRoutes.registerNav(...)`; `GET /api/v1/ui/navigation` serves
 *     them to the web-ui shell with labels already resolved for the
 *     requested locale.
 *
 * They are separate registrations because their `href`/`path` semantics
 * differ: a built-in package whose UI ships as compiled web-ui pages has
 * a nav entry and no uiRoute, while a plugin serving its own HTML has
 * both. Folding them into one descriptor would make one of the two path
 * fields a lie.
 *
 * Both call sites resolve the catalogue via `ctx.services.get<
 * UiRouteCatalog>('uiRouteCatalog')`. The kernel publishes the instance
 * during boot, before any plugin activates, so consumers never see an
 * undefined catalogue.
 *
 * Entries are keyed by (`pluginId`, `routeId`/`navId`). Re-registering
 * the same key throws — plugins must dispose their previous handle
 * before a hot-swap re-activates them, mirroring the route-registry
 * contract.
 *
 * `disposeBySource` is a fail-safe the kernel calls during plugin
 * deactivate — leaked dispose handles from a misbehaving plugin still
 * cannot outlive the plugin's lifecycle.
 */
export class UiRouteCatalog {
  private readonly entries = new Map<string, UiRouteDescriptor>();

  private readonly navEntries = new Map<string, UiNavEntry>();

  /**
   * Register a uiRoute descriptor for the given plugin. The pluginId
   * comes from the kernel-side caller (createPluginContext fills it
   * in from the activating plugin's agentId) — plugins cannot spoof
   * another plugin's surfaces.
   */
  register(pluginId: string, input: UiRouteDescriptorInput): () => void {
    if (typeof pluginId !== 'string' || pluginId.length === 0) {
      throw new Error(
        'UiRouteCatalog.register: pluginId must be a non-empty string',
      );
    }
    if (typeof input.routeId !== 'string' || input.routeId.length === 0) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}): routeId must be a non-empty string`,
      );
    }
    if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}/${input.routeId}): path must start with '/'`,
      );
    }
    if (typeof input.title !== 'string' || input.title.length === 0) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}/${input.routeId}): title must be a non-empty string`,
      );
    }
    const key = `${pluginId}::${input.routeId}`;
    if (this.entries.has(key)) {
      throw new Error(
        `UiRouteCatalog: descriptor '${key}' is already registered — dispose the previous registration before re-registering (hot-swap leak)`,
      );
    }
    const descriptor: UiRouteDescriptor = {
      pluginId,
      routeId: input.routeId,
      path: input.path,
      title: input.title,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    this.entries.set(key, descriptor);
    return () => {
      // Identity-keyed dispose: only delete if the stored entry is
      // still THIS descriptor. A later registration that replaced
      // this slot must not be dropped by a stale dispose closure
      // from the previous owner.
      if (this.entries.get(key) === descriptor) {
        this.entries.delete(key);
      }
    };
  }

  /**
   * Register a navigation entry for the given plugin.
   *
   * Every field is treated as untrusted input: `href` is confined to
   * in-app paths and labels are length- and charset-checked, because
   * both are rendered inside the shell's own header where an operator
   * has every reason to trust what they see.
   */
  registerNav(pluginId: string, input: UiNavEntryInput): () => void {
    if (typeof pluginId !== 'string' || pluginId.length === 0) {
      throw new Error(
        'UiRouteCatalog.registerNav: pluginId must be a non-empty string',
      );
    }
    if (
      typeof input.navId !== 'string' ||
      input.navId.length > MAX_NAV_ID_LENGTH ||
      !NAV_ID.test(input.navId)
    ) {
      throw new Error(
        `UiRouteCatalog.registerNav(${pluginId}): navId must match ${String(NAV_ID)} and be at most ${String(MAX_NAV_ID_LENGTH)} characters`,
      );
    }
    const context = `UiRouteCatalog.registerNav(${pluginId}/${input.navId})`;
    assertInAppHref(context, input.href);
    if (
      input.cluster !== undefined &&
      (input.cluster.length > MAX_CLUSTER_LENGTH ||
        !CLUSTER_KEY.test(input.cluster))
    ) {
      throw new Error(`${context}: cluster must match ${String(CLUSTER_KEY)}`);
    }
    if (input.order !== undefined && !Number.isInteger(input.order)) {
      throw new Error(`${context}: order must be a finite integer`);
    }
    const label = normalizeLabels(context, input.label);

    const key = `${pluginId}::${input.navId}`;
    if (this.navEntries.has(key)) {
      throw new Error(
        `UiRouteCatalog: nav entry '${key}' is already registered — dispose the previous registration before re-registering (hot-swap leak)`,
      );
    }
    let owned = 0;
    for (const existing of this.navEntries.values()) {
      if (existing.pluginId === pluginId) owned += 1;
    }
    if (owned >= MAX_NAV_ENTRIES_PER_PLUGIN) {
      throw new Error(
        `${context}: a plugin may contribute at most ${String(MAX_NAV_ENTRIES_PER_PLUGIN)} nav entries`,
      );
    }
    const entry: UiNavEntry = {
      pluginId,
      navId: input.navId,
      href: input.href,
      label,
      ...(input.cluster !== undefined ? { cluster: input.cluster } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    this.navEntries.set(key, entry);
    return () => {
      if (this.navEntries.get(key) === entry) {
        this.navEntries.delete(key);
      }
    };
  }

  /**
   * Sorted snapshot of every active descriptor. Returns a fresh array
   * each call — safe for consumers to filter/sort further.
   * Sort: (order ?? 100) ASC, then pluginId ASC, then routeId ASC.
   */
  list(): readonly UiRouteDescriptor[] {
    return [...this.entries.values()].sort((a, b) => {
      const oa = a.order ?? DEFAULT_ORDER;
      const ob = b.order ?? DEFAULT_ORDER;
      if (oa !== ob) return oa - ob;
      if (a.pluginId !== b.pluginId) {
        return a.pluginId.localeCompare(b.pluginId);
      }
      return a.routeId.localeCompare(b.routeId);
    });
  }

  /**
   * Sorted nav entries with labels resolved for `locale`. This is what
   * `GET /api/v1/ui/navigation` returns: the browser never sees the
   * per-locale map, so the shell has no second message catalogue to
   * merge and no locale negotiation of its own to get wrong.
   * Sort: order ASC, then pluginId ASC, then navId ASC.
   */
  listNav(locale: string): readonly ResolvedUiNavEntry[] {
    return [...this.navEntries.values()]
      .map((entry): ResolvedUiNavEntry => {
        const order = entry.order ?? DEFAULT_ORDER;
        return {
          pluginId: entry.pluginId,
          navId: entry.navId,
          href: entry.href,
          order,
          label: resolveLabel(entry.label, locale),
          ...(entry.cluster !== undefined ? { cluster: entry.cluster } : {}),
        };
      })
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.pluginId !== b.pluginId) {
          return a.pluginId.localeCompare(b.pluginId);
        }
        return a.navId.localeCompare(b.navId);
      });
  }

  /**
   * Drop every entry registered by the given plugin — both uiRoute
   * descriptors and nav entries. Used by the kernel on plugin deactivate
   * as a fail-safe, so plugins whose close() forgets to call its
   * per-registration dispose handle still cannot leak into the
   * catalogue. Returns the total count dropped (0 when nothing matched).
   */
  disposeBySource(pluginId: string): number {
    let count = 0;
    for (const [key, descriptor] of this.entries) {
      if (descriptor.pluginId === pluginId) {
        this.entries.delete(key);
        count += 1;
      }
    }
    for (const [key, entry] of this.navEntries) {
      if (entry.pluginId === pluginId) {
        this.navEntries.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** Diagnostic: active uiRoute descriptor count. */
  size(): number {
    return this.entries.size;
  }

  /** Diagnostic: active nav entry count. */
  navSize(): number {
    return this.navEntries.size;
  }
}
