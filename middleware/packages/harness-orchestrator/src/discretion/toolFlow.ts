/**
 * Spec 2042 §5.11 at the tool boundary:
 *
 * - **Entry:** a capability result carries the label of its source system
 *   (`restricted` when the operator declared the system restricted) and, when
 *   the privacy shield let classified fields through unmasked (an operator
 *   bypass), the classification `personal`.
 * - **Egress:** a call that may write data out (declared write capability, or
 *   an MCP tool that does not declare itself read-only) is checked against the
 *   integration's declared readership BEFORE it runs. A refused call returns a
 *   structured refusal to the model; it never runs and is audited, with label
 *   ids only.
 */

import { turnContext } from '../turnContext.js';
import { checkFlow, violationSummary } from './flowRule.js';
import { labelSummary, type DiscretionLabel, type Readers } from './labels.js';
import type { DiscretionPort } from './port.js';
import { addTurnLabels, currentDiscretion, resolvedTurnLabels } from './turnLabels.js';

/** Which system a tool belongs to, and whether calling it may write data out. */
export interface ToolSystem {
  /** Plugin id, or `mcp:<serverId>` for an MCP server's tool. */
  readonly system: string;
  readonly mayWrite: boolean;
}

/** The refusal text the model gets: the reason, never the withheld content. */
export function integrationRefusal(toolName: string): string {
  return (
    `Error: \`${toolName}\` was not called. This turn holds information that may not be sent to ` +
    'that system (discretion: its declared readership does not cover where the information came from). ' +
    'Tell the user plainly that you cannot pass it on there, without quoting it.'
  );
}

/**
 * Check an outbound call before it runs. Returns the refusal text, or
 * undefined when the call may proceed. Outside a labelled turn: undefined.
 */
export async function guardIntegrationEgress(
  port: DiscretionPort | undefined,
  toolName: string,
  tool: ToolSystem | undefined,
): Promise<string | undefined> {
  const state = currentDiscretion();
  if (!state || !tool?.mayWrite) return undefined;
  const labels = await resolvedTurnLabels(state);
  const declaration = await port?.declarationOf(tool.system);
  const decision = checkFlow(labels, {
    kind: 'integration',
    system: tool.system,
    ...(declaration ? { readership: declaration.readership } : {}),
    ...(state.contextKey !== undefined ? { currentContextKey: state.contextKey } : {}),
  });
  const crossContext = labels.labels.some((l) => l.kind === 'context' && l.key !== state.contextKey);
  if (!decision.allowed || crossContext) {
    const ctx = turnContext.current();
    port?.audit({
      ...(ctx?.turnId ? { turnId: ctx.turnId } : {}),
      ...(ctx?.agentSlug ? { agentSlug: ctx.agentSlug } : {}),
      egress: 'integration',
      target: tool.system,
      allowed: decision.allowed,
      labels: labelSummary(labels),
      violations: violationSummary(decision),
    });
  }
  return decision.allowed ? undefined : integrationRefusal(toolName);
}

/** Label what a tool call brought into the turn. */
export async function labelToolRead(
  port: DiscretionPort | undefined,
  tool: ToolSystem | undefined,
): Promise<void> {
  const state = currentDiscretion();
  if (!state || !tool) return;
  const declaration = await port?.declarationOf(tool.system).catch(() => undefined);
  const labels: DiscretionLabel[] = [
    { kind: 'source', system: tool.system, restricted: declaration?.sensitivity === 'restricted' },
  ];
  // The shield let classified fields through for this turn (operator bypass):
  // the model saw personal data unmasked.
  if (turnContext.current()?.privacyHandle?.hasBypassed?.() === true) {
    labels.push({ kind: 'classification', class: 'personal' });
  }
  addTurnLabels(labels);
}

/** The refusal text the model gets for a memory write that would carry too much. */
export function memoryRefusal(): string {
  return (
    'Error: nothing was written to memory. This turn holds information from another conversation ' +
    'that not everyone who can read this memory may know (discretion). Do not try to store it in other words.'
  );
}

/**
 * Spec 2042 §5.11 "Memory write" — may what this turn has read be written
 * into a memory tier read by `readers`? The turn's own conversation always
 * passes into its own tiers; knowledge from elsewhere passes only when every
 * reader of the tier may know it. Returns the refusal, or undefined.
 * Outside a labelled turn: undefined.
 */
export async function guardMemoryEgress(
  port: DiscretionPort | undefined,
  readers: Readers,
  target: string,
): Promise<string | undefined> {
  const state = currentDiscretion();
  if (!state) return undefined;
  const labels = await resolvedTurnLabels(state);
  const decision = checkFlow(labels, {
    kind: 'memory',
    ...(state.contextKey !== undefined ? { contextKey: state.contextKey } : {}),
    readers,
  });
  const crossContext = labels.labels.some((l) => l.kind === 'context' && l.key !== state.contextKey);
  if (!decision.allowed || crossContext) {
    const ctx = turnContext.current();
    port?.audit({
      ...(ctx?.turnId ? { turnId: ctx.turnId } : {}),
      ...(ctx?.agentSlug ? { agentSlug: ctx.agentSlug } : {}),
      egress: 'memory',
      target,
      allowed: decision.allowed,
      labels: labelSummary(labels),
      violations: violationSummary(decision),
    });
  }
  return decision.allowed ? undefined : memoryRefusal();
}
