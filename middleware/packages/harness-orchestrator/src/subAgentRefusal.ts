import { TOOL_ERROR_PREFIX } from '@omadia/plugin-api';

/**
 * #1219 — a sub-agent run ended because the model's safety classifiers
 * declined the turn (HTTP 200, `stop_reason: 'refusal'`).
 *
 * `LocalSubAgent` throws it the moment a response comes back refused, before
 * that response is dispatched, escalated or kept, so nothing a refused turn
 * produced (a fragment, a pending tool_use) is ever passed on as an answer.
 * It is typed so the delegation tool can tell it from every other failure:
 * an exception out of `ask()` reaches the parent model as the data-free
 * withheld notice, which would hide that the question itself was declined,
 * while this one gets {@link subAgentRefusalNotice}.
 *
 * The message is authored here and carries no data of the run, so a surface
 * that shows it (the BuilderAgent's `builder.ask_failed` event) shows nothing
 * the model or a tool produced.
 */
export class SubAgentRefusalError extends Error {
  /** The sub-agent's own label (`LocalSubAgent` `name`). */
  readonly subAgentName: string;
  /** The vendor's refusal category (`bio`, `cyber`, …) when it sent one. An
   *  open set: never switch on it exhaustively. */
  readonly category: string | undefined;

  constructor(subAgentName: string, category?: string) {
    const token = refusalCategoryToken(category);
    super(
      `Sub-agent ${subAgentName}: the model declined this request for safety reasons` +
        `${token === undefined ? '' : ` (category ${token})`}. Rephrase it or run this sub-agent on a different model.`,
    );
    this.name = 'SubAgentRefusalError';
    this.subAgentName = subAgentName;
    this.category = category;
  }
}

/** Characters a tool name or category may keep inside the notice — the same
 *  token alphabet the withheld notice uses, so nothing can break its framing. */
const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.:-]/g;
const MAX_CATEGORY_LENGTH = 48;

/** The category as a short plain token, or undefined when none survives. */
function refusalCategoryToken(category: string | undefined): string | undefined {
  if (category === undefined) return undefined;
  const token = category.replace(UNSAFE_TOKEN_CHARS, '').slice(0, MAX_CATEGORY_LENGTH);
  return token.length > 0 ? token : undefined;
}

/**
 * The tool result the parent model receives when the sub-agent behind
 * `toolName` was declined. Fixed, harness-authored text — never the error's
 * message — with the {@link TOOL_ERROR_PREFIX} so the parent flags it
 * `is_error` and the Privacy Shield treats it as control flow, not data.
 */
export function subAgentRefusalNotice(toolName: string, category?: string): string {
  const tool = toolName.replace(UNSAFE_TOKEN_CHARS, '') || 'unknown';
  const token = refusalCategoryToken(category);
  return (
    `${TOOL_ERROR_PREFIX} the \`${tool}\` sub-agent's model declined this question for ` +
    `safety reasons${token === undefined ? '' : ` (category ${token})`}. Rephrase the ` +
    'question or answer without this sub-agent; do not send it again unchanged.'
  );
}
