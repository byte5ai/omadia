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
