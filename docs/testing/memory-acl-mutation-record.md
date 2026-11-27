# Memory ACL — mutation record (memory-ACL test plan, step 6)

Step 6 of the memory testing plan asks whether the memory-access suites
(`middleware/test/memoryAccess/`, steps 1–5) actually bite: if someone deletes an
access rule, does CI go red? This record answers it for every access predicate we
could name, by removing each one once and running the suites.

Run on 2026-11-27 on branch `test/memory-acl-mutation-proof`, on top of `main` at
`5ddf9cbf` (steps 4 and 5 and their fixes merged), with the in-memory suites and
the Neon suites against a local pgvector Postgres. `main` then moved to
`f4a09e2c` (wave 6 train 3), which changed only `chatSessions.ts` among the
mutated files; RT02 and RT03 were rerun there with the same result.

## Result

75 mutants, one per access predicate. **62** turned a memory-access suite red directly. **6** survived the memory-access suites but are killed by a unit test outside them, which CI also runs. **3** survived and were closed in this step with a new or widened test. **4** still survive (IM14, NE09, GV09, GV10): test gaps, not leaks, tracked in #2340.

## How it was run

- `middleware/scripts/mutation/handCatalog.mjs` lists the mutants: one per access
  predicate, written by hand from reading the code. Each removes the predicate or
  forces it open (`find` → `replace`). Nothing in it is derived from the tests.
- `middleware/scripts/mutation/handMutate.mjs` applies one mutant, rebuilds the
  package it lives in, runs the in-memory `memoryAccess` suites (4 files at a
  time) and, for mutants that also reach Neon, the Neon suites one file at a
  time. It stops at the first red file, restores the source and rebuilds.
- "Killed by" names the first file that went red, not the only one.
- Neon SQL mutants keep the predicate and OR it with `TRUE`
  (`(<predicate> OR TRUE)`), so every query parameter stays referenced. The
  first version replaced predicates with `TRUE`; Postgres then cannot type the
  dropped parameter and rejects the query, and recall silently falls back to
  the FTS search, which still filters. NE16 and NE17 "survived" that way
  without testing anything. The runner now flags a mutant whose run logs a SQL
  error as invalid; none of the mutants below is.
- A mutant that survived the memory-access suites was then run against the
  unit tests that load the mutated module, since CI runs those too.

To repeat it on a throwaway checkout, with a pgvector Postgres in
`MEMORY_PG_TEST_URL` and `GRAPH_PG_TEST_URL`:

```sh
cd middleware
npm run build
node scripts/mutation/handMutate.mjs            # all mutants
node scripts/mutation/handMutate.mjs --only GV06,PB02
```

Results go to `reports/mutation/memory-acl-hand.jsonl`. Use a fresh database: a
stale one fails the audit-row checks for reasons unrelated to the mutant.

## Mutants

| Id | Layer | Mutation | Outcome |
| --- | --- | --- | --- |
| IM01 | in-memory graph | memory search: owner check dropped | Killed by `aclContract.test.ts` |
| IM02 | in-memory graph | excerpt search: owner check dropped | Killed by `aclContractExcerptsOwnerOnly.test.ts` |
| IM03 | in-memory graph | memory search: origin-agent isolation dropped | Killed by `aclContract.test.ts` |
| IM04 | in-memory graph | excerpt search: origin-agent isolation dropped | Killed by `aclContractExcerpts.test.ts` |
| IM05 | in-memory graph | memory search: team branch on without teamVisibility | Killed by `aclContract.test.ts` |
| IM06 | in-memory graph | memory search: team branch admits private rows | Killed by `aclContract.test.ts` |
| IM07 | in-memory graph | excerpt search: team branch on without teamVisibility | Killed by `aclContractExcerptsOwnerOnly.test.ts` |
| IM08 | in-memory graph | memory search: sharedOnly narrowing dropped | Killed by `aclContract.test.ts` |
| IM09 | in-memory graph | memory search: members room rule ignores the audience | Killed by `aclContract.test.ts` |
| IM10 | in-memory graph | members: auto-promoted durable rows count as operator-authored | Killed by `aclContract.test.ts` |
| IM11 | in-memory graph | memory search: members room rule drops origin-agent isolation | Killed by `aclContract.test.ts` |
| IM12 | in-memory graph | memory search: Privacy Shield skip dropped | Killed by `aclContract.test.ts` |
| IM13 | in-memory graph | excerpt search: Privacy Shield skip dropped | Killed by `aclContractExcerptsOwnerOnly.test.ts` |
| IM14 | in-memory graph | shield: DERIVED_FROM unprotected-turn check dropped | Survives since #2278: every memory derived from an unprotected turn is now stamped `unprotected` itself, so the stamp alone hides it. The edge check only decides for a turn marked unprotected after promotion, which no test seeds. #2340. |
| IM15 | in-memory graph | empty audience no longer matches nothing | Killed by `aclContract.test.ts` |
| IM16 | in-memory graph | getMemorableKnowledge(id, viewer): owner check dropped | Killed by `canaryHttp.test.ts` |
| IM17 | in-memory graph | turn search: user filter dropped | Killed by `canarySweepOff.test.ts` |
| IM18 | in-memory graph | turn search: members audience filter dropped | Killed by `canarySweepMembers.test.ts` |
| IM19 | in-memory graph | agent scope prefix matches every scope | Killed by `canarySweepOff.test.ts` |
| IM20 | in-memory graph | turn search: Privacy Shield skip dropped | Survived before this step: the shield's digest hid the canaries from the sweep. Killed by `canarySweepOff.test.ts` now that the sweep reads raw tool results (`tool-raw`). |
| IM21 | in-memory graph | embedding turn search: user filter dropped | Killed by `canarySweepOff.test.ts` |
| IM22 | in-memory graph | getSession: members audience filter dropped | Killed by `canarySweepMembers.test.ts` |
| IM23 | in-memory graph | getSession: user filter dropped | Killed by `canarySweepOff.test.ts` |
| IM24 | in-memory graph | room owners check admits every node | Killed by `canarySweepMembers.test.ts` |
| IM25 | in-memory graph | entity-captured turns: user filter dropped | Killed by `canarySweepOff.test.ts` |
| IM26 | in-memory graph | recent plans: user filter dropped | Not by memoryAccess (recall does not pass `userId` to `listRecentPlans`); killed by `test/recallProbe.test.ts`. |
| IM27 | in-memory graph | getDataset: owner check dropped | Killed by `canaryHttp.test.ts` |
| IM28 | in-memory graph | queryDatasetRows: owner check dropped | Killed by `canaryHttp.test.ts` |
| IM29 | in-memory graph | listDatasets: owner filter dropped | Killed by `canaryHttp.test.ts` |
| IM30 | in-memory graph | duplicate list: viewer must own one side, dropped | Killed by `canaryHttp.test.ts` |
| NE01 | Neon graph | memory search: owner predicate forced true | Killed by `aclContract.pg.test.ts` |
| NE02 | Neon graph | excerpt search: owner predicate forced true | Killed by `aclContractExcerpts.pg.test.ts` |
| NE03 | Neon graph | memory search: team branch on without teamVisibility | Killed by `aclContract.pg.test.ts` |
| NE04 | Neon graph | memory search: team branch admits private rows | Killed by `aclContract.pg.test.ts` |
| NE05 | Neon graph | memory search: origin-agent isolation (owner branch) dropped | Killed by `aclContract.pg.test.ts` |
| NE06 | Neon graph | memory search: members room rule ignores the audience | Killed by `aclContract.pg.test.ts` |
| NE07 | Neon graph | memory search: sharedOnly narrowing dropped | Killed by `aclContract.pg.test.ts` |
| NE08 | Neon graph | memory search: Privacy Shield skip dropped | Killed by `aclContract.pg.test.ts` |
| NE09 | Neon graph | shield: DERIVED_FROM unprotected-turn check dropped | Survives since #2278, as IM14: the stamp hides every seeded memory; no test marks a turn unprotected after promotion. #2340. |
| NE10 | Neon graph | memory search: tenant predicate dropped | Killed by `aclContract.pg.test.ts` |
| NE11 | Neon graph | excerpt search: tenant predicates dropped | Killed by `aclContractExcerpts.pg.test.ts` |
| NE12 | Neon graph | excerpt search: team branch on without teamVisibility | Killed by `aclContractExcerpts.pg.test.ts` |
| NE13 | Neon graph | excerpt search: members room rule ignores the audience | Killed by `aclContractExcerpts.pg.test.ts` |
| NE14 | Neon graph | excerpt search: Privacy Shield skip dropped | Killed by `aclContractExcerpts.pg.test.ts` |
| NE15 | Neon graph | getMemorableKnowledge(id, viewer): owner check dropped | Killed by `canaryHttp.pg.test.ts` |
| NE16 | Neon graph | hybrid turn search: user filter dropped | Killed by `canarySweepOff.pg.test.ts` |
| NE17 | Neon graph | hybrid turn search: members audience dropped | Killed by `canarySweepMembers.pg.test.ts` |
| NE18 | Neon graph | hybrid turn search: agent prefix dropped | Killed by `canarySweepOff.pg.test.ts` |
| NE19 | Neon graph | getDataset: owner check dropped | Survived before this step: the Neon REST sweep asserted only the topic routes. Killed by `canaryHttp.pg.test.ts` now that it asserts every route. |
| GV01 | graph view | user turn: memory owner check dropped | Killed by `canarySweepOff.test.ts` |
| GV02 | graph view | user turn: memory origin-agent check dropped | Killed by `canarySweepOff.test.ts` |
| GV03 | graph view | team-visible memory shown without teamVisibility | Survived before this step: every sweep ran team visibility on, where the oracle allows team memories anyway. Killed by `canarySweepOffOwnerOnly.test.ts`, the new owner-only sweep. |
| GV04 | graph view | conversation turn: every memory visible | Killed by `canarySweepStrictProductionRecall.test.ts` |
| GV05 | graph view | members turn: room owners check dropped | Killed by `canarySweepMembers.test.ts` |
| GV06 | graph view | shielded turn: unprotected turns shown | Killed by `canarySweepOffProductionRecall.test.ts` |
| GV07 | graph view | turn visible without being in a readable session | Killed by `canarySweepOff.test.ts` |
| GV08 | graph view | entity visible without a visible capturing turn | Killed by `canarySweepStrictProductionRecall.test.ts` |
| GV09 | graph view | another person's User node visible | Survives: the world has no User node with a canary. #2340. |
| GV10 | graph view | fact visible when one source turn is hidden | Survives: the world has no Fact item. #2340. |
| MS01 | /memories scope | scoped store: every read allowed | Killed by `canarySweepStrict.test.ts` |
| MS02 | /memories scope | scoped store: ro: veto on writes dropped | Not by memoryAccess (the sweep's memory store is read-only); killed by `test/scopedMemoryStore.contexts.test.ts`. |
| MS03 | /memories scope | enforce-strict reads the transcript trees (core, not core-notes) | Killed by `canarySweepStrictProductionRecall.test.ts` |
| MS04 | /memories scope | enforce: shared trees writable | Not by memoryAccess (no writes in the sweep); killed by `test/memoryContextIsolation.test.ts`. |
| MS05 | /memories scope | namespacer: every path passes through to the shared namespace | Not by memoryAccess; killed by `test/memoryContextIsolation.test.ts`. |
| MS06 | /memories scope | members index: groups not covering the room are readable | Killed by `canarySweepMembers.test.ts` |
| PB01 | plugin boundary | plugin memory store reads private trees | Killed by `canarySweepOff.test.ts` |
| PB02 | plugin boundary | plugin turn search: user filter dropped | Killed by `canarySweepOff.test.ts` |
| PB03 | plugin boundary | plugin turn search: room audience dropped | Killed by `canarySweepMembers.test.ts` |
| PB04 | plugin boundary | plugin turn search: conversation scope not enforced | Not by memoryAccess; killed by `test/graphBoundarySideDoors.test.ts`. |
| RT01 | REST routes | GET /api/v1/memory/:id reads without the viewer | Killed by `canaryHttp.test.ts` |
| RT02 | REST routes | chat session read: owner check dropped | Killed by `canaryHttp.test.ts` |
| RT03 | REST routes | chat session list: viewer filter dropped | Killed by `canaryHttp.test.ts`. It is the positive control that fails: without a viewer the session store lists nothing (fails closed), so the route cannot widen; the control catches users losing their own sessions. |
| RT04 | REST routes | chat turn: session ownership check dropped | Not by memoryAccess; killed by `test/chatSessionsOwner.test.ts`. |
| RC01 | recall | memory recall leg: origin-agent isolation not passed | Killed by `canarySweepOff.test.ts` |
| RC02 | recall | excerpt recall leg: origin-agent isolation not passed | Killed by `canarySweepOff.test.ts` |

## Survivors

- **IM14** — Survives since #2278: every memory derived from an unprotected turn is now stamped `unprotected` itself, so the stamp alone hides it. The edge check only decides for a turn marked unprotected after promotion, which no test seeds. #2340.
- **IM20** — Survived before this step: the shield's digest hid the canaries from the sweep. Killed by `canarySweepOff.test.ts` now that the sweep reads raw tool results (`tool-raw`).
- **IM26** — Not by memoryAccess (recall does not pass `userId` to `listRecentPlans`); killed by `test/recallProbe.test.ts`.
- **NE09** — Survives since #2278, as IM14: the stamp hides every seeded memory; no test marks a turn unprotected after promotion. #2340.
- **NE19** — Survived before this step: the Neon REST sweep asserted only the topic routes. Killed by `canaryHttp.pg.test.ts` now that it asserts every route.
- **GV03** — Survived before this step: every sweep ran team visibility on, where the oracle allows team memories anyway. Killed by `canarySweepOffOwnerOnly.test.ts`, the new owner-only sweep.
- **GV09** — Survives: the world has no User node with a canary. #2340.
- **GV10** — Survives: the world has no Fact item. #2340.
- **MS02** — Not by memoryAccess (the sweep's memory store is read-only); killed by `test/scopedMemoryStore.contexts.test.ts`.
- **MS04** — Not by memoryAccess (no writes in the sweep); killed by `test/memoryContextIsolation.test.ts`.
- **MS05** — Not by memoryAccess; killed by `test/memoryContextIsolation.test.ts`.
- **PB04** — Not by memoryAccess; killed by `test/graphBoundarySideDoors.test.ts`.
- **RT04** — Not by memoryAccess; killed by `test/chatSessionsOwner.test.ts`.

## What the run found

**The Privacy Shield hid broken filters from the sweep.** Mutant IM20 removes the
"skip unprotected turns under a shield" filter from turn search. It survived:
the turns did reach the shielded turn, but the shield's digest masked the canaries
before the sweep looked, so the sweep could not see them. The canary sweep now also
records each tool result as the shield receives it, before interning (entry point
`tool-raw`, `canarySweep.ts`). With it, IM20 is killed by
`canarySweepEnforce.test.ts`.

**Two survivors were test gaps, closed here.** NE19 (Neon `getDataset` without
its owner check) reached other people's datasets by id, but the Neon REST sweep
(`canaryHttp.pg.test.ts`) only asserted the topic routes; it now asserts every
route, which is clean on the real code. GV03 (graph view shows team memories
without team visibility) is harmless under today's default, where the oracle
allows team memories anyway, but leaks under the documented owner-only setting
(`KG_RECALL_TEAM_VISIBILITY=false`), which no sweep ran;
`canarySweepOffOwnerOnly.test.ts` runs it now. Production never passes team
visibility to the graph view, so the view hides team memories that recall
admits: stricter than the oracle, not a leak.

**The #2278 fix moved one check out of the tests' reach.** On the step 5 base,
removing the shield's `DERIVED_FROM` check (IM14, NE09) turned the contract red.
Since #2278, `createMemorableKnowledge` stamps `unprotected` from its source
turns, so the stamp alone hides every seeded memory. The edge check now only
decides for a turn marked unprotected after a memory was promoted from it, which
`ingestTurn` allows and no test seeds (#2340).

**That check found two real leaks**, both kept as known leaks (`todo` tests naming
the issue) until fixed:

- **#2333** — under a shield, a plugin's `knowledgeGraph@1` `listPlansForScope`
  returns the own conversation's plans of unprotected or unknown turns. Every
  other plan read skips them (#1536).
- **#2334** — under a shield, a plugin's `processMemory@1` `get`, `history` and
  `edit` return processes stored unprotected. The bounded `query` and the model's
  own process tools skip them (#1540). Neon only, since only Neon has process
  memory.

## Nightly Stryker run

`.github/workflows/memory-acl-mutation.yml` runs Stryker nightly (and on demand)
over the files that hold only access rules
(`scripts/mutation/stryker.memory-acl.config.mjs`): `graphNodeAccess.ts`,
`scopedMemoryStore.ts`, `membersMemory.ts`, `shieldedNeighbors.ts`,
`boundedGraphServices.ts` and `chatSessionAccess.ts`, against the in-memory
`memoryAccess` suites plus the unit tests that hold rules the sweeps cannot see
(write vetoes, the chat turn's session check, the plugin boundary's
conversation scope); `runUntilRed.mjs` stops at the first red file. A local run limited to `chatSessionAccess.ts` (44 mutants) killed 30 and left
14, none timed out: the legacy-owner cache and its warning, the empty-session
check in `chatViewer` and the no-store early return. They are what the first
nightly reports show as the baseline. It reports
only for now; the first runs set the baseline, which is then raised, never
lowered. The Neon SQL and the in-memory graph's search methods stay in the hand
run above: Stryker only swaps whole SQL string literals, and the graph file is too
large to mutate whole every night.

## Adversarial memory corpus

`middleware/test/adversarial/corpus/memory-exfiltration.jsonl` (probe
`memory_acl`, `test/adversarial/memoryExfiltration.ts`) runs seven scripted
attacker turns over the same world: naming another person's conversations,
memory-path traversal, foreign sessions by scope, forged viewer fields,
cross-tenant ids, unprotected turns under a shield, and widening a members room.
All seven hold, each with a positive control (the attacker still gets what it
may read). Four counter-proofs in `test/adversarialModel.test.ts` break the graph
and expect `breached`.
