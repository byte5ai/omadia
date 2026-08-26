import type { MemoryStore } from '@omadia/plugin-api';

/**
 * W5 — `promoteMemory`: the explicit operator act that moves knowledge between
 * an agent's memory tiers (design spec #870 §6, epic #860).
 *
 * Context-scoped memory keeps what an agent learns in team A out of team B.
 * Sharing across that line is therefore never implicit — it is this one
 * operator action, and it is audited three ways (§6):
 *
 *   (a) an append-only JSONL line in {@link PROMOTION_AUDIT_PATH} — inside the
 *       shared `core` namespace, so agents can read it while the operator has
 *       it in one central place;
 *   (b) provenance frontmatter (`promoted-from` / `promoted-by` /
 *       `promoted-at`) in every promoted markdown file;
 *   (c) a structured `[security-audit]` log line, the idiom
 *       `buildOrchestrator.ts` already uses (there is no central audit bus).
 *
 * Like {@link file://./memoryPurge.ts}, this runs on the ROOT (undecorated)
 * `MemoryStore`: promotion crosses the scopes a `ScopedMemoryStore` enforces,
 * so it cannot run inside one. It stays backend-agnostic for the same reason
 * purge does — only the existing `list` / `fileExists` / `directoryExists` /
 * `readFile` / `writeFile` / `delete` surface is used, so filesystem and
 * Postgres stores work unchanged (spec §7: no schema change).
 *
 * Physical layout:
 *
 *   /memories/orchestrators/<slug>/...                 — agent tier
 *   /memories/contexts/<slug>/team/<ctxKey>/...        — team tier
 *   /memories/contexts/<slug>/channel/<ctxKey>/...     — channel tier
 *   /memories/contexts/<slug>/user/<ctxKey>/...        — user tier
 *
 * Both roots are built from the SAME `agentSlug`, so promotion is structurally
 * per-agent (spec §9: never cross-agent). Anything that would escape that
 * agent's two roots — a `..` segment, a `/` inside a context key, an absolute
 * path — is REJECTED, never clamped.
 *
 * `<ctxKey>` is derived by `memoryContextKey` (channel SDK) at the caller /
 * route boundary and never re-derived here; this service validates the shape
 * it must have (see {@link CTX_KEY_RE}).
 */

/** Copy leaves the source in place; move removes it after every write lands. */
export type PromoteMode = 'copy' | 'move';

/** Context tiers a promotion can read from. */
export type PromoteSourceAxis = 'team' | 'channel' | 'user';

/** Tiers a promotion can write to (spec §6: upward, plus downward "seed"). */
export type PromoteTargetTier = 'agent' | 'team';

export interface PromoteSource {
  readonly axis: PromoteSourceAxis;
  /** Context key as produced by `memoryContextKey`. Never contains `:` or `/`. */
  readonly ctxKey: string;
  /** File or directory, RELATIVE to the tier root. */
  readonly path: string;
}

export interface PromoteTarget {
  readonly tier: PromoteTargetTier;
  /** Required for `tier: 'team'`; rejected for `tier: 'agent'`. */
  readonly ctxKey?: string;
  /** Relative target path. Defaults to the source path. */
  readonly path?: string;
}

export interface PromoteRequest {
  readonly agentSlug: string;
  readonly source: PromoteSource;
  readonly target: PromoteTarget;
  readonly mode: PromoteMode;
  /** Operator identity from the session. Recorded in every audit surface. */
  readonly actor: string;
  readonly reason?: string;
  /**
   * Allow overwriting files that already exist at the target. Default `false`:
   * a promotion refuses rather than silently clobbering existing knowledge.
   */
  readonly overwrite?: boolean;
}

export interface PromotedFile {
  readonly sourcePath: string;
  readonly targetPath: string;
  /** UTF-8 byte length of the content written to the target (frontmatter included). */
  readonly bytes: number;
  /** Whether provenance frontmatter was added (markdown-ish files only). */
  readonly provenance: boolean;
}

export interface PromoteReceipt {
  readonly ts: string;
  readonly agentSlug: string;
  readonly actor: string;
  readonly mode: PromoteMode;
  /** Absolute source root — the file or subtree that was promoted. */
  readonly sourcePath: string;
  /** Absolute target root. */
  readonly targetPath: string;
  readonly reason?: string;
  /** Sum of {@link PromotedFile.bytes}. */
  readonly bytes: number;
  readonly files: readonly PromotedFile[];
  readonly auditPath: string;
}

export interface PromoteOptions {
  /** Injectable clock — tests pin the timestamp. */
  readonly now?: () => Date;
  /** Injectable `[security-audit]` sink. Defaults to `console.warn`. */
  readonly securityAuditSink?: (event: Record<string, unknown>) => void;
}

const MEMORIES_ROOT = '/memories';
const AGENT_TIER_ROOT = `${MEMORIES_ROOT}/orchestrators`;
const CONTEXTS_ROOT = `${MEMORIES_ROOT}/contexts`;

/** Central promotion audit log (spec §6a). Shared `core` namespace. */
export const PROMOTION_AUDIT_PATH = `${MEMORIES_ROOT}/core/audit/memory-promotions.jsonl`;

/** Same shape `chat.ts` already enforces for an agent slug. */
const AGENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Shape of a `memoryContextKey` result: `<channelType>~<safeKey>`, where the
 * safe alphabet excludes `:` (which would break the scope-pattern grammar) and
 * `/` (which would leave the tier root).
 */
const CTX_KEY_RE = /^[a-z0-9_-]{1,64}~[a-z0-9_-]{1,128}$/i;

/** Extensions that carry YAML frontmatter without being corrupted by it. */
const FRONTMATTER_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.mdx', '.txt'];

/** Error carrying a machine-readable `code`, matching the `memoryPurge` idiom. */
function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function assertRelativePath(raw: string, label: string): string {
  const path = raw.trim();
  if (path.length === 0) throw fail('invalid_path', `${label} path must not be empty`);
  if (path.startsWith('/')) throw fail('invalid_path', `${label} path must be relative: ${raw}`);
  if (path.includes('\\')) throw fail('invalid_path', `${label} path contains a backslash: ${raw}`);
  if (/\s/.test(path)) throw fail('invalid_path', `${label} path contains whitespace: ${raw}`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) throw fail('invalid_path', `${label} path has an empty segment: ${raw}`);
    if (segment === '.' || segment === '..') {
      throw fail('invalid_path', `${label} path contains a traversal segment: ${raw}`);
    }
  }
  return segments.join('/');
}

function assertCtxKey(raw: string, label: string): string {
  const key = raw.trim();
  if (!CTX_KEY_RE.test(key)) {
    throw fail('invalid_ctx_key', `${label} context key is not a memoryContextKey: ${raw}`);
  }
  return key;
}

function assertAgentSlug(raw: string): string {
  const slug = raw.trim();
  if (!AGENT_SLUG_RE.test(slug)) throw fail('invalid_agent_slug', `Invalid agent slug: ${raw}`);
  return slug;
}

/** Defence in depth: the built path must live under the agent's own root. */
function assertInside(root: string, absolute: string, code: string): string {
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw fail(code, `Path leaves the agent's tier root: ${absolute}`);
  }
  return absolute;
}

function contextTierRoot(agentSlug: string, axis: PromoteSourceAxis, ctxKey: string): string {
  return `${CONTEXTS_ROOT}/${agentSlug}/${axis}/${ctxKey}`;
}

function agentTierRoot(agentSlug: string): string {
  return `${AGENT_TIER_ROOT}/${agentSlug}`;
}

/** Every root this agent's promotions may write to — nothing else is reachable. */
function agentOwnedRoots(agentSlug: string): readonly string[] {
  return [agentTierRoot(agentSlug), `${CONTEXTS_ROOT}/${agentSlug}`];
}

interface ResolvedRequest {
  readonly agentSlug: string;
  readonly actor: string;
  readonly mode: PromoteMode;
  readonly reason?: string;
  readonly overwrite: boolean;
  readonly sourceRoot: string;
  readonly targetRoot: string;
}

/** Validate the request and build the two absolute roots. Rejects, never clamps. */
function resolveRequest(req: PromoteRequest): ResolvedRequest {
  if (req.mode !== 'copy' && req.mode !== 'move') {
    throw fail('invalid_mode', `Unknown promote mode: ${String(req.mode)}`);
  }
  const actor = (req.actor ?? '').trim();
  if (actor.length === 0) throw fail('actor_required', 'actor is required');

  const agentSlug = assertAgentSlug(req.agentSlug ?? '');

  const axis = req.source?.axis;
  if (axis !== 'team' && axis !== 'channel' && axis !== 'user') {
    throw fail('invalid_axis', `Unknown source axis: ${String(axis)}`);
  }
  const sourceCtxKey = assertCtxKey(req.source.ctxKey ?? '', 'source');
  const sourcePath = assertRelativePath(req.source.path ?? '', 'source');
  const sourceRoot = assertInside(
    contextTierRoot(agentSlug, axis, sourceCtxKey),
    `${contextTierRoot(agentSlug, axis, sourceCtxKey)}/${sourcePath}`,
    'source_escapes_agent',
  );

  const tier = req.target?.tier;
  if (tier !== 'agent' && tier !== 'team') {
    throw fail('invalid_tier', `Unknown target tier: ${String(tier)}`);
  }
  const targetPath = assertRelativePath(req.target.path ?? sourcePath, 'target');

  let targetTierRoot: string;
  if (tier === 'agent') {
    if (req.target.ctxKey !== undefined) {
      throw fail('invalid_ctx_key', "target tier 'agent' does not take a context key");
    }
    targetTierRoot = agentTierRoot(agentSlug);
  } else {
    const targetCtxKey = assertCtxKey(req.target.ctxKey ?? '', 'target');
    targetTierRoot = contextTierRoot(agentSlug, 'team', targetCtxKey);
  }
  const targetRoot = assertInside(
    targetTierRoot,
    `${targetTierRoot}/${targetPath}`,
    'target_escapes_agent',
  );

  // Structural belt-and-braces: both roots must live under THIS agent.
  const owned = agentOwnedRoots(agentSlug);
  for (const [path, code] of [
    [sourceRoot, 'source_escapes_agent'],
    [targetRoot, 'target_escapes_agent'],
  ] as const) {
    if (!owned.some((root) => path.startsWith(`${root}/`))) {
      throw fail(code, `Path is outside agent '${agentSlug}': ${path}`);
    }
  }

  if (targetRoot === sourceRoot) {
    throw fail('target_equals_source', `Target is the source: ${targetRoot}`);
  }

  return {
    agentSlug,
    actor,
    mode: req.mode,
    ...(req.reason !== undefined ? { reason: req.reason } : {}),
    overwrite: req.overwrite === true,
    sourceRoot,
    targetRoot,
  };
}

/**
 * Every file under `root` (or `root` itself when it is a file). Walks with the
 * 2-levels-deep `list` contract, so arbitrarily deep subtrees are covered.
 */
async function collectFiles(store: MemoryStore, root: string): Promise<string[]> {
  if (await store.fileExists(root)) return [root];
  if (!(await store.directoryExists(root))) {
    throw fail('source_not_found', `Source does not exist: ${root}`);
  }

  const files = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined || visited.has(dir)) continue;
    visited.add(dir);
    for (const entry of await store.list(dir)) {
      if (entry.virtualPath === dir) continue;
      if (entry.isDirectory) {
        if (!visited.has(entry.virtualPath)) queue.push(entry.virtualPath);
      } else {
        files.add(entry.virtualPath);
      }
    }
  }
  if (files.size === 0) throw fail('source_empty', `Source holds no files: ${root}`);
  return [...files].sort();
}

function hasFrontmatterExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return true; // extensionless memory notes are markdown by convention
  if (dot === 0) return false; // dotfile without an extension — keep it byte-identical
  return FRONTMATTER_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

interface Provenance {
  readonly from: string;
  readonly by: string;
  readonly at: string;
}

const PROVENANCE_KEYS: readonly string[] = ['promoted-from', 'promoted-by', 'promoted-at'];

/** YAML double-quoted scalar — JSON string escaping is a valid subset. */
function provenanceLines(p: Provenance): string[] {
  return [
    `promoted-from: ${JSON.stringify(p.from)}`,
    `promoted-by: ${JSON.stringify(p.by)}`,
    `promoted-at: ${JSON.stringify(p.at)}`,
  ];
}

/**
 * Add provenance frontmatter (spec §6b). An existing frontmatter block is
 * extended in place (its own `promoted-*` keys are replaced, so a two-hop
 * promotion records the latest hop); otherwise a block is prepended.
 */
function withProvenance(content: string, p: Provenance): string {
  const lines = provenanceLines(p);
  const normalised = content.replace(/\r\n/g, '\n');
  if (normalised.startsWith('---\n')) {
    const end = normalised.indexOf('\n---', 3);
    if (end !== -1) {
      const block = normalised.slice(4, end + 1);
      const rest = normalised.slice(end + 1);
      const kept = block
        .split('\n')
        .filter((line) => !PROVENANCE_KEYS.some((key) => line.startsWith(`${key}:`)))
        .filter((line, index, all) => !(line.length === 0 && index === all.length - 1));
      return `---\n${[...kept, ...lines].join('\n')}\n${rest}`;
    }
  }
  return `---\n${lines.join('\n')}\n---\n\n${normalised}`;
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Append one JSONL line. `MemoryStore` has no append, so read-modify-write. */
async function appendAuditLine(store: MemoryStore, line: string): Promise<void> {
  const existing = (await store.fileExists(PROMOTION_AUDIT_PATH))
    ? await store.readFile(PROMOTION_AUDIT_PATH)
    : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await store.writeFile(PROMOTION_AUDIT_PATH, `${prefix}${line}\n`);
}

/**
 * Copy or move a file / subtree between tiers of ONE agent.
 *
 * Fails before writing anything when the source is missing or a target file
 * already exists (unless `overwrite`), so a rejected promotion leaves both
 * tiers untouched. A `move` deletes the source only after every write landed.
 *
 * Throws `Error & { code }`:
 *   `invalid_agent_slug` · `invalid_axis` · `invalid_tier` · `invalid_mode` ·
 *   `invalid_ctx_key` · `invalid_path` · `actor_required` ·
 *   `source_escapes_agent` · `target_escapes_agent` · `target_equals_source` ·
 *   `source_not_found` · `source_empty` · `target_exists` ·
 *   `target_is_directory` · `audit_write_failed` (carries the `receipt`).
 */
export async function promoteMemory(
  store: MemoryStore,
  req: PromoteRequest,
  options: PromoteOptions = {},
): Promise<PromoteReceipt> {
  const resolved = resolveRequest(req);
  const ts = (options.now?.() ?? new Date()).toISOString();

  const sourceFiles = await collectFiles(store, resolved.sourceRoot);
  const sourceIsFile = sourceFiles.length === 1 && sourceFiles[0] === resolved.sourceRoot;

  // Plan every write first — a conflict must abort before the first byte lands.
  const planned: Array<{ source: string; target: string }> = [];
  for (const source of sourceFiles) {
    const target = sourceIsFile
      ? resolved.targetRoot
      : `${resolved.targetRoot}/${source.slice(resolved.sourceRoot.length + 1)}`;
    assertInside(resolved.targetRoot, target, 'target_escapes_agent');
    if (await store.directoryExists(target)) {
      throw fail('target_is_directory', `Target is a directory: ${target}`);
    }
    if (!resolved.overwrite && (await store.fileExists(target))) {
      throw fail('target_exists', `Target already exists: ${target}`);
    }
    planned.push({ source, target });
  }

  const files: PromotedFile[] = [];
  for (const { source, target } of planned) {
    const raw = await store.readFile(source);
    const provenance = hasFrontmatterExtension(target);
    const content = provenance
      ? withProvenance(raw, { from: source, by: resolved.actor, at: ts })
      : raw;
    await store.writeFile(target, content);
    files.push({ sourcePath: source, targetPath: target, bytes: byteLength(content), provenance });
  }

  if (resolved.mode === 'move') {
    await store.delete(resolved.sourceRoot);
  }

  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const receipt: PromoteReceipt = {
    ts,
    agentSlug: resolved.agentSlug,
    actor: resolved.actor,
    mode: resolved.mode,
    sourcePath: resolved.sourceRoot,
    targetPath: resolved.targetRoot,
    ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
    bytes,
    files,
    auditPath: PROMOTION_AUDIT_PATH,
  };

  const auditEvent: Record<string, unknown> = {
    event: 'memory.promote',
    ts,
    agentSlug: receipt.agentSlug,
    actor: receipt.actor,
    mode: receipt.mode,
    sourcePath: receipt.sourcePath,
    targetPath: receipt.targetPath,
    ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
    bytes,
    files: files.length,
  };
  const sink =
    options.securityAuditSink ??
    ((event: Record<string, unknown>): void => {
      console.warn(`[security-audit] ${JSON.stringify(event)}`);
    });
  sink(auditEvent);

  const { event: _event, ...auditLine } = auditEvent;
  try {
    await appendAuditLine(store, JSON.stringify(auditLine));
  } catch (err) {
    // The promotion already happened — surface the audit gap loudly rather
    // than pretending the write was clean.
    throw Object.assign(
      fail('audit_write_failed', `Promotion applied but the audit line failed: ${String(err)}`),
      { receipt },
    );
  }

  return receipt;
}
