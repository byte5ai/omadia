/**
 * Which platform is this middleware running on (#432 follow-up).
 *
 * The self-update executor is compose-only, so a Fly.io deployment sits in
 * notify-only mode and the admin page hands the operator a command to run
 * themselves. A command with `<middleware-app>` in it is a command the
 * operator has to go and look up — and the process already knows the answer:
 * Fly sets `FLY_APP_NAME` and `FLY_MACHINE_ID` inside every Machine.
 *
 * Detection is deliberately positive-only. There is no reliable "am I in
 * compose" signal from inside a container (the labels that would say so are
 * only visible through the Docker socket, which is exactly what this
 * deployment does not have), so anything that is not demonstrably Fly reports
 * `unknown` and the UI falls back to the generic instructions.
 */

export type PlatformKind = 'fly' | 'unknown';

export interface PlatformInfo {
  readonly kind: PlatformKind;
  /** Fly app name, e.g. `omadia-middleware-a1b2c3`. Only set when kind is `fly`. */
  readonly appName?: string;
  /** Fly Machine ID of THIS instance. Only set when kind is `fly`. */
  readonly machineId?: string;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Resolve the hosting platform from an environment bag (injectable so tests
 *  never mutate `process.env`). */
export function resolvePlatform(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlatformInfo {
  const appName = clean(env['FLY_APP_NAME']);
  if (appName === undefined) return { kind: 'unknown' };

  const machineId = clean(env['FLY_MACHINE_ID']);
  return {
    kind: 'fly',
    appName,
    ...(machineId !== undefined ? { machineId } : {}),
  };
}
