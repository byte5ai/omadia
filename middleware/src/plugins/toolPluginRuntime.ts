import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';

import { createPluginContext } from '../platform/pluginContext.js';
import {
  PluginHandoffPlanError,
  loadHandoffPlan,
} from '../platform/pluginHandoffPlan.js';
import { eventEmitIds } from '../platform/eventCatalogRegistry.js';
import type { PluginRouteRegistry } from '../platform/pluginRouteRegistry.js';
import { PublicPathClaimError } from '../platform/publicPathGrants.js';
import type { PublicPathGrantRegistry } from '../platform/publicPathGrants.js';
import type { PublicPathGrantStore } from '../platform/publicPathGrantStore.js';
import type { NotificationRouter } from '../platform/notificationRouter.js';
import type { PluginStatusRegistry } from '../platform/pluginStatusRegistry.js';
import type { UiRouteCatalog } from '../platform/uiRouteCatalog.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { PluginSqlGrantStore } from '../platform/pluginSqlGrantStore.js';
import type { SecretVault } from '../secrets/vault.js';
import type { OAuthReadinessTracker } from './oauth/oauthReadinessTracker.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import type {
  ApprovedExtension,
  ExtensionTemplate,
  OperatorAuthAccessor,
} from '@omadia/plugin-api';
import type { BuiltInPackageStore } from './builtInPackageStore.js';
import type { SelfExtendRegistry } from './selfExtension/selfExtendRegistry.js';
import type { ExtensionStore } from './selfExtension/extensionStore.js';
import { resolveEligiblePlugins } from './capabilityResolver.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { JobScheduler } from './jobScheduler.js';
import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';
import { topoSortByDependsOn } from './topoSort.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';

/**
 * Runtime for `kind: tool`, `kind: extension`, and `kind: integration`
 * plugins.
 *
 * Tool / extension / integration plugins don't expose a toolkit like
 * agent plugins do — their `activate(ctx)` registers into the kernel's
 * native-tool / route / turn-hook / job / service registries during the
 * call and returns a close-only handle. The runtime's responsibilities
 * are thinner than DynamicAgentRuntime's: dynamic-import, invoke
 * activate with timeout, remember the handle so deactivate can call
 * close().
 *
 * Idempotent across boots: if a plugin's activate() throws repeatedly, the
 * InstalledRegistry circuit-breaker flips status to 'errored' and
 * activateAllInstalled skips it.
 */

interface ToolPluginHandle {
  close(): Promise<void>;
}

/** Plugin self-extension SDK surface a module may export next to `activate`. */
interface ModuleSelfExtend {
  templates?: readonly ExtensionTemplate[];
  apply?: (
    approved: ApprovedExtension,
    ctx: unknown,
  ) => Promise<() => void> | (() => void);
}

interface ToolPluginModuleShape {
  activate?: (ctx: unknown) => Promise<ToolPluginHandle>;
  selfExtend?: ModuleSelfExtend;
  default?: {
    activate?: (ctx: unknown) => Promise<ToolPluginHandle>;
    selfExtend?: ModuleSelfExtend;
  };
}

interface ActiveEntry {
  agentId: string;
  handle: ToolPluginHandle;
  /** Dispose handles from `selfExtend.apply()` of each approved extension. */
  extDisposes: Array<() => void>;
}

export interface ToolPluginRuntimeDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  uploadedStore: UploadedPackageStore;
  builtInStore?: BuiltInPackageStore;
  serviceRegistry: ServiceRegistry;
  nativeToolRegistry: NativeToolRegistry;
  pluginRouteRegistry: PluginRouteRegistry;
  /** Epic #470 C4 / H1 — exclusive ownership of manifest-declared public path
   *  prefixes. Optional so narrow test wiring can omit it; when absent, NO
   *  prefix is ever claimed and every plugin route stays behind `requireAuth`
   *  (the fail-closed direction). */
  publicPathGrants?: PublicPathGrantRegistry;
  /** Operator consent backing `publicPathGrants`. Optional for the same
   *  reason, and with the same consequence: no store, no consent, no public
   *  path. */
  publicPathGrantStore?: PublicPathGrantStore;
  /** The core exemption list, injected rather than imported so a declaration
   *  is checked against the SAME array `requireAuth` runs (see the doc comment
   *  on `auth/publicPaths.ts`). Optional; absent means "no core exemptions to
   *  collide with", which only widens what a plugin may declare in tests. */
  corePublicPaths?: readonly RegExp[];
  notificationRouter: NotificationRouter;
  uiRouteCatalog: UiRouteCatalog;
  jobScheduler: JobScheduler;
  /** Spec 004 — key + origin for the `ctx.flows` toolkit, threaded straight
   *  into every `createPluginContext`. Optional so test harnesses can omit
   *  them (flows simply stays unavailable). */
  flowSigningKey?: Uint8Array;
  flowPublicBaseUrl?: string;
  /** Spec 004 — backing store for `ctx.status`; cleared on deactivate. */
  pluginStatusRegistry?: PluginStatusRegistry;
  /** Issue #438 follow-up — kernel-published `ctx.operatorAuth`, threaded
   *  straight into every `createPluginContext`. Optional so narrow test
   *  contexts can omit it (an admin router relying on it then fails closed). */
  operatorAuth?: OperatorAuthAccessor;
  /** Issue #474 (round 5) — automatic OAuth-connection readiness signal,
   *  refreshed from the vault on every activate() and cleared on
   *  deactivate(). Separate from `pluginStatusRegistry` — see
   *  `OAuthReadinessTracker`'s doc comment for why. */
  oauthConnectionTracker?: OAuthReadinessTracker;
  /** Epic #470 C7 / G4 — durable operator consent for `permissions.sql`, read
   *  once per activate. Optional so narrow test contexts can omit it; absent
   *  means ungranted, so a context built without it gets no database access. */
  sqlGrantStore?: PluginSqlGrantStore;
  /** Event-catalog autodiscovery (US4 Conductor Surface): capability entries declaring
   *  `event_emit: true` are resolved into this registry on (de)activation. This runtime is the
   *  ONLY resolve site for built-in/static tool plugins (landmine K — the dynamic runtime has its
   *  own). Optional — absent in narrow test contexts. */
  eventCatalogRegistry?: {
    register(pluginId: string, eventIds: readonly string[]): void;
    unregister(pluginId: string): void;
  };
  /**
   * Fired after a plugin's activate() succeeds and it is recorded active.
   * Used to register the plugin's manifest-declared `service_types` into the
   * agent-builder's `serviceTypeRegistry` (and link its package into the
   * build template) without a middleware restart — see the wiring in
   * index.ts. Receives the catalog entry plus the resolved on-disk package
   * root (symlink target for the build-template node_modules). Hook failures
   * are logged, never propagated: a builder-registry hiccup must not flip a
   * healthy plugin to errored.
   */
  onActivated?: (
    entry: PluginCatalogEntry,
    packagePath: string,
  ) => void | Promise<void>;
  /** Counterpart to `onActivated`: fired after a plugin is removed from the
   *  active set, so the wiring can `unregisterServiceType` its entries. */
  onDeactivated?: (agentId: string) => void | Promise<void>;
  /** Plugin self-extension (Theme B): when present, a plugin exporting
   *  `selfExtend` has its templates registered here on activate and its
   *  operator-approved extensions (from {@link extensionStore}) re-materialised
   *  via `selfExtend.apply(...)`. Both optional — absent ⇒ self-extension is
   *  simply not offered for standalone plugins. */
  selfExtendRegistry?: SelfExtendRegistry;
  extensionStore?: ExtensionStore;
  log?: (msg: string) => void;
}

/**
 * Wall-clock cap on a plugin's boot-time migration batch.
 *
 * Larger than the 10s `activate()` cap because applying schema is a different
 * kind of work: an index build or a backfill on a real table is legitimately
 * slower than wiring up a plugin's handlers. It is still a cap — the point is
 * that a hung migration fails this ONE activation through the existing
 * circuit-breaker instead of hanging middleware boot for everyone.
 *
 * Sits above `PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS` (30s) on purpose: the
 * server-side budget should be what cancels a runaway statement, because it
 * cancels it *in Postgres* and rolls the batch back cleanly. This one is the
 * outer net for the case Postgres cannot see — a connection that never
 * answers at all.
 */
const MIGRATION_TIMEOUT_MS = 60_000;

export class ToolPluginRuntime {
  private readonly active = new Map<string, ActiveEntry>();

  constructor(private readonly deps: ToolPluginRuntimeDeps) {}

  /** Activates every tool- or extension-kind package that the registry
   *  marks as active. Fails per-plugin (logs + circuit-breaker) rather
   *  than failing the whole boot. */
  async activateAllInstalled(): Promise<void> {
    const log = this.deps.log ?? ((m) => console.log(m));

    const ids = new Set<string>();
    for (const pkg of this.deps.uploadedStore.list()) ids.add(pkg.id);
    if (this.deps.builtInStore) {
      for (const pkg of this.deps.builtInStore.list()) ids.add(pkg.id);
    }

    // Pre-filter to tool/extension candidates that are registry-active, then
    // topologically sort so a plugin's dependencies activate first. Cross-
    // runtime deps (agent→tool) are handled by the outer boot order in
    // index.ts — this runtime runs before the agent runtime.
    const eligible: string[] = [];
    for (const id of ids) {
      const catalogEntry = this.deps.catalog.get(id);
      if (!catalogEntry) continue;
      if (
        catalogEntry.plugin.kind !== 'tool' &&
        catalogEntry.plugin.kind !== 'extension' &&
        catalogEntry.plugin.kind !== 'integration'
      ) {
        continue;
      }
      const reg = this.deps.registry.get(id);
      if (!reg || reg.status !== 'active') continue;
      eligible.push(id);
    }

    // Resolve capabilities BEFORE topo-sorting. Two guarantees land here:
    //   (1) implicit provider→consumer edges flow into topoSort so that
    //       `ctx.services.get(<cap>)` inside a consumer's activate() sees
    //       the provider's service already registered;
    //   (2) consumers whose `requires` cannot be satisfied by the
    //       eligible set are dropped and marked errored — the boot does
    //       not abort, the unresolved plugin surfaces in the UI with an
    //       actionable message, and the operator can install the
    //       missing provider via the wizard.
    const resolution = resolveEligiblePlugins(eligible, this.deps.catalog);

    for (const u of resolution.unresolved) {
      const msg = `unresolved capability requires: ${u.requires.join(', ')}`;
      log(`[tool-runtime] ${u.consumerId} not activated — ${msg}`);
      try {
        // Persist the raw `requires:` list alongside the error so the
        // bootstrap retry-loop on next boot can re-check resolvability
        // without re-running the resolver itself (S+8.5 sub-commit 3).
        await this.deps.registry.markActivationFailed(
          u.consumerId,
          msg,
          u.requires,
        );
      } catch (regErr) {
        log(
          `[tool-runtime] registry markActivationFailed FAILED for ${u.consumerId}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
        );
      }
    }

    const sorted = topoSortByDependsOn(
      resolution.resolved,
      this.deps.catalog,
      resolution.edges,
    );

    for (const id of sorted) {
      try {
        await this.activate(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[tool-runtime] activate FAILED for ${id}: ${msg}`);
        try {
          await this.deps.registry.markActivationFailed(id, msg);
        } catch (regErr) {
          log(
            `[tool-runtime] registry markActivationFailed FAILED for ${id}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
          );
        }
      }
    }
  }

  /** Activate a single tool/extension plugin. Idempotent — returns early
   *  if the plugin is already active. */
  async activate(agentId: string): Promise<void> {
    const log = this.deps.log ?? ((m) => console.log(m));
    if (this.active.has(agentId)) return;

    const packagePath = this.resolvePackagePath(agentId);
    if (!packagePath) {
      throw new Error(`tool-runtime: no package source for '${agentId}'`);
    }
    const catalogEntry = this.deps.catalog.get(agentId);
    if (!catalogEntry) {
      throw new Error(`tool-runtime: ${agentId} not in plugin catalog`);
    }

    // Issue #474 (round 5) — refresh the automatic OAuth-connection signal
    // BEFORE the plugin's own activate() runs, so a plugin that separately
    // calls `ctx.status.report(...)` inside activate() lays its own signal
    // on top rather than this one overwriting it (the two are ANDed at the
    // gate, not merged into one entry). No-op when the plugin declares no
    // `type:'oauth'` field.
    if (this.deps.oauthConnectionTracker) {
      await this.deps.oauthConnectionTracker.refresh(
        agentId,
        catalogEntry,
        this.deps.vault,
      );
    }

    const entryRel = extractEntryPath(catalogEntry) ?? 'dist/plugin.js';
    const entryAbs = path.resolve(packagePath, entryRel);
    if (!entryAbs.startsWith(packagePath + path.sep)) {
      throw new Error(
        `tool-runtime: entry path escapes package root (${entryRel})`,
      );
    }
    await fs.access(entryAbs).catch(() => {
      throw new Error(`tool-runtime: entry file not readable at ${entryAbs}`);
    });

    const mod = (await import(pathToFileURL(entryAbs).href)) as ToolPluginModuleShape;
    const activateFn = mod.activate ?? mod.default?.activate;
    if (typeof activateFn !== 'function') {
      throw new Error(
        `tool-runtime: ${entryAbs} exports neither activate() nor default.activate()`,
      );
    }

    // Epic #470 C7 / G4 — read the operator's SQL grant BEFORE building the
    // context. `ctx.services.get` is synchronous and cannot await, so this is
    // the last point where the answer can be obtained honestly; a lookup
    // deferred into the accessor would have to guess while its cache is cold,
    // and a permission that is permissive while cold is not a permission.
    //
    // The grant must also still MATCH the manifest. An operator granted a
    // specific ledger; a package that later ships a manifest naming a
    // different one has not been granted that one, and carrying the stale row
    // forward would let a plugin update silently move its schema somewhere the
    // operator never approved.
    const declaredSql = catalogEntry.plugin.permissions_summary.sql;
    let sqlGranted = false;
    if (declaredSql && this.deps.sqlGrantStore) {
      const grant = await this.deps.sqlGrantStore.get(agentId);
      sqlGranted = grant?.ledger === declaredSql.ledger;
      if (grant && !sqlGranted) {
        log(
          `[tool-runtime] ${agentId}: permissions.sql grant is for ledger '${grant.ledger}' but the manifest now declares '${declaredSql.ledger}' — treating as ungranted until the operator re-grants`,
        );
      }
    }

    const ctx = createPluginContext({
      agentId,
      vault: this.deps.vault,
      registry: this.deps.registry,
      catalog: this.deps.catalog,
      serviceRegistry: this.deps.serviceRegistry,
      sqlGranted,
      packageRoot: packagePath,
      nativeToolRegistry: this.deps.nativeToolRegistry,
      routeRegistry: this.deps.pluginRouteRegistry,
      notificationRouter: this.deps.notificationRouter,
      uiRouteCatalog: this.deps.uiRouteCatalog,
      jobScheduler: this.deps.jobScheduler,
      flowSigningKey: this.deps.flowSigningKey,
      flowPublicBaseUrl: this.deps.flowPublicBaseUrl,
      pluginStatusRegistry: this.deps.pluginStatusRegistry,
      operatorAuth: this.deps.operatorAuth,
      logger: (...args) => console.log(`[${agentId}]`, ...args),
    });

    // Epic #470 C15 — run the declared ledger handoff BEFORE the migration
    // runner below.
    //
    // C11 gave a plugin `ctx.sql.seedLedger` and documented it as "call this
    // before `runMigrations`", which a plugin cannot honour: the runner below
    // runs before `activate()`, so the plugin's own call always arrived after
    // every ledger row was already written. The 2026-08-21 acceptance run
    // measured `0 seeded, 9 already seeded` on the exact upgrade C11 exists
    // for, with `skippedNoWitness` — the one alarm it was built to raise —
    // unreachable. And nothing failed: that log line is indistinguishable
    // from a healthy re-run.
    //
    // The witnesses are knowledge only the plugin has; the ordering is a
    // decision only core can make. So the plugin declares the plan in its
    // manifest and core executes it here, through the SAME accessor a plugin
    // would have called — read-only witness fence, advisory lock, entry
    // validation and all. `ctx.sql.seedLedger` stays for plugins that manage
    // their own order; against this core it degrades to `alreadySeeded`,
    // which is what it should report once the work is done.
    //
    // A refusal fails the activation, and deliberately takes the migration
    // runner with it: running the files anyway would write exactly the ledger
    // rows the unreadable plan existed to decide on.
    if (declaredSql?.handoff && ctx.sql) {
      const plan = await loadHandoffPlan({
        pluginId: agentId,
        packageRoot: packagePath,
        declaredPath: declaredSql.handoff,
      });
      if (plan.declaredLedger && plan.declaredLedger !== declaredSql.ledger) {
        // Not fatal — core's ledger is the granted one and the plan's copy is
        // advisory. But an operator who previewed the handoff with
        // `plugin-ledger-handoff.mjs` read a different table than the one
        // about to be written, and that is worth saying out loud.
        log(
          `[tool-runtime] WARN ${agentId}: handoff plan names ledger '${plan.declaredLedger}' but the manifest declares '${declaredSql.ledger}' — the manifest wins; an operator dry-run against the plan's table showed a different database`,
        );
      }
      const seedLedger = ctx.sql.seedLedger;
      if (!seedLedger) {
        throw new PluginHandoffPlanError(
          agentId,
          declaredSql.handoff,
          'malformed',
          'this kernel builds a SQL accessor with no ledger seeder — the handoff cannot run, and running the migrations instead would silently do the thing the plan exists to prevent',
        );
      }
      // Bounded with the same budget as the runner it precedes, and for the
      // same reason: `seedPluginLedgerFromDonor` sets its timeouts
      // server-side, but neither covers a connection that never answers, and
      // this await sits on the boot path. The two steps also share one
      // advisory lock, so a tighter bound here would only move where the pair
      // gives up.
      const report = await withTimeout(
        seedLedger.call(ctx.sql, {
          entries: plan.entries,
          dryRun: plan.dryRun,
        }),
        MIGRATION_TIMEOUT_MS,
        `seedLedger(${agentId}) timed out after ${String(MIGRATION_TIMEOUT_MS / 1000)}s`,
      );
      log(
        `[tool-runtime] ${agentId}: ledger handoff — ${String(report.seeded.length)} seeded, ` +
          `${String(report.alreadySeeded.length)} already seeded, ` +
          `${String(report.applied.length)} left for the migration runner ` +
          `(ledger '${report.ledger}', donor '${report.donorLedger}', ${String(report.durationMs)}ms` +
          `${report.dryRun ? ', dry run — nothing written' : ''})`,
      );
      if (report.skippedNoWitness.length > 0) {
        // THE output this feature exists to produce. The donor ledger records
        // these, but their witness says the schema object is not there: a
        // restore from an older snapshot, a rolled-back deploy, a table
        // dropped during an incident. The runner below repairs it, so this is
        // a warning rather than a refusal — but the operator has to be told
        // the database is not the one they think it is, and told WHICH files,
        // because a count alone gives them nowhere to look.
        log(
          `[tool-runtime] WARN ${agentId}: ledger handoff — the donor ledger records ` +
            `${String(report.skippedNoWitness.length)} file(s) whose witness says the schema object is ABSENT; ` +
            `the migration runner will apply them, which is the repair — confirm this is the database you think it is: ` +
            report.skippedNoWitness.join(', '),
        );
      }
    }

    // Epic #470 C7 / G4 — apply the plugin's schema BEFORE its `activate()`
    // runs. A plugin whose first act is to query its own tables must not have
    // to remember to migrate first, and the ordering is not a convenience: it
    // is what makes "the tables exist" an invariant `activate()` can rely on
    // rather than a race each plugin re-loses in its own way.
    //
    // Only when the manifest explicitly declares `permissions.sql.migrations`.
    // A plugin that declares `permissions.sql` for pool access alone, with no
    // migrations key, gets `ctx.sql` and decides for itself.
    //
    // A failure here fails the activation. That is deliberate: the alternative
    // is a plugin running against a schema that is not the one it was built
    // for, which fails later, further away, and with the database in a state
    // nobody chose. The circuit-breaker in `activateAllInstalled` treats it
    // like any other activate failure.
    if (declaredSql?.migrations && ctx.sql) {
      // Bounded with the SAME helper that caps `activate()`, and for the same
      // reason. `runPluginMigrations` sets `lock_timeout` and
      // `statement_timeout` server-side, but neither covers a connection that
      // never answers — a pool exhausted by another plugin, a database that
      // accepted the TCP connection and then went away. This await sits on the
      // boot path ahead of `activate()`, so an unbounded one hangs the whole
      // middleware rather than just this plugin. The budget is its own
      // constant because migrating schema is legitimately slower than
      // activating, and folding it into the 10s activate cap would either
      // starve real migrations or loosen the activate bound.
      const report = await withTimeout(
        ctx.sql.runMigrations(),
        MIGRATION_TIMEOUT_MS,
        `runMigrations(${agentId}) timed out after ${String(MIGRATION_TIMEOUT_MS / 1000)}s`,
      );
      if (report.applied.length > 0) {
        log(
          `[tool-runtime] ${agentId}: applied ${String(report.applied.length)} migration(s) to ledger '${report.ledger}' in ${String(report.durationMs)}ms (${report.applied.join(', ')})`,
        );
      }
    }

    let handle: ToolPluginHandle;
    try {
      handle = await withTimeout(
        activateFn(ctx),
        10_000,
        `activate(${agentId}) timed out after 10s`,
      );
    } catch (err) {
      // A plugin that registered a router or a nav entry and THEN threw (or
      // timed out) never reaches `active.set`, so deactivate() would later
      // return false and never clean up — the orphaned route would keep
      // serving and the orphaned menu entry would keep rendering for the
      // life of the process. Roll back what the context handed out before
      // letting the failure propagate to the circuit-breaker. Services are
      // part of that: a plugin that called ctx.services.provide() and then
      // threw would otherwise make every retry fail with 'duplicate
      // provider' instead of the real activation error.
      this.deps.pluginRouteRegistry.disposeBySource(agentId);
      this.deps.uiRouteCatalog.disposeBySource(agentId);
      this.deps.serviceRegistry.disposeBySource(agentId);
      this.deps.jobScheduler.stopForPlugin(agentId);
      this.deps.pluginStatusRegistry?.clear(agentId);
      throw err;
    }

    // Epic #470 C4 / H1 — claim the manifest-declared public-path prefixes.
    //
    // AFTER activate(), deliberately. The rule "a plugin may only make public
    // something it actually serves" needs the prefixes the plugin registered,
    // and those only exist once activate() has run. Claiming earlier would mean
    // trusting the manifest about which routers exist, which is the same
    // mistake as trusting it about authentication.
    //
    // A rejected claim is a hard activation failure with the SAME rollback the
    // catch above performs. Half-activating a plugin whose public-path
    // declaration conflicts with another plugin's is the one outcome worse than
    // refusing it: the operator would see a healthy plugin serving a prefix
    // somebody else owns.
    if (this.deps.publicPathGrants) {
      const declared = catalogEntry.plugin.permissions_summary?.public_paths ?? [];
      if (declared.length > 0) {
        try {
          const granted =
            (await this.deps.publicPathGrantStore?.listForPlugin(agentId)) ??
            new Set<string>();
          this.deps.publicPathGrants.claim(agentId, declared, {
            corePublicPaths: this.deps.corePublicPaths ?? [],
            ownRoutePrefixes: this.deps.pluginRouteRegistry
              .list()
              .filter((r) => r.source === agentId && !r.disposed)
              .map((r) => r.prefix),
            grantedPrefixes: granted,
          });
          const ungranted = declared.filter((p) => !granted.has(p));
          log(
            `[tool-runtime] public paths for ${agentId}: ${String(granted.size)} granted, ` +
              `${String(ungranted.length)} declared-but-awaiting-consent` +
              (ungranted.length > 0 ? ` (${ungranted.join(', ')})` : ''),
          );
        } catch (err) {
          this.deps.publicPathGrants.releaseBySource(agentId);
          this.deps.pluginRouteRegistry.disposeBySource(agentId);
          this.deps.uiRouteCatalog.disposeBySource(agentId);
          this.deps.serviceRegistry.disposeBySource(agentId);
          this.deps.jobScheduler.stopForPlugin(agentId);
          this.deps.pluginStatusRegistry?.clear(agentId);
          // The plugin's own close() still has to run — it may hold a socket or
          // a timer that activate() opened. Best-effort; the claim error is
          // what propagates.
          await Promise.resolve(handle.close()).catch(() => undefined);
          if (err instanceof PublicPathClaimError) {
            throw new Error(
              `tool-runtime: ${agentId} cannot activate — ${err.message}`,
              { cause: err },
            );
          }
          throw err;
        }
      }
    }

    // Plugin self-extension (Theme B): if the module opted into the selfExtend
    // SDK, register its declarative templates and re-materialise every
    // operator-approved extension via the plugin's OWN `apply()`, passing the
    // SAME capability-scoped ctx. Best-effort: a failing extension is logged,
    // never flips the (healthy) base plugin to errored.
    const extDisposes: Array<() => void> = [];
    const selfExtend = mod.selfExtend ?? mod.default?.selfExtend;
    if (selfExtend) {
      if (this.deps.selfExtendRegistry && selfExtend.templates) {
        this.deps.selfExtendRegistry.register(agentId, selfExtend.templates);
      }
      const applyFn = selfExtend.apply;
      if (this.deps.extensionStore && typeof applyFn === 'function') {
        for (const approved of this.deps.extensionStore.list(agentId)) {
          try {
            const dispose = await applyFn(approved, ctx);
            if (typeof dispose === 'function') extDisposes.push(dispose);
            log(
              `[tool-runtime] applied self-extension ${agentId} template=${approved.templateId}`,
            );
          } catch (err) {
            log(
              `[tool-runtime] selfExtend.apply FAILED for ${agentId} template=${approved.templateId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    this.active.set(agentId, { agentId, handle, extDisposes });

    // Event-catalog autodiscovery (US4 / landmine K): static + built-in tool plugins resolve their
    // `event_emit: true` capabilities here — the only place they are picked up (the dynamic runtime
    // covers hot-installed agents). Lets the Designer list emittable events + ctx.events.emit deny-by-default.
    const eventEmitIdList = eventEmitIds(catalogEntry.manifest);
    if (eventEmitIdList.length > 0) {
      this.deps.eventCatalogRegistry?.register(agentId, eventEmitIdList);
      log(`[tool-runtime] event-emit capabilities registered for ${agentId}: ${eventEmitIdList.join(', ')}`);
    }

    try {
      await this.deps.registry.markActivationSucceeded(agentId);
    } catch (err) {
      log(
        `[tool-runtime] registry markActivationSucceeded FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (this.deps.onActivated) {
      try {
        await this.deps.onActivated(catalogEntry, packagePath);
      } catch (err) {
        log(
          `[tool-runtime] onActivated hook FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(
      `[tool-runtime] ACTIVATED ${agentId} (${catalogEntry.plugin.kind}, entry=${entryRel})`,
    );
  }

  async deactivate(agentId: string): Promise<boolean> {
    const log = this.deps.log ?? ((m) => console.log(m));
    const entry = this.active.get(agentId);
    if (!entry) return false;
    // Dispose self-extension registrations first (they registered tools), then
    // drop the plugin's templates from the registry.
    for (const dispose of entry.extDisposes) {
      try {
        dispose();
      } catch (err) {
        log(
          `[tool-runtime] selfExtend dispose FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.deps.selfExtendRegistry?.unregister(agentId);
    this.deps.eventCatalogRegistry?.unregister(agentId);
    // Take the externally-reachable surfaces down BEFORE awaiting close().
    // close() is plugin-controlled and gets a 5s budget, so disposing after
    // it would leave routers answering and the menu entry visible for up to
    // five seconds into a deactivation the operator already triggered —
    // and for the full budget when a plugin's close() hangs.
    //
    // Express cannot unmount, so the route registry flips its entries to
    // disposed and the mounted closure falls through to next(). Without
    // this call a deactivated plugin's routers stay live and — because
    // Express matches first-mount-wins — keep serving after uninstall or
    // across a hot-upgrade. DynamicAgentRuntime already did this; the tool
    // runtime held the dependency and threaded it into the plugin context
    // but never disposed by source.
    //
    // Same reasoning one layer down for the service registry: a provider
    // whose close() forgets its handle leaves the service registered
    // against a torn-down module, so consumers keep resolving a dead
    // implementation and the reinstall throws 'duplicate provider'.
    this.deps.pluginRouteRegistry.disposeBySource(agentId);
    this.deps.uiRouteCatalog.disposeBySource(agentId);
    this.deps.serviceRegistry.disposeBySource(agentId);
    // Epic #470 C4 / H1 — release the public-path ownership in the SAME breath
    // as the routers. These two must never drift apart: an ownership claim that
    // outlives its routers is a granted prefix with nothing behind it, and a
    // router disposed while the claim stands is a prefix nobody else can take.
    // (The mount answers 404 for the window in between either way — it resolves
    // the live router on every request, not once at claim time.)
    this.deps.publicPathGrants?.releaseBySource(agentId);
    try {
      await withTimeout(
        entry.handle.close(),
        5_000,
        `close(${agentId}) timed out after 5s`,
      );
    } catch (err) {
      log(
        `[tool-runtime] close FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Bulk-stop any background jobs the plugin registered. Belt-and-braces
    // alongside the per-registration dispose handles that the plugin's own
    // close() should already invoke — a leaked dispose still won't outlive
    // its plugin's lifecycle.
    this.deps.jobScheduler.stopForPlugin(agentId);
    this.deps.pluginStatusRegistry?.clear(agentId);
    this.deps.oauthConnectionTracker?.clear(agentId);
    this.active.delete(agentId);

    if (this.deps.onDeactivated) {
      try {
        await this.deps.onDeactivated(agentId);
      } catch (err) {
        log(
          `[tool-runtime] onDeactivated hook FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(`[tool-runtime] DEACTIVATED ${agentId}`);
    return true;
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  activeIds(): string[] {
    return Array.from(this.active.keys());
  }

  private resolvePackagePath(agentId: string): string | undefined {
    const uploaded = this.deps.uploadedStore.get(agentId);
    if (uploaded) return uploaded.path;
    return this.deps.builtInStore?.get(agentId)?.path;
  }
}

function extractEntryPath(entry: PluginCatalogEntry): string | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const lifecycle = manifest?.['lifecycle'] as Record<string, unknown> | undefined;
  const raw = lifecycle?.['entry'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
