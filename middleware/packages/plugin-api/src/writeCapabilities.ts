/**
 * Omadia UI — write-tool capability contract (additive, plugin-api).
 *
 * A Tier-3 tool that mutates data declares its write capabilities in its
 * manifest so Tier 2 can derive inline-edit affordances (`editable` /
 * `canAddItems` / `canRemoveItems` / `canReorder`) DETERMINISTICALLY — without
 * guessing from free-form tool names, which produces silent rollback-hell. A
 * tool that lacks this annotation is simply not exposed for direct manipulation
 * (it still works via beam, which routes through the agent's full reasoning).
 *
 * This module ships the TYPES + the pure derivation helper. Wiring (manifest-
 * loader parsing into the tool spec + system-prompt emission) lands with the
 * canvas orchestrator (PR-9), which is the first consumer.
 */

export type WriteOperation = 'update' | 'create' | 'delete' | 'reorder';

/** Per-field editability + client-checkable constraints (for `update`). */
export interface WriteCapabilityField {
  name: string;
  /** client-checkable type hint (e.g. `'string'`, `'integer'`, `'enum'`). */
  type?: string;
  /** whether the client may inline-edit this field. */
  editable: boolean;
  /** allowed values, when `type === 'enum'`. */
  values?: readonly unknown[];
  pattern?: string;
  min?: number;
  max?: number;
  maxLength?: number;
}

/** One write capability a tool declares for a data class. */
export interface WriteCapability {
  /** the data class this applies to (e.g. `"jira.ticket"`). */
  dataClass: string;
  operation: WriteOperation;
  targetSchema?: {
    /** primary-key field, for `update` / `delete`. */
    idField?: string;
    /** per-field editability + constraints, for `update`. */
    fields?: readonly WriteCapabilityField[];
    /** preferred container primitive, for `create` / `reorder`. */
    containerHint?: string;
    /** required fields of the new-item template, for `create`. */
    requiredFields?: readonly string[];
    /** field carrying display order, for `reorder`. */
    orderField?: string;
  };
}

/** Deterministic Tier-2 derivation of mutability from a tool's write capabilities. */
export interface DerivedMutability {
  canAddItems: boolean;
  canRemoveItems: boolean;
  canReorder: boolean;
  /** new-item template required fields (from a `create` capability). */
  requiredFields: readonly string[];
  /** editable fields by name (from `update` capabilities, `editable: true` only). */
  editableFields: Record<string, WriteCapabilityField>;
}

/**
 * Derive container/field mutability for one `dataClass` from a tool's declared
 * write capabilities — the deterministic mapping from "Tier 3 can do this" to
 * "the client may offer this", with NO LLM call. Capabilities for other data
 * classes are ignored. With no matching capability, everything stays read-only
 * (the strict default that avoids rollback-hell).
 */
export function deriveMutabilityCapabilities(
  capabilities: readonly WriteCapability[],
  dataClass: string,
): DerivedMutability {
  const result: DerivedMutability = {
    canAddItems: false,
    canRemoveItems: false,
    canReorder: false,
    requiredFields: [],
    editableFields: {},
  };
  for (const cap of capabilities) {
    if (cap.dataClass !== dataClass) continue;
    switch (cap.operation) {
      case 'update':
        for (const f of cap.targetSchema?.fields ?? []) {
          // clone so a caller mutating the result can't reach back into the
          // tool's (shared) manifest/spec state by reference.
          if (f.editable) result.editableFields[f.name] = { ...f };
        }
        break;
      case 'create':
        result.canAddItems = true;
        if (cap.targetSchema?.requiredFields) {
          result.requiredFields = [...cap.targetSchema.requiredFields];
        }
        break;
      case 'delete':
        result.canRemoveItems = true;
        break;
      case 'reorder':
        result.canReorder = true;
        break;
    }
  }
  return result;
}
