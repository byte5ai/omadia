export { activate, CONDUCTOR_DISCUSSIONS_SERVICE_NAME } from './plugin.js';
export type { DiscussionPluginHandle } from './plugin.js';
export {
  DISCUSSION_PARTNERS_PROMPT_DOC,
  DISCUSSION_PARTNERS_TOOL_NAME,
  DISCUSSION_PROMPT_DOC,
  DISCUSSION_START_TOOL_NAME,
  createDiscussionPartnersHandler,
  createDiscussionStartHandler,
  discussionPartnersToolSpec,
  discussionStartToolSpec,
} from './discussionTool.js';
export type {
  DiscussionPartner,
  DiscussionStartInput,
  DiscussionsCapability,
  ResolveDiscussions,
} from './discussionTool.js';
