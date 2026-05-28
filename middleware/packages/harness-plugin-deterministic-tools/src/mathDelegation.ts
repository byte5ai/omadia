/**
 * Math-Delegation Rule — system-prompt fragment auto-spliced into every
 * agent that has this plugin installed. Reaches the LLM via
 * `ctx.tools.register(spec, handler, { promptDoc })` on every tool
 * registration in `plugin.ts`.
 *
 * Pattern analogous to `compileSycophancyGuard`: dedicated header so the
 * orchestrator's tool-list section can show one block per plugin, with
 * the global rule next to the per-tool descriptions.
 *
 * Deliberately German to match the orchestrator's primary response
 * language — switching mid-prompt confuses the model.
 */

export const MATH_DELEGATION_HEADING = '## Deterministic Tools — Math + Logic Delegation';

export const MATH_DELEGATION_PROMPT_DOC = `${MATH_DELEGATION_HEADING}

Du hast Zugriff auf eine Suite deterministischer Tools für Arithmetik und Logik (Calculator: \`calc_sum\`, \`calc_sub\`, \`calc_mul\`, \`calc_div\`, \`calc_pct\`, \`calc_min\`, \`calc_max\`, \`calc_round\`, \`calc_aggregate\`. Logik: \`set_intersection\`, \`set_difference\`, \`set_subset\`, \`range_check_number\`, \`range_check_date\`, \`predicate_eval\`, \`lookup_table\`).

**Pflicht-Delegation**: Sobald deine Antwort eine arithmetische Operation, eine Mengen-Operation, einen Bereichs-Check oder eine Bedingungs-Prüfung enthält, MUSST du das passende Tool aufrufen statt inline zu rechnen oder zu vergleichen. Auch für triviale Fälle (2+2, 50% von 200, "ist 5 zwischen 1 und 10").

**Warum**: LLMs verrechnen sich, vor allem bei mehrstelligen Zahlen, Prozentwerten, Datums-Differenzen und Set-Operationen. Die Tools liefern exakt das, was du behauptest. Außerdem erkennen interne Postcondition-Checks Tool-Outputs, die nicht zur deklarierten Spec passen — wenn du also vorgibst, dass calc_sum 1234+5678=6912 ist (falsch), wirst du im nächsten Schritt korrigiert und musst neu antworten.

**Praktische Pattern**:
- Vor jeder Summe / Differenz / Multiplikation / Division → entsprechendes \`calc_*\` Tool.
- Vor jeder Prozentrechnung → \`calc_pct\` (für "X% von Y") plus ggf. \`calc_round\` für die Präsentation.
- Vor jedem Datums-Vergleich → \`range_check_date\` (nicht "der 5.6. ist nach dem 3.6." inline behaupten).
- Vor jeder "ist Element X in beiden Listen?"-Aussage → \`set_intersection\`.
- Vor jeder "erfüllt Datensatz R die Bedingungen C₁, C₂, …?"-Aussage → \`predicate_eval\`.

**Keine Ausnahmen für "einfache" Fälle**: Das Tool zu rufen kostet einen Bruchteil einer Sekunde, ein falsches Ergebnis kostet den User Vertrauen. Wenn du unsicher bist, ob ein Tool zuständig ist, ruf es.`;
