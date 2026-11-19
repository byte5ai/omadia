// #2090 — publishes 'executionAuthorization' as a per-caller service, keeps
// expired scopes swept, and hands the kernel the store's revocation and
// reservation operations.

import { archetypeOf, getArchetype, type OrchestratorRegistry } from '@omadia/orchestrator';
import { EXECUTION_AUTHORIZATION_SERVICE_NAME, perCallerService } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import { createExecutionAuthorizationService, type ExecutionAgent } from './executionAuthorizationService.js';
import { ExecutionScopeStore } from './scopeStore.js';

export interface ExecutionWiring {
  readonly store: ExecutionScopeStore;
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

  deps.serviceRegistry.provide(
    EXECUTION_AUTHORIZATION_SERVICE_NAME,
    perCallerService((caller) =>
      createExecutionAuthorizationService({
        store,
        // The kernel itself delivers no archetype, so it is refused like any
        // other caller that does not.
        callerPluginId: caller.pluginId === KERNEL_SERVICE_CALLER.pluginId ? '' : caller.pluginId,
        resolveAgent,
        archetypePluginIdFor,
        configuringMaxMs: deps.configuringMaxHours * 3_600_000,
        log: deps.log,
      }),
    ),
  );

  const sweep = (): void => {
    store
      .sweepExpired()
      .then((swept) => {
        if (swept.scopesEnded > 0 || swept.reservationsReleased > 0) {
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
    stop: () => {
      clearInterval(timer);
    },
  };
}
