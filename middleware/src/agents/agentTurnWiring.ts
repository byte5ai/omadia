// Publishes 'agentTurn' (#2043) as a per-caller service: the kernel knows
// which plugin asks, and only the facilitation engine is answered.

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import { AGENT_TURN_SERVICE_NAME, perCallerService } from '@omadia/plugin-api';

import type { ConversationMessageHub } from '../channels/conversationMessages/hub.js';
import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from '../platform/facilitatorGuard.js';
import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import { AgentTurnBudget, AgentTurnHistory, createAgentTurnService } from './agentTurnService.js';

export function publishAgentTurnService(deps: {
  serviceRegistry: ServiceRegistry;
  getRegistry: () => OrchestratorRegistry | undefined;
  messages?: Pick<ConversationMessageHub, 'getEventById'>;
  engineSources: () => FacilitationEngineSources;
  maxTurnsPerMinute: number;
  language?: () => string | undefined;
  log: (message: string) => void;
}): void {
  // One history and one budget for the process, shared by every facade.
  const history = new AgentTurnHistory();
  const budget = new AgentTurnBudget(deps.maxTurnsPerMinute);
  deps.serviceRegistry.provide(
    AGENT_TURN_SERVICE_NAME,
    perCallerService((caller) => {
      const isKernel = caller.pluginId === KERNEL_SERVICE_CALLER.pluginId;
      return createAgentTurnService({
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
        log: deps.log,
      });
    }),
  );
}
