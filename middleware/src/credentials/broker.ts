/**
 * #578 Phase 2 — the credential broker: the egress-stamping layer.
 *
 * An agent names a `service` credential and describes a request (host,
 * method, path). The broker decides whether that principal, right now, may
 * use that credential for that exact request — and if so, it decrypts the
 * secret, stamps it onto the outbound call itself, and hands back only the
 * RESPONSE. The caller never receives the secret, in either the success or
 * the failure path.
 *
 * `BrokerRequestDescriptor.host` exists precisely so the broker can catch an
 * agent naming the RIGHT credential but the WRONG destination: the request
 * always states a target host, and it is compared against the credential's
 * OWN declared host before anything is dispatched. Trusting the declaration
 * alone and skipping this check would turn "the agent asked to send
 * `github-token` to `evil.example.com`" into a successful exfiltration
 * instead of a `host-not-allowed` denial.
 *
 * ## This is a security boundary: fail-closed, every violation audited
 *
 * Every check below is a candidate for "oops, let it through": an unknown
 * credential, an unreachable store, a malformed declaration, a traversal
 * attempt in the path, a host mismatch. Every one of those denies, counts
 * (`recordBrokerOutcome`, #749's pattern) and — when `onAudit` is wired —
 * emits a `BrokerAuditEvent`. Denial messages never carry the secret or the
 * raw store error; see {@link BrokerDenialError}.
 *
 * ## Check order matters for `once` grants
 *
 * All non-mutating checks (credential lookup, grant lookup, host, method,
 * path) run BEFORE a `once` grant is consumed. Consuming first and checking
 * host/path after would let a request that was always going to be refused
 * burn the caller's one-time permission for nothing. The atomic
 * `markGrantConsumed` call is therefore the LAST gate before dispatch, and
 * its own false-return (lost a race to a concurrent use of the same
 * single-use grant) is itself a fail-closed denial — see
 * `grant-consumed-concurrently` in `brokerMetrics.ts`.
 *
 * ## Egress hardening (#778 S3a)
 *
 * Passing every check is not the end of the boundary, because the upstream
 * answers. Redirects are never followed, a timeout bounds the whole call,
 * the body is read under a byte cap, caller headers pass an allow-list
 * (`brokerOutbound.ts`), and the secret is scrubbed from the response
 * (`brokerResponse.ts`). A failed dispatch is a sanitized `upstream-timeout`
 * / `upstream-unreachable` denial that carries neither the URL nor the
 * underlying error. See `docs/security-architecture.md` §10c.
 */

import {
  isGrantActive,
  type Credential,
  type CredentialId,
  type CredentialStore,
  type EncryptedSecretMaterial,
  type Principal,
} from '@omadia/channel-sdk';

import { recordBrokerOutcome, type BrokerDenialReason } from './brokerMetrics.js';
import { buildOutboundRequest, needsInjectionKey } from './brokerOutbound.js';
import {
  readBodyCapped,
  sanitizeResponseHeaders,
  scrubBody,
  secretForms,
  type BrokerUpstreamResponse,
} from './brokerResponse.js';
import {
  matchesAnyPrefix,
  normalizeHost,
  normalizeMethod,
  normalizePathForMatch,
  resolveWirePath,
  type NormalizedPath,
} from './requestMatching.js';

/** How long one brokered call may take, headers AND body. A slow upstream
 *  otherwise holds the request, the grant use and the socket open forever. */
export const BROKER_DEFAULT_TIMEOUT_MS = 20_000;

/** A memory bound, not a context-size bound: the agent-facing tool (#778
 *  S3b) applies its own, tighter cap. The body is truncated here, not
 *  refused — see `brokerResponse.ts`. */
export const BROKER_DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface BrokerRequestDescriptor {
  /** The destination the agent wants this request sent to. Checked against
   *  the credential's OWN declared host — see the module header. */
  readonly host: string;
  readonly method: string;
  /** Path, optionally carrying a `?query`. Never a full URL — see
   *  `normalizePathForMatch`, which refuses an embedded scheme/authority. */
  readonly path: string;
  /** Extra headers the caller wants sent. Only the static allow-list in
   *  `brokerOutbound.ts` survives, compared case-insensitively; everything
   *  else — including any case variant of the injected Authorization or
   *  injectionKey header — is dropped, and the dropped NAMES are audited. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Refused with `invalid-request` on GET/HEAD — before any grant is
   *  consumed — because fetch rejects such a request locally. */
  readonly body?: string;
}

/**
 * What the caller gets back. Redirects are NOT followed: a 3xx arrives here
 * as its status plus a scrubbed `location` header. Header values and the
 * body are scrubbed of the secret (see `brokerResponse.ts`); `truncated`
 * says the body hit the byte cap.
 */
export interface BrokerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
}

/**
 * Thrown on every denial. The message is ALWAYS safe to log — it never
 * contains the secret, the raw declaration, or the underlying store error's
 * message (which could echo back query parameters or other request data).
 * `reason` is the machine-readable form callers should branch on.
 */
export class BrokerDenialError extends Error {
  readonly reason: BrokerDenialReason;
  constructor(reason: BrokerDenialReason, message: string) {
    super(message);
    this.name = 'BrokerDenialError';
    this.reason = reason;
  }
}

/**
 * One broker decision. A request that passed every check and then failed in
 * dispatch produces TWO events, in this order: `allow` (written just before
 * the secret leaves the process) and then `deny` with `upstream-timeout` /
 * `upstream-unreachable`. An audit sink must not read the pair as a
 * contradiction: the `allow` records that the secret left, the `deny` that
 * no usable answer came back.
 */
export interface BrokerAuditEvent {
  readonly kind: 'allow' | 'deny';
  readonly credentialId: CredentialId;
  /** Never the secret — the same log-surrogate `Credential.fingerprint`
   *  already is. Absent when the credential itself could not be found. */
  readonly credentialFingerprint?: string;
  readonly principal: Principal;
  readonly host: string;
  readonly method: string;
  /** Normalised PATHNAME only — never the query string, which may carry
   *  caller-supplied data outside the credential's own secret but is still
   *  not this audit trail's business to persist. */
  readonly path: string;
  readonly reason?: BrokerDenialReason;
  /** On `allow` only, and only when non-empty: lowercased names of caller
   *  headers the allow-list dropped. Never their values. */
  readonly droppedHeaderNames?: readonly string[];
}

/** What the broker passes to `fetch`. `redirect: 'manual'` is not optional:
 *  a followed redirect would carry a custom-header secret to whatever host
 *  the upstream names — the Fetch spec strips `Authorization` on a
 *  cross-origin hop, but not `X-Api-Key` (same reasoning as
 *  `providerCredentialVerifier.ts`). */
export interface BrokerFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
}

/** Minimal shape of the global `fetch` this module needs — narrowed so a
 *  test stub does not have to implement the full `fetch` surface. */
export type BrokerFetch = (url: string, init: BrokerFetchInit) => Promise<BrokerUpstreamResponse>;

export interface CredentialBrokerDeps {
  readonly store: CredentialStore;
  readonly unseal: (material: EncryptedSecretMaterial) => string;
  readonly fetchImpl?: BrokerFetch;
  readonly onAudit?: (event: BrokerAuditEvent) => void;
  /** Injected clock, defaulting to `() => new Date()`. Tests pin this to
   *  evaluate grant expiry deterministically — see `credentials.ts`'s
   *  `isGrantActive` header for why `now` is always a parameter, never read
   *  internally at the point of comparison. */
  readonly now?: () => Date;
  /** Defaults to {@link BROKER_DEFAULT_TIMEOUT_MS}. A positive integer of
   *  at most 2^31 - 1 (Node's timer limit), checked in the constructor. */
  readonly timeoutMs?: number;
  /** Defaults to {@link BROKER_DEFAULT_MAX_RESPONSE_BYTES}. A positive safe
   *  integer, checked in the constructor. */
  readonly maxResponseBytes?: number;
}

/** Methods fetch refuses to send with a body. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The largest delay a Node timer honours. `AbortSignal.timeout(2 ** 31)`
 *  fires after 1 ms (TimeoutOverflowWarning); `2 ** 32` throws
 *  ERR_OUT_OF_RANGE — both only after the `once` grant is consumed. */
const MAX_TIMER_MS = 2_147_483_647;

function assertPositiveInteger(name: string, value: number | undefined, max = Number.MAX_SAFE_INTEGER): void {
  if (value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= max)) return;
  // A NaN timeout makes `AbortSignal.timeout` throw only after the grant is
  // consumed; a NaN or infinite cap silently removes the memory bound.
  throw new RangeError(`CredentialBroker: ${name} must be a positive integer no greater than ${String(max)}`);
}

/** Everything a `deny`/`allow` call needs to finish auditing and throwing,
 *  threaded through as one object instead of a five-parameter call. */
interface RequestContext {
  readonly credentialId: CredentialId;
  readonly principal: Principal;
  readonly method: string;
  /** Replaced by the wire-resolved path once the declared host is known. */
  pathname: string;
  fingerprint?: string;
  host: string;
}

export class CredentialBroker {
  constructor(private readonly deps: CredentialBrokerDeps) {
    assertPositiveInteger('timeoutMs', deps.timeoutMs, MAX_TIMER_MS);
    assertPositiveInteger('maxResponseBytes', deps.maxResponseBytes);
  }

  async request(
    credentialId: CredentialId,
    principal: Principal,
    req: BrokerRequestDescriptor,
  ): Promise<BrokerResponse> {
    const now = (this.deps.now ?? (() => new Date()))();
    const method = normalizeMethod(req.method);

    let pathname: string;
    let search: string;
    try {
      ({ pathname, search } = normalizePathForMatch(req.path));
    } catch {
      // No credential lookup happened yet, so there is nothing further to
      // report than the shape of the rejected request itself.
      this.deny({ credentialId, principal, method, pathname: req.path, host: normalizeHost(req.host) }, 'path-not-allowed');
    }

    const ctx: RequestContext = { credentialId, principal, method, pathname, host: normalizeHost(req.host) };

    // A malformed request is the caller's error, not the upstream's: refuse
    // it here, before any grant is consumed, instead of letting fetch reject
    // it after the `allow` audit as a misleading `upstream-unreachable`.
    if (BODYLESS_METHODS.has(method) && req.body !== undefined) this.deny(ctx, 'invalid-request');

    let credential: Credential;
    try {
      const found = await this.deps.store.getCredential(credentialId);
      if (!found) this.deny(ctx, 'credential-not-found');
      credential = found;
      ctx.fingerprint = credential.fingerprint;
      if (credential.revokedAt) this.deny(ctx, 'credential-revoked');
      if (credential.kind !== 'service' || !credential.broker) this.deny(ctx, 'not-a-service-credential');
    } catch (err) {
      if (err instanceof BrokerDenialError) throw err;
      this.deny(ctx, 'store-unavailable');
    }

    const declaration = credential.broker as NonNullable<Credential['broker']>;
    const declaredHost = normalizeHost(declaration.host);
    if (ctx.host !== declaredHost) this.deny(ctx, 'host-not-allowed');

    // Match the path fetch will SEND, not the string the caller wrote: the
    // WHATWG parser resolves `%2e%2e` that `path.posix` left alone (#778
    // S3a, `resolveWirePath`). From here on the checked, audited and sent
    // path are the same string.
    let wire: NormalizedPath;
    try {
      wire = resolveWirePath(declaredHost, pathname, search);
    } catch {
      this.deny(ctx, 'invalid-broker-declaration');
    }
    ctx.pathname = wire.pathname;

    if (!declaration.allowedMethods.map(normalizeMethod).includes(method)) this.deny(ctx, 'method-not-allowed');
    if (!matchesAnyPrefix(wire.pathname, declaration.pathPrefixes)) this.deny(ctx, 'path-not-allowed');
    if (needsInjectionKey(declaration.injectionScheme) && !declaration.injectionKey) {
      this.deny(ctx, 'invalid-broker-declaration');
    }

    let grant;
    try {
      grant = await this.deps.store.activeGrant(credentialId, principal, now);
    } catch {
      this.deny(ctx, 'store-unavailable');
    }
    if (!grant || !isGrantActive(grant, now)) this.deny(ctx, 'no-active-grant');

    // The atomic gate for `once` grants: deliberately the LAST check before
    // dispatch, see the module header.
    if (grant.mode === 'once') {
      let consumed: boolean;
      try {
        consumed = await this.deps.store.markGrantConsumed(grant.id, now);
      } catch {
        this.deny(ctx, 'store-unavailable');
      }
      if (!consumed) this.deny(ctx, 'grant-consumed-concurrently');
    }

    let material: EncryptedSecretMaterial | undefined;
    try {
      material = await this.deps.store.getSecretMaterial(credentialId);
    } catch {
      this.deny(ctx, 'store-unavailable');
    }
    if (!material) this.deny(ctx, 'credential-not-found');
    const secret = this.deps.unseal(material);

    const { url, headers, droppedHeaderNames } = buildOutboundRequest(
      declaredHost,
      wire.pathname,
      wire.search,
      declaration.injectionScheme,
      declaration.injectionKey,
      secret,
      req.headers,
    );

    // The allow audit precedes dispatch on purpose: it records that the
    // secret is about to leave the process, whatever the upstream does next.
    // The allow METRIC waits for a completed dispatch, so a failed one counts
    // once, as a deny, and never as both.
    this.deps.onAudit?.({
      kind: 'allow',
      credentialId,
      credentialFingerprint: ctx.fingerprint,
      principal,
      host: declaredHost,
      method,
      path: wire.pathname,
      ...(droppedHeaderNames.length > 0 ? { droppedHeaderNames } : {}),
    });

    return this.dispatch(ctx, url, method, headers, req.body, secretForms(secret, declaration.injectionScheme));
  }

  /**
   * Send the stamped request and make its response safe to return: no
   * redirect following, a timeout over headers AND body, a streaming byte
   * cap, and the secret scrubbed from headers and body. Any failure becomes
   * a sanitized denial — the raw error is dropped, never wrapped, because
   * for `query-param` its message, `input` or `cause` can carry the URL and
   * with it the secret.
   */
  private async dispatch(
    ctx: RequestContext,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    forms: readonly string[],
  ): Promise<BrokerResponse> {
    const fetchImpl = this.deps.fetchImpl ?? (globalThis.fetch as unknown as BrokerFetch);
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? BROKER_DEFAULT_TIMEOUT_MS);
    const maxBytes = this.deps.maxResponseBytes ?? BROKER_DEFAULT_MAX_RESPONSE_BYTES;

    let result: BrokerResponse;
    try {
      const response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal });
      const capped = await readBodyCapped(response, maxBytes, signal);
      result = {
        status: response.status,
        headers: sanitizeResponseHeaders(response.headers, forms),
        body: scrubBody(capped, forms),
        truncated: capped.truncated,
      };
    } catch (err) {
      this.dispatchFailure(ctx, err, signal);
    }
    recordBrokerOutcome('allow');
    return result;
  }

  private dispatchFailure(ctx: RequestContext, err: unknown, signal: AbortSignal): never {
    const name = err instanceof Error ? err.name : '';
    const timedOut = signal.aborted || name === 'TimeoutError' || name === 'AbortError';
    this.deny(ctx, timedOut ? 'upstream-timeout' : 'upstream-unreachable');
  }

  private deny(ctx: RequestContext, reason: BrokerDenialReason): never {
    recordBrokerOutcome('deny', reason);
    this.deps.onAudit?.({
      kind: 'deny',
      credentialId: ctx.credentialId,
      credentialFingerprint: ctx.fingerprint,
      principal: ctx.principal,
      host: ctx.host,
      method: ctx.method,
      path: ctx.pathname,
      reason,
    });
    throw new BrokerDenialError(reason, `credential broker denied the request: ${reason}`);
  }
}
