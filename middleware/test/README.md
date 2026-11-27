# Postgres-gated middleware tests

Some suites here exercise real Postgres (schema, migrations, stores). They are
**opt-in**: they run only when you point them at a database with an explicit
env var, and otherwise skip cleanly — with a logged reason — so `npm test`
stays hermetic and green with no database around.

## Why there is no default port (issue #572)

These suites used to default to a fixed connection string
(`postgres://test:test@127.0.0.1:55438/test`, and one on `55439`). That is a
trap: any scratch Postgres an agent or developer starts on that port silently
answers the suite's `SELECT 1` probe and **hijacks the run**. The resulting
failure does not look like a port collision — it looks like several unrelated
tests breaking (e.g. six tests dying on `CREATE EXTENSION vector` because the
squatting container was plain `postgres`, not `pgvector`).

There is no safe port by convention. So the suites now:

- require an explicit env var (no hardcoded default port), and
- verify the database is the right *kind* (pgvector suites check the extension
  is available) before running.

Everything routes through [`_helpers/pgTestDb.ts`](./_helpers/pgTestDb.ts) —
`probePgTest({ label, vars, requireVector })`.

## Running them locally

Start a Postgres, then export one of the env vars the suite reads and run the
tests. Suites that need vectors want a **pgvector** image:

```bash
# pgvector image — required for the KG / embedding suites
docker run --rm -d -p 5544:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  pgvector/pgvector:pg16

export MEMORY_PG_TEST_URL='postgres://test:test@127.0.0.1:5544/test'
npm test
```

Pick a port you know is free — the suite talks to exactly the URL you give it
and nothing else.

## Postgres tests must be named `*.pg.test.ts`

CI runs the Postgres suites in exactly one step, `npm run test:pg`, which globs
`test/**/*.pg.test.ts` and is the only step with a test DSN. `npm run test`
sets none, so there a Postgres suite skips. A Postgres case in a file named
`foo.test.ts` therefore runs nowhere in CI, and `PG_TEST_FLOOR` cannot notice,
because it counts only what `test:pg` sees.

`npm run test:pg:names` (a CI step) fails when a test file reaches
`_helpers/pgTestDb.ts`, directly or through another helper, without the
`.pg.test.ts` name. A suite with both legs is split: database-free cases in
`foo.test.ts`, Postgres cases in `foo.pg.test.ts`, shared code in a module that
is not a test (`memoryStoreConformance.ts`, `kgFindEntitiesByIdContract.ts`,
`recallDerivedUnprotected1536Contract.ts`). After adding Postgres tests, raise
`PG_TEST_FLOOR` in `.github/workflows/ci.yml` to the `ran=` the CI step prints.

To run what CI runs:

```bash
export MEMORY_PG_TEST_URL='postgres://test:test@127.0.0.1:5544/test' GRAPH_PG_TEST_URL="$MEMORY_PG_TEST_URL"
npm run test:pg
```

## Memory access matrix (`memoryAccess/`)

`memoryAccess/world.ts` is a fixed world of people, agents, conversations and
memory items, each carrying a unique canary. `memoryAccess/oracle.ts` says, by
hand and with a source per rule, which viewer may obtain which item in each
context-memory mode. `memoryAccess/seed.ts` writes the world into a real store.
The oracle is written from documented intent; rows nothing documents are tagged
`pinned, not decided`. Never derive a verdict from production code, and never
change a verdict to make a suite green: a disagreement is either a leak to
report or a documented decision to record first.

`memoryAccess/aclContract.ts` is the store-level contract: for every viewer
and mode it calls the memorable-knowledge and excerpt search with the options
that mode passes and requires the result to equal the oracle's set, item for
item. It runs on the in-memory graph (`aclContract*.test.ts`) and on Neon
(`aclContract.pg.test.ts`, `aclContractExcerpts.pg.test.ts`), with team recall
on (today's default) and off.
Queries are batched under the 50-row cap; a full batch is split again, so the
cap never hides a row.

`memoryAccess/canarySweep.ts` runs one real turn per viewer and mode: the agent
is built by `buildOrchestratorForAgent`, and only the model is scripted
(`_helpers/scriptedModel.ts`, with a responder that follows what the tools
list). The probe names every conversation and entity, views every memory path
and every graph query, then follows every file and session it is shown. Any
canary the oracle forbids in what the model was sent fails
`canarySweep.test.ts`; each mode must also deliver allowed canaries through
recall, the memory tool and the graph tool. Confirmed leaks stay as `todo`
tests that name their issue, until the fix PR turns them into ordinary tests.

The sweep runs one file per mode (`canarySweep<Mode>.test.ts`), each also with
the production recall limits (`…ProductionRecall.test.ts`): the top few hits
decide what the `kg_graph` walk around them reaches. On Neon
(`canarySweep<Mode>.pg.test.ts`) it adds process memory and its tools, which
only Neon has; there only one agent's viewers run turns, the other agent's
items stay seeded. A probe plugin built with the real `createPluginContext`
calls `ctx.knowledgeGraph` and `ctx.memory` as a domain tool mid-turn.
`canaryHttp.test.ts` calls the per-person REST routes (`/api/v1/memory`,
`/api/v1/datasets`, `/api/chat/sessions`) and the admin routes that filter per
viewer (`/api/v1/admin/topics`, `/api/v1/admin/duplicates`, with near-duplicate
markers seeded across owners) as each person, including every read-by-id route
with every id of both tenants; `oracle.ts` `expectedHttp` decides. Admin routes
without a viewer (purge preview, promote, operator memory contexts) are
operator-only by design. Known leaks are listed once, in `canarySweepSuite.ts` `KNOWN_LEAKS`,
with the modes where they were confirmed; the same sighting anywhere else
fails.

Completeness guards (step 4) catch what the sweeps cannot see coming:

- `surfaceInventory.test.ts` reads every mounted route, native tool and
  `PluginContext` method from the source and fails on one missing from the
  hand-written `surfaceClassification.ts` (`no-memory`, `viewer-scoped`,
  `operator-only`, `dev-only`, each with a reason; a viewer-scoped entry names
  the test that proves its filter). Classify a new surface from what its code
  does.
- `middleware/eslint/viewerlessGraphReads.mjs` makes knowledge-graph reads that
  take no viewer a lint error outside an allowlist with a reason per file;
  `viewerlessGraphReads.test.ts` checks the rule fires and no entry is stale.
- `memoryDefaults.test.ts` pins the defaults that decide who reads what on an
  unconfigured deployment. Change one only together with the CHANGELOG and the
  oracle.
- `aclAfterMigrations.pg.test.ts` writes the world into a schema migrated to
  an older graph migration (`BASE`), applies the rest as a boot does, and runs
  the ACL contract against `migrated()`, the world as the migrations are
  documented to leave it. A new migration that rewrites visibility or owners
  goes into `migrated()` by hand, from its documented intent.

Lifecycle invariants (step 5) run the real jobs that change memory after it is
written. `lifecycle.ts` seeds the world on Neon and wraps each job: the
memorable-knowledge search is read for every viewer and mode before and after,
and a canary someone gains without an ACL audit row from that job fails
(`guarded`). What a job creates is checked against the oracle for an item of
its shape (`assertOracleBounds`). `lifecycleInvariants.pg.test.ts` covers the
jobs that write memory (identity resolution, promotion, bulk promotion, the
scratch reaper, owner removal), `lifecycleCleanup.pg.test.ts` those that age,
replay, merge and erase it (decay with a 90-day fake clock, backfill,
auto-merge, the user purge of ADR-0186). `lifecycleInvariants.test.ts` runs
random owner/edit/delete sequences with `fast-check` on the in-memory graph
and checks that scope keys never collide. Add a new lifecycle job to one of
the two files, inside `guarded`.

The seed mints each person's omadia user id through identity resolution, as a
login or Teams message would (`Seeded.users`); `USERS` in `world.ts` holds the
Teams (AAD) ids. Memories list their owners in both forms, as production
stores them depending on where they were promoted.

## Env vars

`MEMORY_PG_TEST_URL` is the shared fallback every suite accepts. Individual
suites also accept a domain-specific var (checked first), preserved from before
this change:

| Var | Suites |
| --- | --- |
| `GRAPH_PG_TEST_URL` | graph / store / migration suites |
| `WS5_PG_TEST_URL` | Dev Platform + scratch-promotion suites |
| `KG_PG_TEST_URL` | KG-walk subgraph suite |
| `DATABASE_URL` | last-resort fallback where already wired |
| `MEMORY_PG_TEST_URL` | accepted by all suites |

If none is set, the suite skips and logs which vars it looked for.
