import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import type { PluginContext } from '@omadia/plugin-api';

import { ClaimExtractor } from './claimExtractor.js';
import { DeterministicChecker, type OdooReader } from './deterministicChecker.js';
import { EvidenceJudge } from './evidenceJudge.js';
import { GraphEvidenceFetcher } from './graphEvidenceFetcher.js';
import { VerifierPipeline } from './verifierPipeline.js';
import { VerifierStore } from './verifierStore.js';

/**
 * @omadia/verifier — plugin entry point.
 *
 * **S+9.3 Sub-Commit 2b: capability lifetime flipped from kernel-bridge
 * to plugin-owned.** activate() reads its setup-fields, late-resolves
 * `knowledgeGraph` (hard) plus optional `graphPool` and `odoo.client`,
 * constructs the five-stage pipeline (ClaimExtractor → DeterministicChecker
 * → EvidenceJudge with GraphEvidenceFetcher → VerifierPipeline) plus an
 * optional VerifierStore (only when graphPool is available — the
 * in-memory KG variant has no Postgres pool), and publishes the bundle
 * as `verifier@1`:
 *
 *   {
 *     pipeline:    VerifierPipeline,
 *     store?:      VerifierStore,
 *     mode:        'shadow' | 'enforce',
 *     maxRetries:  number,
 *   }
 *
 * The kernel late-resolves the bundle after `activateAllInstalled` and
 * after the Orchestrator construction, then wraps it with the kernel-
 * side `VerifierService` (which couples Pipeline + Orchestrator + the
 * `toSemanticAnswer` converter from `src/services/orchestrator.ts`).
 *
 * **Why VerifierService is NOT moved into the plugin:** the wrapper
 * class consumes seven kernel-internal symbols (Orchestrator,
 * ChatAgent, ChatStreamEvent, ChatTurnInput, ChatTurnResult,
 * VerifierResultSummary, toSemanticAnswer) plus RunTracePayload. A
 * full Orchestrator-Surface-Type-Lift to `@omadia/plugin-api`
 * is S+10+ scope (the Orchestrator class itself is ~1k LOC and not
 * yet plugin-extractable). For S+9.3 we keep the wrapper kernel-side
 * and let the plugin own everything below it.
 *
 * **Always-Register-Bootstrap-Pattern (S+9.1 Rule #8):** activate() is
 * tolerant of missing config. Without `anthropic_api_key` or with
 * `verifier_enabled !== 'true'`, the plugin still activates but does
 * NOT publish `verifier@1` — the kernel sees no capability and falls
 * back to running the bare Orchestrator. This is a deliberate boot-
 * order choice: bootstrap registers the plugin entry on every start so
 * the catalog has it, but consumer-degradation lives at runtime.
 */

const VERIFIER_SERVICE = 'verifier';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_CLAIMS = 20;
const DEFAULT_AMOUNT_TOLERANCE = 0.01;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TENANT = 'default';

/**
 * Public shape of the `verifier@1` capability. Kernel-side
 * `buildVerifierService` consumes this to construct the
 * `VerifierService` wrapper around the live Orchestrator instance.
 */
export interface VerifierBundle {
  pipeline: VerifierPipeline;
  store?: VerifierStore;
  mode: 'shadow' | 'enforce';
  maxRetries: number;
}

export interface VerifierPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<VerifierPluginHandle> {
  const enabledFlag = (ctx.config.get<string>('verifier_enabled') ?? '')
    .trim()
    .toLowerCase();
  if (enabledFlag !== 'true') {
    ctx.log(
      '[harness-verifier] verifier_enabled is not "true" — plugin active but verifier@1 capability NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-verifier] deactivating (disabled)');
      },
    };
  }

  // S+12.6: anthropic_api_key is vault-stored (matches database_url-pattern).
  // Bootstrap migrates pre-S+12.6 entries automatically (config → vault).
  const apiKey = ((await ctx.secrets.get('anthropic_api_key')) ?? '').trim();
  if (!apiKey) {
    ctx.log(
      '[harness-verifier] anthropic_api_key not set — plugin active but verifier@1 capability NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-verifier] deactivating (no api key)');
      },
    };
  }

  const knowledgeGraph =
    ctx.services.get<KnowledgeGraph>('knowledgeGraph');
  if (!knowledgeGraph) {
    ctx.log(
      '[harness-verifier] knowledgeGraph capability missing — plugin active but verifier@1 capability NOT published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-verifier] deactivating (no knowledgeGraph)');
      },
    };
  }

  const graphPool = ctx.services.get<Pool>('graphPool');
  // Phase 5B: type-import for `OdooClient` lifted to a local `OdooReader`
  // shim (narrow execute({...}) surface — same shape DeterministicChecker
  // already used for stub-injection).
  const odooClient = ctx.services.get<OdooReader>('odoo.client');

  const model =
    (ctx.config.get<string>('verifier_model') ?? '').trim() || DEFAULT_MODEL;
  const maxClaims =
    parseNumberOrDefault(
      ctx.config.get<unknown>('verifier_max_claims'),
      DEFAULT_MAX_CLAIMS,
    );
  const amountTolerance = parseNumberOrDefault(
    ctx.config.get<unknown>('verifier_amount_tolerance'),
    DEFAULT_AMOUNT_TOLERANCE,
  );
  const maxRetries = clampMaxRetries(
    parseNumberOrDefault(
      ctx.config.get<unknown>('verifier_max_retries'),
      DEFAULT_MAX_RETRIES,
    ),
  );
  const modeRaw = (ctx.config.get<string>('verifier_mode') ?? '')
    .trim()
    .toLowerCase();
  const mode: 'shadow' | 'enforce' =
    modeRaw === 'enforce' ? 'enforce' : 'shadow';
  const tenant =
    (ctx.config.get<string>('graph_tenant_id') ?? '').trim() ||
    DEFAULT_TENANT;

  const anthropic = new Anthropic({ apiKey });

  const extractor = new ClaimExtractor({
    anthropic,
    model,
    maxClaims,
  });
  const deterministic = new DeterministicChecker({
    amountTolerance,
    ...(odooClient ? { odoo: odooClient } : {}),
    graph: knowledgeGraph,
  });
  const fetcher = new GraphEvidenceFetcher({ graph: knowledgeGraph });
  const judge = new EvidenceJudge({
    anthropic,
    fetcher,
    model,
  });
  const pipeline = new VerifierPipeline({
    extractor,
    deterministic,
    judge,
  });
  const store = graphPool
    ? new VerifierStore({ pool: graphPool, tenant })
    : undefined;

  const bundle: VerifierBundle = {
    pipeline,
    ...(store ? { store } : {}),
    mode,
    maxRetries,
  };

  ctx.services.provide(VERIFIER_SERVICE, bundle);
  ctx.log(
    `[harness-verifier] verifier@1 published (mode=${mode}, model=${model}, store=${store ? 'on' : 'off'}, odoo=${odooClient ? 'on' : 'off'}, maxRetries=${String(maxRetries)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-verifier] deactivating');
    },
  };
}

function parseNumberOrDefault(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clampMaxRetries(n: number): number {
  if (n < 0) return 0;
  if (n > 2) return 2;
  return Math.floor(n);
}
