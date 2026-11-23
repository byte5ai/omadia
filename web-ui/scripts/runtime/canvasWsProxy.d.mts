import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export declare const CANVAS_WS_PATH: '/omadia-ui/canvas';
export declare const UPSTREAM_UPGRADE_TIMEOUT_MS: number;

export interface CanvasWsProxyOptions {
  readonly middlewareUrl: string;
  readonly scheme: 'http' | 'https';
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
}

export declare function isCanvasUpgrade(url: string | undefined): boolean;
export declare function upstreamHeaders(
  headers: IncomingHttpHeaders,
  scheme: 'http' | 'https',
): Record<string, string | string[]>;
export declare function proxyCanvasUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: CanvasWsProxyOptions,
): void;
export declare function attachCanvasWsProxy<S extends Server>(server: S, resolve: () => CanvasWsProxyOptions): S;
export declare function canvasWsProxyEnv(): { middlewareUrl: string; scheme: 'http' | 'https' };
