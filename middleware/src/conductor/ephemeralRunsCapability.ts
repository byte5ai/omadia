// `conductorEphemeralRuns` as a per-caller service (epic #470 §2.2 pattern).
//
// The run service takes `agentId` as an argument, and before this module that
// argument was the only attribution: a granted plugin could name any other
// agent and read its facilitation payloads (goal, conversation id, deadline),
// overwrite its state or cancel its runs. The owner-scoped methods now compare
// the caller-supplied agentId against the kernel-known caller (the plugin id
// the kernel activated the plugin under) and refuse a mismatch with the SAME
// answer an unknown run gets — empty list / saved:false / not_found — so a
// probing plugin learns nothing, while the mismatch is logged for operators.
//
// createEphemeralRun and poke stay pass-through for backwards compatibility:
// the Facilitator already passes its own plugin id, and a create cannot touch
// another agent's existing runs (it only spends quota under the named id).
// A mismatching create is logged so a misbehaving plugin is visible.

import type { ServiceCaller } from '@omadia/plugin-api';

import type {
  CancelOwnRunInput,
  CancelOwnRunResult,
  ConductorEphemeralRunService,
  CreateEphemeralRunInput,
  EphemeralRunHandle,
  OwnEphemeralRun,
  SaveRunStateInput,
} from './ephemeralRunService.js';
import { sanitizeForLog } from './ephemeralRunService.js';

/** What a plugin resolving `conductorEphemeralRuns` receives. */
export type EphemeralRunsCapability = Pick<
  ConductorEphemeralRunService,
  'createEphemeralRun' | 'poke' | 'listOwnRuns' | 'saveRunState' | 'cancelOwnRun'
>;

function claimedAgentId(input: unknown): string {
  const raw = typeof input === 'object' && input !== null ? (input as { agentId?: unknown }).agentId : undefined;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Bind the service to one consuming plugin. `caller.agentId` comes from the
 * kernel's service registry, never from the plugin.
 */
export function bindEphemeralRunsToCaller(
  service: ConductorEphemeralRunService,
  caller: ServiceCaller,
  log: (msg: string) => void,
): EphemeralRunsCapability {
  const callerId = caller.agentId;
  const isCaller = (input: unknown): boolean => {
    const claimed = claimedAgentId(input);
    if (claimed === callerId) return true;
    log(
      `[conductor] conductorEphemeralRuns: plugin '${sanitizeForLog(callerId)}' claimed agentId '${sanitizeForLog(claimed)}' — refused`,
    );
    return false;
  };

  return {
    createEphemeralRun: (input: CreateEphemeralRunInput): Promise<EphemeralRunHandle> => {
      const claimed = claimedAgentId(input);
      if (claimed !== callerId) {
        log(
          `[conductor] conductorEphemeralRuns.createEphemeralRun: plugin '${sanitizeForLog(callerId)}' creates as '${sanitizeForLog(claimed)}'`,
        );
      }
      return service.createEphemeralRun(input);
    },
    poke: (runId: string) => service.poke(runId),
    listOwnRuns: async (input: { agentId: string }): Promise<OwnEphemeralRun[]> =>
      isCaller(input) ? service.listOwnRuns({ agentId: callerId }) : [],
    saveRunState: async (input: SaveRunStateInput): Promise<{ saved: boolean }> =>
      isCaller(input) ? service.saveRunState({ ...input, agentId: callerId }) : { saved: false },
    cancelOwnRun: async (input: CancelOwnRunInput): Promise<CancelOwnRunResult> =>
      isCaller(input)
        ? service.cancelOwnRun({ ...input, agentId: callerId })
        : { cancelled: false, reason: 'not_found' },
  };
}
