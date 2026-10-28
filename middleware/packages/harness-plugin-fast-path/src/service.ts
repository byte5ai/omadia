import type { PrivacyGuardService } from '@omadia/plugin-api';

import { parseFastPathChannels, renderChatAnswer } from './chatAnswer.js';
import {
  FAST_MODEL_REASONING,
  fetchRecipeRows,
  parseFastPathTools,
  plannableTools,
  renderSummary,
  type FastLlm,
  type FastPathToolSpec,
  type ToolInvoke,
} from './fastPath.js';
import {
  attributePlan,
  createLearnedPlanStore,
  offeredTools,
  type LearnedPlanStore,
  type PlanMemory,
} from './learnedPlanStore.js';
import { resolveTimeZone, type RefreshSource } from './refreshRecipes.js';
import { openStoredTextPrivacy, TRIAGE_PRIVACY_JOB } from './storedTextPrivacy.js';
import { buildTriagePrompt, parseTriage, TRIAGE_SYSTEM, type PreviousQuery, type TriageRoute } from './triage.js';

/** Bare service-registry key (`fastPath@1` in the manifest). */
export const FAST_PATH_SERVICE = 'fastPath';

/** Active learned plans offered to the chat triage per turn. */
export const TRIAGE_TOP_K = 5;
/** Conversations whose last fast-path query is remembered (follow-ups). */
const MAX_SESSIONS = 500;

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
  readonly timeZone: string;
  /** `fast_path_channels` (and the kill switch) allow `channel` */
  channelEnabled(channel: string): boolean;
  /** the ONE tenant-wide learned plan store */
  readonly plans: LearnedPlanStore;
  /** built-in planner specs of the allow-listed tools */
  plannableTools(): FastPathToolSpec[];
  /** fetch whitelist: the allow-list ∪ tools of ACTIVE learned plans */
  allowedFetchTools(): ReadonlySet<string>;
  /** Book a fast-path execution against the ACTIVE learned plans its fetches
   *  were adapted from; returns their ids. */
  recordFetchOutcome(fetches: readonly RefreshSource[], ok: boolean, reason?: string): string[];
  /** ONE fast-model call + (on a deterministic decision) the query; never throws. */
  triageChatTurn(req: ChatTriageRequest): Promise<ChatTriageOutcome>;
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
}

export function createFastPathService(deps: FastPathServiceDeps): FastPathService {
  const tools: ReadonlySet<string> = new Set(parseFastPathTools(deps.config.get<string>('fast_path_tools')));
  const enabled = tools.size > 0;
  const timeZone = resolveTimeZone(deps.config.get<string>('fast_path_timezone'));
  const channelAllowed = parseFastPathChannels(deps.config.get<string>('fast_path_channels'));
  const plans =
    deps.plans ??
    createLearnedPlanStore({ ...(deps.memory ? { memory: deps.memory } : {}), log: deps.log });
  const builtIn = plannableTools([...tools]);
  const sessions = new Map<string, PreviousQuery>();

  const allowedFetchTools = (): ReadonlySet<string> =>
    new Set([...tools, ...plans.active().map((p) => p.tool)]);

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
    const specs = offeredTools(
      builtIn.filter((t) => permitted.has(t.name)),
      offered,
    );
    if (specs.length === 0) return agent('no-tools');
    const previous = req.sessionKey !== undefined ? sessions.get(req.sessionKey) : undefined;
    const prompt = buildTriagePrompt({ question, tools: specs, examples: offered, ...(previous ? { previous } : {}) });

    // #1540 — the turn has no privacy handle yet: with a shield running the
    // whole prompt goes through its stored-text scope (failure-closed).
    const guard = deps.privacyGuard();
    const privacy = guard !== undefined ? openStoredTextPrivacy(guard, TRIAGE_PRIVACY_JOB) : undefined;
    let content = prompt;
    if (privacy) {
      const masked = await privacy.mask(prompt);
      if (!masked.send) {
        deps.log(`[fast-path] triage skipped channel=${channel} (privacy: ${masked.reason})`);
        return agent('privacy-refused');
      }
      content = masked.text;
    }
    let text: string;
    try {
      const res = await deps.llm.complete({
        model: deps.model,
        system: TRIAGE_SYSTEM,
        messages: [{ role: 'user', content }],
        maxTokens: 1024,
        ...FAST_MODEL_REASONING,
      });
      text = privacy ? privacy.restore(res.text) : res.text;
    } catch (err) {
      deps.log(`[fast-path] triage failed channel=${channel}: ${err instanceof Error ? err.message : String(err)}`);
      return agent('triage-error');
    }
    const decision = parseTriage(text, allowedFetchTools());
    const triageMs = Date.now() - t0;
    if (decision.decision === 'agent') {
      deps.log(`[fast-path] triage channel=${channel} decision=agent:${decision.route ?? 'none'} ms=${triageMs}`);
      return {
        kind: 'agent',
        reason: decision.route ? `agent:${decision.route}` : 'agent',
        ms: triageMs,
        ...(decision.route ? { route: decision.route } : {}),
      };
    }
    deps.log(
      `[fast-path] triage channel=${channel} decision=${decision.decision === 'deterministic' ? 'deterministic' : 'invalid'} ms=${triageMs}`,
    );
    if (decision.decision === 'invalid') return agent(`invalid-plan:${decision.reason}`);
    if (!permitted.has(decision.fetch.tool)) return agent('tool-not-permitted');

    const fetched = await fetchRecipeRows(deps.invoke, decision.fetch, { rejectTruncated: true, timeZone });
    if (!fetched.ok) {
      if (fetched.detail !== undefined) {
        deps.log(`[fast-path] ${decision.fetch.tool} ${fetched.reason}: ${fetched.detail}`);
      }
      recordFetchOutcome([decision.fetch], false, fetched.reason);
      return agent(fetched.reason);
    }
    const rendered = renderSummary(decision.summary, {
      rows: fetched.rows,
      records: fetched.records,
      map: decision.fetch.map,
      ...(decision.locale !== undefined ? { locale: decision.locale } : {}),
    });
    if (!rendered.ok) {
      deps.log(`[fast-path] summary unresolvable: ${rendered.detail}`);
      return agent('summary-unresolvable');
    }
    const answer = renderChatAnswer({
      summary: rendered.text,
      rows: fetched.rows,
      columns: Object.keys(decision.fetch.map),
      labels: decision.labels,
      ...(decision.locale !== undefined ? { locale: decision.locale } : {}),
    });
    const learned = recordFetchOutcome([decision.fetch], true);
    remember(req.sessionKey, { question, fetch: decision.fetch });
    const ms = Date.now() - t0;
    deps.log(
      `[fast-path] hit channel=${channel} tool=${decision.fetch.tool} rows=${fetched.rows.length} ms=${ms}` +
        (learned.length > 0 ? ` plan=${learned.join(',')}` : ''),
    );
    return { kind: 'answer', text: answer, tool: decision.fetch.tool, rows: fetched.rows.length, toolCalls: 1, ms };
  }

  return {
    enabled,
    tools,
    timeZone,
    channelEnabled: (channel) => enabled && channelAllowed(channel),
    plans,
    plannableTools: () => [...builtIn],
    allowedFetchTools,
    recordFetchOutcome,
    triageChatTurn,
  };
}
