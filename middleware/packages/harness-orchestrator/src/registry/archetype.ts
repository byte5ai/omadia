/**
 * #2088 — agent archetypes (migration 0070, spec 2042 §5.1 and §5.10).
 *
 * The archetype is the job profile of an agent: fixed when the agent is
 * created, never switched. `standard` is built in. Every further archetype
 * has a DESCRIPTOR the kernel enforces: what agents of it deliberately omit.
 * No call site asks "is this a facilitator?" to decide whether something is
 * allowed; it asks {@link archetypeOmits}, and the descriptor answers.
 *
 * Until archetype plugins ship their own descriptor (manifest kind
 * `archetype`), the `facilitator` descriptor is seeded here with exactly the
 * omissions of spec 2043 §2.3.
 *
 * DENY BY DEFAULT. An archetype without a registered descriptor (its plugin
 * is gone, or this process does not know it) omits EVERYTHING. The previous
 * rule read an unknown value as `standard`, which would run such an agent
 * with every omission switched off.
 */

export type ArchetypeId = string;

export const STANDARD_ARCHETYPE = 'standard';
export const FACILITATOR_ARCHETYPE = 'facilitator';

/** What an archetype can deliberately leave out of the agent model. */
export const ARCHETYPE_OMISSIONS = [
  'plugin_grant',
  'tool_grant',
  'memory',
  'default_agent',
  'channel_binding',
  'persona_skill',
  'fast_path',
  'agent_to_agent',
  'consultation',
  'sub_agent',
  'assistance',
] as const;
export type ArchetypeOmission = (typeof ARCHETYPE_OMISSIONS)[number];

export interface ArchetypeDescriptor {
  readonly id: ArchetypeId;
  /** Who registered it: `'kernel'` (built in or kernel-seeded) or a plugin id. */
  readonly source: string;
  /** What agents of this archetype never get. */
  readonly omits: readonly ArchetypeOmission[];
  /** How a refusal names such an agent ("a facilitator"). */
  readonly noun: string;
  /** Why, per omission; said to the operator in the refusal. */
  readonly omissionReasons?: Readonly<Partial<Record<ArchetypeOmission, string>>>;
}

const STANDARD_DESCRIPTOR: ArchetypeDescriptor = Object.freeze({
  id: STANDARD_ARCHETYPE,
  source: 'kernel',
  omits: Object.freeze([]),
  noun: 'a standard agent',
});

/** Spec 2043 §2.3, row by row. */
const FACILITATOR_DESCRIPTOR: ArchetypeDescriptor = Object.freeze({
  id: FACILITATOR_ARCHETYPE,
  source: 'kernel',
  omits: Object.freeze([...ARCHETYPE_OMISSIONS]),
  noun: 'a facilitator',
  omissionReasons: Object.freeze({
    plugin_grant:
      'a facilitator only gets the tools of the facilitation engine; business plugins would make it partial',
    tool_grant:
      'a facilitator only gets the tools of the facilitation engine; other tool grants would make it partial',
    memory:
      'a facilitator has no general memory; its only memory is the record of each facilitation',
    default_agent:
      'a facilitator cannot be the default agent; it never answers for or as someone',
    channel_binding:
      'a facilitator speaks only as its own channel identity; a channel binding would let it answer through another bot',
    // The retired term was "persona skill". Spec 2043 §2.3 allows working
    // modes that add moderation methods; until a mode can no longer replace
    // the identity (#2042), every one is refused.
    persona_skill: 'a facilitator has no working modes; it never answers as someone else',
    fast_path: 'a facilitator does not use the fast lane',
    agent_to_agent: 'a facilitator neither talks to other agents nor is addressed by them',
    consultation: 'a facilitator neither consults other agents nor is consulted by them',
    sub_agent: 'a facilitator has no internal helpers and is not attached to other agents',
    assistance: 'a facilitator is not an assistant; it only moderates',
  }),
});

// One registry per process, also when this package is loaded twice (source
// and build): a descriptor registered through one copy must hold for the other.
const REGISTRY_KEY = Symbol.for('omadia.agentArchetypes');
type Registry = Map<ArchetypeId, ArchetypeDescriptor>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let map = holder[REGISTRY_KEY];
  if (!map) {
    map = new Map([
      [STANDARD_DESCRIPTOR.id, STANDARD_DESCRIPTOR],
      [FACILITATOR_DESCRIPTOR.id, FACILITATOR_DESCRIPTOR],
    ]);
    holder[REGISTRY_KEY] = map;
  }
  return map;
}

const ARCHETYPE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export function isArchetypeId(raw: unknown): raw is ArchetypeId {
  return typeof raw === 'string' && ARCHETYPE_ID_RE.test(raw);
}

/**
 * Register (or replace) the descriptor of an archetype. `standard` is the
 * kernel's own and cannot be redefined. Returns a disposer that removes the
 * descriptor again, after which agents of that archetype omit everything.
 */
export function registerArchetype(descriptor: ArchetypeDescriptor): () => void {
  if (!isArchetypeId(descriptor.id)) {
    throw new Error(`archetype id '${String(descriptor.id)}' is not valid (lowercase, digits, hyphens)`);
  }
  if (descriptor.id === STANDARD_ARCHETYPE) {
    throw new Error("the archetype 'standard' is built in and cannot be redefined");
  }
  const unknown = descriptor.omits.filter((o) => !ARCHETYPE_OMISSIONS.includes(o));
  if (unknown.length > 0) {
    throw new Error(`archetype '${descriptor.id}' names unknown omissions: ${unknown.join(', ')}`);
  }
  const frozen: ArchetypeDescriptor = Object.freeze({ ...descriptor, omits: Object.freeze([...descriptor.omits]) });
  registry().set(frozen.id, frozen);
  return () => {
    if (registry().get(frozen.id) === frozen) registry().delete(frozen.id);
  };
}

export function getArchetype(id: ArchetypeId): ArchetypeDescriptor | undefined {
  return registry().get(id);
}

export function listArchetypes(): ArchetypeDescriptor[] {
  return [...registry().values()];
}

/** What an agent row says about its archetype. `kind` is the column of
 *  migration 0067, still written next to `archetype` until it is dropped. */
export interface ArchetypeBearer {
  readonly archetype?: ArchetypeId | undefined;
  readonly kind?: string | undefined;
}

/**
 * The archetype stored for a row. A database before migration 0070 has only
 * `kind`; a database before 0067 has neither, and every agent that existed
 * then is a standard agent.
 */
export function parseArchetype(rawArchetype: unknown, rawKind?: unknown): ArchetypeId {
  if (isArchetypeId(rawArchetype) && rawArchetype !== STANDARD_ARCHETYPE) return rawArchetype;
  if (isArchetypeId(rawKind)) return rawKind;
  return STANDARD_ARCHETYPE;
}

export function archetypeOf(agent: ArchetypeBearer | undefined | null): ArchetypeId {
  return parseArchetype(agent?.archetype, agent?.kind);
}

export function isArchetype(agent: ArchetypeBearer | undefined | null, id: ArchetypeId): boolean {
  return agent !== undefined && agent !== null && archetypeOf(agent) === id;
}

/**
 * THE question every write path and every runtime path asks before it hands
 * an agent something an archetype can leave out. Unknown archetype = yes.
 */
export function archetypeOmits(agent: ArchetypeBearer | undefined | null, omission: ArchetypeOmission): boolean {
  if (!agent) return false;
  const descriptor = getArchetype(archetypeOf(agent));
  return descriptor ? descriptor.omits.includes(omission) : true;
}

/**
 * Thrown wherever an agent is offered something its archetype omits. A
 * distinct class so routes map it to a 4xx with a stable `code`. The code
 * still reads `facilitator_omission`: clients match on it, and it is renamed
 * together with the `kind` column, not before.
 */
export class ArchetypeOmissionError extends Error {
  readonly code = 'facilitator_omission';
  constructor(
    readonly omission: ArchetypeOmission,
    readonly agentSlug: string,
    readonly archetype: ArchetypeId = FACILITATOR_ARCHETYPE,
  ) {
    super(ArchetypeOmissionError.describe(omission, agentSlug, archetype));
    this.name = 'ArchetypeOmissionError';
  }

  private static describe(omission: ArchetypeOmission, agentSlug: string, archetype: ArchetypeId): string {
    const descriptor = getArchetype(archetype);
    if (!descriptor) {
      return `agent "${agentSlug}" has the archetype '${archetype}', which is not registered on this instance: nothing is granted to it`;
    }
    const reason = descriptor.omissionReasons?.[omission] ?? `the archetype '${archetype}' omits ${omission}`;
    return `agent "${agentSlug}" is ${descriptor.noun}: ${reason}`;
  }
}

export function assertArchetypeAllows(
  agent: (ArchetypeBearer & { readonly slug: string }) | undefined | null,
  omission: ArchetypeOmission,
): void {
  if (agent && archetypeOmits(agent, omission)) {
    throw new ArchetypeOmissionError(omission, agent.slug, archetypeOf(agent));
  }
}
