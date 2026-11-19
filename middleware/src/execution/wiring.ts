// #2090 — publishes 'executionAuthorization' as a per-caller service, keeps
// expired scopes swept, and hands the kernel the store's revocation and
// reservation operations.

import { archetypeOf, getArchetype, type OrchestratorRegistry } from '@omadia/orchestrator';
import {
  EXECUTION_AUTHORIZATION_SERVICE_NAME,
  perCallerService,
  type ExecutionAuthorizationService,
} from '@omadia/plugin-api';
import type { Pool } from 'pg';

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import { createExecutionAuthorizationService, type ExecutionAgent } from './executionAuthorizationService.js';
import { ExecutionScopeStore } from './scopeStore.js';

export interface ExecutionWiring {
  readonly store: ExecutionScopeStore;
  /** The execution authorization as the plugin `pluginId` gets it: for kernel
   *  services that draw an authorization on a plugin's behalf (`agentTurn@2`). */
  serviceFor(pluginId: string): ExecutionAuthorizationService;
  stop(): void;
}

export interface ExecutionWiringDeps {
  readonly pool: Pool;
  readonly serviceRegistry: ServiceRegistry;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  /** The bound engine of the legacy form (`facilitationEngine@1`), which
   *  delivers the kernel's own `facilitator` descriptor. */
  readonly legacyEnginePluginId: () => string | undefined;
  readonly configuringMaxHours: number;
  readonly sweepIntervalMs: number;
  /** #2089 — a reservation was released or a scope ended (by the plugin or by
   *  the sweep): message subscriptions follow at once. */
  readonly onAccessChanged?: () => void;
  readonly log: (message: string) => void;
}

export function wireExecutionAuthorization(deps: ExecutionWiringDeps): ExecutionWiring {
  const store = new ExecutionScopeStore(deps.pool);

  // The registry holds agents that are in service; a tombstone is not in it.
  const resolveAgent = (slug: string): ExecutionAgent | undefined => {
    const agent = deps.getRegistry()?.get(slug)?.agent;
    if (!agent) return undefined;
    return {
      id: agent.id,
      slug: agent.slug,
      archetype: archetypeOf(agent),
      enabled: agent.status === 'enabled',
    };
  };

  const archetypePluginIdFor = (archetypeId: string): string | undefined => {
    const source = getArchetype(archetypeId)?.source;
    if (source && source !== 'kernel') return source;
    return archetypeId === 'facilitator' ? deps.legacyEnginePluginId() : undefined;
  };

  const serviceFor = (pluginId: string): ExecutionAuthorizationService =>
    createExecutionAuthorizationService({
      store,
      callerPluginId: pluginId,
      resolveAgent,
      archetypePluginIdFor,
      configuringMaxMs: deps.configuringMaxHours * 3_600_000,
      ...(deps.onAccessChanged ? { onAccessChanged: deps.onAccessChanged } : {}),
      log: deps.log,
    });

  deps.serviceRegistry.provide(
    EXECUTION_AUTHORIZATION_SERVICE_NAME,
    // The kernel itself delivers no archetype, so it is refused like any
    // other caller that does not.
    perCallerService((caller) =>
      serviceFor(caller.pluginId === KERNEL_SERVICE_CALLER.pluginId ? '' : caller.pluginId),
    ),
  );

  const sweep = (): void => {
    store
      .sweepExpired()
      .then((swept) => {
        if (swept.scopesEnded > 0 || swept.reservationsReleased > 0) {
          deps.onAccessChanged?.();
          deps.log(
            `[execution] sweep: ${String(swept.scopesEnded)} scope(s) past their deadline ended, ${String(swept.reservationsReleased)} reservation(s) without an open scope released`,
          );
        }
      })
      .catch((err: unknown) => {
        deps.log(`[execution] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
  sweep();
  const timer = setInterval(sweep, deps.sweepIntervalMs);
  timer.unref();

  return {
    store,
    serviceFor,
    stop: () => {
      clearInterval(timer);
    },
  };
}
