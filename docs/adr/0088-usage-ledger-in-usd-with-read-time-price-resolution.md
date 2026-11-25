# 0088 — The usage ledger is append-only and in USD; prices are a code table, and a missing price is resolved when the ledger is read

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #1098 attribution, OM-103 subscription rows, #1389 price unknown, #1396 time zones, #679 EUR display)
- **Supersedes:** —

## Context and Problem Statement

Operators need to see what model calls cost, per model and per source. Calls are made in
several packages (orchestrator streaming, orchestrator-extras, verifier, plugins through
`ctx.llm`), providers count cached tokens differently, new models appear through live
discovery before anyone has entered a price, and a subscription call has no price per
call at all. What is recorded per call, where do prices come from, and what does the
dashboard show when a price is missing or the reader thinks in euros? This record is
retroactive.

## Decision Drivers

- Telemetry must never break or slow a chat turn.
- A number on the dashboard must be money somebody was billed, or be labelled otherwise.
- An unknown model must not read as "free".
- Runaway protection, not per-call cost metering, is the control
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)); the ledger observes.

## Considered Options

- **A — Fire-and-forget ledger in USD, price table in code, missing prices resolved at read time, EUR as presentation**
- **B — Cost computed and stored once at write time, backfill when prices change**
- **C — No own ledger; read cost from the providers' billing APIs**

## Decision Outcome

Chosen option: **A**.

- **One recorder per process** (`harness-usage-telemetry/src/recorder.ts`) writes rows to
  `token_usage` (knowledge-graph migrations 0028, 0032, 0033). `recordUsage` never throws
  into the caller, buffers in memory and flushes every 5 seconds or at 100 rows, with a
  hard cap of 10,000 buffered rows. Without a Postgres pool (in-memory graph) rows are
  dropped and the dashboard route is not mounted.
- **A row** holds source, model, the four token counts, `cost_usd`, tenant, session,
  `turn_id`, `provider` (the provider the call actually ran on, so a fallback is visible)
  and the call time taken at `recordUsage()`, not at flush. Turn and session come from an
  ambient context the orchestrator registers; explicit ids win; calls outside a turn
  store NULL.
- **Recording happens at the provider boundary** (`withProviderUsageTracking`, the
  orchestrator's own streaming seam). A provider that records itself is skipped
  (`SELF_RECORDING_PROVIDER_IDS`, today `claude-cli`).
- **Prices are a table in `pricing.ts`**, USD per million tokens, matched by exact id and
  then by family keyword ordered most specific first, so dated snapshots and point
  releases resolve. Each entry carries its provider's cache convention
  (`cacheIncludedInInput`, `cachedInputPerMTok`) and an optional `longContext` tier that
  bills the whole call at the higher rate above a prompt threshold. The model registry
  holds no prices.
- **Unknown model: cost 0, logged once, and resolved when read**
  (`priceResolution.ts`, #1389). A metered row with tokens and cost 0 whose model still
  has no price counts as "price unknown" and is kept out of every cost figure. If the
  model has a price by now, the row is priced from its tokens with today's table. No
  schema change and no backfill.
- **Subscription rows bill 0.** The vendor's own figure goes to `reference_cost_usd`,
  which no total sums (OM-103); the dashboard shows the count of subscription calls.
- **The ledger stays in USD.** EUR is a presentation: `exchangeRate.ts` reads the ECB
  daily reference rate, serves it for 6 hours, keeps the last good rate on failure and
  retries after 10 minutes. The response names the rate and its publication date; with
  no rate the page stays in USD.
- **Cache saving** is reported per model for metered calls: reads at the full input rate
  minus the write premium (`computeCacheSavingsUsd`).
- **Time buckets** are cut in an explicit IANA zone (default UTC), never in the database
  session's zone (#1396).
- **Budgets settled with real usage** read the cost meter (`costMeter.ts`), which adds
  each call's cost to the async scopes around it, not the table.

### Consequences

- 🟢 **Good:** A database problem costs dashboard rows, never a turn.
- 🟢 **Good:** A price added later corrects old rows without a migration.
- 🔴 **Bad:** Rows can be lost: on a crash within the 5-second window, beyond the buffer
  cap, and always without Postgres. The ledger is not an accounting record.
- 🔴 **Bad:** The price table is maintained by hand (review dates are in the file header)
  while models arrive automatically. Stored `cost_usd` keeps the price of the day it was
  written; only rows stored at 0 are priced with today's table, so the two kinds of row
  use different price dates.
- 🔴 **Bad:** Cache writes are priced at the 5-minute rate (1.25×) although the agent loop
  writes with a 1-hour TTL ([ADR-0077](0077-prompt-cache-layout-and-per-turn-tool-advertisement.md)). The saving
  is computed from sums at base rates and understates long-context calls.
- 🔴 **Bad:** The EUR figure uses today's rate for every past row. It is labelled with the
  rate date; it is not what a bill in euros would say.
- ⚪ **Neutral:** Transcription minutes are metered separately and only to the log
  ([ADR-0087](0087-transcription-capability-one-provider-consent-and-guardrails.md)).

## Pros and Cons of the Options

### A — Observing ledger, read-time resolution

- 🟢 No coupling of turns to telemetry; self-correcting for new models.
- 🔴 Approximate by design.

### B — Cost fixed at write time with backfills

- 🟢 One price date per row.
- 🔴 Every unknown model needs a data migration; a wrong zero stays until someone runs it.

### C — Provider billing APIs

- 🟢 Exact money.
- 🔴 No attribution to agent, turn or source; not available for every provider or for
  local models.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0086](0086-subscription-logins-as-providers.md), [ADR-0082](0082-model-refs-classes-and-live-model-discovery.md).
- Paths: `middleware/packages/harness-usage-telemetry/src/`, `middleware/src/routes/usage.ts`,
  `middleware/packages/harness-knowledge-graph-neon/src/migrations/{0028_token_usage,0032_token_usage_subscription,0033_token_usage_attribution}.sql`.
- Tests: `middleware/test/usageTelemetryPricing.test.ts`, `usagePriceResolution.test.ts`,
  `usageCacheSavingsAndFx.test.ts`, `usageRouteTimeZone.test.ts`, `usageDashboard*.pg.test.ts`,
  `middleware/test/costLedger/*`, `middleware/test/subscriptionParity/usageSubscription.test.ts`.

## Errata

- 2026-11-25 (#2236): the cache-write 🔴 above is fixed for new rows. The Anthropic adapter reports 1-hour writes (`cacheWrite1hTokens`), the ledger stores them (`token_usage.cache_creation_1h_tokens`, KG migration `0036`) and prices them at 2×; a row without the split keeps 1.25×. Rows written before are not repriced (option A).
