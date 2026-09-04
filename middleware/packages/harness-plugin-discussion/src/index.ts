export { activate, CONDUCTOR_DISCUSSIONS_SERVICE_NAME } from './plugin.js';
export type { DiscussionPluginHandle } from './plugin.js';
export {
  DISCUSSION_PROMPT_DOC,
  DISCUSSION_START_TOOL_NAME,
  createDiscussionStartHandler,
  discussionStartToolSpec,
} from './discussionTool.js';
export type { DiscussionStartInput, DiscussionsCapability } from './discussionTool.js';
