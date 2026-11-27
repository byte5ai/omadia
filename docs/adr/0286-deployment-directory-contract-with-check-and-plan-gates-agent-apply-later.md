# 0286 — A versioned deployment directory with check and plan gates; agent-run apply comes later and only as a granted capability

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for #582 (wave 6, W36). Accepted by the owner on 2026-11-27; implementation is not planned yet.

## Context and Problem Statement

An omadia deployment today is a compose file plus overlays
([ADR-0150](0150-compose-minimal-core-with-opt-in-overlays-and-prebuilt-images.md)), the
setup wizard, `fly/deploy.sh`, `render.yaml`, and for our own instance
`scripts/fly-deploy.sh`. None of these is a committed, diffable description of *one*
deployment: which services, which public URL, which secrets, which pinned images.

#582 proposes the pattern of `yc-software/qm`: a deployment directory with a versioned
contract file, one CLI that interprets it, gates `check → doctor → plan → apply → drift
check`, pinned images, and a materialised deploy skill so an agent performs and verifies
the deployment.

The question has two parts. Should omadia have such a contract? And may an agent run the
deployment?

## Decision Drivers

- Operators need a reproducible, reviewable deployment without Kubernetes.
- Secrets are never printed or committed; the contract names them, the vault or the
  platform holds them ([ADR-0054](0054-setup-fields-typed-secrets-in-per-plugin-vault-validated-server-side.md)).
- An agent acts only within its envelope and its grants
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)); admin work an operator
  starts is an operator job ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).
  Infrastructure changes are the highest-impact action omadia could take.
- Writes need two-phase confirmation ([ADR-0005](0005-two-phase-confirmation-for-writes.md)).
- The existing targets (compose, Fly, Render, Azure VM) must keep working.

## Considered Options

- **A — Contract and read-only gates first.** A deployment directory with
  `omadia.deploy.jsonc` (`contract: 1`): public URL, enabled overlays, image pins, secret
  catalogue (names and source, never values), target (`compose`, `fly`, `azure-vm`). A CLI
  `omadia deploy check | plan` validates the contract and prints the diff against the live
  target. `apply` calls the existing target scripts. Agent-run deployment is a later step.
- **B — Full adoption.** Contract, CLI with `apply` and rollback, and a materialised deploy
  skill an agent runs, all in v1.
- **C — No contract.** Keep compose, wizard and per-target scripts as they are.

## Decision Outcome

Chosen option: **A** (owner decision 2026-11-27).

- **The contract is data.** One versioned file per deployment; the CLI is its only
  interpreter; an unknown `contract` version is refused. The secret catalogue lists names,
  the service that needs each secret and where it lives; values are never read into the
  contract or printed.
- **Gates.** `check` (static, one verdict per clause, JSON output) and `plan` (read-only
  diff against the live target) come first. `apply` wraps the existing target scripts
  (`fly/deploy.sh`, compose) and runs only after `plan` on the same contract hash.
- **Pins.** Images are pinned by digest; `plan` refuses a floating tag outside development.
- **Agents later, and only granted.** A deploy capability for agents is a separate step:
  a capability plugin granted to one agent explicitly, `apply` as a two-phase write the
  operator confirms, every run audited. It never runs as a privileged background process.
  `check` and `plan` may be granted read-only first.
- **Where it lives.** The CLI ships with the middleware image as an operator command; the
  contract schema is a package in this repository. Target adapters stay thin wrappers of
  today's scripts.

### Consequences

- 🟢 **Good:** A reviewable, diffable deployment; drift becomes visible before an update.
- 🟢 **Good:** The agent story ("omadia deployed by omadia agents") stays possible without
  giving any agent standing infrastructure rights.
- 🔴 **Bad:** A new CLI and schema to maintain next to compose and the setup wizard.
- 🔴 **Bad:** Per-target `plan` needs read access to the target (Fly API, Docker), which the
  CLI must obtain from the operator's environment.
- ⚪ **Neutral:** Follow-ups: spec under `specs/582-deployment-directory/`, then issues for
  schema, `check`, `plan` per target, and the agent capability.

## Pros and Cons of the Options

### A — Contract and read-only gates first

- 🟢 Delivers the reviewable artefact early; low risk.
- 🔴 The headline feature (agent-run deploy) is deferred.

### B — Full adoption

- 🟢 Complete story in one go.
- 🔴 Agent-run `apply` with rollback is the riskiest part and has the least operator
  experience behind it; it conflicts with ADR-0016 unless the grant model is designed first.

### C — No contract

- 🟢 No new surface.
- 🔴 Deployments stay undocumented state; the Fly incidents with missing build args and
  config drift (see `docs/fly-deploy.md`) keep recurring at customers.

## More Information

- Issue: [#582](https://github.com/byte5ai/omadia/issues/582); analysis in
  `docs/competitive/qm-2026-08.md`.
- Related: ADR-0150 (compose core and overlays), ADR-0016, ADR-0017, ADR-0005, ADR-0054.
