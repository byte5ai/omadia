import { z } from 'zod';

import {
  decideCommand,
  defaultCommandPolicy,
  formatSessionScope,
  parseSessionScope,
  type CommandPolicy,
} from '@omadia/channel-sdk';
import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';
import { resolveAgentComputerProfile, type AgentComputerProfile, type SandboxBackend } from '@omadia/sandbox';
import { publish, type PublishRuntime, type PublishStore } from '@omadia/publish';

import { recordCommandPolicyOutcome } from '../commandPolicyMetrics.js';
import { turnContext } from '../turnContext.js';

/**
 * Issue #581 P2 — the `publish` native tool: turns a directory in the
 * calling turn's scope sandbox into a running, immutably-versioned web app.
 *
 * Same "belt AND braces" posture as `executeTool.ts` (#576 P2): this tool
 * lives entirely behind the `sandbox_publish_enabled` operator flag (see
 * `plugin.ts`), and its handler additionally runs `defaultCommandPolicy()`
 * — the org floor — against a SYNTHETIC command string (`publish <appId>`)
 * before ever touching a sandbox or the version store. No default policy
 * rule matches that string today (the floor's patterns target shell
 * metacharacters, not tool-level pseudo-commands), so this is inert until
 * an operator deliberately adds a rule for it — exactly the "require_approval
 * semantics IF the command policy concerns deploy commands" the #581 phase
 * plan asks for, wired through the SAME `decideCommand`/metrics machinery
 * `execute` uses rather than a bespoke publish-only policy surface.
 */

export const PUBLISH_TOOL_NAME = 'publish';

const PublishInputSchema = z.object({
  appId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'appId must be a lowercase, hyphen-safe slug'),
  name: z.string().min(1).max(200),
  dir: z.string().min(1).max(1000),
  entrypoint: z.string().min(1).max(500),
});

export const publishToolSpec: NativeToolSpec = {
  name: PUBLISH_TOOL_NAME,
  description:
    'Publish a directory from this scope\'s sandbox as a running, immutably-versioned internal web app. Every call creates a NEW version (never overwrites a prior one) and — on success — makes it the live version. Returns {appId, version, dirHash, createdAt} as JSON on success.',
  input_schema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'Stable app slug (lowercase, hyphen-safe). The SAME appId across calls versions one app.',
      },
      name: { type: 'string', description: 'Human-readable display name for the app.' },
      dir: { type: 'string', description: "Directory in this scope's sandbox to publish (root-relative)." },
      entrypoint: {
        type: 'string',
        description: 'Node entrypoint file, relative to `dir` (e.g. "server.js"). Must listen on $PORT.',
      },
    },
    required: ['appId', 'name', 'dir', 'entrypoint'],
  },
};

export interface CreatePublishHandlerOptions {
  readonly sandboxBackend: SandboxBackend;
  readonly runtime: PublishRuntime;
  readonly store: PublishStore;
  readonly profile?: AgentComputerProfile;
  readonly resolveCommandPolicy?: () => CommandPolicy;
}

/** Same "turn-unique fallback for an unscoped turn" posture as
 *  `executeTool.ts`'s `resolveScopeKey` — publish reads the SAME
 *  scope-sandbox `execute` would run commands in, per the #581 plan ("publish
 *  läuft IMMER über den Sandbox des Turn-Scopes"). Duplicated rather than
 *  imported: `executeTool.ts` does not export it, and the two tools must
 *  each be independently understandable without cross-file lookups for
 *  something this small. */
function resolveScopeKey(): string {
  const raw = turnContext.current()?.sessionScope;
  const scope = parseSessionScope(raw);
  if (scope.kind !== 'unscoped') return formatSessionScope(scope);
  const turnId = turnContext.current()?.turnId;
  return `unscoped:${turnId && turnId.length > 0 ? turnId : 'no-turn'}`;
}

export function createPublishHandler(options: CreatePublishHandlerOptions): NativeToolHandler {
  const resolvePolicy = options.resolveCommandPolicy ?? defaultCommandPolicy;
  const profile = options.profile ?? resolveAgentComputerProfile();

  return async (input) => {
    const parsed = PublishInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return `Error: invalid publish input — ${detail}`;
    }

    let policy: CommandPolicy;
    try {
      policy = resolvePolicy();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordCommandPolicyOutcome('resolve_failed');
      return `Error: publish — the command policy could not be resolved; refusing to run (fail-closed). ${detail}`;
    }

    const pseudoCommand = `publish ${parsed.data.appId}`;
    const decision = decideCommand(policy, pseudoCommand);
    if (decision.decision === 'deny') {
      recordCommandPolicyOutcome('denied', decision.ruleId);
      return `Error: publish — refused by the command policy: ${decision.reason}.`;
    }
    if (decision.decision === 'require_approval') {
      recordCommandPolicyOutcome('require_approval', decision.ruleId);
      return `Error: publish — this app requires human approval to publish (${decision.reason}), which is not yet available in this build. It was NOT published.`;
    }
    recordCommandPolicyOutcome('allowed');

    const scopeKey = resolveScopeKey();
    try {
      const sandbox = await options.sandboxBackend.provision({ scopeKey, profile });
      const record = await publish({
        sandbox,
        store: options.store,
        runtime: options.runtime,
        input: {
          appId: parsed.data.appId,
          name: parsed.data.name,
          entrypoint: parsed.data.entrypoint,
          dir: parsed.data.dir,
          sourceScopeKey: scopeKey,
        },
      });
      return JSON.stringify({
        appId: record.appId,
        version: record.version,
        dirHash: record.dirHash,
        createdAt: record.createdAt.toISOString(),
      });
    } catch (err) {
      return `Error: publish — ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

export const PUBLISH_SYSTEM_PROMPT_DOC = `### Publish (\`publish\`)
Publishes a directory from this scope's sandbox as a running, immutably-versioned internal web app. The entrypoint must be a Node script listening on \`process.env.PORT\`; durable state must be written under \`process.env.DATA_DIR\`, never anywhere else in the container — files outside \`DATA_DIR\` do NOT survive a later publish of the same app. Every call creates a brand-new version; verify the app actually runs (the tool result includes the assigned version) before telling the user it is done.`;

// Issue #581 P3 — re-exported (not newly defined here) so
// `publishGrantedTools.ts`'s grant-check wrapper can resolve the SAME scope
// key this handler provisions its sandbox under, without a third
// copy-pasted implementation. Additive-only: nothing above this line
// changed for P3.
export { resolveScopeKey };
