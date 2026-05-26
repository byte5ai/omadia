#!/usr/bin/env -S node --import tsx
/**
 * agents:apply — local E2E CLI for the multi-orchestrator runtime (US4 / T017).
 *
 * Reads a YAML config file describing the desired Agent set and applies it
 * to the live Postgres so the next process boot (or US5 hot-reload) picks
 * it up. Operator-readable input; intended for dev + smoke tests until the
 * US9 operator UI lands.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     node --import tsx middleware/scripts/agents-apply.ts \
 *       middleware/agent-config-dev.yaml
 *
 * File shape (snake_case to match `manifest.yaml`):
 *
 *   agents:
 *     - slug: public
 *       name: Public Agent
 *       description: ...                  # optional
 *       privacy_profile: default          # 'strict' | 'default', default 'default'
 *       status: enabled                   # 'enabled' | 'disabled', default 'enabled'
 *       plugins:
 *         - id: '@omadia/agent-seo-analyst'
 *           config: { ... }               # optional
 *           enabled: true                 # default true
 *       channel_bindings:
 *         - channel_type: teams
 *           channel_key: 28:bot-id-1234
 *   fallback_agent: public                # optional slug; null/missing ⇒ hard-reject
 *
 * The apply is **replace-by-slug**: any agent in the YAML is upserted, its
 * plugins + bindings are fully replaced. Agents present in the DB but absent
 * from the YAML are **left alone** (so an operator can ship an additive YAML
 * without wiping their existing config); pass `--prune` to delete agents not
 * referenced by the YAML.
 */

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { Pool } from 'pg';

import {
  ConfigStore,
  runMultiOrchestratorMigrations,
  type AgentInput,
  type AgentPluginInput,
  type ChannelBindingInput,
  type PrivacyProfile,
  type AgentStatus,
} from '@omadia/orchestrator';

interface PluginYaml {
  id: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

interface BindingYaml {
  channel_type: string;
  channel_key: string;
}

interface AgentYaml {
  slug: string;
  name: string;
  description?: string;
  privacy_profile?: PrivacyProfile;
  status?: AgentStatus;
  plugins?: PluginYaml[];
  channel_bindings?: BindingYaml[];
}

interface ConfigYaml {
  agents?: AgentYaml[];
  fallback_agent?: string | null;
}

function parseArgs(argv: readonly string[]): {
  file: string;
  prune: boolean;
} {
  const args = argv.slice(2);
  const prune = args.includes('--prune');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'usage: agents-apply <config.yaml> [--prune]\n\n' +
        'reads DATABASE_URL from the environment.',
    );
    process.exit(2);
  }
  return { file, prune };
}

function assertAgentYaml(value: unknown, idx: number): AgentYaml {
  if (!value || typeof value !== 'object') {
    throw new Error(`agents[${String(idx)}] must be an object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v['slug'] !== 'string' || v['slug'].length === 0) {
    throw new Error(`agents[${String(idx)}].slug is required (string)`);
  }
  if (typeof v['name'] !== 'string' || v['name'].length === 0) {
    throw new Error(`agents[${String(idx)}].name is required (string)`);
  }
  return v as unknown as AgentYaml;
}

async function applyConfig(
  store: ConfigStore,
  config: ConfigYaml,
  prune: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const desiredAgents = (config.agents ?? []).map((a, i) =>
    assertAgentYaml(a, i),
  );

  const existing = await store.listAgents();
  const existingBySlug = new Map(existing.map((a) => [a.slug, a]));
  const desiredSlugs = new Set(desiredAgents.map((a) => a.slug));

  // Upsert each desired agent + replace its plugins + bindings.
  for (const ag of desiredAgents) {
    const input: AgentInput = {
      slug: ag.slug,
      name: ag.name,
      ...(ag.description !== undefined ? { description: ag.description } : {}),
      ...(ag.privacy_profile ? { privacyProfile: ag.privacy_profile } : {}),
      ...(ag.status ? { status: ag.status } : {}),
    };
    const existingRow = existingBySlug.get(ag.slug);
    const row = existingRow
      ? await store.updateAgent(existingRow.id, {
          name: input.name,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.privacyProfile
            ? { privacyProfile: input.privacyProfile }
            : {}),
          ...(input.status ? { status: input.status } : {}),
        })
      : await store.createAgent(input);
    log(
      `${existingRow ? 'updated' : 'created'} agent slug=${row.slug} id=${row.id}`,
    );

    // Replace plugins — delete what's not in the YAML, upsert what is.
    const currentPlugins = await store.listAgentPlugins(row.id);
    const desiredPluginIds = new Set((ag.plugins ?? []).map((p) => p.id));
    for (const p of currentPlugins) {
      if (!desiredPluginIds.has(p.pluginId)) {
        await store.removeAgentPlugin(row.id, p.pluginId);
        log(`  removed plugin ${p.pluginId}`);
      }
    }
    for (const p of ag.plugins ?? []) {
      const input: AgentPluginInput = {
        pluginId: p.id,
        ...(p.config ? { config: p.config } : {}),
        ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      };
      await store.upsertAgentPlugin(row.id, input);
      log(
        `  upserted plugin ${p.id} enabled=${String(p.enabled ?? true)}`,
      );
    }

    // Replace channel bindings — delete what's not in the YAML, insert what is.
    const currentBindings = await store.listChannelBindingsForAgent(row.id);
    const desiredBindings = new Set(
      (ag.channel_bindings ?? []).map((b) => `${b.channel_type}|${b.channel_key}`),
    );
    for (const b of currentBindings) {
      if (!desiredBindings.has(`${b.channelType}|${b.channelKey}`)) {
        await store.removeChannelBinding(b.channelType, b.channelKey);
        log(`  removed binding ${b.channelType}/${b.channelKey}`);
      }
    }
    for (const b of ag.channel_bindings ?? []) {
      const input: ChannelBindingInput = {
        channelType: b.channel_type,
        channelKey: b.channel_key,
      };
      await store.createChannelBinding(row.id, input).catch(async (err) => {
        // Already-exists (PK violation) means the binding is for THIS agent
        // and was preserved across the cleanup above — no-op.
        if ((err as Error).name === 'ConfigValidationError') {
          const existing = await store.resolveBinding(
            b.channel_type,
            b.channel_key,
          );
          if (existing?.agentId === row.id) return;
        }
        throw err;
      });
      log(`  upserted binding ${b.channel_type}/${b.channel_key}`);
    }
  }

  // Optional prune — wipe agents in DB but not in YAML.
  if (prune) {
    for (const existingRow of existing) {
      if (!desiredSlugs.has(existingRow.slug)) {
        await store.deleteAgent(existingRow.id);
        log(`pruned agent slug=${existingRow.slug} id=${existingRow.id}`);
      }
    }
  }

  // Fallback agent.
  if (config.fallback_agent !== undefined) {
    if (config.fallback_agent === null) {
      await store.setFallbackAgentId(null);
      log('cleared fallback_agent');
    } else {
      const fallback = await store.getAgentBySlug(config.fallback_agent);
      if (!fallback) {
        throw new Error(
          `fallback_agent "${config.fallback_agent}" does not exist after apply`,
        );
      }
      await store.setFallbackAgentId(fallback.id);
      log(`set fallback_agent slug=${fallback.slug} id=${fallback.id}`);
    }
  }
}

async function main(): Promise<void> {
  const { file, prune } = parseArgs(process.argv);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('agents-apply: DATABASE_URL is required');
    process.exit(2);
  }

  const raw = await readFile(file, 'utf8');
  const parsed = parse(raw) as ConfigYaml;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${file} must be a YAML object`);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMultiOrchestratorMigrations(pool, (m) => console.log(m));
    const store = new ConfigStore(pool);
    await applyConfig(store, parsed, prune, (m) => console.log(m));
    console.log('agents-apply: done');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`agents-apply: ${(err as Error).message}`);
  process.exit(1);
});
