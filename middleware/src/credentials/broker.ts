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
 */

import {
  isGrantActive,
  type Credential,
  type CredentialId,
  type CredentialInjectionScheme,
  type CredentialStore,
  type EncryptedSecretMaterial,
  type Principal,
} from '@omadia/channel-sdk';

import { recordBrokerOutcome, type BrokerDenialReason } from './brokerMetrics.js';
import { matchesAnyPrefix, normalizeHost, normalizeMethod, normalizePathForMatch } from './requestMatching.js';

export interface BrokerRequestDescriptor {
  /** The destination the agent wants this request sent to. Checked against
   *  the credential's OWN declared host — see the module header. */
  readonly host: string;
  readonly method: string;
  /** Path, optionally carrying a `?query`. Never a full URL — see
   *  `normalizePathForMatch`, which refuses an embedded scheme/authority. */
  readonly path: string;
  /** Extra headers the caller wants sent. The broker's own injected
   *  Authorization/header/query-param value always wins on a collision — a
   *  caller cannot override or discover it by supplying the same key. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface BrokerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
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
}

/** Minimal shape of the global `fetch` this module needs — narrowed so a
 *  test stub does not have to implement the full `fetch` surface. */
export type BrokerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; headers: Iterable<[string, string]>; text(): Promise<string> }>;

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
}

/** Everything a `deny`/`allow` call needs to finish auditing and throwing,
 *  threaded through as one object instead of a five-parameter call. */
interface RequestContext {
  readonly credentialId: CredentialId;
  readonly principal: Principal;
  readonly method: string;
  readonly pathname: string;
  fingerprint?: string;
  host: string;
}

export class CredentialBroker {
  constructor(private readonly deps: CredentialBrokerDeps) {}

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
    if (!declaration.allowedMethods.map(normalizeMethod).includes(method)) this.deny(ctx, 'method-not-allowed');
    if (!matchesAnyPrefix(pathname, declaration.pathPrefixes)) this.deny(ctx, 'path-not-allowed');
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

    recordBrokerOutcome('allow');
    this.deps.onAudit?.({
      kind: 'allow',
      credentialId,
      credentialFingerprint: ctx.fingerprint,
      principal,
      host: declaredHost,
      method,
      path: pathname,
    });

    const { url, headers } = buildOutboundRequest(
      declaredHost,
      pathname,
      search,
      declaration.injectionScheme,
      declaration.injectionKey,
      secret,
      req.headers,
    );
    const fetchImpl = this.deps.fetchImpl ?? (globalThis.fetch as unknown as BrokerFetch);
    const response = await fetchImpl(url, { method, headers, body: req.body });
    const body = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
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

function needsInjectionKey(scheme: CredentialInjectionScheme): boolean {
  return scheme === 'header' || scheme === 'query-param';
}

function buildOutboundRequest(
  host: string,
  pathname: string,
  search: string,
  scheme: CredentialInjectionScheme,
  injectionKey: string | undefined,
  secret: string,
  callerHeaders: Readonly<Record<string, string>> | undefined,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...(callerHeaders ?? {}) };
  let effectiveSearch = search;

  if (scheme === 'bearer') {
    headers.Authorization = `Bearer ${secret}`;
  } else if (scheme === 'basic-password') {
    headers.Authorization = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
  } else if (scheme === 'header') {
    headers[injectionKey as string] = secret;
  } else if (scheme === 'query-param') {
    const param = `${encodeURIComponent(injectionKey as string)}=${encodeURIComponent(secret)}`;
    effectiveSearch = effectiveSearch ? `${effectiveSearch}&${param}` : `?${param}`;
  }

  return { url: `https://${host}${pathname}${effectiveSearch}`, headers };
}
