/**
 * S+10-2: `ChatStreamEvent` is now defined as a full discriminated union in
 * `chatAgent.ts` (lifted from the kernel-side orchestrator). This module
 * remains as a back-compat re-export so existing imports via
 * `coreApi.ts` keep working.
 */
export type { ChatStreamEvent } from './chatAgent.js';
