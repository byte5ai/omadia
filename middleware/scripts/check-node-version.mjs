#!/usr/bin/env node
// Hard-fail when the wrong Node major is active, enforcing the `engines` range
// (>=22.13.0 <23) and .nvmrc at the earliest possible moment.
//
// Originally this guarded the better-sqlite3 ABI saga: running under v24
// silently triggered a node-gyp rebuild against ABI 137 and clobbered the v22
// binary the middleware boot relied on (HANDOFF-2026-05-08-dev-stack-monitoring.md).
// better-sqlite3 v13 moved to N-API and ships ABI-stable prebuilds, so that
// particular failure can no longer happen — but the Node pin still stands on
// its own: `engines` (an install gate, `engine-strict` in .npmrc) and this
// guard keep the toolchain that installs, builds and tests the kernel on one
// major. tsx, CI, the docker base images and the desktop release build all run
// Node 22.
//
// The compiled kernel itself runs on a second major: the desktop app starts it,
// and the web-ui, under Electron's embedded Node (ELECTRON_RUN_AS_NODE,
// desktop/src/supervisor.ts), Node 24 since Electron 44. That runtime never
// goes through npm or this guard, so `engines` does not list it. The decision
// is recorded in docs/security-architecture.md §4a; the CI leg that would run
// this suite on Electron's Node is still open (docs/middleware-agent-handoff.md
// §13).

const required = '127'; // Node 22 (LTS, .nvmrc)
const actual = process.versions.modules;

if (actual !== required) {
  console.error(
    `❌ Node 22.x required (modules=${required}). Got node=${process.version} modules=${actual}.\n` +
      `   Run \`nvm use\` (or restart your shell after \`nvm alias default 22.22.3\`) and try again.`,
  );
  process.exit(1);
}
