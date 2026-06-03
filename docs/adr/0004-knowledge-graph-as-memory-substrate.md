# 0004 — Knowledge graph as the agent memory substrate

## Status

Accepted

- **Date:** 2026-06-03
- **Deciders:** Core maintainers
- **Supersedes:** —

## Context and Problem Statement

Omadia agents need durable memory that survives across turns, sessions, and
channels: facts learned, plans made, processes followed, and team insights. They
also need to retrieve the *relevant* slice of that memory at answer time. A flat
vector store alone loses the relationships between entities; a pure relational
schema alone loses semantic similarity search.

What should back agent memory and retrieval?

## Decision Drivers

- **Relationships matter:** the knowledge is graph-shaped — entities (people,
  plans, processes, documents) connected by typed edges — and retrieval often
  needs to walk those connections, not just match text.
- **Semantic retrieval:** answer-time recall needs similarity search over
  embeddings, not only exact lookup.
- **Cross-session, cross-channel:** memory must persist and be recallable
  regardless of which session or channel produced it.
- **Operable on standard infrastructure:** prefer a store an operator can run and
  back up with ordinary Postgres tooling, not a bespoke graph engine.
- **Capability-pluggable:** the store must slot in as a capability provider
  ([ADR-0003](0003-capability-based-multi-provider-middleware.md)), not a
  hard-coded dependency.

## Considered Options

- **A — Knowledge graph over Postgres + vector extension**
  Model memory as a typed graph (entities + relationships) stored in Postgres,
  with embeddings via a pgvector-style extension for semantic search. Exposed to
  agents through graph read paths (a retrieval helper, a query tool, and a
  query-building sub-agent).
- **B — Vector store only**
  Embed everything; retrieve purely by similarity. No first-class relationships.
- **C — Dedicated graph database**
  Use a purpose-built graph DB (e.g. a Cypher-native engine) as a separate
  datastore.

## Decision Outcome

Chosen option: **A — Knowledge graph over Postgres + vector extension**, because
it captures both the relationships *and* the semantics of agent memory in a
single store that runs on standard, operator-friendly Postgres infrastructure,
and plugs in cleanly as a capability provider. It gives multiple retrieval paths
(similarity, direct query, and relationship walks) over one source of truth.

### Consequences

- 🟢 **Good:** Memory keeps its structure — plans, processes, and team insights
  are entities with typed edges, so retrieval can follow relationships, not just
  match strings.
- 🟢 **Good:** Semantic recall and relational/graph queries live in one store;
  one backup and one operational story.
- 🟢 **Good:** Runs on managed or self-hosted Postgres with a vector extension —
  no separate graph-engine to operate; the store is swappable as a capability.
- 🔴 **Bad:** Graph traversal expressed over a relational schema is more work to
  model and tune than in a native graph engine; deep walks need care to stay
  performant.
- 🔴 **Bad:** Multiple read paths (retrieval helper, query tool, query sub-agent)
  mean the system must guide *which* path to use for a given question, or risk
  inconsistent recall.
- ⚪ **Neutral:** The store's connection secret is held in a vault rather than
  passed as plain configuration.

## Pros and Cons of the Options

### A — Graph over Postgres + vectors

- 🟢 Relationships + semantics in one operable store; capability-pluggable;
  standard backup/ops.
- 🔴 Graph traversal on a relational schema needs modeling/perf care; several
  retrieval paths to coordinate.

### B — Vector-only

- 🟢 Simplest; great at "find similar text".
- 🔴 No first-class relationships — can't answer "what depends on / belongs to /
  follows from" without bolting structure back on.

### C — Dedicated graph DB

- 🟢 Native, expressive traversal.
- 🔴 A second datastore to run, secure, and back up; weaker/extra path for vector
  search; higher operational burden, against the "standard infrastructure"
  driver.

## More Information

The store is registered as a capability per
[ADR-0003](0003-capability-based-multi-provider-middleware.md). Retrieval-path
selection heuristics are documented alongside the orchestrator.
