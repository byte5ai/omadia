import { today, turnContext } from '@omadia/orchestrator';

/** Install the canvas sentinel tap and return the FIFO lookup for
 *  `synthesizeSurfaceEvents`. On privacy-guard servers most sentinel-bearing
 *  tool results reaching the stream are interned digests, so the guard's
 *  dispatch sites hand the RAW sentinel-bearing result to this sink BEFORE
 *  interning; `v4_render_answer` hands its full `_pendingCanvasTree` snapshot
 *  to the same sink (its streamed output only acknowledges the render). The
 *  sink is set on the CURRENT (outer) scope —
 *  the orchestrator's turn scope carries it inward (same merge contract as
 *  `captureRawToolResult`); when no scope exists yet (canvas channel
 *  dispatch), one is entered with placeholder identity, exactly like
 *  `withChatParticipants` does for Teams. Guard-less servers never call the
 *  sink and the lookup stays empty — behaviour is unchanged there. */
export function tapCanvasSentinels(log?: (m: string) => void): (toolName: string) => string | undefined {
  const queues = new Map<string, string[]>();
  const sink = (toolName: string, raw: string): void => {
    log?.(`[ui-orchestrator] sentinel tapped tool=${toolName} bytes=${raw.length}`);
    const q = queues.get(toolName);
    if (q) q.push(raw);
    else queues.set(toolName, [raw]);
  };
  const t = turnContext.current();
  if (t !== undefined) {
    t.canvasSentinelSink = sink;
  } else {
    turnContext.enter({ turnId: '', turnDate: today(), canvasSentinelSink: sink });
  }
  return (toolName) => queues.get(toolName)?.shift();
}
