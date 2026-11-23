import type { Plugin, ToolSideEffect } from '../api/admin-v1.js';

/**
 * Spec 2042 §5.10/§5.11 — what a plugin tool declares it does, for the
 * checks that depend on it (a write through a plugin tool is checked
 * against the target's readership, §6 criterion 17).
 *
 * `unknown`: the tool declared nothing in its manifest. Until the contract
 * step every plugin may still ship tools without a declaration; a caller
 * decides what `unknown` means for it and must not read it as `read`.
 */
export type DeclaredToolEffect = ToolSideEffect | 'unknown';

export function declaredToolEffect(
  plugin: Pick<Plugin, 'tool_side_effects'> | undefined,
  toolId: string,
): DeclaredToolEffect {
  const declared = plugin?.tool_side_effects;
  return declared !== undefined && Object.hasOwn(declared, toolId) ? (declared[toolId] ?? 'unknown') : 'unknown';
}
