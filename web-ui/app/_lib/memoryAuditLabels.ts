import type { MemorableAclAction } from './api';

/**
 * Translation-key suffixes per memory audit action, under
 * `memories.detail.actions.*`. Shared by the memory detail page and the graph
 * explorer's owner section so both name an action the same way (#1839).
 */
export const MEMORY_AUDIT_ACTION_KEYS: Record<MemorableAclAction, string> = {
  create: 'create',
  expand: 'expand',
  shrink: 'shrink',
  delete: 'delete',
  edit: 'edit',
  edit_excerpt: 'editExcerpt',
  delete_excerpt: 'deleteExcerpt',
};

/** The key suffix for an action, or `null` for one this build does not know. */
export function memoryAuditActionKey(action: string): string | null {
  return Object.prototype.hasOwnProperty.call(MEMORY_AUDIT_ACTION_KEYS, action)
    ? MEMORY_AUDIT_ACTION_KEYS[action as MemorableAclAction]
    : null;
}
