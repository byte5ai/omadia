import { isPreviewDraftAgentSlug } from '../plugins/builder/previewDraftAgents.js';

/**
 * #2054 — spec 2042 §7 "Onboarding": a fresh installation starts with no agent
 * holding any capability; the first-run flow creates the first agent with an
 * explicit choice of capabilities (no preselection, zero allowed).
 *
 * The flow is due while the instance has no agent of the operator's making.
 * There is no boot seed any more (#2055 removed the fallback agent), so that
 * means: no agent at all (a Plugin Builder preview's draft agent does not
 * count; the caller leaves those out).
 */

export interface OnboardingAgent {
  readonly id: string;
  readonly slug: string;
}

export type OnboardingTarget = { readonly kind: 'create' };

export function onboardingTarget(agents: readonly OnboardingAgent[]): OnboardingTarget | undefined {
  return agents.length === 0 ? { kind: 'create' } : undefined;
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
