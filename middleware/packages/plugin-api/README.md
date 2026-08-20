# `@omadia/plugin-api`

The shared type contract between the kernel and every plugin. The kernel imports it to build
`PluginContext`; each plugin imports it to describe what it needs. Nothing in here has a runtime
of its own beyond a handful of pure helpers and fixtures.

The package is `private: true` and is not published. Consumers inside this repo resolve it
through the npm workspace; out-of-repo plugins consume it by `file:` link, a vendored `.d.ts`, or
a git tag.

## The API surface is machine-checked

`api-snapshot/plugin-api.d.ts.snap` is a golden snapshot of every declaration this package emits:
comments stripped, blank lines dropped, whitespace collapsed, files concatenated in sorted path
order. `test/apiSnapshot.test.ts` regenerates it from the current `src/` and fails on any
difference.

It exists because a breaking change here is invisible at the moment it is made. Every consumer
lives in this repo today and gets recompiled in the same commit, so `tsc` stays green while a
renamed method or a narrowed parameter quietly changes what a plugin must compile against. Once
plugins ship from their own repositories that silence becomes someone else's install-time
incident. The snapshot turns it into a diff in the PR that causes it.

```bash
npm run api:check  -w packages/plugin-api   # what CI runs
npm run api:update -w packages/plugin-api   # accept the new surface
```

The declarations are compiled into a temporary directory, never into `dist/`, so the check always
measures the current source and never races the compiled output other suites import.

## What to do when the check fails

A red snapshot check is not a request to run `api:update` and move on. It is the one place the
change is visible, so read the diff first and decide what it means.

1. **Unintended?** Fix the source. That is the whole point of the gate.
2. **Intended?** Run `npm run api:update -w packages/plugin-api`, commit the regenerated snapshot
   in the same commit as the source change, and bump `version` in `package.json`:

| Change in the diff | Bump |
| --- | --- |
| Symbol removed or renamed; parameter added; type narrowed; optional field made required | **MAJOR** — every consumer must be checked |
| Symbol added; required field made optional; type widened | **MINOR** — existing consumers keep compiling |
| Nothing (the diff is empty) | none |

SemVer is load-bearing here rather than decorative: after the split it is the only signal an
out-of-repo plugin gets about whether its pinned contract still holds.

## Layout

- `src/` — the contract. `index.ts` re-exports the modules that make up the public surface.
- `scripts/api-snapshot.mjs` — snapshot generator and checker.
- `api-snapshot/` — the committed golden snapshot. Generated; do not hand-edit.
- `test/` — the gate. Run standalone with `npm test -w packages/plugin-api`; CI runs it as part
  of the middleware suite.
