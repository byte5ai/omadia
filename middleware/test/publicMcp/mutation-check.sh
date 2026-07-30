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
  if ! python3 - "$file" "$mutation" <<'PY'
import sys, io
path, mutation = sys.argv[1], sys.argv[2]
src = open(path).read()
old, new = mutation.split('|||')
if old not in src:
    print(f'MUTATION-NOT-APPLICABLE: {old[:60]!r} not found in {path}')
    sys.exit(2)
open(path, 'w').write(src.replace(old, new, 1))
PY
  then
    echo "‼ SKIPPED (mutation no longer applies): $label"
    fail=$((fail+1)); revert; return
  fi

  local out
  out=$(node --import tsx --test "${TESTS[@]}" 2>&1)
  if echo "$out" | grep -qE '^# fail [1-9]|ℹ fail [1-9]'; then
    local n
    n=$(echo "$out" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -oE 'fail [0-9]+' | tail -1)
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
  'if (isWrite && !this.deps.writeRateLimiter.tryConsume(principal.keyId, binding.writeRateLimitPerMinute)) {|||if (false) {'
run_mutation "the concurrency ceiling is not enforced" "$SERVER" \
  'if (this.inFlight >= this.maxConcurrentCalls) {|||if (false) {'
run_mutation "the per-tool timeout never fires" "$SERVER" \
  'return this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;|||return 2_147_483_647;'
run_mutation "the body cap ignores the actual body size" "$SERVER" \
  'if (declaredTooLarge || actualTooLarge) {|||if (declaredTooLarge) {'
run_mutation "405 on non-POST is removed" "$SERVER" \
  "if (req.method !== 'POST') {|||if (false) {"

echo "── statelessness ────────────────────────────────────────────────────────"
run_mutation "the transport is reused across requests (the SDK reuse guard)" "$SERVER" \
  'await session?.transport.close().catch(() => {});
      await session?.mcp.close().catch(() => {});|||'

echo "── binding normalization ────────────────────────────────────────────────"
run_mutation "a malformed 'enabled' column defaults to enabled" "$BINDINGS" \
  "if (typeof raw.enabled !== 'boolean') {
    warnMalformed('enabled is not a boolean', keyId);
    return undefined;
  }
  if (!raw.enabled) return undefined;|||if (raw.enabled === false) return undefined;"
run_mutation "a partially-valid tool list narrows to its valid subset" "$BINDINGS" \
  'const invalid = raw.filter((entry) => nonEmptyString(entry) === undefined);|||const invalid: unknown[] = [];'
run_mutation "a null tool list becomes an empty grant instead of a denial" "$BINDINGS" \
  'if (raw === null || raw === undefined) {|||if (false) {'
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
[ "$fail" -eq 0 ]
