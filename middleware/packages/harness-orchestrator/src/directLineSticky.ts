/**
 * #445 Layer 2b — sticky Direct Line: the target-SELECTION layer.
 *
 * #332 shipped per-message directives (`#<agent> <question>`). Sustaining a
 * multi-turn sparring session with one specialist meant re-typing the token on
 * every message. Sticky mode binds a conversation to a specialist until the
 * user explicitly leaves.
 *
 * The whole feature is one idea: **sticky changes only WHICH
 * `{candidate, payload}` the existing #332 dispatch body receives.** It never
 * introduces a second dispatch path. Everything downstream — privacy masking,
 * the `dispatchTool` choke point, verbatim capture, `delegatedAnswer`
 * attribution, guarded-mode notes, session logging, fact extraction — is the
 * same physical code on turn 1 and on turn N, so every #332 / #361 / #474
 * invariant holds by construction rather than by re-implementation.
 *
 * Everything here is pure and synchronous: no Orchestrator, no I/O, no
 * promises. The store being synchronous matters — it means a read-modify-write
 * is atomic on Node's single thread, so two concurrent turns in one session can
 * never interleave between a sticky read and its write.
 */

import { formatSessionScope, parseSessionScope } from '@omadia/channel-sdk';

import {
  parseDirectLineDirective,
  resolveDirectLineTarget,
  type DirectLineCandidate,
} from './directLine.js';

/** A live binding: this conversation currently talks to this specialist. */
export interface DirectLineBinding {
  /** Stable tool name — the key into the orchestrator's whitelist map. */
  readonly toolName: string;
  /** Stable agent id when known (re-checked for availability every turn). */
  readonly agentId?: string;
  /** Human label for attribution and the on-screen indicator. */
  readonly label: string;
  /** When the binding was first established. Stable across touches. */
  readonly boundAt: number;
  /** Last turn that used the binding — the idle-TTL clock. */
  readonly lastTurnAt: number;
}

/** Why a conversation is not allowed to hold a sticky binding. */
export type StickyScopeRefusal = 'no-scope' | 'shared-scope' | 'synthetic-scope';

export type StickyScopeClassification =
  | { readonly kind: 'eligible'; readonly key: string }
  | { readonly kind: 'refused'; readonly reason: StickyScopeRefusal };

/** Idle lifetime of a binding. Mirrors the conversation-history store. */
export const STICKY_IDLE_TTL_MS = 2 * 60 * 60 * 1000;

/** LRU cap. A bounded map cannot become a memory leak. */
export const STICKY_MAX_BINDINGS = 1000;

/**
 * Reserved exit tokens. Deliberately NOT resolvable agent names: the exit is
 * honoured only when the token does not resolve to a whitelisted specialist,
 * so a deployment that ships an `End` agent keeps its agent and loses only one
 * of the two exit spellings.
 */
export const DIRECT_LINE_EXIT_TOKENS: ReadonlySet<string> = new Set(['end', 'orchestrator']);

/**
 * NUL separator. It cannot occur in a kebab agent slug, in a channel
 * conversation id, or in a `USER_ID_RE`-validated user id, so no field
 * combination can collide with another. This key never reaches the knowledge
 * graph, so the 80-char `sanitizeScope` truncation is structurally irrelevant.
 */
const KEY_SEPARATOR = '\0';

export function stickyKeyFor(args: {
  readonly agentSlug: string;
  readonly sessionScope: string;
  readonly userId?: string;
}): string {
  return `${args.agentSlug}${KEY_SEPARATOR}${args.sessionScope}${KEY_SEPARATOR}${args.userId ?? ''}`;
}

/**
 * Allow-gate for sticky state. Names its refusal instead of silently doing
 * nothing, so the caller can tell the user why the binding did not take.
 *
 * #575 Phase 1: this used to carry its own `SHARED_SCOPES` and
 * `SYNTHETIC_SCOPE_PREFIXES` denylists — a feature-local reconstruction of the
 * scope model that did not exist. Both are gone; the three refusal reasons now
 * fall out of `ScopeId` directly:
 *
 *   `unscoped`/`absent`  → `'no-scope'`      (nothing to be sticky about)
 *   `unscoped`/`shared`  → `'shared-scope'`  (redeemable by a user id)
 *   `system`             → `'synthetic-scope'` (no human conversation at all)
 *
 * That the mapping is total and reason-for-reason identical is the evidence
 * that the type covers what the denylists were covering. If a future scope
 * spelling needs a fourth denylist entry here, the type is wrong — fix the type.
 */
export function classifyStickyScope(args: {
  readonly agentSlug: string;
  readonly sessionScope?: string;
  readonly userId?: string;
}): StickyScopeClassification {
  const scope = parseSessionScope(args.sessionScope);
  if (scope.kind === 'system') return { kind: 'refused', reason: 'synthetic-scope' };
  if (scope.kind === 'unscoped' && scope.reason === 'absent') {
    return { kind: 'refused', reason: 'no-scope' };
  }

  const userId = args.userId?.trim() ?? '';
  if (scope.kind === 'unscoped' && userId.length === 0) {
    // A shared bucket. Only a user id makes the key per-person.
    return { kind: 'refused', reason: 'shared-scope' };
  }

  return {
    kind: 'eligible',
    key: stickyKeyFor({
      agentSlug: args.agentSlug,
      // The wire spelling, unchanged — `formatSessionScope` round-trips, so the
      // key is byte-identical to the pre-#575 one for every existing binding.
      sessionScope: formatSessionScope(scope),
      ...(userId.length > 0 ? { userId } : {}),
    }),
  };
}

/** The bare token of a whole-message directive, or undefined. */
function wholeMessageToken(text: string, prefix: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  return trimmed.slice(prefix.length).toLowerCase();
}

/**
 * True only when the ENTIRE trimmed message is `<prefix><exit-token>`.
 *
 * Whole-message-only is what keeps `#end of quarter — what now?` a genuine
 * question to the specialist rather than a surprise exit that silently eats
 * the user's text.
 */
export function isDirectLineExitMessage(text: string, prefix: string): boolean {
  const token = wholeMessageToken(text, prefix);
  return token !== undefined && DIRECT_LINE_EXIT_TOKENS.has(token);
}

export type DirectLineDecision =
  /** Not a direct-line turn — proceed with the normal LLM loop. */
  | { readonly kind: 'ordinary' }
  /** Bind the conversation to this specialist. No dispatch this turn. */
  | { readonly kind: 'enter'; readonly candidate: DirectLineCandidate }
  /** Hand the conversation back to the orchestrator. No dispatch this turn. */
  | { readonly kind: 'exit' }
  /** Dispatch to this specialist. `sticky` distinguishes bound from one-shot. */
  | {
      readonly kind: 'dispatch';
      readonly candidate: DirectLineCandidate;
      readonly payload: string;
      readonly sticky: boolean;
    }
  /** A faithful, non-dispatching reply. */
  | {
      readonly kind: 'notice';
      readonly reason: 'ambiguous' | 'no-question' | 'sticky-refused' | 'already-bound';
      readonly matches?: readonly DirectLineCandidate[];
      readonly candidate?: DirectLineCandidate;
      readonly refusedReason?: StickyScopeRefusal;
    };

const ORDINARY: DirectLineDecision = { kind: 'ordinary' };

function candidateOf(binding: DirectLineBinding): DirectLineCandidate {
  return {
    toolName: binding.toolName,
    ...(binding.agentId ? { agentId: binding.agentId } : {}),
    label: binding.label,
  };
}

function stickyDispatch(binding: DirectLineBinding, userMessage: string): DirectLineDecision {
  return {
    kind: 'dispatch',
    candidate: candidateOf(binding),
    payload: userMessage,
    sticky: true,
  };
}

/** Exactly #332's rules — used verbatim when the feature flag is off. */
function decideWithoutSticky(
  userMessage: string,
  prefix: string,
  candidates: readonly DirectLineCandidate[],
): DirectLineDecision {
  const directive = parseDirectLineDirective(userMessage, prefix);
  if (!directive) return ORDINARY;
  const resolution = resolveDirectLineTarget(directive.token, candidates);
  if (resolution.kind === 'unknown') return ORDINARY;
  if (resolution.kind === 'ambiguous') {
    return { kind: 'notice', reason: 'ambiguous', matches: resolution.matches };
  }
  if (directive.payload.length === 0) {
    return { kind: 'notice', reason: 'no-question', candidate: resolution.candidate };
  }
  return {
    kind: 'dispatch',
    candidate: resolution.candidate,
    payload: directive.payload,
    sticky: false,
  };
}

function decideWithSticky(args: {
  readonly userMessage: string;
  readonly prefix: string;
  readonly candidates: readonly DirectLineCandidate[];
  readonly binding: DirectLineBinding | undefined;
  readonly scope: StickyScopeClassification;
}): DirectLineDecision {
  const { userMessage, prefix, candidates, binding, scope } = args;

  // Exit is checked FIRST so a live binding can never swallow it.
  if (binding && isDirectLineExitMessage(userMessage, prefix)) {
    const token = wholeMessageToken(userMessage, prefix) ?? '';
    if (resolveDirectLineTarget(token, candidates).kind !== 'resolved') {
      return { kind: 'exit' };
    }
  }

  const directive = parseDirectLineDirective(userMessage, prefix);
  if (!directive) return binding ? stickyDispatch(binding, userMessage) : ORDINARY;

  const resolution = resolveDirectLineTarget(directive.token, candidates);
  if (resolution.kind === 'ambiguous') {
    return { kind: 'notice', reason: 'ambiguous', matches: resolution.matches };
  }
  // The #332 collision rule, preserved literally: an unresolvable `#token` is
  // ordinary text. While bound it belongs to the specialist, verbatim and whole.
  if (resolution.kind === 'unknown') {
    return binding ? stickyDispatch(binding, userMessage) : ORDINARY;
  }

  // A directive WITH a question stays a one-shot and never rebinds — this is
  // what stops the Teams "Direkt mit X" button (which submits
  // `#<token> <original message>`) from silently mode-switching a thread.
  if (directive.payload.length > 0) {
    return {
      kind: 'dispatch',
      candidate: resolution.candidate,
      payload: directive.payload,
      sticky: false,
    };
  }

  // Bare `#<agent>` — the entry gesture. Today this is the one dead end in
  // executeDirectLine ("you didn't include a question"), so it is free grammar.
  if (binding && binding.toolName === resolution.candidate.toolName) {
    return { kind: 'notice', reason: 'already-bound', candidate: resolution.candidate };
  }
  if (scope.kind === 'refused') {
    return {
      kind: 'notice',
      reason: 'sticky-refused',
      candidate: resolution.candidate,
      refusedReason: scope.reason,
    };
  }
  return { kind: 'enter', candidate: resolution.candidate };
}

/**
 * The whole selection rule, as one pure function. Ordered so that the flag-off
 * path is provably identical to #332 and the exit can never be shadowed.
 */
export function decideDirectLineTurn(args: {
  readonly userMessage: string;
  readonly prefix: string;
  readonly candidates: readonly DirectLineCandidate[];
  readonly binding: DirectLineBinding | undefined;
  readonly stickyEnabled: boolean;
  readonly scope: StickyScopeClassification;
}): DirectLineDecision {
  if (!args.stickyEnabled) {
    return decideWithoutSticky(args.userMessage, args.prefix, args.candidates);
  }
  return decideWithSticky({
    userMessage: args.userMessage,
    prefix: args.prefix,
    candidates: args.candidates,
    binding: args.binding,
    scope: args.scope,
  });
}

/** Synchronous by contract — see the module header. */
export interface DirectLineStickyStore {
  get(key: string): DirectLineBinding | undefined;
  bind(
    key: string,
    binding: Pick<DirectLineBinding, 'toolName' | 'agentId' | 'label'>,
  ): DirectLineBinding;
  touch(key: string): void;
  clear(key: string): void;
  size(): number;
}

/**
 * Process-shared, bounded, idle-expiring binding store.
 *
 * Deliberately NOT an Orchestrator instance field: the registry replaces the
 * instance on any config diff, which would silently unbind every live session
 * on an unrelated operator tweak. Every way a binding can be lost — TTL, LRU
 * eviction, process restart — fails toward the orchestrator, which is the safe
 * direction.
 */
export class InMemoryDirectLineStickyStore implements DirectLineStickyStore {
  private readonly bindings = new Map<string, DirectLineBinding>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { now?: () => number; ttlMs?: number; maxEntries?: number }) {
    this.now = opts?.now ?? (() => Date.now());
    this.ttlMs = opts?.ttlMs ?? STICKY_IDLE_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? STICKY_MAX_BINDINGS;
  }

  get(key: string): DirectLineBinding | undefined {
    const existing = this.bindings.get(key);
    if (!existing) return undefined;
    if (this.now() - existing.lastTurnAt > this.ttlMs) {
      this.bindings.delete(key);
      return undefined;
    }
    // Re-insert to move the entry to the most-recently-used end.
    this.bindings.delete(key);
    this.bindings.set(key, existing);
    return existing;
  }

  bind(
    key: string,
    binding: Pick<DirectLineBinding, 'toolName' | 'agentId' | 'label'>,
  ): DirectLineBinding {
    const at = this.now();
    const next: DirectLineBinding = {
      toolName: binding.toolName,
      ...(binding.agentId ? { agentId: binding.agentId } : {}),
      label: binding.label,
      boundAt: at,
      lastTurnAt: at,
    };
    this.bindings.delete(key);
    this.bindings.set(key, next);
    this.evictOverflow();
    return next;
  }

  touch(key: string): void {
    const existing = this.bindings.get(key);
    if (!existing) return;
    const next: DirectLineBinding = { ...existing, lastTurnAt: this.now() };
    this.bindings.delete(key);
    this.bindings.set(key, next);
  }

  clear(key: string): void {
    this.bindings.delete(key);
  }

  size(): number {
    return this.bindings.size;
  }

  private evictOverflow(): void {
    while (this.bindings.size > this.maxEntries) {
      const oldest = this.bindings.keys().next();
      if (oldest.done === true) return;
      this.bindings.delete(oldest.value);
    }
  }
}
