/**
 * #2090, spec 2042 §5.10 — the host half of the model gateway's gate.
 *
 * Every provider calls `admitModelCall(operation)` (`@omadia/llm-provider-api`)
 * before it reaches its backend, and this module decides what that does:
 *
 *   1. **Execution context.** Every model call runs in exactly one execution
 *      context (agent turn, execution scope, inbound processing, operator job,
 *      maintenance run), which says whose budget it uses and what it may do.
 *      A call outside any context is refused in `enforce` mode and recorded
 *      in `observe` mode (the expand step: the live instance keeps working
 *      while the last call sites are found).
 *   2. **Operations.** A context may allow only some operations: a
 *      maintenance run only `embed`.
 *   3. **Deadline, cancel, kill switch.** A context past its deadline, a
 *      cancelled one, and any call while an instance or agent kill switch is
 *      set, is refused.
 *   4. **Count and limit** (#2090). Inside {@link meterModelCalls} the call is
 *      counted and, with a limit, refused beyond it.
 *
 * Many helpers catch a failing model call and carry on (a classifier that
 * falls back, a guard that passes on error). A refused call must not become
 * such a silent fallback, so the meter also reports THAT a call was refused;
 * whoever opened it decides what that means for the whole turn.
 *
 * The store and the installed check are process-wide (`Symbol.for` slots): a
 * package that got loaded twice still feeds the one meter the kernel opened.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  MODEL_CALL_GATE_SLOT,
  ModelCallNotCoveredError,
  ModelCallRefusedError,
  type ModelOperation,
} from '@omadia/llm-provider';

/** Spec 2042 §5.10 — whose model call this is. */
export type ExecutionContextKind =
  | 'agent_turn'
  | 'execution_scope'
  | 'inbound_processing'
  | 'operator_job'
  | 'maintenance_run';

export interface ModelExecutionContext {
  readonly kind: ExecutionContextKind;
  /** Whose it is: the agent slug (agent turn, inbound processing), the scope
   *  id, the operator job id, the maintenance run id. */
  readonly ownerId: string;
  /** The agent the call is charged to, where there is one. */
  readonly agentSlug?: string;
  /** Operations the context allows. Absent: all. */
  readonly operations?: readonly ModelOperation[];
  /** Epoch ms after which no call is admitted. */
  readonly deadlineAt?: number;
  /** Aborted: no further call is admitted. */
  readonly signal?: AbortSignal;
}

/** `observe` records calls outside any context, `enforce` refuses them. */
export type ModelGatewayMode = 'observe' | 'enforce';

interface Meter {
  /** Calls let through, in this scope and the ones nested in it. */
  admitted: number;
  /** Calls refused, in this scope and the ones nested in it. */
  refused: number;
  readonly limit: number | undefined;
  readonly context: ModelExecutionContext | undefined;
  readonly parent: Meter | undefined;
}

interface GatewayState {
  mode: ModelGatewayMode;
  /** Set while an instance-wide kill switch is on. */
  instanceHalt: string | undefined;
  /** Agent slugs under an agent kill switch. */
  haltedAgents: ReadonlyMap<string, string>;
  /** Calls admitted outside any context, by operation and call site. */
  readonly uncovered: Map<string, number>;
  /** Called once per new uncovered call site. */
  onUncovered: ((report: UncoveredModelCall) => void) | undefined;
  /** The context a call has when no meter around it carries one: the agent
   *  runtime registers its turn context here, so every call inside an agent's
   *  turn (helpers, hooks, plugin `ctx.llm`, memory) is that agent's without
   *  each call site opening a context of its own. */
  ambient: (() => ModelExecutionContext | undefined) | undefined;
}

export interface UncoveredModelCall {
  readonly operation: ModelOperation;
  /** The first stack frame outside the gate and the provider adapters. */
  readonly site: string;
}

const STORE_SLOT = Symbol.for('omadia.llm.modelCallMeter');
const STATE_SLOT = Symbol.for('omadia.llm.modelGatewayState');
type Slots = Record<symbol, unknown>;

function store(): AsyncLocalStorage<Meter> {
  const slots = globalThis as unknown as Slots;
  const existing = slots[STORE_SLOT] as AsyncLocalStorage<Meter> | undefined;
  if (existing) return existing;
  const created = new AsyncLocalStorage<Meter>();
  slots[STORE_SLOT] = created;
  return created;
}

function state(): GatewayState {
  const slots = globalThis as unknown as Slots;
  const existing = slots[STATE_SLOT] as GatewayState | undefined;
  if (existing) return existing;
  const created: GatewayState = {
    mode: 'observe',
    instanceHalt: undefined,
    haltedAgents: new Map(),
    uncovered: new Map(),
    onUncovered: undefined,
    ambient: undefined,
  };
  slots[STATE_SLOT] = created;
  return created;
}

function refuse(innermost: Meter | undefined, error: Error): never {
  for (let m: Meter | undefined = innermost; m; m = m.parent) m.refused += 1;
  throw error;
}

/** Frames of the gate itself and of provider adapters say nothing about who
 *  called; the first frame after them does. */
const GATE_FRAME = /modelCallMeter|modelCallGate|llm-adapter-|llm-provider|claudeCliAdapter|node:internal|node_modules/;

/** Kernel bridges every caller of a kind passes through: the neutral-provider
 *  bridge of `ctx.llm` / the `llm` service, the `ctx.llm` accessor and the
 *  provider usage wrapper. Reporting them would file every plugin's call under
 *  one site, so the frame after them is the caller. */
const BRIDGE_FRAME = /platform\/anthropicLlmProvider|platform\/pluginContext|withProviderUsageTracking/;

/** The path prefix of a kernel file: `…/middleware/` in a checkout,
 *  `/app/` in the image. */
const KERNEL_PATH_PREFIX = /file:\/\/[^\s)]*?\/(?:middleware|app)\//;

/** Exported for tests: the call site of a stack (`new Error().stack`). */
export function callSiteOf(stack: string): string {
  const frames = stack.split('\n').slice(1);
  const outside = frames.filter((f) => !GATE_FRAME.test(f));
  const frame = outside.find((f) => !BRIDGE_FRAME.test(f)) ?? outside[0] ?? frames[0] ?? 'unknown';
  return frame.trim().replace(/^at /, '').replace(KERNEL_PATH_PREFIX, '');
}

function callSite(): string {
  return callSiteOf(new Error().stack ?? '');
}

function ambientContext(gateway: GatewayState): ModelExecutionContext | undefined {
  try {
    return gateway.ambient?.();
  } catch {
    return undefined;
  }
}

function check(operation: ModelOperation = 'complete'): void {
  const gateway = state();
  const innermost = store().getStore();
  let context: ModelExecutionContext | undefined;
  for (let m: Meter | undefined = innermost; m; m = m.parent) {
    if (m.context) {
      context = m.context;
      break;
    }
  }
  const ambient = context ? undefined : ambientContext(gateway);
  context ??= ambient;

  if (gateway.instanceHalt !== undefined) {
    refuse(innermost, new ModelCallRefusedError('kill_switch', `stopped by an operator (${gateway.instanceHalt})`));
  }

  if (!context) {
    if (gateway.mode === 'enforce') {
      refuse(innermost, new ModelCallRefusedError('no_context', `a '${operation}' call outside any execution context`));
    }
    const site = callSite();
    const key = `${operation} ${site}`;
    const seen = gateway.uncovered.get(key) ?? 0;
    gateway.uncovered.set(key, seen + 1);
    if (seen === 0) gateway.onUncovered?.({ operation, site });
  } else {
    const chain: ModelExecutionContext[] = [];
    for (let m: Meter | undefined = innermost; m; m = m.parent) if (m.context) chain.push(m.context);
    if (ambient) chain.push(ambient);
    for (const c of chain) {
      if (c.operations && !c.operations.includes(operation)) {
        refuse(
          innermost,
          new ModelCallRefusedError('operation_not_allowed', `a ${c.kind.replace('_', ' ')} may not '${operation}'`),
        );
      }
      if (c.signal?.aborted) refuse(innermost, new ModelCallRefusedError('cancelled', `the ${c.kind.replace('_', ' ')} was cancelled`));
      if (c.deadlineAt !== undefined && Date.now() > c.deadlineAt) {
        refuse(innermost, new ModelCallRefusedError('deadline', `the ${c.kind.replace('_', ' ')} is past its deadline`));
      }
      if (c.agentSlug !== undefined) {
        const halt = gateway.haltedAgents.get(c.agentSlug);
        if (halt !== undefined) refuse(innermost, new ModelCallRefusedError('kill_switch', `agent '${c.agentSlug}' stopped by an operator (${halt})`));
      }
    }
  }

  if (!innermost) return;
  for (let meter: Meter | undefined = innermost; meter; meter = meter.parent) {
    if (meter.limit !== undefined && meter.admitted >= meter.limit) {
      refuse(innermost, new ModelCallNotCoveredError(meter.limit));
    }
  }
  for (let meter: Meter | undefined = innermost; meter; meter = meter.parent) meter.admitted += 1;
}

/** Install the check behind `admitModelCall()`. Idempotent. */
export function installModelCallGate(): void {
  const slots = globalThis as unknown as Slots;
  if (typeof slots[MODEL_CALL_GATE_SLOT] !== 'function') slots[MODEL_CALL_GATE_SLOT] = check;
}

export interface ModelCallCount<T> {
  readonly value: T;
  /** Model calls made inside the scope. */
  readonly modelCalls: number;
  /** Model calls the limit refused. More than 0: the work ran without a call
   *  it asked for, whatever it returned. */
  readonly refused: number;
}

/**
 * Run `work`, count the model calls made inside it and, with `limit`, refuse
 * every call beyond it. With `context`, the work runs in that execution
 * context. Scopes nest: a call counts for every scope around it, and each
 * scope's limit, operations, deadline and cancel apply. A call made after
 * `work` settled is outside the scope. `work` gets a probe for the counts so
 * far, so it can decide before it commits a result whether a call was
 * refused on the way. What `work` throws carries on.
 */
export async function meterModelCalls<T>(
  work: (probe: () => { modelCalls: number; refused: number }) => Promise<T>,
  options: { readonly limit?: number; readonly context?: ModelExecutionContext } = {},
): Promise<ModelCallCount<T>> {
  installModelCallGate();
  const als = store();
  const meter: Meter = {
    admitted: 0,
    refused: 0,
    limit: options.limit,
    context: options.context,
    parent: als.getStore(),
  };
  const probe = (): { modelCalls: number; refused: number } => ({ modelCalls: meter.admitted, refused: meter.refused });
  const value = await als.run(meter, () => work(probe));
  return { value, modelCalls: meter.admitted, refused: meter.refused };
}

/**
 * Spec 2042 §5.10 — run `work` in an execution context. Every model call made
 * inside it, at any depth, is that context's.
 */
export async function runInExecutionContext<T>(
  context: ModelExecutionContext,
  work: () => Promise<T>,
): Promise<T> {
  return (await meterModelCalls(() => work(), { context })).value;
}

/**
 * The same, for code that cannot await (a stream constructor, an event
 * handler): `work` runs synchronously in the context, and so does every
 * async continuation it starts.
 */
export function runInExecutionContextSync<T>(context: ModelExecutionContext, work: () => T): T {
  installModelCallGate();
  const als = store();
  return als.run({ admitted: 0, refused: 0, limit: undefined, context, parent: als.getStore() }, work);
}

/** The innermost execution context around the caller, if any (the ambient
 *  one when no meter carries one). */
export function currentExecutionContext(): ModelExecutionContext | undefined {
  for (let m: Meter | undefined = store().getStore(); m; m = m.parent) {
    if (m.context) return m.context;
  }
  return ambientContext(state());
}

/** Every execution context around the caller, innermost first (the ambient
 *  one last, when there is one). A scoped agent turn is an agent turn inside
 *  an execution scope; a rule about the scope looks along this chain. */
export function executionContextChain(): readonly ModelExecutionContext[] {
  const chain: ModelExecutionContext[] = [];
  for (let m: Meter | undefined = store().getStore(); m; m = m.parent) {
    if (m.context) chain.push(m.context);
  }
  const ambient = ambientContext(state());
  if (ambient) chain.push(ambient);
  return chain;
}

/** Registered once by the agent runtime: the agent turn around the caller. */
export function setAmbientExecutionContext(provider: (() => ModelExecutionContext | undefined) | undefined): void {
  installModelCallGate();
  state().ambient = provider;
}

/**
 * Run an async generator in an execution context. A generator resumes in the
 * async context of whoever calls `next()`, so the context is re-entered for
 * every advance (the same reason `turnContext.runGenerator` exists).
 */
export async function* runGeneratorInExecutionContext<T>(
  context: ModelExecutionContext,
  make: () => AsyncGenerator<T> | AsyncIterable<T>,
): AsyncGenerator<T> {
  installModelCallGate();
  const als = store();
  const meter: Meter = { admitted: 0, refused: 0, limit: undefined, context, parent: als.getStore() };
  const iterable = als.run(meter, make);
  const it = (iterable as AsyncIterable<T>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await als.run(meter, () => it.next());
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await als.run(meter, async () => {
      await it.return?.();
    });
  }
}

/** Set by the kernel at boot from `MODEL_GATEWAY_MODE`. Default `observe`. */
export function setModelGatewayMode(mode: ModelGatewayMode): void {
  installModelCallGate();
  state().mode = mode;
}

export function modelGatewayMode(): ModelGatewayMode {
  return state().mode;
}

/** The kernel mirrors its kill switches here; the gate reads them per call. */
export function setModelCallHalts(halts: {
  readonly instance?: string | undefined;
  readonly agents?: ReadonlyMap<string, string>;
}): void {
  installModelCallGate();
  const s = state();
  s.instanceHalt = halts.instance;
  s.haltedAgents = halts.agents ?? new Map();
}

/**
 * The halt that applies to `agentSlug` right now (instance switch first), or
 * `undefined`. For loops the gate cannot see into (a running `claude-cli`
 * turn): they poll this and end themselves.
 */
export function modelCallHaltFor(agentSlug: string | undefined): string | undefined {
  const s = state();
  if (s.instanceHalt !== undefined) return s.instanceHalt;
  return agentSlug !== undefined ? s.haltedAgents.get(agentSlug) : undefined;
}

/** Called once for every call site found making a call outside any context. */
export function onUncoveredModelCall(listener: ((report: UncoveredModelCall) => void) | undefined): void {
  state().onUncovered = listener;
}

/** Calls admitted outside any context so far (observe mode), by
 *  `<operation> <call site>`. */
export function uncoveredModelCalls(): ReadonlyMap<string, number> {
  return new Map(state().uncovered);
}

/** Tests only: back to the boot state. */
export function resetModelGatewayForTests(): void {
  const s = state();
  s.mode = 'observe';
  s.instanceHalt = undefined;
  s.haltedAgents = new Map();
  s.uncovered.clear();
  s.onUncovered = undefined;
  s.ambient = undefined;
}
