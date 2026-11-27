# 0299 — An internal Kroki renderer is a reader inside the instance

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Owner decision 2026-11-27 (Marcel, via the wave 5+6 master); implemented by wave 6
  cluster W32 (#2338).
- **Supersedes:** — (refines [ADR-0298](0298-file-tools-that-answer-into-the-turn-declare-no-effect.md)
  for Diagrams)

## Context and Problem Statement

`render_diagram` sends the whole diagram source, chart data included, to the Kroki endpoint in
the Diagrams setting `kroki_base_url`. ADR-0298 left Diagrams undeclared, so the discretion
integration egress checks it like a write, and a turn that holds a label from another
conversation never renders a diagram. Most instances run their own Kroki (the compose overlay's
`kroki` service; on Fly the app `odoo-bot-kroki`, reachable only over Fly's private network),
while others point at the public `kroki.io`. The effect of the tool therefore depends on the
instance's configuration, and the manifest's `capabilities[].side_effects` is static. How does
the tool say which case applies?

## Decision Drivers

- Owner decision: a self-hosted Kroki is an internal reader and may see everything the turn may
  show; `kroki.io` and other external endpoints stay refused for turns with foreign labels.
- The decision must be per instance, at activation, without an operator readership row for a
  system that is part of the instance.
- Undeclared stays write-like for every other tool.

## Considered Options

- **A — Effect declared at registration.** `ToolRegistrationOptions.sideEffects` (plugin-api
  1.111.0) carries `read | write | none` from the plugin at activation; Diagrams sets `none` only
  for an internal endpoint.
- **B — Operator readership row for `@omadia/diagrams`.** Works with the existing egress, but every
  instance must declare readers by hand, and the check would not follow a changed endpoint.
- **C — A kernel special case for Diagrams.** The kernel would parse a plugin's config; no other
  plugin could use it.

## Decision Outcome

Chosen option: **A**.

- **Contract.** `ToolRegistrationOptions.sideEffects?: 'read' | 'write' | 'none'`, forwarded by
  `ctx.tools.register` and `registerHandler` onto the native tool entry.
  `Orchestrator.toolSystemOf` takes `write` for a declared `writeCapabilities`, else the
  registered effect, else `unknown`, which the manifest refines as before.
- **Internal endpoint** (`isInternalKrokiEndpoint`, `harness-diagrams/src/krokiEndpoint.ts`):
  - by its address: loopback, private IPv4 ranges, IPv6 unique-local (Fly's `fdaa::/16`), host
    names that resolve only privately (`.internal`, `.flycast`, `.local`, `.svc`), a single-label
    name such as the compose service `kroki`;
  - otherwise only when the operator turns on the new setup field `kroki_internal` (a self-hosted
    Kroki under a public DNS name);
  - `kroki.io` and its subdomains are never internal, whatever the flag says.
- **Diagrams** registers `render_diagram` with `sideEffects: 'none'` when the endpoint is internal,
  and without a declaration otherwise. The boot line says `internal` or `external`.

### Consequences

- 🟢 **Good:** With its own Kroki, an instance renders diagrams in every turn whose answer may
  reach the person; the answer's people egress gates the image (ADR-0298).
- 🟢 **Good:** An external renderer keeps the write-like check, so chart data with a foreign label
  never goes to a third party.
- 🔴 **Bad:** The flag is the operator's word. A wrong `kroki_internal` sends data to a renderer
  that is not part of the instance.
- 🔴 **Bad:** A plugin can now declare its effect at runtime, which a review of the manifest alone
  does not show. A plugin is trusted code either way (it can send data anywhere from its handler).
- ⚪ **Neutral:** ADR-0298's residual (tool outputs of a withheld streamed answer stay in the
  client's trace, #2342) applies to diagrams as well.

## Pros and Cons of the Options

### A — Registration-time effect

- 🟢 Follows the configuration; reusable by any plugin with a configurable target.
- 🔴 One more place where an effect is declared.

### B — Readership row

- 🟢 No contract change.
- 🔴 Manual per instance; does not follow a changed endpoint.

### C — Kernel special case

- 🟢 No contract change.
- 🔴 The kernel would know one plugin's configuration.

## More Information

- Issue #2338; [ADR-0298](0298-file-tools-that-answer-into-the-turn-declare-no-effect.md),
  [ADR-0019](0019-discretion-as-information-flow-control.md).
- Code: `middleware/packages/plugin-api/src/pluginContext.ts` (`ToolRegistrationOptions`),
  `middleware/src/platform/pluginContext.ts`,
  `middleware/packages/harness-orchestrator/src/{nativeToolRegistry,orchestrator}.ts`,
  `middleware/packages/harness-diagrams/src/{krokiEndpoint,plugin}.ts`,
  `middleware/packages/harness-diagrams/manifest.yaml`.
- Test: `middleware/test/discretion/registeredToolEffect2338.test.ts`.
