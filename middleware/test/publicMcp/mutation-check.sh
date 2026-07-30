#!/usr/bin/env bash
# W2-3 (issue #542) — mutation harness for the public MCP endpoint.
#
# Counting mock invocations proves nothing about whether a gate works. Each entry
# below deliberately BREAKS one invariant with a real source edit, re-runs the
# suite, and requires a real assertion failure. A mutation that leaves the suite
# green means the invariant is untested — the check FAILS in that direction, which
# is the whole point.
#
# Usage: bash test/publicMcp/mutation-check.sh
# Run from middleware/. Reverts every edit via `git checkout --` afterwards.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

# ── Guard: never run against a dirty tree ───────────────────────────────────
# This harness EDITS tracked source files in place and restores them with
# `git checkout --`. Two failure modes made that dangerous in practice, and both
# actually happened during development:
#
#  1. A `git add -A && git commit` running CONCURRENTLY with this script swept a
#     mid-mutation file into a commit — the per-tool timeout shipped as
#     `return 2_147_483_647` (i.e. disabled) inside a docs commit.
#  2. Killing the script mid-run leaves the last mutation applied, and the next
#     `git checkout --` then restores it from a commit that already contains it.
#
# Refusing to start on a dirty tree makes (1) detectable — you cannot have
# uncommitted work in flight — and `verify_clean` at the end makes (2) loud.
# NEVER commit while this script is running.
if ! git diff --quiet -- "$@" 2>/dev/null; then
  if [ -n "$(git status --porcelain -- packages/harness-api-key-auth/src src/mcp src/auth)" ]; then
    echo "✖ REFUSING TO RUN: uncommitted changes in the files this harness mutates."
    echo "  Commit or stash them first — a concurrent commit can capture a mutation."
    git status --porcelain -- packages/harness-api-key-auth/src src/mcp src/auth
    exit 2
  fi
fi
SCOPES=packages/harness-api-key-auth/src/apiKeyScopes.ts
SERVER=src/mcp/publicMcpServer.ts
BINDINGS=src/mcp/publicMcpKeyBindings.ts
PATHS=src/auth/publicPaths.ts
PRIVACY=src/mcp/publicMcpPrivacy.ts

TESTS=('test/publicMcp/publicMcpScopes.test.ts'
       'test/publicMcp/publicMcpKeyBindings.test.ts'
       'test/publicMcp/publicMcpBodyCap.test.ts'
       'test/publicMcp/publicMcpEndpoint.e2e.test.ts'
       'test/publicMcp/publicMcpPrivacy.e2e.test.ts'
       'test/publicPaths.test.ts')

pass=0; fail=0

revert() { git checkout -- "$SCOPES" "$SERVER" "$BINDINGS" "$PATHS" "$PRIVACY" 2>/dev/null; }

# run_mutation <label> <file> <python-mutation-expression>
run_mutation() {
  local label="$1" file="$2" mutation="$3"
  revert
  # A mutation is one or more `old|||new` pairs joined by `@@@`. Multi-edit
  # support is not a convenience: some invariants cannot be broken with a single
  # substitution. Sharing the stateless transport across requests — the bare
  # "flag flip" a naive port would ship — needs a module-level slot, a memoized
  # assignment, AND the teardown removed. A one-line version of that mutation
  # only deleted the teardown, which leaks memory without causing reuse (a fresh
  # pair is still built per request), so it left the suite green and the harness
  # mis-reported the statelessness invariant as untested.
  if ! python3 - "$file" "$mutation" <<'PY'
import sys
path, mutation = sys.argv[1], sys.argv[2]
src = open(path).read()
for pair in mutation.split('@@@'):
    old, new = pair.split('|||')
    if old not in src:
        print(f'MUTATION-NOT-APPLICABLE: {old[:60]!r} not found in {path}')
        sys.exit(2)
    src = src.replace(old, new, 1)
open(path, 'w').write(src)
PY
  then
    echo "‼ SKIPPED (mutation no longer applies): $label"
    fail=$((fail+1)); revert; return
  fi

  # `--test-timeout` is load-bearing, not hygiene. Several mutations make a test
  # HANG rather than fail — e.g. disabling the per-tool timeout leaves the
  # "hanging tool" test waiting on a promise that never settles. Without a bound
  # the harness deadlocks and reports nothing. With one, the hang becomes a real
  # assertion failure, which is the correct verdict: a mutation that stops the
  # suite from completing has been detected.
  local out
  out=$(node --import tsx --test --test-timeout=20000 "${TESTS[@]}" 2>&1)
  # A mutation is CAUGHT by a failed assertion OR by a CANCELLED test. The
  # second matters: removing the concurrency ceiling makes the "at capacity"
  # test's second call block on a gate that only the first call's completion
  # releases, so the test deadlocks and hits `--test-timeout` instead of
  # asserting. An earlier version of this grep looked only for `fail [1-9]` and
  # reported that as "invariant untested" — it was the harness that was blind,
  # not the suite. A suite that no longer COMPLETES has detected the regression.
  if echo "$out" | grep -qE '^# (fail|cancelled) [1-9]|ℹ (fail|cancelled) [1-9]'; then
    local n
    n=$(echo "$out" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -oE '(fail|cancelled) [1-9][0-9]*' | tr '\n' ' ')
    echo "✔ CAUGHT ($n): $label"
    pass=$((pass+1))
  else
    echo "✖ NOT CAUGHT — invariant is untested: $label"
    fail=$((fail+1))
  fi
  revert
}

echo "── scope model ──────────────────────────────────────────────────────────"
run_mutation "WILDCARD_SCOPE grants a per-tool write" "$SCOPES" \
  'if (isMcpWriteScope(required)) return granted.includes(required);|||'
run_mutation "isValidScope admits any three-segment scope" "$SCOPES" \
  'const MCP_WRITE_SCOPE_PATTERN = /^mcp:write:[a-z][a-z0-9_-]*$/;|||const MCP_WRITE_SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;'
run_mutation "bare mcp:write validates again" "$SCOPES" \
  "const REJECTED_SCOPES: readonly string[] = ['mcp:write'];|||const REJECTED_SCOPES: readonly string[] = [];"
run_mutation "hasWriteScope stops delegating to hasScope" "$SCOPES" \
  'return hasScope(granted, mcpWriteScope(toolName));|||return granted?.includes(WILDCARD_SCOPE) === true || hasScope(granted, mcpWriteScope(toolName));'
run_mutation "malformed persisted scopes no longer deny all" "$SCOPES" \
  'const invalid = raw.filter((entry) => !isValidScope(entry));|||const invalid: unknown[] = [];'

echo "── tool visibility ──────────────────────────────────────────────────────"
run_mutation "tools/list skips the mcp:list scope check" "$SERVER" \
  "if (!hasScope(principal.scopes, MCP_LIST_SCOPE)) {|||if (false) {"
run_mutation "tools/list skips the mcp:invoke gate" "$SERVER" \
  'if (!hasScope(principal.scopes, MCP_INVOKE_SCOPE)) return new Set();|||'
run_mutation "tools/list stops filtering by the per-key allowlist" "$SERVER" \
  '.filter((spec) => callable.has(spec.name))|||'
run_mutation "write tools are callable without their per-tool write scope" "$SERVER" \
  'if (hasWriteScope(principal.scopes, tool)) callable.add(tool);|||callable.add(tool);'
run_mutation "the unavailable-tool message distinguishes unknown from not-allowlisted" "$SERVER" \
  'return `Tool \`${name}\` is not available to this API key.`;|||return `Tool \`${name}\` exists but is not allowlisted for this API key.`;'

echo "── call authorization ───────────────────────────────────────────────────"
run_mutation "tools/call skips the allowlist check" "$SERVER" \
  'if (!callable.has(name)) {|||if (false) {'
run_mutation "a missing binding no longer denies the call" "$SERVER" \
  "this.record(principal, 'unbound', name, false, 'no public MCP binding', startedAt, false);
      throw new McpError(ErrorCode.InvalidParams, unavailableToolMessage(name));|||this.record(principal, 'unbound', name, false, 'no public MCP binding', startedAt, false);"
run_mutation "an inactive bound agent no longer fails closed" "$SERVER" \
  'if (!dispatcher) {|||if (dispatcher === null) {'

echo "── rate limits, timeout, concurrency, body cap ──────────────────────────"
run_mutation "the write rate limit is not enforced" "$SERVER" \
  '!this.deps.writeRateLimiter.tryConsume(principal.keyId, binding.writeRateLimitPerMinute)|||false'
run_mutation "the concurrency ceiling is not enforced" "$SERVER" \
  'if (this.inFlight >= this.maxConcurrentCalls) {|||if (false) {'
run_mutation "the per-tool timeout never fires" "$SERVER" \
  'return this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;|||return 2_147_483_647;'
run_mutation "the body cap ignores the actual body size" "$SERVER" \
  'if (declaredTooLarge || actualTooLarge) {|||if (declaredTooLarge) {'
run_mutation "405 on non-POST is removed" "$SERVER" \
  "if (req.method !== 'POST') {|||if (false) {"

echo "── statelessness ────────────────────────────────────────────────────────"
# THE headline invariant of the issue. Three edits, because the failure being
# guarded against is a SHARED transport, not merely a missing teardown: build the
# pair once into a module-level slot, reuse it, and skip the close. That is
# exactly what "just flip sessionIdGenerator to undefined" produces, and it makes
# only the FIRST request work.
run_mutation "the transport is shared across requests (the naive flag-flip port)" "$SERVER" \
  'export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;|||export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
let __shared: ReturnType<PublicMcpServer["createRequestScopedServer"]> | undefined;@@@      session = this.createRequestScopedServer(principal);|||      __shared ??= this.createRequestScopedServer(principal);
      session = __shared;@@@      await session?.transport.close().catch(() => {});
      await session?.mcp.close().catch(() => {});|||      /* mutation: no teardown */'

echo "── binding normalization ────────────────────────────────────────────────"
run_mutation "a malformed 'enabled' column defaults to enabled" "$BINDINGS" \
  "if (typeof raw.enabled !== 'boolean') {
    warnMalformed('enabled is not a boolean', keyId);
    return undefined;
  }
  if (!raw.enabled) return undefined;|||if (raw.enabled === false) return undefined;"
run_mutation "a partially-valid tool list narrows to its valid subset" "$BINDINGS" \
  'const invalid = raw.filter((entry) => nonEmptyString(entry) === undefined);|||const invalid: unknown[] = [];'
# Must replace the null guard's RESULT, not just skip the branch: `!Array.isArray(null)`
# catches a null anyway, so `if (false)` changed no behaviour and the harness
# read that as "invariant untested". The real question is whether a null column
# can ever become an empty GRANT.
run_mutation "a null tool list becomes an empty grant instead of a denial" "$BINDINGS" \
  'if (raw === null || raw === undefined) {
    // Schema says NOT NULL DEFAULT '"'"'{}'"'"', so NULL here is a foreign writer.
    warnMalformed(`${column} is null`, keyId);
    return undefined;
  }
  if (!Array.isArray(raw)) {|||if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {'
run_mutation "a both-read-and-write tool resolves toward READ" "$BINDINGS" \
  'const readOnly = readTools.filter((t) => !writeSet.has(t));|||const readOnly = readTools;'

echo "── the publicPaths entry ────────────────────────────────────────────────"
run_mutation "the publicPaths entry is removed" "$PATHS" \
  'pathPrefixPattern(PUBLIC_MCP_PATH),
];|||];'
run_mutation "the publicPaths entry widens to a prefix" "$PATHS" \
  'pathPrefixPattern(PUBLIC_MCP_PATH),
];|||new RegExp(`^${PUBLIC_MCP_PATH}`),
];'

echo "── privacy: fail-closed (the #542 decision) ─────────────────────────────"
run_mutation "masking failure fails OPEN (the gate stops recording it)" "$PRIVACY" \
  'failed = true;|||failed = false;'
run_mutation "the endpoint stops detecting a masking failure" "$SERVER" \
  "if (gate?.maskingFailed() === true) {|||if (false) {"
run_mutation "the operator privacy bypass is honoured for public callers" "$PRIVACY" \
  'checkBypass(): undefined {
      return undefined;
    },|||checkBypass(toolName: string) {
      return base.checkBypass(toolName);
    },'
run_mutation "an absent privacy provider no longer refuses the call" "$SERVER" \
  'if (this.privacyMaskingRequired) {|||if (false) {'
run_mutation "the privacy handle is never installed on the dispatcher" "$SERVER" \
  'if (gate && dispatcher.withPrivacy) {|||if (false && dispatcher.withPrivacy) {'
run_mutation "intern-exempt tools become publicly servable" "$PRIVACY" \
  'return !isInternExemptTool(name);|||return true;'
run_mutation "the intern-exemption filter is dropped from the allowlist" "$SERVER" \
  'if (!isPubliclyServableTool(tool)) continue;|||'

echo "── write capability (declaration UNION operator list) ───────────────────"
run_mutation "write capability ignores the tool's own declaration" "$SERVER" \
  'return dispatcher.isWriteCapable(name) || binding.writeTools.includes(name);|||return binding.writeTools.includes(name);'
run_mutation "write capability ignores the operator's write_tools list" "$SERVER" \
  'return dispatcher.isWriteCapable(name) || binding.writeTools.includes(name);|||return dispatcher.isWriteCapable(name);'

echo "── caller context propagation ───────────────────────────────────────────"
run_mutation "the API-key principal is not propagated to dispatch" "$SERVER" \
  'principal: principal.keyId,|||principal: undefined,'

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "caught: $pass    NOT caught / skipped: $fail"
revert

# ── Guard: prove nothing was left mutated ───────────────────────────────────
# `revert` runs after every mutation AND here, but a kill -9 between the edit and
# the revert still leaves a mutated file behind. Anything left dirty at this
# point is a leaked mutation, and a leaked mutation is a disabled security
# control — say so loudly rather than exiting 0 on a quiet disaster.
leftover=$(git status --porcelain -- packages/harness-api-key-auth/src src/mcp src/auth)
if [ -n "$leftover" ]; then
  echo
  echo "✖ LEAKED MUTATION — these files are still modified. DO NOT COMMIT:"
  echo "$leftover"
  echo "  Run: git checkout -- packages/harness-api-key-auth/src src/mcp src/auth"
  exit 3
fi
echo "✔ tree clean — no mutation leaked"

[ "$fail" -eq 0 ]
