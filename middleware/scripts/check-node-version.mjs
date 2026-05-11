#!/usr/bin/env node
// Hard-fail when the wrong Node major is active. Prevents `npm test` (or any
// pre-hooked script) from running under v24, which silently triggers a
// node-gyp rebuild of better-sqlite3 against ABI 137 the first time the test
// process imports it via `bindings.js`. That clobbers the v22 binary the
// middleware boot relies on (see HANDOFF-2026-05-08-dev-stack-monitoring.md).

const required = '127'; // Node 22 (LTS, .nvmrc)
const actual = process.versions.modules;

if (actual !== required) {
  console.error(
    `❌ Node 22.x required (modules=${required}). Got node=${process.version} modules=${actual}.\n` +
      `   Run \`nvm use\` (or restart your shell after \`nvm alias default 22.12.0\`) and try again.`,
  );
  process.exit(1);
}
