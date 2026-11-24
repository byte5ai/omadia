// The run-context token grammar — `{{ctx.path}}` / `{{steps.<stepId>.field}}` — in ONE
// place (#1709). Two sides have to agree on it or a graph becomes unauthorable:
//
//   - the AUTHORING side (`validate.ts`) exempts a templated `step.agentId` from the
//     `unknown_agent_ref` check, because the agent is named by the run, not the graph;
//   - the RUNTIME side (the middleware's `conductor/runInterpolation.ts`) substitutes the
//     token against the live run context.
//
// When those grammars drifted, a token the runtime resolved was rejected at authoring
// time as an unknown ref. Hence this module: the pattern is defined once and both sides
// import it.
//
// Path segments are `[A-Za-z0-9_-]+`. The dash matters: a step id is any non-empty string
// (conductorGraphSchema), and the bundled templates use kebab ids, so
// `{{steps.hr-checklist.approved}}` has to be a token. A `:` is deliberately NOT in the
// class, which is what keeps this grammar disjoint from the template `slot:text:<key>`
// tokens of textSlots.ts.

const RUN_TOKEN_SOURCE = '\\{\\{\\s*([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)\\s*\\}\\}';

/** A fresh global matcher. Fresh per call: a shared `/g` regex carries `lastIndex`
 *  between callers, and this one is used from both packages. */
export function runTokenMatcher(): RegExp {
  return new RegExp(RUN_TOKEN_SOURCE, 'g');
}

/** True when `value` contains at least one run-context token — i.e. it names a value the
 *  RUN supplies rather than one the graph pins. */
export function isTemplateExpression(value: string): boolean {
  return new RegExp(RUN_TOKEN_SOURCE).test(value);
}
