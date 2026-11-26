import { isTemplateExpression, validate } from '@omadia/conductor-core';
import type { KnownRefs, ValidationError, ValidationResult, WorkflowGraph } from '@omadia/conductor-core';
import type { PoolClient } from 'pg';

import { isUuid } from '../http/uuidParam.js';
import type { ConductorRouterDeps } from './routes.js';
import { WEBHOOK_POST_ACTION_ID, webhookPostInputError } from './webhookPostAction.js';

export interface PublishKnownRefs extends KnownRefs {
  requiredActionInputs?: ReadonlyMap<string, readonly string[]>;
}

export async function validatePublishGraph(
  graph: WorkflowGraph,
  deps: Pick<ConductorRouterDeps, 'templateKnownRefs' | 'isOperatorAccountId'>,
): Promise<ValidationResult> {
  const knownRefs = await deps.templateKnownRefs?.();
  const result = validate(graph, knownRefs);
  if (!result.ok) return result;

  const accountIds = new Map<string, Promise<boolean>>();
  for (const step of graph.steps) {
    if (step.kind === 'action' && step.actionId === WEBHOOK_POST_ACTION_ID) {
      const url = step.input?.url;
      // A run token may supply the URL later. The action validates that value at dispatch.
      const error = typeof url === 'string' && isTemplateExpression(url) ? null : webhookPostInputError(step.input);
      if (error) {
        result.errors.push({ code: 'invalid_action_input', message: `step '${step.id}': ${error}`, nodeIds: [step.id] });
      }
    }
    if (step.kind === 'action' && step.actionId) {
      const required = knownRefs?.requiredActionInputs?.get(step.actionId) ?? [];
      const missing = required.filter((key) => !Object.hasOwn(step.input ?? {}, key));
      if (missing.length > 0) {
        result.errors.push({
          code: 'invalid_action_input',
          message: `step '${step.id}' is missing required action inputs: ${missing.join(', ')}`,
          nodeIds: [step.id],
        });
      }
    }
    const principal = step.kind === 'human' ? step.human?.principal : undefined;
    if (principal?.kind !== 'user' || !deps.isOperatorAccountId || !isUuid(principal.ref.trim())) continue;
    // A Teams directory object ID can also be a UUID. Only reject IDs from our account table.
    const id = principal.ref.trim().toLowerCase();
    let account = accountIds.get(id);
    if (!account) {
      account = deps.isOperatorAccountId(id);
      accountIds.set(id, account);
    }
    if (await account) {
      result.errors.push({
        code: 'invalid_user_ref',
        message: `human step '${step.id}' uses an operator account ID; choose a person from the channel directory or use their email address`,
        nodeIds: [step.id],
      });
    }
  }
  return { ...result, ok: result.errors.length === 0 };
}

export class PublishRoleUnavailableError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super('a referenced role disappeared during publish');
  }
}

/** Hold referenced roles until the active-version write commits, against role deletion. */
export async function lockPublishedRoles(client: PoolClient, graph: WorkflowGraph): Promise<void> {
  const steps = graph.steps.filter((step) => step.kind === 'human' && step.human?.principal.kind === 'role');
  if (steps.length === 0) return;
  const keys = [...new Set(steps.map((step) => step.human!.principal.ref))];
  const { rows } = await client.query<{ key: string }>(
    'SELECT key FROM conductor_roles WHERE key = ANY($1::text[]) ORDER BY key FOR KEY SHARE',
    [keys],
  );
  const live = new Set(rows.map((row) => row.key));
  const errors = steps.flatMap((step): ValidationError[] => {
    const key = step.human!.principal.ref;
    return live.has(key) ? [] : [{ code: 'unknown_role_ref', message: `step '${step.id}' references unknown role '${key}'`, nodeIds: [step.id] }];
  });
  if (errors.length > 0) throw new PublishRoleUnavailableError(errors);
}
