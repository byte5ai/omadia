import {
  FALLBACK_AGENT_SEED_DESCRIPTION,
  FALLBACK_AGENT_SEED_NAME,
  FALLBACK_AGENT_SLUG,
} from '@omadia/orchestrator';

import { isPreviewDraftAgentSlug } from '../plugins/builder/previewDraftAgents.js';

/**
 * #2054 — spec 2042 §7 "Onboarding": a fresh installation starts with no agent
 * holding any capability; the first-run flow creates the first agent with an
 * explicit choice of capabilities (no preselection, zero allowed).
 *
 * The first-run flow is due while the instance has no agent of the operator's
 * making:
 *  - no agent at all → the flow creates one;
 *  - only the boot seed, untouched (seed slug, name and description, no plugin
 *    row) → the flow turns the seed into the first agent. The seed exists for
 *    routing (`ensureFallbackAgent`); its name and description are the
 *    kernel's, so changing them is what marks it as the operator's.
 * Anything else — a second agent, a renamed seed, a seed with a grant — is
 * the operator's configuration and the flow is not offered.
 */

export interface OnboardingAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
}

export type OnboardingTarget =
  | { readonly kind: 'create' }
  | { readonly kind: 'seed'; readonly agent: OnboardingAgent };

export function onboardingTarget(
  agents: readonly OnboardingAgent[],
  pluginRowsOf: (agentId: string) => number,
): OnboardingTarget | undefined {
  if (agents.length === 0) return { kind: 'create' };
  const [only] = agents;
  if (agents.length !== 1 || !only) return undefined;
  const untouched =
    only.slug === FALLBACK_AGENT_SLUG &&
    only.name === FALLBACK_AGENT_SEED_NAME &&
    only.description === FALLBACK_AGENT_SEED_DESCRIPTION &&
    pluginRowsOf(only.id) === 0;
  return untouched ? { kind: 'seed', agent: only } : undefined;
}

const MAX_SLUG_LENGTH = 64;

/** A slug for the first agent from its name; `agent` when nothing is left. */
export function firstAgentSlug(name: string, reserved: ReadonlySet<string>): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'agent';
  // The draft agents of Plugin Builder previews own this prefix (#2049).
  if (isPreviewDraftAgentSlug(slug)) return `agent-${slug}`.slice(0, MAX_SLUG_LENGTH);
  return reserved.has(slug) ? `${slug.slice(0, MAX_SLUG_LENGTH - 6)}-agent` : slug;
}
