/**
 * LAN zero-config advertisement for friction-free pairing (#293).
 *
 * Advertises the Omadia host as a `_omadia._tcp` mDNS/Bonjour service so a
 * desktop client on the same network can discover it with zero typing — the
 * pattern self-hosters already know from Home Assistant, Plex, Syncthing and
 * Jellyfin. The TXT record carries everything the client needs to assemble the
 * same descriptor the HTTP discovery path returns:
 *
 *   path  → canvas WS path (e.g. `/omadia-ui/canvas`)
 *   proto → canvas protocol version (e.g. `1.0`)
 *   auth  → auth mode (`none` | `password` | `oidc`)
 *   name  → human instance label
 *
 * Best-effort and fully optional: any failure to publish is logged and
 * swallowed (a host with no LAN reachability — e.g. a Fly machine — simply
 * never gets discovered this way, which is correct). Toggle with
 * `OMADIA_UI_MDNS_ENABLED`. The desktop app turns it off: user and kernel sit
 * on one machine, so there is nobody to discover it.
 *
 * The advertised HOST is never the machine's own name (OM-70 / #1004).
 * `bonjour-service` defaults the SRV target, and the A record it answers for,
 * to `os.hostname()`. On macOS that is the same `<LocalHostName>.local` the
 * system responder defends, so every start produced a name conflict and macOS
 * renamed the Mac (`-8` → `-9` → `-10`). A derived host such as
 * `omadia-<machine>.local` is unique per machine and cannot collide with it.
 *
 * `bonjour-service` is imported lazily so the dependency is only loaded when
 * advertising is actually enabled.
 */
import os from 'node:os';

export interface MdnsAdvertiseOptions {
  readonly port: number;
  readonly name: string;
  readonly canvasPath: string;
  readonly protocolVersion: string;
  readonly authMode: 'none' | 'password' | 'oidc';
  /**
   * Host name to advertise as the SRV target. Defaults to
   * `deriveAdvertisedHost(name, machineHostName)`; pass one to override. Must
   * never be the machine's own `.local` name (see the header).
   */
  readonly host?: string;
  /** The machine's host name used for the derived default. Defaults to `os.hostname()`. */
  readonly machineHostName?: string;
  /** Test seam: builds the responder instead of importing `bonjour-service`. */
  readonly createResponder?: () => BonjourLike;
  readonly log?: (msg: string) => void;
}

/** One DNS label: lowercase, `[a-z0-9-]`, no leading/trailing/double dashes. */
function dnsLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A DNS label is at most 63 octets. `dns-packet` writes the length byte
 * unchecked, so a longer label goes out with its high bits set and is read
 * back as a compression pointer: the record is malformed, not merely long.
 */
export const MAX_DNS_LABEL_OCTETS = 63;

/** Truncate a label to `max` and drop any dash the cut left at the end. */
function clampLabel(label: string, max: number): string {
  return label.slice(0, Math.max(0, max)).replace(/-+$/, '');
}

/**
 * The host name omadia advertises for itself: `<name>-<machine>.local`, with
 * both parts reduced to DNS labels and a trailing `.local` on the machine name
 * dropped first. Falls back to `omadia` for an unusable instance name and to
 * `<name>.local` for an empty machine name, so the result is always a valid,
 * non-empty host that differs from the machine's own. The label is capped at
 * 63 octets by shortening the machine part first, then the instance part.
 */
export function deriveAdvertisedHost(name: string, machineHostName: string): string {
  const instance = clampLabel(dnsLabel(name) || 'omadia', MAX_DNS_LABEL_OCTETS) || 'omadia';
  const machineBudget = MAX_DNS_LABEL_OCTETS - instance.length - 1;
  const machine = clampLabel(
    dnsLabel(machineHostName.replace(/\.local\.?$/i, '')),
    machineBudget,
  );
  return machine ? `${instance}-${machine}.local` : `${instance}.local`;
}

export interface MdnsAdvertisement {
  stop(): Promise<void>;
}

/**
 * Start advertising `_omadia._tcp`. Returns a handle whose `stop()` tears the
 * advertisement down (and destroys the responder). Never throws — on any
 * failure it logs and returns an inert handle.
 */
export async function startMdnsAdvertiser(
  opts: MdnsAdvertiseOptions,
): Promise<MdnsAdvertisement> {
  const log = opts.log ?? (() => {});
  const inert: MdnsAdvertisement = { async stop() {} };
  try {
    const bonjour = opts.createResponder
      ? opts.createResponder()
      : await importResponder(log);
    if (!bonjour) return inert;
    const host = opts.host ?? deriveAdvertisedHost(opts.name, opts.machineHostName ?? os.hostname());
    const service = bonjour.publish({
      name: opts.name,
      type: 'omadia',
      protocol: 'tcp',
      port: opts.port,
      host,
      txt: {
        path: opts.canvasPath,
        proto: opts.protocolVersion,
        auth: opts.authMode,
        name: opts.name,
      },
    });
    service.on?.('error', (err: unknown) => {
      log(`[pairing/mdns] advertisement error: ${String(err)}`);
    });
    log(
      `[pairing/mdns] advertising _omadia._tcp "${opts.name}" on :${opts.port} ` +
        `(host=${host}, auth=${opts.authMode}, proto=${opts.protocolVersion})`,
    );
    return {
      async stop() {
        await new Promise<void>((resolve) => {
          try {
            bonjour.unpublishAll(() => {
              bonjour.destroy();
              resolve();
            });
          } catch {
            resolve();
          }
        });
      },
    };
  } catch (err) {
    log(`[pairing/mdns] failed to start advertiser (non-fatal): ${String(err)}`);
    return inert;
  }
}

/**
 * Lazy import: keep `bonjour-service` off the hot path when disabled. The
 * specifier is held in a variable so the typecheck gate does not require the
 * package to be installed in every workspace — it is a runtime dep
 * (package.json) pulled in on deploy.
 */
async function importResponder(log: (msg: string) => void): Promise<BonjourLike | undefined> {
  const specifier = 'bonjour-service';
  const mod = (await import(specifier)) as {
    Bonjour: new () => BonjourLike;
    default?: new () => BonjourLike;
  };
  const Ctor = mod.Bonjour ?? mod.default;
  if (!Ctor) {
    log('[pairing/mdns] bonjour-service has no usable constructor — skipping');
    return undefined;
  }
  return new Ctor();
}

/** Minimal structural type for the slice of `bonjour-service` we use. */
export interface BonjourLike {
  publish(config: {
    name: string;
    type: string;
    protocol: 'tcp' | 'udp';
    port: number;
    /** SRV target and the A record the responder answers for. */
    host?: string;
    txt?: Record<string, string>;
  }): { on?(event: string, cb: (err: unknown) => void): void };
  unpublishAll(cb?: () => void): void;
  destroy(): void;
}
