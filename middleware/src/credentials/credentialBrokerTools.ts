/**
 * #2319 / ADR-0290 / ADR-0355 — the kernel capability `credentialBroker@1`:
 * the tools `credential_request` and `credential_ask`.
 *
 * Every call, in this order, fail-closed:
 *  1. a turn with an agent (`turnContext`) — the call runs in that agent's
 *     envelope (ADR-0016), never another's;
 *  2. the account the turn speaks for (`TurnContextValue.accountUserId`,
 *     ADR-0355). Never read from the tool input: an input naming a principal
 *     is refused (`identity_from_turn`), as the asks route does;
 *  3. the operator's grant of this credential to this agent, read live;
 *  4. for a request: the broker (ADR-0102) — the account's own credential
 *     grant, host, method, path, stamping, scrubbing.
 *
 * What reaches the model is a status, the content type and a capped body —
 * no other upstream header (no `set-cookie`). The result then goes through
 * the ordinary tool-result path, Privacy Shield included; the broker's
 * secret scrub stays the first line. A dispatched request that got no usable
 * answer is reported as "outcome unknown", not as a refusal, so a
 * non-idempotent request is not repeated blindly.
 */

import { formatPrincipal, makePrincipal, type CredentialStore, type Principal } from '@omadia/channel-sdk';
import { currentDispatchCaller, turnContext } from '@omadia/orchestrator';
import type { NativeToolSpec } from '@omadia/plugin-api';

import { CredentialAskRejectedError, isAskActionable, type CredentialAsk, type CredentialAskStore } from './asks.js';
import type { AgentCredentialGrantSnapshot, AgentCredentialGrantStore, CredentialAskDeliveryStore } from './agentCredentialGrants.js';
import { BrokerDenialError, type BrokerResponse, type CredentialBroker } from './broker.js';
import type { CredentialAskNotices } from './credentialAskNotices.js';

export const CREDENTIAL_BROKER_CAPABILITY = 'credentialBroker@1';
export const CREDENTIAL_REQUEST_TOOL_NAME = 'credential_request';
export const CREDENTIAL_ASK_TOOL_NAME = 'credential_ask';

/** What an agent sees of a response body; the broker's own cap is a memory bound. */
export const CREDENTIAL_TOOL_MAX_BODY_CHARS = 32_000;
export const CREDENTIAL_ASK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ONCE_VALID_MINUTES = 60;
const MAX_ONCE_VALID_MINUTES = 24 * 60;
const MAX_STANDING_VALID_MINUTES = 30 * 24 * 60;
const MAX_PURPOSE_CHARS = 500;

/** Upstream headers an agent may see. Everything else — cookies first — stays here. */
const VISIBLE_RESPONSE_HEADERS: readonly string[] = ['content-type', 'location', 'retry-after'];

/** Input fields that would let the model name who is calling. */
const IDENTITY_FIELDS: readonly string[] = ['principal', 'user', 'userId', 'user_id', 'requester', 'owner', 'on_behalf_of'];

export const credentialRequestToolSpec: NativeToolSpec = {
  name: CREDENTIAL_REQUEST_TOOL_NAME,
  description:
    'Call an external service with a credential you were granted, without seeing the secret: the kernel adds the secret to the request and returns the response. Name the credential and the exact host, method and path; only what the credential declares is allowed, and the person you work for must hold a grant for it. If they lack one, use credential_ask. A result with status "outcome_unknown" means the request was sent but no answer came back: do not repeat a request that changes data without asking the user.',
  input_schema: {
    type: 'object',
    properties: {
      credential: { type: 'string', description: 'Name of a credential you were granted.' },
      host: { type: 'string', description: 'The host to call, e.g. api.example.com. Must be the credential\'s declared host.' },
      method: { type: 'string', description: 'HTTP method, e.g. GET or POST.' },
      path: { type: 'string', description: 'Path with optional ?query, e.g. /v1/items?limit=10. Never a full URL.' },
      headers: { type: 'object', description: 'Optional extra headers (Accept, Content-Type, …). Authorization is set by the kernel.' },
      body: { type: 'string', description: 'Optional request body (not for GET/HEAD).' },
    },
    required: ['credential', 'host', 'method', 'path'],
  },
};

export const credentialAskToolSpec: NativeToolSpec = {
  name: CREDENTIAL_ASK_TOOL_NAME,
  description:
    'Ask the owner of a personal credential you were granted for permission to use it for the person you work for. The owner gets a notice and decides; you get "pending" now, and the decision is posted to this conversation later. Do not ask again while an ask is pending. State the purpose plainly; the owner reads it. Note: an approved personal credential cannot be used through credential_request yet; tell the user that the permission is recorded.',
  input_schema: {
    type: 'object',
    properties: {
      credential: { type: 'string', description: 'Name of a credential you were granted.' },
      purpose: { type: 'string', description: 'Why it is needed, in one or two sentences.' },
      mode: { type: 'string', enum: ['once', 'standing'], description: 'once (default): a single use; standing: repeated use.' },
      valid_minutes: {
        type: 'number',
        description: 'How long the permission lasts, counted from the approval. Default 60 for once; a standing permission without it lasts until revoked.',
      },
    },
    required: ['credential', 'purpose'],
  },
};

export interface CredentialBrokerAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface CredentialBrokerToolDeps {
  readonly broker: Pick<CredentialBroker, 'request'>;
  readonly credentials: Pick<CredentialStore, 'getCredentialByName' | 'getCredential'>;
  readonly grants: Pick<AgentCredentialGrantStore, 'list'>;
  readonly snapshot: Pick<AgentCredentialGrantSnapshot, 'hasAnyGrant'>;
  readonly asks: Pick<CredentialAskStore, 'createAsk' | 'listForRequester'>;
  readonly deliveries: Pick<CredentialAskDeliveryStore, 'put'>;
  readonly notices: Pick<CredentialAskNotices, 'notifyOwner'>;
  readonly agentBySlug: (slug: string) => CredentialBrokerAgent | undefined;
  /** The asking conversation as the channel's reply handle (`routineTurnContext`). */
  readonly currentConversation: () => { readonly channel: string; readonly conversationRef: unknown } | undefined;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

type Handler = (input: unknown) => Promise<string>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function refuse(code: string, message: string): string {
  return `Error: (${code}) ${message}`;
}

function currentAgentSlug(): string | undefined {
  return turnContext.current()?.agentSlug ?? turnContext.currentAgentSlug() ?? currentDispatchCaller()?.agentSlug;
}

/** The agent of the turn, for the offer gate. */
export function currentBrokerAgent(deps: Pick<CredentialBrokerToolDeps, 'agentBySlug'>): CredentialBrokerAgent | undefined {
  const slug = currentAgentSlug();
  return slug ? deps.agentBySlug(slug) : undefined;
}

/** Offered only to an agent that holds at least one credential grant. */
export function credentialToolsOffered(deps: Pick<CredentialBrokerToolDeps, 'agentBySlug' | 'snapshot'>): boolean {
  const agent = currentBrokerAgent(deps);
  return agent !== undefined && deps.snapshot.hasAnyGrant(agent.id);
}

interface CallFrame {
  readonly agent: CredentialBrokerAgent;
  readonly principal: Principal;
  readonly input: Record<string, unknown>;
}

/** Steps 1 and 2 of the module header, plus the input shape. */
function openCall(deps: CredentialBrokerToolDeps, rawInput: unknown): CallFrame | string {
  const agent = currentBrokerAgent(deps);
  if (!agent) return refuse('no_turn', 'credentials can only be used by an agent inside a turn.');
  const input = isRecord(rawInput) ? rawInput : {};
  const named = IDENTITY_FIELDS.find((field) => input[field] !== undefined);
  if (named) return refuse('identity_from_turn', `\`${named}\` is not accepted: who is calling comes from the conversation, never from the input.`);
  const accountUserId = turnContext.current()?.accountUserId;
  const principal = accountUserId ? makePrincipal('user', accountUserId) : undefined;
  if (!principal) {
    return refuse(
      'account_not_linked',
      'this account is not linked to an omadia user, so no credential can be used for it. Tell the user plainly; an operator can link their channel account.',
    );
  }
  return { agent, principal, input };
}

/** Step 3: the credential, by name, only when granted to this agent. */
async function grantedCredential(
  deps: CredentialBrokerToolDeps,
  frame: CallFrame,
): Promise<{ id: string; name: string; kind: string } | string> {
  const name = str(frame.input['credential']);
  if (!name) return refuse('invalid', '`credential` is required.');
  const [credential, grants] = await Promise.all([deps.credentials.getCredentialByName(name), deps.grants.list(frame.agent.id)]);
  const grantedIds = new Set(grants.map((g) => g.credentialId));
  if (credential && grantedIds.has(credential.id) && !credential.revokedAt) {
    return { id: credential.id, name: credential.name, kind: credential.kind };
  }
  // Same answer for "does not exist" and "not yours": the names of other
  // credentials are not this agent's business.
  const names = (await Promise.all([...grantedIds].map((id) => deps.credentials.getCredential(id))))
    .filter((c) => c !== undefined && !c.revokedAt)
    .map((c) => `"${c!.name}"`);
  return refuse(
    'not_granted',
    names.length > 0
      ? `no credential named "${name}" is granted to you. Granted: ${names.join(', ')}.`
      : 'no credential is granted to you.',
  );
}

function visibleHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (VISIBLE_RESPONSE_HEADERS.includes(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}

export function formatBrokerResponse(response: BrokerResponse): string {
  const capped = response.body.length > CREDENTIAL_TOOL_MAX_BODY_CHARS;
  return JSON.stringify({
    status: response.status,
    headers: visibleHeaders(response.headers),
    body: capped ? response.body.slice(0, CREDENTIAL_TOOL_MAX_BODY_CHARS) : response.body,
    truncated: response.truncated || capped,
  });
}

const DENIAL_HINTS: Partial<Record<string, string>> = {
  'no-active-grant': 'the person you work for holds no active grant for this credential. For a personal credential use credential_ask; otherwise an operator must grant it.',
  'host-not-allowed': 'this credential may not be sent to that host.',
  'method-not-allowed': 'this credential does not allow that method.',
  'path-not-allowed': 'this credential does not allow that path.',
  'not-a-service-credential': 'this credential cannot be used through a request (it is a personal credential or has no declared service).',
  'credential-revoked': 'this credential was revoked.',
  'secret-too-short': 'this credential cannot be used safely; an operator must replace it.',
  'store-unavailable': 'the credential store is unavailable right now. Try again later.',
};

function denialText(err: BrokerDenialError): string {
  if (err.reason === 'upstream-timeout' || err.reason === 'upstream-unreachable') {
    return JSON.stringify({
      status: 'outcome_unknown',
      note: 'The request was sent, but no usable answer came back. It may have taken effect. Do not repeat a request that changes data without asking the user.',
    });
  }
  return refuse(`denied:${err.reason}`, DENIAL_HINTS[err.reason] ?? 'the credential broker refused the request.');
}

export function createCredentialRequestHandler(deps: CredentialBrokerToolDeps): Handler {
  return async (rawInput) => {
    const frame = openCall(deps, rawInput);
    if (typeof frame === 'string') return frame;
    let credential;
    try {
      credential = await grantedCredential(deps, frame);
    } catch {
      return refuse('unavailable', 'the credential grants could not be read right now. Try again later.');
    }
    if (typeof credential === 'string') return credential;

    const { input } = frame;
    const headers = input['headers'];
    if (headers !== undefined && (!isRecord(headers) || !Object.values(headers).every((v) => typeof v === 'string'))) {
      return refuse('invalid', '`headers` must be an object of strings.');
    }
    const body = input['body'];
    if (body !== undefined && typeof body !== 'string') return refuse('invalid', '`body` must be a string.');
    const host = str(input['host']);
    const method = str(input['method']);
    const path = str(input['path']);
    if (!host || !method || !path) return refuse('invalid', '`host`, `method` and `path` are required.');

    try {
      const response = await deps.broker.request(credential.id, frame.principal, {
        host,
        method,
        path,
        ...(headers ? { headers: headers as Record<string, string> } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      return formatBrokerResponse(response);
    } catch (err) {
      if (err instanceof BrokerDenialError) return denialText(err);
      // Broker errors carry no secret (BrokerDenialError is handled above);
      // anything else is a programming or store error worth its message.
      deps.log?.(`[credential-broker] request failed unexpectedly — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      return refuse('failed', 'the request could not be made.');
    }
  };
}

interface AskTerms {
  readonly purpose: string;
  readonly mode: 'once' | 'standing';
  readonly validMinutes?: number;
}

function askTerms(input: Record<string, unknown>): AskTerms | string {
  const purpose = str(input['purpose']);
  if (!purpose) return refuse('invalid', '`purpose` is required.');
  if (purpose.length > MAX_PURPOSE_CHARS) return refuse('invalid', `\`purpose\` is limited to ${String(MAX_PURPOSE_CHARS)} characters.`);
  const rawMode = input['mode'] ?? 'once';
  if (rawMode !== 'once' && rawMode !== 'standing') return refuse('invalid', '`mode` must be "once" or "standing".');
  const raw = input['valid_minutes'];
  const max = rawMode === 'once' ? MAX_ONCE_VALID_MINUTES : MAX_STANDING_VALID_MINUTES;
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max)) {
    return refuse('invalid', `\`valid_minutes\` must be a whole number from 1 to ${String(max)}.`);
  }
  const validMinutes = typeof raw === 'number' ? raw : rawMode === 'once' ? DEFAULT_ONCE_VALID_MINUTES : undefined;
  return { purpose, mode: rawMode, ...(validMinutes !== undefined ? { validMinutes } : {}) };
}

/** One ask at a time per person and credential, so parallel tool calls in one
 *  model message cannot each pass the "already pending?" check. In-process:
 *  a second machine could still race, and then the owner gets two notices. */
const askLocks = new Map<string, Promise<unknown>>();

async function withAskLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = askLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  askLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (askLocks.get(key) === settled) askLocks.delete(key);
  }
}

function alreadyPendingText(ask: CredentialAsk): string {
  return JSON.stringify({
    status: 'pending',
    askId: ask.id,
    note: 'An ask for this credential is already pending for this person; no new ask was sent. Tell the user it is still pending.',
  });
}

function pendingText(ask: CredentialAsk, ownerNotified: boolean, deliversHere: boolean): string {
  return JSON.stringify({
    status: 'pending',
    askId: ask.id,
    note: [
      ownerNotified ? 'The owner was notified.' : 'The owner will see the ask in their inbox.',
      deliversHere
        ? 'Their decision will be posted to this conversation.'
        : 'Their decision cannot be posted here; the user should ask again later.',
      'Tell the user it is pending; do not use the credential before then.',
    ].join(' '),
  });
}

export function createCredentialAskHandler(deps: CredentialBrokerToolDeps): Handler {
  return async (rawInput) => {
    const frame = openCall(deps, rawInput);
    if (typeof frame === 'string') return frame;
    const terms = askTerms(frame.input);
    if (typeof terms === 'string') return terms;
    let credential;
    try {
      credential = await grantedCredential(deps, frame);
    } catch {
      return refuse('unavailable', 'the credential grants could not be read right now. Try again later.');
    }
    if (typeof credential === 'string') return credential;
    if (credential.kind !== 'personal') {
      return refuse('not_askable', `"${credential.name}" has no owner to ask; use credential_request, an operator grants it.`);
    }

    const now = (deps.now ?? (() => new Date()))();
    const lockKey = `${formatPrincipal(frame.principal)}\u0000${credential.id}`;
    try {
      return await withAskLock(lockKey, async () => {
        // One open ask per person and credential: a looping agent must not
        // flood the owner with notices.
        const open = (await deps.asks.listForRequester(frame.principal)).find(
          (a) => a.credentialId === credential.id && isAskActionable(a, now),
        );
        if (open) return alreadyPendingText(open);

        const askExpiresAt = new Date(now.getTime() + CREDENTIAL_ASK_TTL_MS);
        const ask = await deps.asks.createAsk({
          credentialId: credential.id,
          requester: frame.principal,
          purpose: terms.purpose,
          mode: terms.mode,
          askExpiresAt,
          // Counted from approval; the absolute bound covers an approval at
          // the very end of the ask window.
          ...(terms.validMinutes !== undefined
            ? {
                requestedGrantValidSeconds: terms.validMinutes * 60,
                requestedGrantExpiresAt: new Date(askExpiresAt.getTime() + terms.validMinutes * 60_000),
              }
            : {}),
        });
        const conversation = deps.currentConversation();
        if (conversation) {
          await deps.deliveries.put({ askId: ask.id, agentId: frame.agent.id, ...conversation });
        }
        const notified = await deps.notices.notifyOwner(ask, { credentialName: credential.name, agentName: frame.agent.name });
        return pendingText(ask, notified, conversation !== undefined);
      });
    } catch (err) {
      if (err instanceof CredentialAskRejectedError) return refuse(`ask_rejected:${err.reason}`, 'the ask was not accepted.');
      deps.log?.(`[credential-broker] ask failed — ${err instanceof Error ? err.message : String(err)}`);
      return refuse('failed', 'the ask could not be created right now.');
    }
  };
}
