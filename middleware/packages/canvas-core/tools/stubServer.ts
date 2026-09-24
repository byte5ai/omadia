/**
 * Dev/test stand-in for omadia-ui-channel: serves the canvas WebSocket at
 * /omadia-ui/canvas, runs the offer→select→ack handshake, and replays the
 * Walkthrough-1 recording once per incoming `turn`. No auth — local dev only.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // `host` is explicit for the same reason the HTTP test helper binds it: with
  // `port = 0` and no host the socket lands on the wildcard, whose chosen port
  // is not reserved against a process holding that port on 127.0.0.1 — the
  // address every caller below actually dials.
  const wss = new WebSocketServer({ port, host: '127.0.0.1', path: '/omadia-ui/canvas' });

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

/**
 * CLI entry: `npm run stub-server`.
 *
 * The previous form compared only the BASENAME — `import.meta.url.endsWith(
 * argv[1].split('/').pop())` — which is wrong twice over: it splits on `/`
 * only, so on Windows the whole backslash path is the "basename" and the guard
 * is never true; and any entry script that happens to share this filename would
 * start a WebSocket server as a side effect of an unrelated import. Compare
 * full paths instead, realpathing both sides: Node resolves `import.meta.url`
 * through realpath while leaving `argv[1]` alone, so a symlinked checkout or a
 * macOS `/var` → `/private/var` temp dir breaks a plain string compare. Same
 * rule as `desktop/scripts/isEntryPoint.mjs`; kept local because these are
 * separate packages.
 */
function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  void startStubServer(8181).then(({ port }) =>
    console.log(`omadia-ui stub server: ws://127.0.0.1:${port}/omadia-ui/canvas`),
  );
}
