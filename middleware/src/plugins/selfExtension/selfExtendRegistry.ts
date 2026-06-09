/**
 * Plugin self-extension — in-memory registry of the extension TEMPLATES a
 * plugin declares (its `selfExtend.templates`). Populated by the
 * `ToolPluginRuntime` when a self-extendable plugin activates, and read by the
 * routes (to offer templates) and the escalation guard (to resolve a template's
 * required sub-surface). Cleared on deactivation. No persistence — templates are
 * static plugin metadata, re-read from the live module on every activation.
 */

import type { ExtensionTemplate } from '@omadia/plugin-api';

export class SelfExtendRegistry {
  private readonly byPlugin = new Map<string, readonly ExtensionTemplate[]>();

  register(pluginId: string, templates: readonly ExtensionTemplate[]): void {
    this.byPlugin.set(pluginId, templates);
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  /** Templates declared by the plugin; empty array when none / not active. */
  templates(pluginId: string): readonly ExtensionTemplate[] {
    return this.byPlugin.get(pluginId) ?? [];
  }

  getTemplate(pluginId: string, templateId: string): ExtensionTemplate | undefined {
    return this.byPlugin.get(pluginId)?.find((t) => t.id === templateId);
  }

  /** True iff the plugin currently exposes any self-extend templates. */
  has(pluginId: string): boolean {
    return (this.byPlugin.get(pluginId)?.length ?? 0) > 0;
  }
}
