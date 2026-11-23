// Run-context interpolation for a workflow graph's operator-authored fields (#1709).
//
// `{{ctx.<path>}}` / `{{steps.<stepId>.<field>}}` tokens are rendered against the LIVE
// run context, every time a step is entered. The grammar itself lives in
// conductor-core/runTokens.ts, shared with the authoring-time check that exempts a
// templated `step.agentId` from `unknown_agent_ref` — one grammar, or a token the
// runtime resolves gets rejected as an unknown ref.
//
// NOT to be confused with `renderTemplate` in src/triggers/triggerChain.ts: that one
// fills a trigger POST template from a fixed value set (`{{purpose}}`, `{{minutes_left}}`,
// `{{event.*}}`) and shares no grammar with this.
//
// Four fields, and the WHOLE point of this module is that they do not share one policy
// for an unresolved token:
//
//   | field                | renderer            | unresolved token becomes          |
//   |----------------------|---------------------|-----------------------------------|
//   | `step.human.message` | renderAwaitMessage  | a visible dash, and the result is |
//   |                      |                     | length-capped                     |
//   | `step.prompt`        | renderAgentPrompt   | empty                             |
//   | `step.input`         | renderActionInput   | empty (every string, any depth)   |
//   | `step.agentId`       | renderAgentRef      | empty                             |
//
// A dash is for a field a PERSON reads: an approver must never be shown
// `{{ctx.employeeName}}` and asked to decide on it, and "—" says "this run carries no
// value here" in a way raw template syntax never does.
//
// Everything else keeps the empty string, and each for its own reason:
//   - a REF (`agentId`) stays empty so the caller can refuse the step loudly ("the run
//     context does not name a speaker"); a dash would be looked up as an agent named "—".
//   - a PROMPT stays empty because a model reads it as a statement of fact. The
//     discussion pattern opens with "THE CONVERSATION SO FAR (empty if you are
//     opening):\n\n{{ctx.transcriptText}}" and branches on that emptiness; a dash there
//     hands the first speaker a transcript that is no longer empty.
//   - an ACTION INPUT stays empty because it is a machine payload. A dash would be POSTed
//     onward — `…/hire/—` in a URL, "—" in a connector field.
//
// Disjoint from the template `slot:text:<key>` grammar (conductor-core/textSlots.ts):
// text slots are substituted ONCE at instantiation with operator-supplied install text,
// these tokens survive into the instantiated graph and are rendered per run.

import { runTokenMatcher } from '@omadia/conductor-core';
import type { JsonObject, JsonValue } from '@omadia/conductor-core';

/**
 * What an unresolved token renders as in a field a person reads. A visible placeholder,
 * not the empty string: "New hire — starts on —" reads as a run that is missing its
 * payload, while "New hire  starts on " reads as a typo in the template.
 */
export const UNRESOLVED_PLACEHOLDER = '—';

/**
 * Hard cap on a rendered await message. Interpolation can inline a whole agent answer
 * (`weekly-report`'s `{{steps.compose.text}}`), and the result is both persisted in
 * `conductor_awaits.message` and sent to a chat as `Reminder: <message>`; before #1709
 * the stored string was short template prose, so nothing bounded it. Generous enough to
 * carry a real summary, small enough that a card still renders.
 */
export const AWAIT_MESSAGE_MAX_CHARS = 4000;

/**
 * The root a token path resolves against: `ctx.*` is the run context, and `steps.*` is
 * lifted to the top level so a step result is reachable as `{{steps.<id>.<field>}}` as
 * well as `{{ctx.steps.<id>.<field>}}`.
 */
function root(context: JsonObject): JsonObject {
  return { ctx: context, steps: asObject(context.steps) };
}

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/** Resolve a dot path over a plain-object root. Arrays are not indexed into. */
function resolve(from: JsonObject, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = from;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, JsonValue>)[seg];
  }
  return cur;
}

/**
 * The one substitution pass. `unresolved` is what an absent value becomes — the single
 * axis on which the four fields differ, which is why every export below is a thin,
 * NAMED policy over this function rather than an options bag at the call sites.
 *
 * `undefined` and `null` both count as unresolved: a context key explicitly set to null
 * carries no more information for a reader than a missing one. An empty string is a value
 * and stays empty.
 */
function render(tpl: string, context: JsonObject, unresolved: string): string {
  return tpl.replace(runTokenMatcher(), (_m, path: string) => {
    const v = resolve(root(context), path);
    if (v === undefined || v === null) return unresolved;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/**
 * `step.human.message` — the prose an approver reads, in the inbox, on the card and in
 * every reminder. Unresolved tokens become a visible dash; the result is capped at
 * {@link AWAIT_MESSAGE_MAX_CHARS} with an explicit ellipsis so a truncation is never
 * mistaken for the end of the sentence.
 *
 * Also the read-side renderer for an await row stored BEFORE this fix, which still holds
 * raw template text (awaitStore).
 */
export function renderAwaitMessage(message: string, context: JsonObject): string {
  const rendered = render(message, context, UNRESOLVED_PLACEHOLDER);
  if (rendered.length <= AWAIT_MESSAGE_MAX_CHARS) return rendered;
  return `${rendered.slice(0, AWAIT_MESSAGE_MAX_CHARS - 1)}…`;
}

/** `step.prompt` — read by a model. Unresolved tokens render EMPTY: see the module note
 *  on the discussion pattern's opening turn. */
export function renderAgentPrompt(prompt: string, context: JsonObject): string {
  return render(prompt, context, '');
}

/** `step.agentId` — a ref, not prose. Unresolved renders EMPTY so an agent step can tell
 *  "the run names no speaker" apart from a literal slug and refuse. */
export function renderAgentRef(ref: string, context: JsonObject): string {
  return render(ref, context, '');
}

/**
 * `step.input` — an action's input object: every string VALUE, at any depth, is rendered
 * with the empty-string policy (a machine payload, not prose). Object KEYS are never
 * touched: they are the action's parameter names, not authored text.
 *
 * Substitution is always textual, so a token always yields a string: `"{{ctx.n}}"` with
 * `n: 5` becomes `"5"`, not `5`. The alternative (a lone token adopting the resolved JSON
 * type) would make an input's shape depend on the run's payload, which is exactly what a
 * connector's schema cannot absorb.
 *
 * Recursion terminates because the input is parsed JSON (acyclic by construction); a
 * fresh value is returned and the graph's own `step.input` is never mutated.
 */
export function renderActionInput(input: JsonObject, context: JsonObject): JsonObject {
  return renderJson(input, context) as JsonObject;
}

function renderJson(value: JsonValue, context: JsonObject): JsonValue {
  if (typeof value === 'string') return render(value, context, '');
  if (Array.isArray(value)) return value.map((entry) => renderJson(entry, context));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = renderJson(entry, context);
    return out;
  }
  return value;
}
