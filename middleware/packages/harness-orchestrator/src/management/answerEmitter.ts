/**
 * #2045 / #2046 — the single typed emitter of one agent (spec 2042 §5.5,
 * ADR-0013). Every emission declares its type and the checks follow it:
 *
 *  - `prose`    the identity guard (deterministic layer, then model layer on
 *               the masked text); refused text is replaced by an honest
 *               `system` notice;
 *  - `template` the template id must be registered and the values must have
 *               the declared types; no model call;
 *  - `data`     side-channel data: discretion and audience checks (#2085),
 *               never seen by a model; published as is here;
 *  - `system`   a management-layer notice; speaker `system`.
 *
 * A path that cannot name its speaker cannot emit: a `prose`, `template` or
 * `data` emission must carry this emitter's own agent as speaker.
 */

import type {
  AgentSpeaker,
  AnswerEmitter,
  Emission,
  EmissionRefusalReason,
  EmitOutcome,
  SystemNoticeCode,
  TemplateValue,
} from '@omadia/plugin-api';

import type { IdentityGuard, IdentityGuardResult } from '../identityGuard/guard.js';

import { buildSystemNotice, systemEmission } from './systemNotices.js';

export type TemplateValueType = 'string' | 'number' | 'boolean';

/** Registered templates: id → the type of each value it is filled with. */
export class TemplateRegistry {
  private readonly templates = new Map<string, Readonly<Record<string, TemplateValueType>>>();

  register(templateId: string, values: Readonly<Record<string, TemplateValueType>>): this {
    this.templates.set(templateId, values);
    return this;
  }

  /** `undefined` when the values fit the registered template, else why not. */
  check(templateId: string, values: Readonly<Record<string, TemplateValue>>): EmissionRefusalReason | undefined {
    const declared = this.templates.get(templateId);
    if (!declared) return 'template_unknown';
    const given = Object.keys(values);
    if (given.length !== Object.keys(declared).length) return 'template_values_invalid';
    for (const key of given) {
      if (declared[key] === undefined || typeof values[key] !== declared[key]) return 'template_values_invalid';
    }
    return undefined;
  }
}

export interface AgentAnswerEmitterOptions {
  readonly speaker: AgentSpeaker;
  /** A guard for one emission; `restoredValues` are masked for its model layer. */
  readonly guard: (restoredValues?: readonly string[]) => IdentityGuard;
  readonly templates?: TemplateRegistry;
  readonly locale?: () => string | undefined;
  readonly onGuardResult?: (result: IdentityGuardResult) => void;
}

export class AgentAnswerEmitter implements AnswerEmitter {
  constructor(private readonly options: AgentAnswerEmitterOptions) {}

  get speaker(): AgentSpeaker {
    return this.options.speaker;
  }

  /** A fresh identity guard for this agent (streaming checks sentence by sentence). */
  guardFor(restoredValues?: readonly string[]): IdentityGuard {
    return this.options.guard(restoredValues);
  }

  /** The locale `system` notices of this agent are worded in. */
  noticeLocale(): string | undefined {
    return this.options.locale?.();
  }

  /** Reports a guard result observed outside {@link emit} (streaming). */
  reportGuardResult(result: IdentityGuardResult): void {
    this.options.onGuardResult?.(result);
  }

  async emit(emission: Emission): Promise<EmitOutcome> {
    if (emission.type === 'system') return { published: true, emission };
    if (emission.speaker.agentId !== this.options.speaker.agentId) {
      return this.refuse('speaker_missing', 'agent_error');
    }
    if (emission.type === 'data') return { published: true, emission };
    if (emission.type === 'template') {
      const refusal = (this.options.templates ?? new TemplateRegistry()).check(emission.templateId, emission.values);
      return refusal ? this.refuse(refusal, 'agent_error') : { published: true, emission };
    }
    const result = await this.options.guard(emission.restoredValues).check(emission.text);
    this.options.onGuardResult?.(result);
    if (result.outcome === 'pass') return { published: true, emission };
    return result.outcome === 'blocked'
      ? this.refuse('identity_guard_blocked', 'identity_guard_blocked')
      : this.refuse('identity_guard_unavailable', 'identity_guard_unavailable');
  }

  private refuse(reason: EmissionRefusalReason, code: SystemNoticeCode): EmitOutcome {
    const { speaker } = this.options;
    const locale = this.options.locale?.();
    const notice = buildSystemNotice(code, {
      agent: { slug: speaker.slug, displayName: speaker.displayName, agentId: speaker.agentId },
      ...(locale ? { locale } : {}),
    });
    return { published: false, reason, replacement: systemEmission(notice) };
  }
}
