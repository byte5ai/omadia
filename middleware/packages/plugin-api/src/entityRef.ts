/**
 * Structured reference to an entity in an upstream business system, captured at
 * the moment a proxy route returns a successful response. Emitted onto the
 * EntityRefBus so the orchestrator can attach it to the current turn's session
 * transcript — turning prose ("Employee Müller") into a machine-readable
 * anchor ("odoo://hr.employee/42") that a future knowledge-graph ingest can
 * lift without LLM guesswork.
 */
export interface EntityRef {
  /**
   * Source-system namespace. Built-in: `'odoo'`, `'confluence'`. OB-29-2
   * widens this to `string` so plugins can stage their own namespaces
   * (e.g. `'personal-notes'`) into the same EntityRef shape — see
   * `EntityIngest.system` for the plugin-side ingest contract.
   */
  system: string;
  /** e.g. `hr.employee`, `account.move`, `confluence.page`. */
  model: string;
  id: string | number;
  /** Human-friendly label if the response carried one (`name`, `title`, …). */
  displayName?: string;
  /**
   * The operation that produced this reference.
   *
   * `'read'` for every observed entity (the common case — proxy reads,
   * search hits, page fetches). `'write'` for entities a plugin created or
   * mutated, e.g. the gated Confluence write tools
   * (`@omadia/integration-confluence` >= 0.3.0: create page / update page /
   * add comment). Consumers that don't care about the distinction can ignore
   * the field; the EntityRefBus forwards refs without inspecting `op`.
   */
  op: 'read' | 'write';
}
