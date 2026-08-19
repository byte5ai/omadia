/**
 * #584 — per-dispatch metering side-channel for NATIVE tools.
 *
 * `NativeToolHandler` returns a bare string, so a native tool that metered a
 * transcription call has no return-value slot for its Source/Billed Minutes
 * (sub-agent tools carry them on `LocalSubAgentToolResult.usage`, the
 * `postcondition` route). The orchestrator therefore opens a capture scope
 * around each dispatch and the tool reports into it via {@link toolUsage}.
 *
 * Deliberately its OWN AsyncLocalStorage, not a field on `turnContext`: a
 * per-dispatch turn-context copy would break the documented live-store
 * mutation contract (`activePersonaSkillId`, `mcpInputReplayNote` are
 * written onto the live store inside tool handlers and must survive to later
 * iterations — pinned by turnContextPropagation.test.ts). A separate storage
 * scopes the sink per call (concurrent slots in one `allSettled` batch
 * cannot see each other's box) while `turnContext.current()` keeps returning
 * the live object.
 *
 * Outside any capture scope `report` is a no-op and only the trace field is
 * lost — the `transcription_usage` table stays authoritative either way
 * (trace = visibility, table = truth).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolCallUsageReport {
  sourceMinutes: number;
  billedMinutes: number;
}

interface UsageBox {
  value?: ToolCallUsageReport;
}

const storage = new AsyncLocalStorage<UsageBox>();

export const toolUsage = {
  /** Runs one tool dispatch with `box` as its capture slot (orchestrator). */
  capture<T>(box: UsageBox, fn: () => Promise<T>): Promise<T> {
    return storage.run(box, fn);
  },
  /** Reports the dispatch's metering (tool side). Last write wins — a tool
   *  books once per provider call, and the call's final figures stand. */
  report(usage: ToolCallUsageReport): void {
    const box = storage.getStore();
    if (box) box.value = usage;
  },
};
