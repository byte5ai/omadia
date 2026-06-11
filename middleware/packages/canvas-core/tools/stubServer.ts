/**
 * Dev/test stand-in for omadia-ui-channel: serves the canvas WebSocket at
 * /omadia-ui/canvas, runs the offer→select→ack handshake, and replays the
 * Walkthrough-1 recording once per incoming `turn`. No auth — local dev only.
 */
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';

interface RecordedFrame {
  delayMs: number;
  message: Record<string, unknown>;
}

const recording: { frames: RecordedFrame[] } = JSON.parse(
  readFileSync(new URL('./recordings/wt1.json', import.meta.url), 'utf8'),
) as { frames: RecordedFrame[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stamp(message: Record<string, unknown>, turnId: string, canvasSessionId: string): string {
  return JSON.stringify(message)
    .replaceAll('"$TURN"', JSON.stringify(turnId))
    .replaceAll('"$CANVAS"', JSON.stringify(canvasSessionId));
}

export function startStubServer(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port, path: '/omadia-ui/canvas' });

  wss.on('connection', (ws: WebSocket) => {
    const handshakeId = `hs-${Math.random().toString(36).slice(2)}`;
    let canvasSessionId = '';
    let ready = false;
    let replay: Promise<void> = Promise.resolve();

    ws.send(
      JSON.stringify({
        type: 'handshake_offer',
        handshakeId,
        protocolVersions: ['1.0'],
        opsCatalogVersions: ['1.0'],
      }),
    );

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!ready && msg['type'] === 'handshake_select' && msg['handshakeId'] === handshakeId) {
        if (msg['protocolVersion'] !== '1.0' || msg['opsCatalogVersion'] !== '1.0') {
          ws.send(
            JSON.stringify({
              type: 'handshake_error',
              handshakeId,
              reason: 'protocol-version-unsupported',
              supported: { protocolVersions: ['1.0'], opsCatalogVersions: ['1.0'] },
            }),
          );
          return;
        }
        canvasSessionId =
          typeof msg['canvasSessionId'] === 'string' && msg['canvasSessionId'].length > 0
            ? msg['canvasSessionId']
            : 'stub-canvas';
        ws.send(JSON.stringify({ type: 'handshake_ack', handshakeId, canvasSessionId }));
        ready = true;
        return;
      }
      if (ready && msg['type'] === 'turn') {
        const turnId = typeof msg['turnId'] === 'string' && msg['turnId'] ? msg['turnId'] : 'stub-turn';
        replay = replay.then(async () => {
          for (const frame of recording.frames) {
            await sleep(frame.delayMs);
            if (ws.readyState !== ws.OPEN) return;
            ws.send(stamp(frame.message, turnId, canvasSessionId));
          }
        });
      }
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      resolve({
        port: typeof addr === 'object' && addr !== null ? addr.port : port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
  });
}

// CLI entry: `npm run stub-server`
const argv1 = process.argv[1];
if (argv1 && import.meta.url.endsWith(argv1.split('/').pop() ?? '')) {
  void startStubServer(8181).then(({ port }) =>
    console.log(`omadia-ui stub server: ws://127.0.0.1:${port}/omadia-ui/canvas`),
  );
}
