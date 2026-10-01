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
import { McpAuthPromptMint, runWithMcpAuthPromptMint } from './mcp/mcpAuthPromptMint.js';
import {
  guardControlFlowResult,
  isGuardedControlFlowResult,
  withholdThrownToolError,
} from './toolErrorRedaction.js';
import type { WriteCapability } from '@omadia/plugin-api';
import type { PrivacyTurnHandle } from './privacyHandle.js';
import type { DomainTool } from './tools/domainQueryTool.js';
import type { NativeToolRegistry } from './nativeToolRegistry.js';
import { sortByToolName } from './toolOrdering.js';
import { turnContext } from './turnContext.js';
import { runHandlerInPrivacyScope } from './handlerPrivacyScope.js';
import { runWithDispatchCaller } from './toolCallerContext.js';
import { runWithIdempotencyScope } from './toolIdempotency.js';
import type { ToolIdempotencyStore } from './toolIdempotency.js';

/**
 * Who authored a `ToolDispatchResult.content`, and therefore whether it had to
 * cross the privacy boundary.
 *
 *  - `'tool'`       — produced by a tool handler: its return value, or — only
 *                     where nothing is withheld (no privacy provider, an
 *                     intern-exempt self tool) — the message of the exception
 *                     it threw. UNTRUSTED. It carries whatever the handler (and
 *                     the ORM/driver beneath it) chose to put in it, so it must
 *                     be masked before it reaches an untrusted caller.
 *  - `'dispatcher'` — produced by this service itself: its own guards (unknown
 *                     tool, plugin not ready), and the withheld notice it puts
 *                     in place of a thrown exception's message (tool name,
 *                     exception class name, sanitised code, log ref). Never
 *                     tool data, so there is nothing for masking to have
 *                     crossed.
 *
 * A consumer that gates on this MUST treat an ABSENT value as `'tool'`: a
 * dispatcher that predates this field, or a future one that forgets it, has to
 * fail toward "must be masked".
 */
export type ToolDispatchContentOrigin = 'tool' | 'dispatcher';

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  /** See `ToolDispatchContentOrigin`. Absent ⇒ treat as `'tool'`. */
  readonly origin?: ToolDispatchContentOrigin;
  /**
   * This body came from the idempotency cache; no handler ran for THIS request.
   *
   * Load-bearing for the public endpoint's fail-closed privacy assertion, which
   * demands that masking actually ran for the current dispatch. A replay
   * satisfies that by construction and cannot satisfy it by observation — the
   * gate is built per request, so `masked()` is false however well the cached
   * body was masked when it was produced. Without this flag the endpoint
   * discards a legitimate cached success and answers "privacy masking did not
   * run", which is precisely the wrong answer to a retried write: the caller
   * cannot tell whether the mutation committed.
   */
  readonly replayed?: boolean;
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
  /**
   * Caller's own admissibility check, run on a freshly-produced result BEFORE
   * the idempotency store retains it. Throw to reject.
   *
   * Exists because "may this body be returned" and "may this body be CACHED"
   * are the same question, and asking it only at the caller answers it too
   * late. The public MCP endpoint asserts that privacy masking actually ran; it
   * does so after `dispatch()` returns, by which point the store has already
   * retained the result. An unmasked body was therefore cached, the first
   * request correctly refused — and the retry replayed the cached RAW body,
   * flagged `replayed` and so exempt from the very assertion that had just
   * rejected it.
   *
   * Running it inside the store's `exec` makes a rejected result throw before
   * retention, and the store does not keep a rejected outcome. That also covers
   * the concurrent duplicate, which collapses onto the same execution and would
   * otherwise be handed the poisoned body before any after-the-fact
   * invalidation could run.
   *
   * Applied on the non-idempotent path too, so the check does not depend on
   * whether a caller happened to send a key.
   */
  readonly validateResult?: (result: ToolDispatchResult) => void;
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
       *
       * The handle also guards what runs INSIDE a handler — see
       * `handlerPrivacyScope.ts`.
       */
      readonly privacy?: () => PrivacyTurnHandle | undefined;
      /**
       * Run no tool handler without a privacy handle. With none resolvable at
       * dispatch time the call answers with a dispatcher-authored notice and
       * no handler runs, so nothing beneath it (a sub-agent's model loop) can
       * reach a model unguarded. The public MCP endpoint sets this whenever
       * masking is required; the loopback and CLI dispatchers leave it off
       * (parity: no provider installed ⇒ nothing is masked).
       */
      readonly requirePrivacyHandle?: boolean;
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
      const outcome = await store.run(
        key,
        name,
        input,
        async () => {
          // The scope must wrap the EXECUTION, not the cache lookup, so the MCP
          // transport layer beneath the handler can read it and suppress its retry.
          const produced = await runWithIdempotencyScope(
            { key, toolName: name, exactlyOnce: true },
            () => this.dispatchInner(name, input, options),
          );
          // INSIDE the exec on purpose — see `validateResult`. A throw here
          // happens before the store retains anything, so a body the caller
          // would refuse can never be replayed back to it later, and a
          // concurrent duplicate collapsing onto this execution inherits the
          // rejection rather than the body.
          options?.validateResult?.(produced);
          return produced;
        },
        // The trust boundary. `caller.principal` is the API-key id on the public
        // MCP path, so two keys cannot collide on a guessable key like
        // `invoice-42` and replay each other's writes. Absent caller ⇒ the
        // in-process chat/loopback path, which is one trusted principal and
        // shares a namespace exactly as before.
        options?.caller?.principal ?? '',
      );
      // Mark a cache hit so a downstream fail-closed privacy check can tell
      // "no handler ran for this request" from "a handler ran and skipped
      // masking". See `ToolDispatchResult.replayed`.
      return outcome.replayed ? { ...outcome.result, replayed: true } : outcome.result;
    }
    const produced = await this.dispatchInner(name, input, options);
    // Same check on the path with no idempotency key, so a caller's
    // admissibility rule does not silently depend on whether the request
    // happened to carry one.
    options?.validateResult?.(produced);
    return produced;
  }

  private async dispatchInner(
    name: string,
    input: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const nativeRegistration = this.deps.nativeTools.get(name);
    const nativeHandler = nativeRegistration?.handler;
    // Mirrors Orchestrator ordering: plugin/native handlers win first.
    if (nativeRegistration !== undefined && nativeHandler !== undefined) {
      if (!this.isToolAvailable(nativeRegistration.agentId)) {
        return {
          content: `Error: tool \`${name}\` is unavailable — plugin \`${nativeRegistration.agentId}\` has not completed its connection/auth setup.`,
          isError: true,
          origin: 'dispatcher',
        };
      }
      return this.invoke(name, () => nativeHandler(input), options);
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
          origin: 'dispatcher',
        };
      }
      return this.invoke(name, () => domainTool.handle(input), options);
    }

    return { content: `Error: unknown tool \`${name}\`.`, isError: true, origin: 'dispatcher' };
  }

  /** One handler run, native or domain: the same steps for both branches. */
  private async invoke(
    name: string,
    handler: () => Promise<string>,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const privacy = this.privacyHandle();
    if (privacy === undefined && this.deps.requirePrivacyHandle === true) {
      console.error(
        `[toolDispatchService:${name}] no privacy handle for this dispatch — refused before the handler ran`,
      );
      return {
        content: `Error: tool \`${name}\` was not run: no privacy guard is active for this call.`,
        isError: true,
        origin: 'dispatcher',
      };
    }
    try {
      // One mint per dispatch: a connect prompt the MCP manager produces
      // while this handler runs is recorded in it (`mcpAuthPromptMint.ts`).
      const authPromptMint = new McpAuthPromptMint();
      // The handler runs with this dispatch's handle as the ambient one, so a
      // sub-agent model loop inside it is guarded too (`handlerPrivacyScope.ts`).
      const raw = await runWithMcpAuthPromptMint(authPromptMint, () =>
        runHandlerInPrivacyScope(privacy, handler),
      );
      return {
        content: await this.afterDispatch(name, raw, authPromptMint, options),
        origin: 'tool',
      };
    } catch (error) {
      return this.thrownResult(name, error, options);
    }
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
    /** The connect prompts the MCP manager produced in this dispatch. */
    authPromptMint: McpAuthPromptMint,
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

    // #1105 / #1097 — fulfilled control-flow prose (the `Error:` convention,
    // or the MCP connect prompt this dispatch produced) is never interned:
    // interning would both hide the failure behind a masked digest and
    // register a renderable dataset a later `v4_render_answer` could
    // materialize as if the error were data. It is not forwarded unchecked
    // either: the `Error:` text goes through the shield's free-text redactor
    // (or is withheld whole) and is receipted — the same helper
    // `Orchestrator.dispatchTool` uses. The connect prompt counts only by
    // provenance; text that merely starts like it is interned below. Thrown
    // exceptions take `thrownResult`.
    if (isGuardedControlFlowResult(result, authPromptMint)) {
      return guardControlFlowResult({
        toolName: name,
        result,
        privacy,
        site: 'toolDispatchService',
        authPromptMint,
      });
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

  /**
   * The result for an exception a tool handler THREW.
   *
   * ─── Why the error path needs its own branch ────────────────────────────────
   *
   * `afterDispatch` runs only on the success path. Handler exceptions are not
   * sanitized strings: an ORM echoes the failing row, a driver echoes the bound
   * query parameters. `Fault: Invalid field 'x' on record {'id':42,'name':'Jane
   * Doe','email':'jane@example.com'}` is a perfectly ordinary Odoo error.
   *
   * ─── The policy: withheld, as on the chat path ──────────────────────────────
   *
   * This branch used to intern the message as a dataset — which handed the
   * caller a renderable 1-row error "dataset" (the #1105 shape) and still let a
   * name through wherever the classifier kept a column clear. It now applies the
   * one thrown-error policy every seam shares (`withholdThrownToolError`,
   * `toolErrorRedaction.ts`): under a privacy handle the caller gets the
   * withheld notice — exception class name, sanitised code, log ref (the
   * caller's `requestId` when it sent one) — the full error goes to the server
   * log, and the turn's receipt, when there is one, records a `thrown` entry.
   * The notice is authored here and carries no tool data, hence
   * `origin: 'dispatcher'`: the public endpoint may return it without a
   * masking pass.
   *
   * Two steps of `afterDispatch` stay deliberately out:
   *  - **Raw capture.** `captureRawToolResult` is documented as receiving "the
   *    tool result", and its consumers (trace/audit, and on the chat path the
   *    Knowledge-Graph ingest) treat it as business data. A driver stack trace
   *    is not a tool result.
   *  - **Operator bypass.** `_privacy_mode: bypass` is consent about a specific
   *    plugin's DECLARED output shape, not about arbitrary exception text, and a
   *    `recordBypassedTool` receipt would mis-describe what happened.
   *
   * Parity: with no privacy provider installed, or for an intern-exempt self
   * tool (the agent's own operational state), the raw message is returned as
   * before, as `origin: 'tool'` content. The public endpoint refuses to call
   * without a provider (`requirePrivacyMasking`) and never serves an
   * intern-exempt tool (`isPubliclyServableTool`).
   */
  private async thrownResult(
    name: string,
    error: unknown,
    options?: ToolDispatchOptions,
  ): Promise<ToolDispatchResult> {
    const requestId = options?.caller?.requestId;
    const outcome = await withholdThrownToolError({
      toolName: name,
      err: error,
      privacy: this.privacyHandle(),
      site: 'toolDispatchService',
      ...(requestId !== undefined && requestId !== '' ? { ref: requestId } : {}),
      formatRaw: (message) => message,
    });
    return {
      content: outcome.text,
      isError: true,
      origin: outcome.withheld ? 'dispatcher' : 'tool',
    };
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
// CLOSED (W4, then unified): the ERROR path. A thrown handler's message used to
// skip the whole boundary above; W4 interned it as a dataset on this path only,
// while the chat path forwarded it raw. There is now ONE policy for both, in
// `toolErrorRedaction.ts`: a thrown message is withheld (notice with class name,
// sanitised code and log ref; full error in the log; `thrown` receipt entry),
// deliberately WITHOUT raw capture or the operator bypass — see `thrownResult`.
// A fulfilled `Error:` text, and an MCP connect prompt the manager produced in
// the same dispatch (`McpAuthPromptMint`), go through `guardControlFlowResult`
// exactly as in `Orchestrator.dispatchToolDeadlined`.
// Every result also carries `origin`, so a consumer can tell handler-authored
// content (must have been masked) from this service's own text (its refusals and
// the withheld notice — nothing to mask).
//
// CLOSED: what runs INSIDE a handler. The handler runs with the dispatch's
// handle as the ambient `turnContext.privacyHandle`
// (`runHandlerInPrivacyScope`), so a domain tool's `LocalSubAgent` masks its
// inner results and tool errors before its own model sees them, as on the chat
// path; `requirePrivacyHandle` runs no handler when no handle resolves.
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
