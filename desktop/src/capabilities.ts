/**
 * The first-run capability switches, and what each one changes in the kernel.
 *
 * A switch in the setup wizard is a promise, so each one has to map to kernel
 * env the supervisor sets on every boot, and the kernel has to report whether
 * it took. `capabilityKernelEnv` is the first half, `attachmentReadiness` judges
 * the kernel's `/health` answer after boot.
 *
 * Only switches the kernel can honour belong here. The wizard once also offered
 * semantic memory and diagrams; both were stored in setup.json and never reached
 * the kernel. Semantic memory is switched on from the admin interface (it
 * downloads its model there), and diagrams need a Kroki server and S3 storage
 * that a desktop install does not ship.
 *
 * Kept free of Electron and Node-only imports: setupState, ipc and the
 * supervisor all use it, and the tests load it directly.
 */

export interface DesktopCapabilities {
  /** Keep attachments in `<data folder>/attachments` (kernel: `ATTACHMENT_STORE_DIR`). */
  readonly attachments: boolean;
}

/** What a fresh install starts with; the wizard's checkbox is pre-ticked to match. */
export const DEFAULT_CAPABILITIES: DesktopCapabilities = Object.freeze({ attachments: true });

/**
 * Kernel env keys the switches own. The switch decides them on every boot, so
 * a value inherited from the launch environment is dropped rather than allowed
 * to turn a switched-off capability back on.
 */
export const CAPABILITY_ENV_KEYS: readonly string[] = Object.freeze(['ATTACHMENT_STORE_DIR']);

/** Where the switched-on capabilities keep their data. */
export interface CapabilityDirs {
  readonly attachments: string;
}

/**
 * Read an untrusted selection: the wizard's payload or a setup.json from any
 * build. Returns only the switches that exist, or null when `attachments` is
 * not a boolean. Keys older builds stored (`embeddings`, `diagrams`) are
 * dropped.
 */
export function parseCapabilities(value: unknown): DesktopCapabilities | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const attachments = (value as { attachments?: unknown }).attachments;
  return typeof attachments === 'boolean' ? { attachments } : null;
}

/** The kernel env the switches produce. Keys of switched-off capabilities are absent. */
export function capabilityKernelEnv(
  capabilities: DesktopCapabilities,
  dirs: CapabilityDirs,
): Record<string, string> {
  return capabilities.attachments ? { ATTACHMENT_STORE_DIR: dirs.attachments } : {};
}

/** A copy of `env` without the keys the switches own. */
export function withoutCapabilityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !CAPABILITY_ENV_KEYS.includes(key)),
  );
}

/** Whether the running kernel does what the switch asked for, as one log line. */
export interface CapabilityReadiness {
  readonly honoured: boolean;
  readonly message: string;
}

type ReportedStore = 's3' | 'filesystem' | 'none';

/** `attachments.store` from a `/health` body, or undefined when it is not there. */
function reportedAttachmentStore(health: unknown): ReportedStore | undefined {
  if (typeof health !== 'object' || health === null) return undefined;
  const attachments = (health as { attachments?: unknown }).attachments;
  if (typeof attachments !== 'object' || attachments === null) return undefined;
  const store = (attachments as { store?: unknown }).store;
  return store === 's3' || store === 'filesystem' || store === 'none' ? store : undefined;
}

/**
 * Judge the kernel's `/health` answer against the attachments switch.
 *
 * On: honoured when the kernel runs a store, the local one or an S3 bucket the
 * environment configured (the kernel prefers S3). Off: honoured unless the
 * kernel still keeps attachments on this computer, which can only come from
 * outside the app (a middleware `.env`, for instance).
 */
export function attachmentReadiness(requested: boolean, health: unknown): CapabilityReadiness {
  const store = reportedAttachmentStore(health);
  if (requested) {
    switch (store) {
      case 'filesystem':
        return { honoured: true, message: 'attachments: on, kept in the data folder on this computer' };
      case 's3':
        return {
          honoured: true,
          message: 'attachments: on, kept in the S3 bucket configured in the environment, which takes precedence over the data folder',
        };
      case 'none':
        return {
          honoured: false,
          message: 'attachments: switched on in setup, but the kernel has no attachment store (see its "attachment store" log line)',
        };
      default:
        return {
          honoured: false,
          message: 'attachments: switched on in setup, but the kernel did not report an attachment store on /health',
        };
    }
  }
  if (store === 'filesystem') {
    return {
      honoured: false,
      message: 'attachments: switched off in setup, but the kernel keeps attachments on this computer (ATTACHMENT_STORE_DIR set outside the app)',
    };
  }
  return { honoured: true, message: 'attachments: off' };
}
