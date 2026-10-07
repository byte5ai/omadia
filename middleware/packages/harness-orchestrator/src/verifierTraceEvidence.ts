import { knowledgeGraphRefsOf, type RunTracePayload } from './runTraceCollector.js';

/**
 * What the answer verifier reads from a turn's run trace: the tools and
 * sub-agents it called, whether it reached the knowledge graph, and the tool
 * postcondition violations the bridge recorded. Pure; used by
 * `VerifierService.safeVerify` to build the pipeline input.
 */

/**
 * Flatten a RunTrace into the list of tool / sub-agent names invoked in
 * this turn. Used by the pipeline's trace-cross-check rule to spot
 * accounting/HR numeric claims that arrived WITHOUT a fresh fach-agent
 * call — i.e. the orchestrator replayed numbers from the context block.
 *
 * Returns `undefined` when no trace is available — the pipeline then
 * skips the check rather than treating "no evidence" as "no tool call".
 */
export function extractToolsCalled(
  trace: RunTracePayload | undefined,
): string[] | undefined {
  if (!trace) return undefined;
  const names = new Set<string>();
  for (const invocation of trace.agentInvocations) {
    names.add(invocation.agentName);
    for (const call of invocation.toolCalls) {
      names.add(call.toolName);
    }
  }
  for (const call of trace.orchestratorToolCalls) {
    names.add(call.toolName);
  }
  return [...names];
}

/**
 * #131 — true when this turn invoked the knowledge-graph (or any of the
 * KG-backed sub-agent / orchestrator tools the verifier counts as
 * "fetched evidence"). The pipeline uses this as the gate for the
 * citation-missing check: no KG call ⇒ citations are irrelevant.
 */
export function extractKnowledgeGraphToolsCalled(
  trace: RunTracePayload | undefined,
): boolean | undefined {
  if (!trace) return undefined;
  const KG_NAMES: ReadonlySet<string> = new Set(['query_knowledge_graph']);
  for (const call of trace.orchestratorToolCalls) {
    if (KG_NAMES.has(call.toolName)) return true;
  }
  for (const inv of trace.agentInvocations) {
    for (const call of inv.toolCalls) {
      if (KG_NAMES.has(call.toolName)) return true;
    }
  }
  return false;
}

/**
 * The source ids this turn's knowledge-graph results showed the model — what
 * a `[ref:…]` marker may name. Undefined when there is no trace or the trace
 * predates the field; an empty list when the graph returned nothing citable.
 */
export function extractKnowledgeGraphRefs(
  trace: RunTracePayload | undefined,
): readonly string[] | undefined {
  return trace ? knowledgeGraphRefsOf(trace) : undefined;
}

/**
 * Names of the calls in this turn that failed (`isError`), orchestrator and
 * sub-agent alike. A claim of a failed or missing access needs one of them.
 * Undefined when no trace is available.
 */
export function extractFailedToolsCalled(
  trace: RunTracePayload | undefined,
): string[] | undefined {
  if (!trace) return undefined;
  const names = new Set<string>();
  for (const call of trace.orchestratorToolCalls) {
    if (call.isError) names.add(call.toolName);
  }
  for (const invocation of trace.agentInvocations) {
    if (invocation.status === 'error') names.add(invocation.agentName);
    for (const call of invocation.toolCalls) {
      if (call.isError) names.add(call.toolName);
    }
  }
  return [...names];
}

/**
 * #130 — collect every postcondition violation the bridgeTool stamped onto
 * the runTrace. The verifier turns each entry into a synthetic
 * `tool_postcondition` ClaimVerdict (status='contradicted'), which flips the
 * verdict to `blocked` and drives the existing correctionPrompt retry loop.
 */
export function extractPostconditionViolations(
  trace: RunTracePayload | undefined,
): {
  toolName: string;
  callId: string;
  agentContext: string;
  issues: readonly string[];
}[] {
  if (!trace) return [];
  const out: {
    toolName: string;
    callId: string;
    agentContext: string;
    issues: readonly string[];
  }[] = [];
  for (const invocation of trace.agentInvocations) {
    for (const call of invocation.toolCalls) {
      if (call.postcondition) {
        out.push({
          toolName: call.toolName,
          callId: call.callId,
          agentContext: call.agentContext,
          issues: call.postcondition.issues,
        });
      }
    }
  }
  for (const call of trace.orchestratorToolCalls) {
    if (call.postcondition) {
      out.push({
        toolName: call.toolName,
        callId: call.callId,
        agentContext: call.agentContext,
        issues: call.postcondition.issues,
      });
    }
  }
  return out;
}
