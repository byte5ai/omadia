#!/usr/bin/env node
// Hard-fail when the wrong Node major is active, enforcing the `engines` range
// (>=22.13.0 <23) and .nvmrc at the earliest possible moment.
//
// Originally this guarded the better-sqlite3 ABI saga: running under v24
// silently triggered a node-gyp rebuild against ABI 137 and clobbered the v22
// binary the middleware boot relied on (HANDOFF-2026-05-08-dev-stack-monitoring.md).
// better-sqlite3 v13 moved to N-API and ships ABI-stable prebuilds, so that
// particular failure can no longer happen — but the Node pin still stands on
// its own: `engines` declares a single supported major, and the rest of the
// stack (tsx, the compiled dist/, CI, the docker base image) is built for it.

const required = '127'; // Node 22 (LTS, .nvmrc)
const actual = process.versions.modules;

if (actual !== required) {
  console.error(
    `❌ Node 22.x required (modules=${required}). Got node=${process.version} modules=${actual}.\n` +
      `   Run \`nvm use\` (or restart your shell after \`nvm alias default 22.22.3\`) and try again.`,
  );
  process.exit(1);
}
