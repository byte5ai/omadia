<!-- Keep PR descriptions short. Reviewers scan this in seconds. -->

## What
<!-- 1-2 sentences. Reference issue/task ID if any (e.g. OB-30 Block 6). -->

## Why
<!-- One paragraph. Optional if "what" already encodes the why. -->

## Test plan
<!-- Checklist of what you actually ran. Be specific:
     - [ ] `npm run lint && npm run typecheck && npm run test` in middleware
     - [ ] `docker compose -f infra/docker-compose.yml up postgres` + 9 migrations
     - [ ] manual: ___                                                            -->

## ADR check
<!-- Required (AGENTS.md "ADR-Abgleich"). Name the ADRs you checked in docs/adr/ and one of:
     - conforms to ADR NNNN, NNNN
     - adds ADR NNNN (new decision) / supersedes ADR NNNN with MMMM
     - no ADR needed, because ___ (plain fix, one sensible solution)               -->

## Risk / blast radius
<!-- Optional. Mention if this:
     - changes existing schema (migration safety)
     - bumps a public API (consumer impact)
     - touches CI / release tooling
     - introduces a new env-var (docs+compose updated?)                            -->

## Naming-decisions still pending
<!-- Delete if no naming-decision flags. Otherwise list:
     - [ ] uses placeholder scope/name that needs Block-2 finalization             -->
