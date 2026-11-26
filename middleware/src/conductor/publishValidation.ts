import { isTemplateExpression, validate } from '@omadia/conductor-core';
import type { ValidationResult, WorkflowGraph } from '@omadia/conductor-core';

import { isUuid } from '../http/uuidParam.js';
import type { ConductorRouterDeps } from './routes.js';
import { WEBHOOK_POST_ACTION_ID, webhookPostInputError } from './webhookPostAction.js';

export async function validatePublishGraph(
  graph: WorkflowGraph,
  deps: Pick<ConductorRouterDeps, 'templateKnownRefs' | 'isOperatorAccountId'>,
): Promise<ValidationResult> {
  const result = validate(graph, await deps.templateKnownRefs?.());
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
