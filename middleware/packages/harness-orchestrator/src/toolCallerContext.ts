/**
 * Ambient caller identity for the standalone tool-dispatch path (#542 prerequisite).
 *
 * `ToolDispatchService` historically carried no caller identity at all. That is
 * fine for the loopback bridge — the caller is the local CLI acting as the
 * session's own user — but a public endpoint receives every call with an API key
 * or token behind it, and the layers beneath dispatch (MCP audit rows, plugin
 * handlers, downstream integrations) need to be able to attribute the call.
 *
 * Propagated ambiently via `AsyncLocalStorage` rather than as a handler parameter
 * for the same reason the idempotency key is: `NativeToolHandler` is
 * `(input: unknown) => Promise<string>`, a published contract implemented by
 * out-of-tree plugins. Widening it is not an option, and it is the same mechanism
 * the privacy handle already uses via `turnContext`.
 *
 * This is a CARRIER, not an authorization boundary. Reading a principal here says
 * who claims to be calling — it does not mean anything checked their scopes.
 * Enforcement belongs with the endpoint that authenticated the credential.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ToolDispatchCallerContext } from './toolDispatchService.js';

const callerStorage = new AsyncLocalStorage<ToolDispatchCallerContext>();

/** Caller identity of the in-flight dispatch, if the entry point supplied one. */
export function currentDispatchCaller(): ToolDispatchCallerContext | undefined {
  return callerStorage.getStore();
}

/** Run `fn` with `caller` visible to every layer beneath it. */
export function runWithDispatchCaller<T>(
  caller: ToolDispatchCallerContext,
  fn: () => T,
): T {
  return callerStorage.run(caller, fn);
}
