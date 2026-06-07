/**
 * Plugin self-extension — append-only audit trail.
 *
 * Every self-modification leaves a record: who proposed what, the guard's
 * verdict (incl. the exact escalations on a denial), the operator decision and
 * any narrowing, and the final install outcome. Append-only with a monotonic
 * `seq` so the history cannot be silently rewritten; an optional `sink` lets a
 * caller mirror events to durable storage without this module taking a
 * filesystem/db dependency.
 */

import type { SurfaceWidening } from './permissionSurface.js';

export type SelfExtensionAuditType =
  | 'proposed'
  | 'denied_escalation'
  | 'invalid_spec'
  | 'approved'
  | 'narrowed'
  | 'denied_by_operator'
  | 'installed'
  | 'install_failed';

export interface SelfExtensionAuditEvent {
  readonly seq: number;
  readonly at: number;
  readonly type: SelfExtensionAuditType;
  readonly pluginId: string;
  readonly proposalId: string;
  /** Operator email for decision events; agent/system id for `proposed`. */
  readonly actor: string;
  readonly detail: string;
  /** Present on `denied_escalation` — the precise widenings that blocked it. */
  readonly escalations?: readonly SurfaceWidening[];
}

export interface SelfExtensionAuditInput {
  type: SelfExtensionAuditType;
  pluginId: string;
  proposalId: string;
  actor: string;
  detail: string;
  escalations?: readonly SurfaceWidening[];
}

export interface SelfExtensionAuditOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional durable mirror. Failures here are swallowed — the audit log must
   *  never break the lifecycle it observes. */
  sink?: (event: SelfExtensionAuditEvent) => void;
}

export class SelfExtensionAudit {
  private readonly events: SelfExtensionAuditEvent[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly sink: SelfExtensionAuditOptions['sink'];

  constructor(opts: SelfExtensionAuditOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.sink = opts.sink;
  }

  record(input: SelfExtensionAuditInput): SelfExtensionAuditEvent {
    const event: SelfExtensionAuditEvent = {
      seq: ++this.seq,
      at: this.now(),
      type: input.type,
      pluginId: input.pluginId,
      proposalId: input.proposalId,
      actor: input.actor,
      detail: input.detail,
      ...(input.escalations ? { escalations: input.escalations } : {}),
    };
    this.events.push(event);
    if (this.sink) {
      try {
        this.sink(event);
      } catch {
        // never let the durable mirror break the in-memory trail
      }
    }
    return event;
  }

  /** Immutable snapshot, optionally filtered by proposal or plugin. */
  list(filter?: { proposalId?: string; pluginId?: string }): SelfExtensionAuditEvent[] {
    return this.events.filter((e) => {
      if (filter?.proposalId && e.proposalId !== filter.proposalId) return false;
      if (filter?.pluginId && e.pluginId !== filter.pluginId) return false;
      return true;
    });
  }
}
