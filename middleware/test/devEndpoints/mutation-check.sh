#!/usr/bin/env bash
# Issue #669 — mutation harness for the /api/dev + KG-admin authentication fix.
#
# A green suite proves nothing on its own: the assertions have to be the reason
# it is green. Each entry below deliberately BREAKS one invariant with a real
# source edit, re-runs the suite, and requires a real assertion failure. A
# mutation that leaves the suite green means the invariant is untested — this
# script FAILS in that direction, which is the point.
#
# Usage: bash test/devEndpoints/mutation-check.sh
# Run from middleware/. Reverts every edit via `git checkout --` afterwards.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

MUTATED_PATHS=(src/auth/publicPaths.ts src/auth/loopbackOnly.ts src/routes/graphRouterMounts.ts)

# ── Guard: never run against a dirty tree ───────────────────────────────────
# This harness EDITS tracked source files in place and restores them with
# `git checkout --`. A concurrent commit can sweep a mid-mutation file into
# history, and a kill mid-run leaves the last mutation applied. Refusing to
# start on a dirty tree makes the first detectable; the leak check at the end
# makes the second loud. NEVER commit while this script is running.
if [ -n "$(git status --porcelain -- "${MUTATED_PATHS[@]}")" ]; then
  echo "✖ REFUSING TO RUN: uncommitted changes in the files this harness mutates."
  echo "  Commit or stash them first — a concurrent commit can capture a mutation."
  git status --porcelain -- "${MUTATED_PATHS[@]}"
  exit 2
fi

PATHS=src/auth/publicPaths.ts
LOOPBACK=src/auth/loopbackOnly.ts
MOUNTS=src/routes/graphRouterMounts.ts

TESTS=('test/devEndpoints/devEndpointsAuth.e2e.test.ts'
       'test/devEndpoints/loopbackOnly.test.ts'
       'test/publicPaths.test.ts')

pass=0; fail=0

revert() { git checkout -- "${MUTATED_PATHS[@]}" 2>/dev/null; }

# run_mutation <label> <file> <old|||new[@@@old|||new…]>
run_mutation() {
  local label="$1" file="$2" mutation="$3"
  revert
  if ! python3 - "$file" "$mutation" <<'PY'
import sys
path, mutation = sys.argv[1], sys.argv[2]
src = open(path).read()
for pair in mutation.split('@@@'):
    old, new = pair.split('|||')
    if old not in src:
        print(f'MUTATION-NOT-APPLICABLE: {old[:70]!r} not found in {path}')
        sys.exit(2)
    src = src.replace(old, new, 1)
open(path, 'w').write(src)
PY
  then
    echo "‼ SKIPPED (mutation no longer applies): $label"
    fail=$((fail+1)); revert; return
  fi

  local out
  out=$(node --import tsx --test --test-timeout=30000 "${TESTS[@]}" 2>&1)
  # A mutation is CAUGHT by a failed assertion OR by a cancelled test — a suite
  # that no longer COMPLETES has detected the regression just as surely.
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

echo "── the allowlist entry (THE #669 fix) ───────────────────────────────────"
# The exact pre-#669 state: /api/dev exempt from the session gate.
run_mutation "the /api/dev publicPaths exemption is restored" "$PATHS" \
  'export function publicPaths(): readonly RegExp[] {
  return STATIC_PUBLIC_PATHS;|||export function publicPaths(): readonly RegExp[] {
  return [...STATIC_PUBLIC_PATHS, /^\/api\/dev(?:\/|$|\?)/];'
# A narrower re-open: only the destructive sweeps. Must still be caught.
run_mutation "only the lifecycle sub-tree is re-exempted" "$PATHS" \
  'export function publicPaths(): readonly RegExp[] {
  return STATIC_PUBLIC_PATHS;|||export function publicPaths(): readonly RegExp[] {
  return [...STATIC_PUBLIC_PATHS, /^\/api\/dev\/graph(?:\/|$|\?)/];'

echo "── the dev/operator separation ──────────────────────────────────────────"
# The regression the issue is really about: the admin page needing the dev flag.
run_mutation "the KG-lifecycle admin router goes back behind a flag" "$MOUNTS" \
  'if (lifecycle) {
    app.use(
      KG_LIFECYCLE_ADMIN_PATH,|||if (false && lifecycle) {
    app.use(
      KG_LIFECYCLE_ADMIN_PATH,'
run_mutation "the priorities admin router goes back behind a flag" "$MOUNTS" \
  'if (priorities) {
    app.use(
      KG_PRIORITIES_ADMIN_PATH,|||if (false && priorities) {
    app.use(
      KG_PRIORITIES_ADMIN_PATH,'
run_mutation "the plugin-domains admin router goes back behind a flag" "$MOUNTS" \
  'app.use(PLUGIN_DOMAINS_ADMIN_PATH, requireAuth, createAdminDomainsRouter({ catalog }));|||if (false) app.use(PLUGIN_DOMAINS_ADMIN_PATH, requireAuth, createAdminDomainsRouter({ catalog }));'
# NOT a mutation, and deliberately so: dropping the per-mount `requireAuth`
# from an admin router changes NOTHING observable, because the blanket
# `app.use('/api', requireAuth, …)` line already guards the same paths through
# the same allowlist. It is defence-in-depth against a future reordering, not
# an independent gate — asserting it here would be asserting a tautology, and
# a mutation that can never be caught belongs in neither column of this
# script's tally. What actually gates these routes is the allowlist, and the
# two mutations at the top of this file are what prove it.
run_mutation "the dev graph mounts regardless of DEV_ENDPOINTS_ENABLED" "$MOUNTS" \
  'if (!deps.enabled) return false;|||'

echo "── the loopback gate ────────────────────────────────────────────────────"
run_mutation "the loopback gate reads the spoofable req.ip instead of the socket" "$LOOPBACK" \
  'const remote = req.socket.remoteAddress;|||const remote = req.ip ?? req.socket.remoteAddress;'
run_mutation "the loopback gate admits every address" "$LOOPBACK" \
  'if (isLoopbackAddress(remote)) {|||if (true) {'
run_mutation "an unknown socket address counts as loopback" "$LOOPBACK" \
  "if (!address) return false;|||if (!address) return true;"
run_mutation "the IPv4-mapped IPv6 form is no longer unwrapped" "$LOOPBACK" \
  "const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;|||const addr = address;"
run_mutation "the gate matches any address STARTING with 127" "$LOOPBACK" \
  'const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);|||const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(addr);'

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "caught: $pass    NOT caught / skipped: $fail"
revert

# ── Guard: prove nothing was left mutated ───────────────────────────────────
# A kill between the edit and the revert leaves a mutated file behind, and a
# leaked mutation here is a disabled security control. Say so loudly rather
# than exiting 0 on a quiet disaster.
leftover=$(git status --porcelain -- "${MUTATED_PATHS[@]}")
if [ -n "$leftover" ]; then
  echo
  echo "✖ LEAKED MUTATION — these files are still modified. DO NOT COMMIT:"
  echo "$leftover"
  echo "  Run: git checkout -- ${MUTATED_PATHS[*]}"
  exit 3
fi
echo "✔ tree clean — no mutation leaked"

[ "$fail" -eq 0 ]
