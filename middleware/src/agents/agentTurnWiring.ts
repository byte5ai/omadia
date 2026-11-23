// Publishes 'agentTurn@2' (#2043, #2090) as a per-caller service: the kernel
// knows which plugin asks, and only the facilitation engine is answered.

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import {
  AGENT_TURN_V2_SERVICE_NAME,
  perCallerService,
  type ExecutionAuthorizationService,
} from '@omadia/plugin-api';
import { meterModelCalls } from '@omadia/usage-telemetry';

import type { ConversationMessageHub } from '../channels/conversationMessages/hub.js';
import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from '../platform/facilitatorGuard.js';
import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import {
  AgentTurnBudget,
  AgentTurnHistory,
  createScopedAgentTurnService,
  type AgentTurnServiceDeps,
} from './agentTurnService.js';

export function publishAgentTurnService(deps: {
  serviceRegistry: ServiceRegistry;
  getRegistry: () => OrchestratorRegistry | undefined;
  messages?: Pick<ConversationMessageHub, 'getProcessEventById'>;
  engineSources: () => FacilitationEngineSources;
  /** #2090 — the calling plugin's execution authorization, for `agentTurn@2`.
   *  Answers `undefined` without a database. */
  executionFor?: (pluginId: string) => ExecutionAuthorizationService | undefined;
  maxTurnsPerMinute: number;
  language?: () => string | undefined;
  /** #2048 — the conversation roster as the agent's own identity. */
  roster?: AgentTurnServiceDeps['roster'];
  /** #2066 — the agent's archetype settings, for the profile. */
  archetypeSettings?: AgentTurnServiceDeps['archetypeSettings'];
  log: (message: string) => void;
}): void {
  // One history and one budget for the process, shared by every facade.
  const history = new AgentTurnHistory();
  const budget = new AgentTurnBudget(deps.maxTurnsPerMinute);
  const depsFor = (caller: { pluginId: string }): AgentTurnServiceDeps => {
    const isKernel = caller.pluginId === KERNEL_SERVICE_CALLER.pluginId;
    return {
      getRegistry: deps.getRegistry,
      ...(deps.messages ? { messages: deps.messages } : {}),
      callerPluginId: isKernel ? undefined : caller.pluginId,
      isEngine: () => {
        const engine = resolveFacilitationEngine(deps.engineSources());
        return engine.state === 'bound' && engine.pluginId === caller.pluginId;
      },
      history,
      budget,
      ...(deps.language ? { language: deps.language } : {}),
      ...(deps.roster ? { roster: deps.roster } : {}),
      ...(deps.archetypeSettings ? { archetypeSettings: deps.archetypeSettings } : {}),
      log: deps.log,
    };
  };
  // #2090 — a model turn is an authorized action under an execution scope
  // (`agentTurn@2`); the bare name `agentTurn` provides nothing.
  deps.serviceRegistry.provide(
    AGENT_TURN_V2_SERVICE_NAME,
    perCallerService((caller) =>
      createScopedAgentTurnService({
        ...depsFor(caller),
        execution: () => deps.executionFor?.(caller.pluginId),
        meter: meterModelCalls,
      }),
    ),
  );
}
