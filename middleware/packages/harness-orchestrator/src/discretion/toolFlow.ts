/**
 * Spec 2042 §5.11 at the tool boundary:
 *
 * - **Entry:** a capability result carries the label of its source system
 *   (`restricted` when the operator declared the system restricted) and, when
 *   the privacy shield let classified fields through unmasked (an operator
 *   bypass), the classification `personal`.
 * - **Egress:** a call that may write data out is checked against the
 *   integration's declared readership BEFORE it runs. A refused call returns a
 *   structured refusal to the model; it never runs and is audited, with label
 *   ids only. What writes:
 *   - `write`: a declared `writeCapabilities` (#542), a manifest
 *     `capabilities[].side_effects: write`, or an MCP tool without
 *     `readOnlyHint` — checked against every label;
 *   - `read` / `none` (declared, or an MCP `readOnlyHint`) — not checked;
 *   - `unknown` (declared nothing) — like a write, checked against every
 *     label (since the contract step, S3b: every published plugin declares
 *     its tools' effects, so a tool that declares none is the exception).
 */

import { turnContext } from '../turnContext.js';
import { checkFlow, violationSummary } from './flowRule.js';
import { labelSummary, unionLabels, UNKNOWN_READERS, type DiscretionLabel, type Readers } from './labels.js';
import type { DiscretionPort, LabelSubjectKind } from './port.js';
import { addTurnLabels, currentDiscretion, resolvedTurnLabels } from './turnLabels.js';

/** What a tool declared it does to its system (`unknown`: nothing declared). */
export type ToolEffect = 'read' | 'write' | 'none' | 'unknown';

/** Which system a tool belongs to, and what calling it does there. */
export interface ToolSystem {
  /** Plugin id, or `mcp:<serverId>` for an MCP server's tool. */
  readonly system: string;
  /**
   * What the runtime knows from the tool itself (`writeCapabilities`, MCP
   * annotations). `unknown` is refined through the plugin's manifest
   * (`DiscretionPort.toolEffectOf`).
   */
  readonly effect: ToolEffect;
  /** A plugin's sub-agent (domain tool): refined by the plugin's declarations as a whole. */
  readonly subAgent?: boolean;
}

function effectOf(port: DiscretionPort | undefined, toolName: string, tool: ToolSystem): ToolEffect {
  if (tool.effect !== 'unknown') return tool.effect;
  if (tool.subAgent) return port?.pluginEffectOf?.(tool.system) ?? 'unknown';
  return port?.toolEffectOf?.(tool.system, toolName) ?? 'unknown';
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
  if (!state || !tool) return undefined;
  const effect = effectOf(port, toolName, tool);
  if (effect === 'read' || effect === 'none') return undefined;
  // `write` and `unknown` alike: every label of the turn.
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
    'Error: memory was not changed. This turn holds information from another conversation ' +
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

/**
 * Spec 2042 §5.11 — a written subject (a memorable) keeps the active turn's
 * labels, plus `extra`. Outside a labelled turn, or with nothing to keep:
 * nothing. Never throws; a failure is logged (the subject stays unlabelled).
 */
export async function labelSubjectWithTurn(
  port: DiscretionPort | undefined,
  kind: LabelSubjectKind,
  id: string,
  agentSlug: string,
  extra: readonly DiscretionLabel[] = [],
): Promise<void> {
  const state = currentDiscretion();
  if (!port || !state) return;
  const labels = unionLabels(await resolvedTurnLabels(state), extra);
  if (labels.labels.length === 0) return;
  await port.persistLabels(kind, id, agentSlug, labels).catch((err: unknown) => {
    console.error(`[discretion] persisting the labels of ${kind} ${id} failed:`, err);
  });
}

/**
 * Spec 2042 §5.11 — reusing written subjects (recalled turns, memorables,
 * processes) adds the labels they kept to the active turn. A lookup failure
 * fails closed: the turn gets a label nobody is known to be allowed to read,
 * so nothing of it can flow outside this conversation. Never throws.
 */
export async function labelTurnWithSubjects(
  port: DiscretionPort | undefined,
  kind: LabelSubjectKind,
  ids: readonly string[],
): Promise<void> {
  if (!port || ids.length === 0 || !currentDiscretion()) return;
  try {
    const found = await port.labelsOf(kind, ids);
    for (const labels of found.values()) addTurnLabels(labels);
  } catch (err) {
    console.error(`[discretion] ${kind} label lookup failed — labelling the turn unreadable:`, err);
    addTurnLabels([{ kind: 'context', key: 'unreadable', readers: UNKNOWN_READERS }]);
  }
}
