import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

import type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';

/** Resolve a dot-path over a plain object root (for prompt interpolation). */
function resolve(root: JsonObject, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, JsonValue>)[seg];
  }
  return cur;
}

/** Replace `{{ctx.path}}` / `{{steps.id.field}}` tokens in a prompt template. */
function renderTemplate(tpl: string, root: JsonObject): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = resolve(root, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

export interface RealStepEffectsDeps {
  /** the multi-orchestrator registry — resolves an Agent (orchestrator) by slug. */
  getRegistry: () => OrchestratorRegistry | undefined;
  /** invoke a deterministic-action / connector tool by id (dynamicAgentRuntime). */
  invokeAction?: (toolId: string, input: unknown) => Promise<string | undefined>;
  log?: (msg: string) => void;
}

/**
 * Real step execution — no stubs.
 *  - agent step: resolves `step.agentId` (an Agent / orchestrator-instance slug) in the
 *    multi-orchestrator registry and runs a genuine turn via `bundle.agent.chat(...)`,
 *    the same headless entrypoint the schedule worker uses. The Agent's prose answer
 *    becomes the step result (`{ text }`).
 *  - action step: invokes the named connector/deterministic tool and captures its output.
 *
 * This is the seam that distinguishes an *Agent* (an independent orchestrator instance that
 * runs a full tool/sub-agent/memory loop) from a sub-agent or a bare model call.
 */
export class RealStepEffects implements StepEffects {
  constructor(private readonly deps: RealStepEffectsDeps) {}

  async runAgentStep(step: Step, context: JsonObject, meta: StepMeta): Promise<StepExecution> {
    const slug = step.agentId;
    if (!slug) throw new Error(`agent step '${step.id}' has no agentId (Agent slug)`);

    const registry = this.deps.getRegistry();
    if (!registry) throw new Error('orchestrator registry is unavailable (no graphPool / registry not built)');

    const entry = registry.get(slug);
    if (!entry) {
      throw new Error(`Agent '${slug}' is not active in the orchestrator registry`);
    }

    const root: JsonObject = { ctx: context, steps: asObject(context.steps) };
    const userMessage = step.prompt
      ? renderTemplate(step.prompt, root)
      : `Conductor workflow step "${step.id}". Run your configured task. Run context: ${JSON.stringify(context)}`;

    this.deps.log?.(`[conductor] agent step '${step.id}' → Agent '${slug}' (run ${meta.runId})`);
    const answer = await entry.built.bundle.agent.chat({
      userMessage,
      sessionScope: `conductor:${meta.runId}:${step.id}`,
    });

    return {
      result: { text: answer.text },
      actor: { kind: 'agent', agentSlug: slug },
    };
  }

  async runActionStep(step: Step, _context: JsonObject, meta: StepMeta): Promise<StepExecution> {
    const toolId = step.actionId;
    if (!toolId) throw new Error(`action step '${step.id}' has no actionId`);
    if (!this.deps.invokeAction) throw new Error('action execution is not wired (no deterministic-action invoker)');

    const input = step.input ?? {};
    this.deps.log?.(`[conductor] action step '${step.id}' → tool '${toolId}' (run ${meta.runId})`);
    const out = await this.deps.invokeAction(toolId, input);
    if (out === undefined) {
      throw new Error(`action '${toolId}' is not registered or returned nothing`);
    }

    let data: JsonValue;
    try {
      data = JSON.parse(out) as JsonValue;
    } catch {
      data = out;
    }
    return {
      result: { text: out, data },
      actor: { kind: 'action', actionId: toolId },
    };
  }
}
