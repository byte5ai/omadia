import { z } from 'zod';

import { decideCommand, defaultCommandPolicy, type CommandPolicy } from '@omadia/channel-sdk';
import type { NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';
import { rollbackTo, type PublishStore } from '@omadia/publish';

import { recordCommandPolicyOutcome } from '../commandPolicyMetrics.js';

/**
 * Issue #581 P2 — `publish_rollback`: flips a published app's live pointer
 * back to an earlier, already-published version. This is a pointer flip
 * ONLY — `rollbackTo` (in `@omadia/publish`) does not even accept a
 * `PublishRuntime`, so this handler structurally cannot trigger a new
 * build/deploy no matter what it is given.
 *
 * Same synthetic-command command-policy check as `publishTool.ts`, using a
 * `rollback <appId>` pseudo-command — see that file's doc for why.
 */
export const PUBLISH_ROLLBACK_TOOL_NAME = 'publish_rollback';

const RollbackInputSchema = z.object({
  appId: z.string().min(1).max(100),
  version: z.number().int().min(1),
});

export const publishRollbackToolSpec: NativeToolSpec = {
  name: PUBLISH_ROLLBACK_TOOL_NAME,
  description:
    "Roll a published app's live pointer back to an earlier version that was already published. This is a pointer flip — it does NOT rebuild or redeploy anything; the target version's container is still running from when it was originally published. Returns {appId, currentVersion, updatedAt} as JSON on success.",
  input_schema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The app slug to roll back.' },
      version: { type: 'integer', description: 'The version number to make live again. Must already exist.' },
    },
    required: ['appId', 'version'],
  },
};

export interface CreatePublishRollbackHandlerOptions {
  readonly store: PublishStore;
  readonly resolveCommandPolicy?: () => CommandPolicy;
}

export function createPublishRollbackHandler(options: CreatePublishRollbackHandlerOptions): NativeToolHandler {
  const resolvePolicy = options.resolveCommandPolicy ?? defaultCommandPolicy;

  return async (input) => {
    const parsed = RollbackInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return `Error: invalid publish_rollback input — ${detail}`;
    }

    let policy: CommandPolicy;
    try {
      policy = resolvePolicy();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordCommandPolicyOutcome('resolve_failed');
      return `Error: publish_rollback — the command policy could not be resolved; refusing to run (fail-closed). ${detail}`;
    }

    const decision = decideCommand(policy, `rollback ${parsed.data.appId}`);
    if (decision.decision === 'deny') {
      recordCommandPolicyOutcome('denied', decision.ruleId);
      return `Error: publish_rollback — refused by the command policy: ${decision.reason}.`;
    }
    if (decision.decision === 'require_approval') {
      recordCommandPolicyOutcome('require_approval', decision.ruleId);
      return `Error: publish_rollback — this app requires human approval to roll back (${decision.reason}), which is not yet available in this build. It was NOT rolled back.`;
    }
    recordCommandPolicyOutcome('allowed');

    try {
      const pointer = await rollbackTo({ store: options.store, appId: parsed.data.appId, version: parsed.data.version });
      return JSON.stringify({
        appId: pointer.appId,
        currentVersion: pointer.currentVersion,
        updatedAt: pointer.updatedAt.toISOString(),
      });
    } catch (err) {
      return `Error: publish_rollback — ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

export const PUBLISH_ROLLBACK_SYSTEM_PROMPT_DOC = `### Publish rollback (\`publish_rollback\`)
Flips a published app's live pointer back to an earlier version that was already published with \`publish\`. Instant — no rebuild, no redeploy. The version must already exist (i.e. have been published before); rolling back to a version number that was never published fails.`;
