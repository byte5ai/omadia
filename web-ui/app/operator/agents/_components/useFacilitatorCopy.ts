'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import {
  FACILITATOR_PERSONA_MAX,
  FACILITATOR_PERSONA_MIN,
  isFacilitatorIssueRule,
  issueAxis,
  parseFacilitatorRefusal,
  type FacilitatorContractIssue,
} from '../../../_lib/facilitators';
import { PERSONA_AXIS_LABELS } from '../../../_lib/personaTypes';

/**
 * #2066 — catalogue copy for the two facilitator refusals.
 *
 * The server answers with English prose (`message`) plus stable machine
 * fields (`omission`, `issues[].rule`). The UI renders the catalogue sentence
 * for the machine field and keeps the server prose as detail only, for a rule
 * this client has no copy for yet (web-ui i18n hard rule).
 */

/** `(err) => sentence`, or `null` when the error is not a facilitator refusal. */
export function useFacilitatorRefusalMessage(): (err: unknown) => string | null {
  const t = useTranslations('operatorAgents.facilitator');
  return useCallback(
    (err: unknown): string | null => {
      const refusal = parseFacilitatorRefusal(err);
      if (!refusal) return null;
      if (refusal.kind === 'contract') {
        return t('contractRejected', { count: refusal.issues.length });
      }
      const reason = t(`omissions.${refusal.omission ?? 'unknown'}`);
      return refusal.refusedPlugins.length > 0
        ? t('omissionWithPlugins', {
            reason,
            plugins: refusal.refusedPlugins.join(', '),
          })
        : reason;
    },
    [t],
  );
}

/** `(issue) => sentence` for one finding of a 422 `facilitator_contract_violation`. */
export function useFacilitatorIssueText(): (
  issue: FacilitatorContractIssue,
) => string {
  const t = useTranslations('operatorAgents.facilitator.issues');
  return useCallback(
    (issue: FacilitatorContractIssue): string => {
      if (!isFacilitatorIssueRule(issue.rule)) {
        return t('unknown', { detail: issue.message });
      }
      const axis = issueAxis(issue.path);
      if (issue.rule === 'persona_axis_above_bound') {
        return t(issue.rule, {
          axis: axis ? PERSONA_AXIS_LABELS[axis].right : issue.path,
          bound: axis ? (FACILITATOR_PERSONA_MAX[axis] ?? 0) : 0,
        });
      }
      if (issue.rule === 'persona_axis_below_bound') {
        return t(issue.rule, {
          axis: axis ? PERSONA_AXIS_LABELS[axis].right : issue.path,
          bound: axis ? (FACILITATOR_PERSONA_MIN[axis] ?? 0) : 0,
        });
      }
      if (issue.rule === 'sycophancy_guard_off') return t(issue.rule);
      return issue.excerpt
        ? t('withExcerpt', { reason: t(issue.rule), excerpt: issue.excerpt })
        : t(issue.rule);
    },
    [t],
  );
}
