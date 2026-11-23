// GET/PUT /api/v1/operator/agents/:slug/archetype-settings (#2066, spec 2043
// §7) — the per-agent settings the agent's archetype declares: for a
// facilitator its default methods and reminder policy. The fields come from
// the archetype descriptor (the archetype plugin's manifest); the values are
// validated against them, stored on the agent row and handed to the plugin
// with the agent's profile. An unset field means the plugin's instance
// setting applies; the answer says which fields are set.

import { Router, type Request, type Response } from 'express';

import {
  archetypeOf,
  effectiveArchetypeAgentSettings,
  getArchetype,
  validateArchetypeAgentSettings,
  type ArchetypeAgentSetting,
  type ArchetypeText,
} from '@omadia/orchestrator';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { AgentArchetypeSettingsStore } from '../platform/agentArchetypeSettingsStore.js';

export interface ArchetypeSettingFieldDto {
  readonly key: string;
  readonly type: ArchetypeAgentSetting['type'];
  readonly label: ArchetypeText;
  readonly help: ArchetypeText | null;
  readonly options: readonly { readonly value: string; readonly label: ArchetypeText }[] | null;
  readonly max_items: number | null;
}

export interface ArchetypeSettingsDto {
  readonly archetype: string;
  readonly fields: readonly ArchetypeSettingFieldDto[];
  /** Only the fields that are set; a missing key = the instance setting. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface OperatorAgentArchetypeSettingsDeps {
  readonly getAgent: (slug: string) => Promise<{ readonly id: string; readonly archetype?: string } | undefined>;
  readonly getStore: () => AgentArchetypeSettingsStore | undefined;
  readonly recordAudit?: (entry: AuditEntryInput) => Promise<void>;
  readonly log?: (message: string) => void;
}

export function archetypeSettingFields(
  fields: readonly ArchetypeAgentSetting[] | undefined,
): ArchetypeSettingFieldDto[] {
  return (fields ?? []).map((f) => ({
    key: f.key,
    type: f.type,
    label: f.label,
    help: f.help ?? null,
    options: f.type === 'enum' ? f.options.map((o) => ({ value: o.value, label: o.label })) : null,
    max_items: f.type === 'number_list' ? f.maxItems : null,
  }));
}

const slugOf = (req: Request): string => {
  const raw = req.params['slug'];
  return typeof raw === 'string' ? raw : '';
};

export function createOperatorAgentArchetypeSettingsRouter(deps: OperatorAgentArchetypeSettingsDeps): Router {
  const router = Router();

  const load = async (
    req: Request,
    res: Response,
  ): Promise<{ agent: { id: string; archetype?: string }; store: AgentArchetypeSettingsStore } | undefined> => {
    const store = deps.getStore();
    if (!store) {
      res.status(503).json({ error: 'archetype_settings_unavailable', message: 'No database is configured.' });
      return undefined;
    }
    const agent = await deps.getAgent(slugOf(req));
    if (!agent) {
      res.status(404).json({ error: 'not_found' });
      return undefined;
    }
    return { agent, store };
  };

  const dto = (agent: { archetype?: string }, stored: unknown): ArchetypeSettingsDto => {
    const archetype = archetypeOf(agent);
    const descriptor = getArchetype(archetype);
    return {
      archetype,
      fields: archetypeSettingFields(descriptor?.agentSettings),
      values: effectiveArchetypeAgentSettings(descriptor, stored),
    };
  };

  router.get('/:slug/archetype-settings', async (req: Request, res: Response) => {
    try {
      const loaded = await load(req, res);
      if (!loaded) return;
      res.json(dto(loaded.agent, await loaded.store.get(loaded.agent.id)));
    } catch (err) {
      deps.log?.(`[archetype-settings] read failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'internal', message: 'The settings could not be read.' });
    }
  });

  router.put('/:slug/archetype-settings', async (req: Request, res: Response) => {
    try {
      const loaded = await load(req, res);
      if (!loaded) return;
      const { agent, store } = loaded;
      const descriptor = getArchetype(archetypeOf(agent));
      const checked = validateArchetypeAgentSettings(descriptor, (req.body ?? {}).settings);
      if ('issues' in checked) {
        res.status(422).json({ error: 'invalid_archetype_settings', issues: checked.issues });
        return;
      }
      const before = dto(agent, await store.get(agent.id)).values;
      const stored = await store.merge(agent.id, checked.settings);
      if (!stored) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const after = dto(agent, stored);
      await deps.recordAudit?.({
        actor: auditActorFromRequest(req),
        action: 'agent.archetype_settings_change',
        target: `agent:${agent.id}`,
        before,
        after: after.values,
      });
      res.json(after);
    } catch (err) {
      deps.log?.(`[archetype-settings] write failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'internal', message: 'The settings could not be saved.' });
    }
  });

  return router;
}
