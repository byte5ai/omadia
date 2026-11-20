import type { PreviewDraftAgentSource } from '../../src/plugins/builder/previewChatService.js';
import { previewDraftAgentSlug, type PreviewDraftAgentRef } from '../../src/plugins/builder/previewDraftAgents.js';

/** A draft-agent source for preview tests: records each `ensure` call. */
export function fakePreviewDraftAgents(): PreviewDraftAgentSource & {
  readonly calls: Array<{ draftId: string; pluginName: string }>;
} {
  const calls: Array<{ draftId: string; pluginName: string }> = [];
  return {
    calls,
    ensure: (draftId: string, pluginName: string): Promise<PreviewDraftAgentRef> => {
      calls.push({ draftId, pluginName });
      return Promise.resolve({
        id: `draft-agent-${draftId}`,
        slug: previewDraftAgentSlug(draftId),
        name: `Preview: ${pluginName}`,
      });
    },
  };
}
