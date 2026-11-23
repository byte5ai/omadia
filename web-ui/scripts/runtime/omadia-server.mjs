// @ts-check
/**
 * The web-ui image's entry point: Next's standalone `server.js`, with the
 * canvas WebSocket relayed to the middleware (`canvasWsProxy.mjs`).
 *
 * Next creates its HTTP server inside `server.js` and exposes no hook for
 * upgrades, so the relay is attached to every server `node:http` creates in
 * this process (there is one: Next's).
 */

import http from 'node:http';
import { createRequire } from 'node:module';

import { attachCanvasWsProxy, canvasWsProxyEnv } from './canvasWsProxy.mjs';

const createServer = http.createServer;
/** @type {typeof http.createServer} */
const createServerWithCanvasRelay = function (...args) {
  // @ts-expect-error -- the overloads of createServer do not spread
  return attachCanvasWsProxy(createServer.apply(http, args), canvasWsProxyEnv);
};
http.createServer = createServerWithCanvasRelay;

createRequire(import.meta.url)('./server.js');
