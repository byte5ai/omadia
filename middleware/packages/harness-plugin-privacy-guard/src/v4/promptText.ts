/**
 * Privacy Shield v4 — shared model-facing prompt fragments.
 *
 * The render-vs-file-export contract reaches the model from three surfaces in
 * the same turn: the `v4_render_answer` tool description (`toolDefs.ts`), the
 * digest that carries a dataset (`digest.ts`), and the sub-agent dataset
 * hand-off header (`service.ts`). Hand-maintained, they drifted — one said
 * "ALWAYS end a data question with this call" while the others carried the
 * file/download exception, and only two of the three named the export tool
 * the model can actually call (#1215). Both halves of the contract live here
 * once for this plugin's three surfaces. The orchestrator's system prompt
 * (rules a and 14) and the office plugin's prompts state the same contract in
 * their own words, so a change to it has to follow there too.
 */

/**
 * The inline half: a data answer is rendered server-side from a `datasetId`.
 * Stated plainly on purpose — a capitalised ALWAYS/MUST here over-triggers on
 * current models and then has to be overridden by the exception below.
 */
export const RENDER_CONTRACT =
  'Deliver the final inline answer to a data question with v4_render_answer. ' +
  'The server renders the data table/list from the datasetId, so do not write ' +
  'it yourself.';

/**
 * The file half: a download leaves the inline path entirely. Only the
 * spreadsheet export takes a `datasetId` (`create_docx` has no such hand-off),
 * so a Word document cannot carry the real rows. The tool is named as an
 * example: the v4 tools are offered whenever the shield is on, also on
 * installs without the office plugin.
 */
export const FILE_EXPORT_EXCEPTION =
  'If the user wants the data as a downloadable spreadsheet (Excel/.xlsx) ' +
  'rather than an inline answer, do not use v4_render_answer — call the ' +
  'spreadsheet export tool (e.g. `create_xlsx`, when it is offered) with the ' +
  'same datasetId and the server materializes the real rows into the file. ' +
  'A Word document cannot take a datasetId: offer the data as a spreadsheet ' +
  'or inline instead.';
