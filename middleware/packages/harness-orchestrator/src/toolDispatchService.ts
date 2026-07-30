/**
 * Standalone tool dispatcher — the entry point that is NOT the Orchestrator turn
 * loop. Serves the loopback MCP server (subscription-CLI provider), the CLI
 * bridge, and CLI sub-agents; it is also the path any future public MCP endpoint
 * (#542) would dispatch through.
 *
 * It replicates the native-handler and DomainTool branches of
 * `Orchestrator.dispatchToolInner`, and — since #542's prerequisite work — the
 * privacy data-plane boundary and raw-result capture that `dispatchToolDeadlined`
 * applies around them. See the SEAM note at the bottom of this file for what is
 * closed and what is still deliberately orchestrator-only.
 */

import { isInternExemptTool } from './privacyInternPolicy.js';
import { isWriteCapableTool } from '@omadia/plugin-api';
import type { WriteCapability } from '@omadia/plugin-api';
import type { PrivacyTurnHandle } from './privacyHandle.js';
import type { DomainTool } from './tools/domainQueryTool.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import { sortByToolName } from './toolOrdering.js';
import { turnContext } from './turnContext.js';
import { runWithDispatchCaller } from './toolCallerContext.js';
import { runWithIdempotencyScope } from './toolIdempotency.js';
import type { ToolIdempotencyStore } from './toolIdempotency.js';

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface DispatchableToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/**
 * Identity of whoever asked for this dispatch.
 *
 * The dispatch path historically carried NO caller identity at all — no tenant,
 * no user, no principal — which is fine for the loopback bridge (the caller is
 * the local CLI, acting as the session's own user) but is the missing seam for a
 * public endpoint, where every call arrives with an API key or token that has to
 * be attributable and scope-checked.
 *
 * Optional by construction: the loopback and CLI-sub-agent paths pass nothing and
 * behave exactly as before. When #438/#439's `harness-api-key-auth` lands, the
 * public endpoint fills this in from the verified credential; nothing downstream
 * has to change shape again.
 *
 * NOTE: this is a CARRIER, not an enforcement point. `ToolDispatchService` does
 * not currently authorize against `scopes` — a per-principal tool allowlist is
 * the public endpoint's own job (#542) and belongs where the allowlist policy
 * lives, not here. Do not read the presence of this field as "the dispatch path
 * is now access-controlled".
 */
export interface ToolDispatchCallerContext {
  /** Stable id of the acting principal (API-key id, service account, user id). */
  readonly principal?: string;
  /** Scopes/permissions the credential carries, for the caller's own policy check. */
  readonly scopes?: readonly string[];
  /** Tenant the call is acting within. */
  readonly tenantId?: string;
  /** End user on whose behalf the call runs, when distinct from `principal`. */
  readonly userId?: string;
  /** Correlation id for logs/traces. */
  readonly requestId?: string;
}

/** Per-dispatch options. All optional — omitting the whole argument is legacy behaviour. */
export interface ToolDispatchOptions {
  readonly caller?: ToolDispatchCallerContext;
  /**
   * Caller-supplied idempotency key. Applied ONLY to write-capable tools (see
   * `isWriteCapableTool`): two dispatches sharing a key execute the tool at most
   * once while the record is live, and the MCP transport layer suppresses its
   * transient retry for the call.
   *
   * Read tools ignore this: deduping reads would serve stale data, and the
   * flaky-proxy retry mitigation must stay in force for them.
   */
  readonly idempotencyKey?: string;
}

export class ToolDispatchService {
  constructor(
    private readonly deps: {
      readonly nativeTools: NativeToolRegistry;
      /** Static sub-agent tools (M1 tests / fixed sets). */
      readonly domainTools?: readonly DomainTool[];
      /** Live sub-agent tools — read on every dispatch/list so sub-agents that
       *  attach to the orchestrator AFTER construction (the normal post-activate
       *  flow via `registerDomainTool`) are reachable. Takes precedence over the
       *  static list when present. */
      readonly domainToolsProvider?: () => readonly DomainTool[];
      /**
       * Issue #474 — per-plugin tool-readiness gate, mirroring
       * `OrchestratorOptions.isPluginToolsReady`. This dispatcher is a
       * SEPARATE entry point from `Orchestrator.dispatchTool` (used by the
       * subscription-CLI provider), so the gate must be repeated here too —
       * relying on `Orchestrator`'s own check alone would leave this path
       * ungated. Absent ⇒ every plugin's tools are always available.
       */
      readonly isPluginToolsReady?: (agentId: string) => boolean;
      /**
       * #542 prerequisite — the privacy data-plane boundary for this path.
       *
       * The chat path reads its handle from `turnContext`, which this dispatcher
       * runs entirely outside of: the loopback MCP server and any public endpoint
       * are not inside `turnContext.run(...)`, so `turnContext.current()` is
       * `undefined` and a tool result would reach the caller with PII intact.
       * That was the open half of the privacy seam.
       *
       * Resolution order is explicit-dep first, ambient turn context second, so
       * a host that DOES dispatch from inside a turn still inherits that turn's
       * handle. Absent from both ⇒ no privacy provider installed and results flow
       * through unchanged, matching the orchestrator.
       */
      readonly privacy?: () => PrivacyTurnHandle | undefined;
      /**
       * #542 prerequisite — raw-result capture (the orchestrator's Phase C.2
       * `captureRawToolResult`). Receives the tool result BEFORE masking, so a
       * trace/audit consumer sees ground truth while the caller gets the digest.
       * Must not throw; a throw is caught and logged rather than failing the call.
       *
       * Receives the dispatch's caller context so an audit consumer can attribute
       * the result to the principal that caused it.
       */
      readonly captureRawToolResult?: (
        name: string,
        result: string,
        caller?: ToolDispatchCallerContext,
      ) => void;
      /**
       * #542 prerequisite — dedupe store for write-capable dispatches. Absent ⇒
       * `idempotencyKey` is inert and every dispatch executes (legacy behaviour).
       * Process-local: see `toolIdempotency.ts` for the exact limits of the
       * guarantee — it is NOT distributed idempotency.
       */
      readonly idempotency?: ToolIdempotencyStore;
    },
  ) {}

  private domainTools(): readonly DomainTool[] {
    return this.deps.domainToolsProvider?.() ?? this.deps.domainTools ?? [];
  }

  /** Issue #474 — see `Orchestrator.isToolAvailable`; kept in sync with it. */
  private isToolAvailable(agentId: string | undefined): boolean {
    if (agentId === undefined) return true;
    if (!this.deps.isPluginToolsReady) return true;
    return this.deps.isPluginToolsReady(agentId);
  }

  /** Explicit dep wins; ambient turn handle is the fallback. */
  private privacyHandle(): PrivacyTurnHandle | undefined {
    return this.deps.privacy?.() ?? turnContext.current()?.privacyHandle;
  }

  /** Declared write capabilities for `name`, from whichever carrier owns it. */
  private writeCapabilities(name: string): readonly WriteCapability[] | undefined {
    const native = this.deps.nativeTools.get(name);
    if (native?.writeCapabilities !== undefined) return native.writeCapabilities;
    return this.domainTools().find((t) => t.name === name)?.writeCapabilities;
  }

  /** True when dispatching `name` may mutate data. */
  isWriteCapable(name: string): boolean {
    return isWriteCapableTool(this.writeCapabilities(name));
  }

  async dispatch(
    name: string,
    input: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const caller = options?.caller;
    // Publish caller identity for every layer beneath this dispatch. Omitted
    // entirely when the entry point supplied none, so the loopback path runs with
    // an empty store exactly as before.
    return caller === undefined
      ? this.dispatchIdempotent(name, input, options)
      : runWithDispatchCaller(caller, () =>
          this.dispatchIdempotent(name, input, options),
        );
  }

  private async dispatchIdempotent(
    name: string,
    input: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const key = options?.idempotencyKey;
    const store = this.deps.idempotency;
    // Idempotency applies to write-capable tools only. A read tool keeps the
    // transport-retry mitigation and never replays a cached body.
    if (key !== undefined && store !== undefined && this.isWriteCapable(name)) {
      const outcome = await store.run(key, name, input, () =>
        // The scope must wrap the EXECUTION, not the cache lookup, so the MCP
        // transport layer beneath the handler can read it and suppress its retry.
        runWithIdempotencyScope({ key, toolName: name, exactlyOnce: true }, () =>
          this.dispatchInner(name, input, options),
        ),
      );
      return outcome.result;
    }
    return this.dispatchInner(name, input, options);
  }

  private async dispatchInner(
    name: string,
    input: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const nativeRegistration = this.deps.nativeTools.get(name);
    // Mirrors Orchestrator ordering: plugin/native handlers win first.
    if (nativeRegistration?.handler) {
      if (!this.isToolAvailable(nativeRegistration.agentId)) {
        return {
          content: `Error: tool \`${name}\` is unavailable — plugin \`${nativeRegistration.agentId}\` has not completed its connection/auth setup.`,
          isError: true,
        };
      }
      try {
        const raw = await nativeRegistration.handler(input);
        return { content: await this.afterDispatch(name, raw, options) };
      } catch (error) {
        return { content: this.errMsg(error), isError: true };
      }
    }

    const domainTool = this.domainTools().find((t) => t.name === name);
    if (domainTool) {
      // Issue #474 follow-up — same gate as the native-handler branch above;
      // DomainTools carry an `agentId` too and were previously dispatchable
      // through this bridge regardless of the owning plugin's readiness.
      if (!this.isToolAvailable(domainTool.agentId)) {
        return {
          content: `Error: tool \`${name}\` is unavailable — plugin \`${domainTool.agentId}\` has not completed its connection/auth setup.`,
          isError: true,
        };
      }
      try {
        const raw = await domainTool.handle(input);
        return { content: await this.afterDispatch(name, raw, options) };
      } catch (error) {
        return { content: this.errMsg(error), isError: true };
      }
    }

    return { content: `Error: unknown tool \`${name}\`.`, isError: true };
  }

  /**
   * Post-dispatch pipeline: raw capture, then the privacy data-plane boundary.
   *
   * Ordering mirrors `Orchestrator.dispatchToolDeadlined` deliberately, because a
   * divergence here is a privacy divergence:
   *   1. raw capture — trace/audit consumers must see ground truth
   *   2. intern-exemption — the agent's own infra tools are never masked
   *   3. operator bypass (+ receipt entry) — explicit opt-out stays auditable
   *   4. intern — the caller receives the identity-free digest
   */
  private async afterDispatch(
    name: string,
    result: string,
    options?: ToolDispatchOptions,
  ): Promise<string> {
    const capture = this.deps.captureRawToolResult;
    if (capture !== undefined && typeof result === 'string') {
      try {
        capture(name, result, options?.caller);
      } catch (err) {
        console.warn(
          `[toolDispatchService:${name}] captureRawToolResult threw — continuing without capture:`,
          err,
        );
      }
    }

    const privacy = this.privacyHandle();
    if (privacy === undefined || typeof result !== 'string') return result;

    // Interning-exemption: the agent's own infrastructure/self tools (memory,
    // stored-process CRUD, self-produced meta output) are never interned —
    // masking them blinds the agent to its own operational state. Same
    // auditable allowlist the orchestrator uses.
    if (isInternExemptTool(name)) return result;

    // Operator-owned per-plugin bypass (Slice 2.5). Raw passthrough, but the
    // receipt entry keeps it transparent.
    const bypass = privacy.checkBypass(name);
    if (bypass !== undefined) {
      try {
        await privacy.recordBypassedTool({
          toolName: name,
          pluginId: bypass.pluginId,
          reason: 'operator_setting',
          bytes: Buffer.byteLength(result, 'utf8'),
        });
      } catch (err) {
        console.warn(
          `[toolDispatchService:${name}] privacy.recordBypassedTool threw — bypass still applied:`,
          err,
        );
      }
      return result;
    }

    try {
      const v4 = await privacy.internToolResultV4({
        toolName: name,
        rawResult: result,
      });
      return v4.digestText;
    } catch (err) {
      // Fail-OPEN, matching `Orchestrator.dispatchToolDeadlined` exactly. This is
      // parity, not an endorsement: for a PUBLIC endpoint a masking failure that
      // emits raw rows is a leak, and a fail-CLOSED policy for untrusted callers
      // is worth its own decision (#542) — but making this path stricter than the
      // chat path would be a silent behaviour change beyond closing the seam.
      console.warn(
        `[toolDispatchService:${name}] privacy.internToolResultV4 threw — sending raw result:`,
        err,
      );
      return result;
    }
  }

  listDispatchableToolSpecs(): readonly DispatchableToolSpec[] {
    const advertised = new Map<string, DispatchableToolSpec>();

    for (const registration of this.deps.nativeTools.listWithHandler()) {
      if (!registration.spec) {
        // Handler-only registrations remain dispatchable by name, but cannot be
        // advertised without a stable tool spec.
        continue;
      }
      // Issue #474 — same gate as `dispatch()`; a not-yet-ready plugin's
      // tools are excluded from the advertised list too.
      if (!this.isToolAvailable(registration.agentId)) {
        continue;
      }

      advertised.set(registration.name, {
        name: registration.spec.name,
        description: registration.spec.description,
        input_schema: registration.spec.input_schema,
      });
    }

    for (const tool of this.domainTools()) {
      // Native tools keep precedence on collisions to mirror dispatch order.
      if (advertised.has(tool.name)) {
        continue;
      }
      // Issue #474 follow-up — same gate as the native-tool loop above.
      if (!this.isToolAvailable(tool.agentId)) {
        continue;
      }
      advertised.set(tool.name, {
        name: tool.spec.name,
        description: tool.spec.description,
        input_schema: tool.spec.input_schema,
      });
    }

    // W0-3 — sort by name so every consumer of this list (the loopback MCP
    // server, the CLI bridge) advertises a byte-stable order. Both source
    // iterations above are Map-ordered — plugin load order and `created_at`
    // row order — which differ across machines and deploys.
    //
    // Collision resolution is NOT affected: which spec wins a duplicate name
    // was already decided by the `advertised.has(...)` guard above (native
    // tools first), and sorting only reorders the surviving entries.
    return sortByToolName(Array.from(advertised.values()));
  }

  private errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// SEAM — divergence from `Orchestrator.dispatchToolInner` /
// `dispatchToolDeadlined`, kept current deliberately.
//
// CLOSED (#542 prerequisite): the privacy data-plane boundary — intern-exemption,
// operator bypass with its receipt entry, and `internToolResultV4` masking — plus
// raw-result capture, now run on this path in the same order as the chat path. A
// caller reaching tools here no longer bypasses the PII masking chat enforces.
// Caller identity is carried by `ToolDispatchCallerContext` (a carrier, not an
// enforcement point — see its docs).
//
// STILL ORCHESTRATOR-ONLY, because each needs turn-scoped state this path has no
// access to (an unconditional copy would throw or silently no-op):
//   - kernel-tool branches: scoped-memory shadowing, knowledge_graph,
//     query_dataset, chat_participants, ask_user_choice, suggest_follow_ups,
//     read_attachment, find_free_slots, book_meeting
//   - `v4_*` verb/render tool routing via `privacy.runV4Tool` (needs the turn's
//     data-plane engine; here such a name resolves to "unknown tool")
//   - sub-agent dataset bridging (`subAgentDatasetSink` / `subAgentResultV4`)
//     and the Slice-2.5 sub-agent bypass flag
//   - MCP → Knowledge-Graph ingestion (needs `knowledgeGraph` + turn user id)
//   - canvas sentinel tap (`canvasSentinelSink`)
//   - the W0-2 per-tool dispatch deadline and its late-result firewall
