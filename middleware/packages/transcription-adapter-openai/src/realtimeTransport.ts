import { WebSocket } from 'ws';

/**
 * Injectable WebSocket seam for the realtime provider (#584 WS T).
 *
 * The provider is written against this three-method surface so its protocol
 * logic (session config, audio append/commit, delta consumption) is fully
 * unit-testable with a scripted fake — no live credentials, no network. The
 * default implementation below is the only file that touches `ws`.
 */

export interface RealtimeSocket {
  /** Send one JSON event to the session. */
  send(event: Record<string, unknown>): void;
  /** Server events, parsed from JSON, until the socket closes. */
  events(): AsyncIterable<unknown>;
  close(): void;
}

export type RealtimeSocketFactory = (connect: {
  readonly url: string;
  readonly apiKey: string;
}) => Promise<RealtimeSocket>;

/** Production factory over `ws`. Bearer auth via header, matching the
 *  Realtime API's server-to-server WebSocket auth. */
export const openRealtimeSocket: RealtimeSocketFactory = async ({
  url,
  apiKey,
}) => {
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', (err: Error) => {
      reject(err);
    });
  });

  // Buffered pull adapter: 'message' events land between iterator pulls, so
  // they queue; close/error resolve any waiting pull. Single-consumer.
  const queue: unknown[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      queue.push(JSON.parse(rawToString(data)));
    } catch {
      // Non-JSON frames carry nothing for this consumer.
    }
    wake();
  });
  socket.on('close', () => {
    done = true;
    wake();
  });
  socket.on('error', (err: Error) => {
    failure = err;
    done = true;
    wake();
  });

  return {
    send(event: Record<string, unknown>): void {
      socket.send(JSON.stringify(event));
    },
    async *events(): AsyncIterable<unknown> {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (done) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    close(): void {
      socket.close();
    },
  };
};

function rawToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
