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
 * `OMADIA_UI_MDNS_ENABLED`.
 *
 * `bonjour-service` is imported lazily so the dependency is only loaded when
 * advertising is actually enabled.
 */

export interface MdnsAdvertiseOptions {
  readonly port: number;
  readonly name: string;
  readonly canvasPath: string;
  readonly protocolVersion: string;
  readonly authMode: 'none' | 'password' | 'oidc';
  readonly log?: (msg: string) => void;
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
    // Lazy import: keep `bonjour-service` off the hot path when disabled. The
    // specifier is held in a variable so the typecheck gate does not require
    // the package to be installed in every workspace — it is a runtime dep
    // (package.json) pulled in on deploy.
    const specifier = 'bonjour-service';
    const mod = (await import(specifier)) as {
      Bonjour: new () => BonjourLike;
      default?: new () => BonjourLike;
    };
    const Ctor = mod.Bonjour ?? mod.default;
    if (!Ctor) {
      log('[pairing/mdns] bonjour-service has no usable constructor — skipping');
      return inert;
    }
    const bonjour = new Ctor();
    const service = bonjour.publish({
      name: opts.name,
      type: 'omadia',
      protocol: 'tcp',
      port: opts.port,
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
        `(auth=${opts.authMode}, proto=${opts.protocolVersion})`,
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

/** Minimal structural type for the slice of `bonjour-service` we use. */
interface BonjourLike {
  publish(config: {
    name: string;
    type: string;
    protocol: 'tcp' | 'udp';
    port: number;
    txt?: Record<string, string>;
  }): { on?(event: string, cb: (err: unknown) => void): void };
  unpublishAll(cb?: () => void): void;
  destroy(): void;
}
