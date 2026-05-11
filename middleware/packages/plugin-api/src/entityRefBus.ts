import { EventEmitter } from 'node:events';
import type { EntityRef } from './entityRef.js';

/**
 * In-memory pub/sub for EntityRefs observed at tool-execution time. Odoo /
 * Confluence core helpers publish; the Orchestrator opens a collection for
 * the duration of a single chat turn and drains the captured refs into the
 * session transcript.
 *
 * Correlation: every `publish` tags the ref with the active turnId from
 * `getCurrentTurnId()`. `beginCollection(turnId)` filters for exact matches,
 * so concurrent turns (e.g. two Teams conversations) don't cross-contaminate.
 * Refs published outside any turn context are dropped — they have no home.
 *
 * S+8 sub-commit 2a: the turn-id getter is dependency-injected (was a direct
 * import of the kernel-side `turnContext` AsyncLocalStorage). Kernel binds
 * with `() => turnContext.currentTurnId()`. Tests construct without args and
 * get a no-op getter (refs published outside `beginCollection` are dropped).
 */
export interface EntityRefBusOptions {
  getCurrentTurnId?: () => string | undefined;
}

export class EntityRefBus {
  private readonly emitter = new EventEmitter();
  private readonly getCurrentTurnId: () => string | undefined;

  constructor(opts: EntityRefBusOptions = {}) {
    this.emitter.setMaxListeners(256);
    this.getCurrentTurnId = opts.getCurrentTurnId ?? ((): string | undefined => undefined);
  }

  publish(ref: EntityRef): void {
    const turnId = this.getCurrentTurnId();
    this.emitter.emit('ref', { ref, turnId });
  }

  /**
   * Opens a collection handle for a single turn. Subscribes to the bus and
   * accumulates every `publish` whose turnId matches. The caller must invoke
   * `drain()` exactly once — the `finally` in the orchestrator ensures that
   * even on thrown errors.
   */
  beginCollection(turnId: string): EntityRefCollection {
    const collected: EntityRef[] = [];
    const listener = (envelope: { ref: EntityRef; turnId: string | undefined }): void => {
      if (envelope.turnId === turnId) collected.push(envelope.ref);
    };
    this.emitter.on('ref', listener);
    let drained = false;
    return {
      drain: (): EntityRef[] => {
        if (drained) return [];
        drained = true;
        this.emitter.off('ref', listener);
        return [...collected];
      },
    };
  }
}

export interface EntityRefCollection {
  drain(): EntityRef[];
}
