/**
 * The tool-error helper of `@omadia/plugin-api`, resolved at runtime.
 *
 * A plugin's `@omadia/plugin-api` is the HOST's copy, and
 * `toolErrorFromException` exists only from plugin-api 1.20.0 on. A named
 * import of it is an ESM link error on an older host: the plugin would not
 * load at all, although its manifest admits that host. So it is read off the
 * namespace, and where it is missing the tool answers with
 * {@link legacyHostToolError}, a fixed text that carries nothing of the error.
 *
 * Plugins must not import kernel code, so web-search, diagrams and discussion
 * each carry their own copy of this module (this one without
 * `newToolErrorRef`, which discussion does not use).
 */
import { randomBytes } from 'node:crypto';

import * as pluginApi from '@omadia/plugin-api';

export interface ToolErrorHelpers {
  readonly toolErrorFromException: typeof pluginApi.toolErrorFromException;
}

/**
 * The helper from a `@omadia/plugin-api` namespace, or `null` when it lacks
 * it (a host before plugin-api 1.20.0).
 */
export function resolveToolErrorHelpers(api: object): ToolErrorHelpers | null {
  const { toolErrorFromException } = api as { readonly toolErrorFromException?: unknown };
  if (typeof toolErrorFromException !== 'function') return null;
  return { toolErrorFromException } as ToolErrorHelpers;
}

/** This host's helpers: `null` on a host before plugin-api 1.20.0. */
export const hostToolErrorHelpers: ToolErrorHelpers | null = resolveToolErrorHelpers(pluginApi);

export interface LegacyToolErrorOptions {
  /** Log prefix naming the producer, e.g. `discussion`. */
  readonly site: string;
  /** Where the FULL error goes. Default `console.error`. */
  readonly log?: (line: string, err: unknown) => void;
}

/**
 * The tool result for a failure on a host before plugin-api 1.20.0. It names
 * the tool and a fresh log reference, nothing of the error: no message, no
 * class name, no upstream text. The full error goes to the server log under
 * that reference, where an operator finds it.
 */
export function legacyHostToolError(
  toolName: string,
  err: unknown,
  options: LegacyToolErrorOptions,
): string {
  const ref = `err_${randomBytes(6).toString('hex')}`;
  const log =
    options.log ??
    ((line: string, e: unknown): void => {
      console.error(line, e);
    });
  log(
    `[${options.site}:${toolName}] tool failed (ref=${ref}) — error text withheld from the model:`,
    err,
  );
  return `Error: ${toolName} failed; details are in the server log (ref ${ref})`;
}

/**
 * `toolErrorFromException` where the host has it, {@link legacyHostToolError}
 * where it does not.
 */
export function compatToolErrorFromException(
  helpers: ToolErrorHelpers | null,
  toolName: string,
  err: unknown,
  options: LegacyToolErrorOptions,
): string {
  return helpers === null
    ? legacyHostToolError(toolName, err, options)
    : helpers.toolErrorFromException(toolName, err, options);
}
