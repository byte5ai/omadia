/**
 * The tenant's delegated Teams sign-in, driven from the operator UI
 * (byte5ai/omadia#924).
 *
 * ONE FLOW AT A TIME, HELD IN THIS PROCESS. `startDelegatedSignIn` returns a
 * `flowHandle` that CARRIES the OAuth `device_code`. Anyone holding it for the
 * flow's lifetime can complete the sign-in against Microsoft themselves, which
 * makes it exactly as sensitive as the token it becomes. So it never leaves
 * this process:
 *
 *   * `start()` keeps the handle here and returns only what a human has to
 *     read — the user code, the verification URL, the expiry, the poll
 *     interval and the admin-consent URL.
 *   * `poll()` takes NO handle from the caller. It uses the one it is holding.
 *     The browser therefore has nothing to leak, nothing to replay and nothing
 *     to put in a URL bar.
 *
 * WHY IN MEMORY AND NOT IN THE VAULT. The handle is worthless after roughly
 * fifteen minutes, and a restart mid-flow is an event the operator can see and
 * answer with one click ("start sign-in" again). Persisting a live device code
 * would create a durable copy of a credential to buy a convenience nobody
 * asked for. The TOKENS that come out of the flow are persisted — that is the
 * whole point — and they go to the vault, not here.
 *
 * SINGLE PENDING FLOW, DELIBERATELY. The sign-in is tenant-wide: two operators
 * starting one concurrently want the same outcome, and a second `start()`
 * replaces the first rather than racing it. That also bounds this map at one
 * entry, so there is no expiry sweep to get wrong.
 *
 * NOTHING HERE LOGS A SECRET. Every log line and every returned error goes
 * through `redactDelegated`; the flow handle and both tokens are named in
 * `DELEGATED_SECRET_KEYS`.
 */

import {
  redactDelegated,
  supportsDelegatedCatalogUpload,
  type DelegatedRevokeResult,
  type DelegatedTokenSet,
  type DeviceCodeStart,
  type TeamsDelegatedProvisionerMethods,
} from '../platform/teamsDelegatedSignIn.js';
import type {
  DelegatedSignInPresence,
} from '../platform/teamsDelegatedTokenStore.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Structural subset of the accessor — only the delegated half is needed. */
export type DelegatedProvisionerPort = Partial<TeamsDelegatedProvisionerMethods>;

/** Structural subset of `TeamsDelegatedTokenStore` (platform/teamsDelegatedTokenStore). */
export interface DelegatedTokenCustody {
  read(): Promise<DelegatedTokenSet | undefined>;
  write(tokens: DelegatedTokenSet): Promise<void>;
  clear(): Promise<void>;
  describe(): Promise<DelegatedSignInPresence>;
}

export interface TeamsDelegatedSignInServiceOptions {
  readonly tokens: DelegatedTokenCustody;
  /** Resolves the live accessor, or `undefined` when no connector is active. */
  readonly getProvisioner: () => DelegatedProvisionerPort | undefined;
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Public shapes — none of them carries a secret
// ---------------------------------------------------------------------------

/** What the browser is given when a flow starts. NO `flowHandle`. */
export interface DeviceCodePublicStart {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  readonly scopes: readonly string[];
  /**
   * Shown NEXT TO the code, before anything fails. An admin whose sign-in page
   * demands consent first and who has not been given this URL is stuck with no
   * way forward — which is the dead end this field exists to prevent.
   */
  readonly adminConsentUrl: string;
}

export type DeviceCodePublicPoll =
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'succeeded'; readonly signIn: DelegatedSignInPresence }
  | { readonly status: 'expired'; readonly reason?: string }
  /**
   * NOT "the admin clicked cancel". Microsoft returns the same verdict when
   * Conditional Access, a device-compliance policy or an authentication-method
   * requirement blocks the flow. The `reason` is what tells the two apart, so
   * it is carried through and the UI is required to show it rather than
   * narrating an intent nobody expressed.
   */
  | { readonly status: 'declined'; readonly reason?: string }
  /** No flow is pending in this process — start one (or a restart lost it). */
  | { readonly status: 'no_flow' };

/** Why an operation could not run. Codes, never prose. */
export type DelegatedSignInFailureCode =
  | 'teams_provisioner_unavailable'
  | 'delegated_sign_in_unsupported'
  | 'device_code_flow_failed';

export class DelegatedSignInUnavailableError extends Error {
  constructor(
    public readonly code: DelegatedSignInFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DelegatedSignInUnavailableError';
  }
}

interface PendingFlow {
  /** SECRET-GRADE. Never returned, never logged. */
  readonly flowHandle: string;
  readonly startedAt: Date;
  readonly expiresAt: string;
  readonly public: DeviceCodePublicStart;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TeamsDelegatedSignInService {
  private readonly tokens: DelegatedTokenCustody;
  private readonly getProvisioner: () => DelegatedProvisionerPort | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private pending: PendingFlow | undefined;

  constructor(opts: TeamsDelegatedSignInServiceOptions) {
    this.tokens = opts.tokens;
    this.getProvisioner = opts.getProvisioner;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** Is the delegated half available RIGHT NOW? Resolved per call, never
   *  cached: the connector can be installed or upgraded while we run. */
  supported(): boolean {
    return supportsDelegatedCatalogUpload(this.getProvisioner());
  }

  /**
   * The sign-in state the operator screen renders, plus whether a device-code
   * flow is currently waiting for someone to type the code.
   */
  async status(): Promise<{
    readonly supported: boolean;
    readonly signIn: DelegatedSignInPresence;
    readonly pending: DeviceCodePublicStart | null;
  }> {
    const flow = this.livePending();
    return {
      supported: this.supported(),
      signIn: await this.tokens.describe(),
      pending: flow?.public ?? null,
    };
  }

  /**
   * Begin a device-code sign-in. Replaces any flow already pending — see the
   * module header on why that is the right answer for a tenant-wide action.
   */
  async start(input?: { readonly displayName?: string }): Promise<DeviceCodePublicStart> {
    const provisioner = this.requireDelegated();
    let started: DeviceCodeStart;
    try {
      started = await provisioner.startDelegatedSignIn(
        input?.displayName !== undefined ? { displayName: input.displayName } : {},
      );
    } catch (err) {
      throw this.flowFailure('start', err);
    }
    const publicView: DeviceCodePublicStart = {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresAt: started.expiresAt,
      // A zero or missing interval would turn the UI poll into a hot loop.
      intervalSeconds:
        Number.isFinite(started.intervalSeconds) && started.intervalSeconds > 0
          ? Math.ceil(started.intervalSeconds)
          : DEFAULT_POLL_INTERVAL_SECONDS,
      scopes: started.scopes,
      adminConsentUrl: started.adminConsentUrl,
    };
    this.pending = {
      flowHandle: started.flowHandle,
      startedAt: this.now(),
      expiresAt: started.expiresAt,
      public: publicView,
    };
    // Deliberately no identifiers: the user code is a one-time credential for
    // the duration of the flow and has no business in a server log either.
    this.log('[teams-delegated] device-code sign-in started');
    return publicView;
  }

  /**
   * Poll the flow this service is holding. Takes no handle — that is the
   * point.
   *
   * A `succeeded` poll persists the tokens BEFORE it answers, so an operator
   * who sees "signed in" is looking at a sign-in that survives a restart. The
   * flow is dropped on every terminal verdict; a `pending` one is kept.
   */
  async poll(): Promise<DeviceCodePublicPoll> {
    const flow = this.livePending();
    if (!flow) return { status: 'no_flow' };
    const provisioner = this.requireDelegated();
    let result;
    try {
      result = await provisioner.pollDelegatedSignIn({ flowHandle: flow.flowHandle });
    } catch (err) {
      this.pending = undefined;
      throw this.flowFailure('poll', err);
    }
    switch (result.status) {
      case 'pending':
        return {
          status: 'pending',
          retryAfterSeconds:
            Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds > 0
              ? Math.ceil(result.retryAfterSeconds)
              : flow.public.intervalSeconds,
        };
      case 'succeeded': {
        this.pending = undefined;
        await this.tokens.write(result.tokens);
        this.log('[teams-delegated] device-code sign-in completed; token set stored');
        return { status: 'succeeded', signIn: await this.tokens.describe() };
      }
      case 'expired':
        this.pending = undefined;
        return {
          status: 'expired',
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        };
      case 'declined':
        this.pending = undefined;
        return {
          status: 'declined',
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        };
    }
  }

  /**
   * Refresh the stored access token without a human.
   *
   * Returns the refreshed presence, or `undefined` when nobody is signed in.
   * Used by the runner's recovery path for `DelegatedTokenExpiredError` with
   * `recoverableByRefresh` — a case the operator should never be shown at all.
   */
  async refresh(): Promise<DelegatedSignInPresence | undefined> {
    const current = await this.tokens.read();
    if (current === undefined) return undefined;
    const provisioner = this.requireDelegated();
    const refreshed = await provisioner.refreshDelegatedToken({ tokens: current });
    await this.tokens.write(refreshed);
    return this.tokens.describe();
  }

  /**
   * Sign out: tell the connector, then forget the record.
   *
   * The local clear happens EVEN IF the remote revoke fails or is unsupported.
   * A middleware that kept credentials it was told to drop because a network
   * call failed would be holding a token the operator believes is gone; the
   * remote outcome is reported alongside, so nothing is hidden.
   */
  async revoke(): Promise<{
    readonly cleared: true;
    readonly remote: DelegatedRevokeResult | null;
  }> {
    const current = await this.tokens.read();
    this.pending = undefined;
    let remote: DelegatedRevokeResult | null = null;
    const provisioner = this.getProvisioner();
    if (current !== undefined && typeof provisioner?.revokeDelegatedSignIn === 'function') {
      try {
        remote = provisioner.revokeDelegatedSignIn({ tokens: current });
      } catch (err) {
        this.log(
          `[teams-delegated] remote revoke failed, clearing locally anyway: ${redactedMessage(err)}`,
        );
      }
    }
    await this.tokens.clear();
    return { cleared: true, remote };
  }

  /** The pending flow, unless it has expired — an expired handle is dead
   *  weight and answering `no_flow` sends the operator to the right button. */
  private livePending(): PendingFlow | undefined {
    const flow = this.pending;
    if (!flow) return undefined;
    const expiry = Date.parse(flow.expiresAt);
    if (Number.isFinite(expiry) && expiry <= this.now().getTime()) {
      this.pending = undefined;
      return undefined;
    }
    return flow;
  }

  private requireDelegated(): TeamsDelegatedProvisionerMethods {
    const provisioner = this.getProvisioner();
    if (provisioner === undefined) {
      throw new DelegatedSignInUnavailableError(
        'teams_provisioner_unavailable',
        'teamsProvisioner@1 is not installed — install and activate the M365 connector plugin before signing in.',
      );
    }
    if (!supportsDelegatedCatalogUpload(provisioner)) {
      throw new DelegatedSignInUnavailableError(
        'delegated_sign_in_unsupported',
        'the installed M365 connector does not publish the delegated Teams sign-in — upgrade it to 0.6.0 or newer.',
      );
    }
    return provisioner as TeamsDelegatedProvisionerMethods;
  }

  /** Wrap a connector failure as a typed, redacted service error. */
  private flowFailure(phase: 'start' | 'poll', err: unknown): Error {
    const message = redactedMessage(err);
    this.log(`[teams-delegated] device-code ${phase} failed: ${message}`);
    return new DelegatedSignInUnavailableError('device_code_flow_failed', message);
  }
}

/** Microsoft's own floor when the connector reports nothing usable. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * An error's message with every secret-grade field stripped.
 *
 * The MESSAGE itself is connector prose and may name an OAuth error code —
 * that is wanted, it is what tells "Conditional Access blocked this" apart
 * from "the code expired". What must not travel is anything hanging off the
 * error object, which is why the object goes through `redactDelegated` and
 * only the message string comes out.
 */
function redactedMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(redactDelegated(err));
  return err.message;
}
