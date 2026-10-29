import type { PrivacyGuardService } from '@omadia/plugin-api';

import {
  ANSWER_CACHE_PRIVACY_JOB,
  answerCacheEnabled,
  CACHE_DOUBT_REASON,
  createAnswerCache,
  isCacheDoubt,
  settleAnswerCache,
  type AnswerCache,
} from './answerCache.js';
import { parseFastPathChannels, renderChatAnswer } from './chatAnswer.js';
import {
  fetchRecipeRows,
  parseBooleanSetting,
  parseFastPathTools,
  plannableTools,
  renderSummary,
  type FastLlm,
  type FastPathToolSpec,
  type ToolInvoke,
} from './fastPath.js';
import { genericToolSpecs, type FastPathToolDefinition } from './genericToolSpecs.js';
import {
  attributePlan,
  createLearnedPlanStore,
  offeredTools,
  type LearnedPlanStore,
  type PlanMemory,
} from './learnedPlanStore.js';
import { resolveTimeZone, type RefreshSource } from './refreshRecipes.js';
import { openStoredTextPrivacy, TRIAGE_PRIVACY_JOB } from './storedTextPrivacy.js';
import type { PreviousQuery, TriageRoute } from './triage.js';
import { triageTurn, type TriageOutcome } from './triageTurn.js';

/** Bare service-registry key (`fastPath@1` in the manifest). */
export const FAST_PATH_SERVICE = 'fastPath';

/** Active learned plans offered to the router (intents) and planner
 *  (examples) per turn. */
export const TRIAGE_TOP_K = 5;
/** Conversations whose last fast-path query is remembered (follow-ups). */
const MAX_SESSIONS = 500;
/** Generic tool names kept in the fetch whitelist (process-wide, bounded). */
const MAX_GENERIC_TOOLS = 500;

/** Fast-path failures that count against a learned plan — an invoke error
 *  may be the asking user's missing permission, not the plan's fault. */
const PLAN_FAILURES: ReadonlySet<string> = new Set(['tool-error', 'unmappable', 'truncated']);

export interface ChatTriageRequest {
  /** channel name for the channel filter and the logs (web, teams, …) */
  channel: string;
  /** conversation key (the turn's sessionScope) — follow-up memory */
  sessionKey?: string;
  userMessage: string;
  /** the tools the answering agent itself offers its model on this turn —
   *  the triage plans and the executor runs only tools in this set (∩ the
   *  allow-list / learned tools). Required: an unknown set is the caller's
   *  fail-closed pass-through, never "everything". */
  permittedTools: ReadonlySet<string>;
  /** the agent's own definitions of those tools (`ChatAgent.
   *  offeredToolDefinitions`): every read tool among them without a catalog
   *  spec gets a generic planner spec (genericToolSpecs.ts). Absent → only
   *  catalog and learned tools, as before. */
  toolDefinitions?: readonly FastPathToolDefinition[];
}

export type ChatTriageOutcome =
  | {
      kind: 'answer';
      /** summary sentence + markdown table — the full text answer */
      text: string;
      tool: string;
      rows: number;
      toolCalls: number;
      ms: number;
    }
  | {
      kind: 'agent';
      /** the triage's simple/complex route — absent when it decided none */
      route?: TriageRoute;
      reason: string;
      ms: number;
    };

/**
 * `fastPath@1` — the shared deterministic fast path. ONE tenant-wide learned
 * plan store, the allow-list/kill switch, the timezone and the channel
 * filter for every channel; the chat triage for non-canvas channels. The
 * canvas orchestrator runs its own composer/in-place planner on top of the
 * same store and building blocks.
 */
export interface FastPathService {
  /** `fast_path_tools` non-empty — the global kill switch */
  readonly enabled: boolean;
  readonly tools: ReadonlySet<string>;
  /** `fast_path_generic_tools` — other plugins' read tools plannable from
   *  their own schema (default on); off → only catalog + learned tools */
  readonly genericToolsEnabled: boolean;
  readonly timeZone: string;
  /** `fast_path_channels` (and the kill switch) allow `channel` */
  channelEnabled(channel: string): boolean;
  /** the ONE tenant-wide learned plan store */
  readonly plans: LearnedPlanStore;
  /** the zero-LLM answer cache (answerCache.ts) — absent when
   *  `fast_path_answer_cache` is off */
  readonly answerCache?: AnswerCache;
  /** planner specs: the allow-listed catalog tools, then a generic spec for
   *  every read tool of `definitions` (the agent's offered tools) without
   *  one — budgeted, name-ordered, the same text for the same tool set */
  plannableTools(definitions?: readonly FastPathToolDefinition[]): FastPathToolSpec[];
  /** fetch whitelist: the allow-list ∪ tools of ACTIVE learned plans ∪ the
   *  generic tools `plannableTools` built a spec for (the caller still
   *  checks the agent's own tool set) */
  allowedFetchTools(): ReadonlySet<string>;
  /** Book a fast-path execution against the ACTIVE learned plans its fetches
   *  were adapted from; returns their ids. */
  recordFetchOutcome(fetches: readonly RefreshSource[], ok: boolean, reason?: string): string[];
  /** Book an executed triage plan in the answer cache: a cached plan is
   *  kept on a hit and evicted on a miss; an LLM plan of a self-contained
   *  hit is stored (async, privacy-checked). No-op without a ticket. */
  settleTriage(outcome: TriageOutcome, result: { ok: true } | { ok: false; reason: string }): void;
  /** Router call → (deterministic) planner call → the query; never throws. */
  triageChatTurn(req: ChatTriageRequest): Promise<ChatTriageOutcome>;
  /** The last fast-path query answered in conversation `key` (follow-ups). */
  previousQuery(key: string): PreviousQuery | undefined;
  /** Remember a fast-path hit of conversation `key` (bounded LRU). */
  rememberQuery(key: string, prev: PreviousQuery): void;
}

export interface FastPathServiceDeps {
  config: { get<T>(key: string): T | undefined };
  llm?: FastLlm;
  model: string;
  invoke?: ToolInvoke;
  memory?: PlanMemory;
  /** the Privacy Shield, resolved lazily per call */
  privacyGuard: () => PrivacyGuardService | undefined;
  /** the org policy requires a shield and none runs (#1535) */
  privacyForced: () => boolean;
  log: (message: string) => void;
  /** test seam — an injected store */
  plans?: LearnedPlanStore;
  /** test seam — an injected answer cache */
  answerCache?: AnswerCache;
}

export function createFastPathService(deps: FastPathServiceDeps): FastPathService {
  const tools: ReadonlySet<string> = new Set(parseFastPathTools(deps.config.get<string>('fast_path_tools')));
  const enabled = tools.size > 0;
  const genericToolsEnabled = parseBooleanSetting(deps.config.get<unknown>('fast_path_generic_tools'), true);
  const timeZone = resolveTimeZone(deps.config.get<string>('fast_path_timezone'));
  const channelAllowed = parseFastPathChannels(deps.config.get<string>('fast_path_channels'));
  const plans =
    deps.plans ??
    createLearnedPlanStore({ ...(deps.memory ? { memory: deps.memory } : {}), log: deps.log });
  const answerCache: AnswerCache | undefined = answerCacheEnabled(deps.config.get<string | boolean>('fast_path_answer_cache'))
    ? (deps.answerCache ?? createAnswerCache({ ...(deps.memory ? { memory: deps.memory } : {}), log: deps.log }))
    : undefined;
  const builtIn = plannableTools([...tools]);
  const sessions = new Map<string, PreviousQuery>();
  /** read tools a generic spec was built for — planned, so fetchable */
  const genericTools = new Set<string>();

  const allowedFetchTools = (): ReadonlySet<string> =>
    new Set([...tools, ...plans.active().map((p) => p.tool), ...genericTools]);

  /** Catalog specs ∪ generic specs of `definitions` (only tools in
   *  `permitted`, so a foreign tool never takes budget). With generic tools
   *  switched off no generic spec is built — so none becomes fetchable. */
  function plannable(definitions?: readonly FastPathToolDefinition[], permitted?: ReadonlySet<string>): FastPathToolSpec[] {
    const catalog = permitted ? builtIn.filter((t) => permitted.has(t.name)) : [...builtIn];
    if (!enabled || !genericToolsEnabled || definitions === undefined || definitions.length === 0) return catalog;
    const generic = genericToolSpecs(permitted ? definitions.filter((d) => permitted.has(d.name)) : definitions, {
      exclude: new Set(catalog.map((t) => t.name)),
    });
    for (const t of generic) {
      if (genericTools.has(t.name)) continue;
      if (genericTools.size >= MAX_GENERIC_TOOLS) break;
      genericTools.add(t.name);
    }
    return [...catalog, ...generic.filter((t) => genericTools.has(t.name))];
  }

  function recordFetchOutcome(fetches: readonly RefreshSource[], ok: boolean, reason?: string): string[] {
    const ids: string[] = [];
    for (const f of fetches) {
      const plan = attributePlan(plans, f);
      if (!plan) continue;
      ids.push(plan.id);
      if (ok || (reason !== undefined && PLAN_FAILURES.has(reason))) {
        void plans.recordExecution(plan.id, ok, reason);
      }
    }
    return ids;
  }

  function remember(key: string | undefined, prev: PreviousQuery): void {
    if (key === undefined) return;
    sessions.delete(key);
    sessions.set(key, prev);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
  }

  async function triageChatTurn(req: ChatTriageRequest): Promise<ChatTriageOutcome> {
    const t0 = Date.now();
    const channel = req.channel;
    const agent = (reason: string): ChatTriageOutcome => {
      deps.log(`[fast-path] miss channel=${channel} reason=${reason}`);
      return { kind: 'agent', reason, ms: Date.now() - t0 };
    };
    if (!enabled || !channelAllowed(channel)) return { kind: 'agent', reason: 'disabled', ms: 0 };
    const question = req.userMessage.trim();
    if (question.length === 0) return agent('no-question');
    if (deps.privacyForced()) return agent('privacy-forced');
    if (!deps.llm) return agent('no-llm');
    if (!deps.invoke) return agent('no-invoker');
    try {
      await plans.load();
    } catch {
      // a store that cannot load still leaves the built-in tools
    }
    const permitted = req.permittedTools;
    // only tools the answering agent may use itself — built-in and learned
    const offered = plans
      .rank(question, TRIAGE_TOP_K * 2)
      .map((s) => s.plan)
      .filter((p) => permitted.has(p.tool))
      .slice(0, TRIAGE_TOP_K);
    const specs = offeredTools(plannable(req.toolDefinitions, permitted), offered);
    if (specs.length === 0) return agent('no-tools');
    const previous = req.sessionKey !== undefined ? sessions.get(req.sessionKey) : undefined;

    // #1540 — the turn has no privacy handle yet: with a shield running the
    // user-derived turn message goes through ONE stored-text scope, masked
    // once for router + planner (failure-closed) on the sidecar's
    // interactive lane — the turn waits. Fixed prompt text is never masked.
    const guard = deps.privacyGuard();
    const privacy = guard !== undefined ? openStoredTextPrivacy(guard, TRIAGE_PRIVACY_JOB, 'interactive') : undefined;
    const llm = deps.llm;
    const invoke = deps.invoke;
    // answer cache → router ∥ speculative planner (triageTurn.ts)
    const runTriage = (withCache: boolean): Promise<TriageOutcome> =>
      triageTurn({
        llm,
        model: deps.model,
        channel,
        question,
        tools: specs,
        offered,
        allowedTools: allowedFetchTools(),
        ...(previous ? { previous } : {}),
        ...(privacy ? { privacy } : {}),
        ...(withCache && answerCache ? { answerCache } : {}),
        log: deps.log,
      });

    /** Execute the triage's plan; undefined = a cache doubt (re-triage). */
    async function execute(triage: TriageOutcome): Promise<ChatTriageOutcome | undefined> {
      if (triage.kind === 'agent') {
        if (triage.route === undefined) deps.log(`[fast-path] miss channel=${channel} reason=${triage.reason}`);
        return { kind: 'agent', reason: triage.reason, ms: Date.now() - t0, ...(triage.route ? { route: triage.route } : {}) };
      }
      const decision = triage.plan;
      const miss = (reason: string): ChatTriageOutcome => {
        settleTriage(triage, { ok: false, reason });
        return agent(reason);
      };
      if (!permitted.has(decision.fetch.tool)) return miss('tool-not-permitted');
      const fetched = await fetchRecipeRows(invoke, decision.fetch, { rejectTruncated: true, timeZone });
      if (!fetched.ok) {
        if (fetched.detail !== undefined) {
          deps.log(`[fast-path] ${decision.fetch.tool} ${fetched.reason}: ${fetched.detail}`);
        }
        recordFetchOutcome([decision.fetch], false, fetched.reason);
        return miss(fetched.reason);
      }
      if (isCacheDoubt(triage, fetched.rows.length)) {
        settleTriage(triage, { ok: false, reason: CACHE_DOUBT_REASON });
        deps.log(`[fast-path] cache miss channel=${channel} reason=${CACHE_DOUBT_REASON}`);
        return undefined;
      }
      const rendered = renderSummary(decision.summary, {
        rows: fetched.rows,
        records: fetched.records,
        map: decision.fetch.map,
        ...(decision.locale !== undefined ? { locale: decision.locale } : {}),
      });
      if (!rendered.ok) {
        deps.log(`[fast-path] summary unresolvable: ${rendered.detail}`);
        return miss('summary-unresolvable');
      }
      const answer = renderChatAnswer({
        summary: rendered.text,
        rows: fetched.rows,
        columns: Object.keys(decision.fetch.map),
        labels: decision.labels,
        ...(decision.locale !== undefined ? { locale: decision.locale } : {}),
      });
      const learned = recordFetchOutcome([decision.fetch], true);
      settleTriage(triage, { ok: true });
      remember(req.sessionKey, { question, fetch: decision.fetch });
      const ms = Date.now() - t0;
      deps.log(
        `[fast-path] hit channel=${channel} tool=${decision.fetch.tool} rows=${fetched.rows.length} ms=${ms}` +
          (triage.cache?.source === 'cache' ? ' via=cache' : '') +
          (learned.length > 0 ? ` plan=${learned.join(',')}` : ''),
      );
      return { kind: 'answer', text: answer, tool: decision.fetch.tool, rows: fetched.rows.length, toolCalls: 1, ms };
    }

    // a slot-filled cache plan with no rows is a doubt: re-plan without it
    return (await execute(await runTriage(true))) ?? (await execute(await runTriage(false))) ?? agent(CACHE_DOUBT_REASON);
  }

  /** Book a triage plan's execution in the answer cache (see CacheTicket). */
  function settleTriage(outcome: TriageOutcome, result: { ok: true } | { ok: false; reason: string }): void {
    if (answerCache === undefined || outcome.kind !== 'plan' || outcome.cache === undefined) return;
    const guard = deps.privacyGuard();
    const open = guard?.openStoredTextScope?.bind(guard);
    settleAnswerCache(answerCache, outcome.cache, outcome.plan, result, open ? () => open({ job: ANSWER_CACHE_PRIVACY_JOB }) : undefined);
  }

  return {
    enabled,
    tools,
    genericToolsEnabled,
    timeZone,
    channelEnabled: (channel) => enabled && channelAllowed(channel),
    plans,
    ...(answerCache ? { answerCache } : {}),
    plannableTools: (definitions) => plannable(definitions),
    allowedFetchTools,
    recordFetchOutcome,
    settleTriage,
    triageChatTurn,
    previousQuery: (key) => sessions.get(key),
    rememberQuery: (key, prev) => remember(key, prev),
  };
}
