import type { AgentAvailability } from './agentAvailability';
import type { AgentIdentityInput } from './agentIdentity';

/**
 * #2049 — how the Agent Builder creates an agent, from a template or blank
 * (spec 2042 §5.2, §5.10, INV-8). A client flow over the existing routes,
 * each step its own request:
 *
 *   1. `create`        POST /operator/agents as a `draft` (never addressable);
 *   2. `identity`      PUT  /operator/agents/:slug/identity (template only);
 *   3. `availability`  PUT  /operator/agents/:slug/availability — a new agent
 *                      reaches nobody until this says who;
 *   4. `grants`        the capability plugins the OPERATOR chose (none is a
 *                      valid choice), through the broad-reach confirmation;
 *   5. `enable`        PATCH status `enabled`, only when asked — otherwise
 *                      the agent stays a draft.
 *
 * A failed step stops the flow and is reported by name; the draft stays and
 * can be fixed in the Agent Builder or deleted. Nothing is rolled back
 * silently.
 */

export const AGENT_CREATE_STEPS = [
  'create',
  'identity',
  'availability',
  'grants',
  'enable',
] as const;
export type AgentCreateStep = (typeof AGENT_CREATE_STEPS)[number];

export interface AgentCreatePlan {
  slug: string;
  agent: { name: string; description?: string; archetype: string };
  /** The template's identity as the full PUT body; `null` for a blank agent. */
  identity: AgentIdentityInput | null;
  availability: AgentAvailability;
  /** Exactly the capability plugins the operator ticked. */
  pluginIds: readonly string[];
  /** Enable as the last step; `false` leaves a draft. */
  enable: boolean;
}

export interface AgentCreateDeps {
  createDraft: (input: {
    slug: string;
    name: string;
    description?: string;
    archetype: string;
    status: 'draft';
  }) => Promise<{ slug: string }>;
  saveIdentity: (slug: string, identity: AgentIdentityInput) => Promise<unknown>;
  setAvailability: (slug: string, availability: AgentAvailability) => Promise<unknown>;
  /** Resolves `false` when the operator declined the broad-reach confirmation. */
  grant: (slug: string, pluginIds: readonly string[]) => Promise<boolean>;
  enable: (slug: string) => Promise<unknown>;
}

export type AgentCreateResult =
  | { readonly ok: true; readonly slug: string; readonly enabled: boolean }
  | {
      readonly ok: false;
      /** `null` when not even the draft was created. */
      readonly slug: string | null;
      readonly failedStep: AgentCreateStep;
      /** `declined`: the operator refused the broad-reach confirmation. */
      readonly error: string | 'declined';
      readonly done: readonly AgentCreateStep[];
    };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runAgentCreateFlow(
  plan: AgentCreatePlan,
  deps: AgentCreateDeps,
): Promise<AgentCreateResult> {
  const done: AgentCreateStep[] = [];
  let slug: string | null = null;
  let step: AgentCreateStep = 'create';
  try {
    const created = await deps.createDraft({
      slug: plan.slug,
      name: plan.agent.name,
      ...(plan.agent.description ? { description: plan.agent.description } : {}),
      archetype: plan.agent.archetype,
      status: 'draft',
    });
    slug = created.slug;
    done.push('create');

    if (plan.identity) {
      step = 'identity';
      await deps.saveIdentity(slug, plan.identity);
      done.push('identity');
    }

    step = 'availability';
    await deps.setAvailability(slug, plan.availability);
    done.push('availability');

    if (plan.pluginIds.length > 0) {
      step = 'grants';
      const granted = await deps.grant(slug, plan.pluginIds);
      if (!granted)
        return {
          ok: false,
          slug,
          failedStep: 'grants',
          error: 'declined',
          done,
        };
      done.push('grants');
    }

    if (plan.enable) {
      step = 'enable';
      await deps.enable(slug);
      done.push('enable');
    }
    return { ok: true, slug, enabled: plan.enable };
  } catch (err) {
    return { ok: false, slug, failedStep: step, error: message(err), done };
  }
}

/** A slug proposal from a name: lowercase, digits, single hyphens, ≤ 64. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}
