#!/usr/bin/env bash
# fly-deploy.sh — THE way to deploy byte5's own Fly instance of omadia
# (apps odoo-bot-middleware + odoo-bot-harness). Not the public installer:
# that is fly/deploy.sh, which provisions a NEW set of apps.
#
# Doc: docs/fly-deploy.md. Run `scripts/fly-deploy.sh --help` for flags.
#
# What it does, in order:
#   1. refuses a dirty checkout and the main checkout (see --help for why)
#   2. takes the shared lock /tmp/omadia-fly-deploy.lock (mkdir, waits)
#   3. git fetch origin, resolves the target (default origin/main)
#   4. reads the live sha from the middleware /health; skips if the target
#      is already shipped (unless --force)
#   5. refuses if middleware/sidecars, fly/ or middleware/.env.example
#      changed between live and target (unless --allow-config-diff)
#   6. builds a fresh detached worktree at the target in a temp dir, copies
#      the gitignored fly.toml files into it, deploys middleware then web-ui
#      with --build-arg OMADIA_VERSION=sha-<8>
#   7. verifies /health version, /.well-known/omadia-ui (wss://) and the
#      Secure flag on the Entra login-start cookie on both apps
#   8. removes the temp worktree and releases the lock (trap, always)

set -euo pipefail

# --- configuration (env-overridable) -----------------------------------------
MW_TOML="${OMADIA_FLY_MIDDLEWARE_TOML:-$HOME/sources/odoo-bot/fly.toml}"
UI_TOML="${OMADIA_FLY_WEBUI_TOML:-$HOME/sources/odoo-bot/web-ui/fly.toml}"
MW_APP="${OMADIA_FLY_MIDDLEWARE_APP:-odoo-bot-middleware}"
UI_APP="${OMADIA_FLY_WEBUI_APP:-odoo-bot-harness}"
MW_URL="${OMADIA_FLY_MIDDLEWARE_URL:-https://${MW_APP}.fly.dev}"
UI_URL="${OMADIA_FLY_WEBUI_URL:-https://${UI_APP}.fly.dev}"
LOCK_DIR="${OMADIA_FLY_LOCK_DIR:-/tmp/omadia-fly-deploy.lock}"
VERIFY_TIMEOUT="${OMADIA_FLY_VERIFY_TIMEOUT:-300}"
REMOTE="${OMADIA_FLY_REMOTE:-origin}"

readonly LOCK_POLL_SECONDS=30
readonly VERIFY_POLL_SECONDS=10
readonly CURL_TIMEOUT_SECONDS=20
TMPDIR="${TMPDIR:-/tmp}"
readonly CONFIG_PATHS="middleware/sidecars fly/ middleware/.env.example"

# --- flags -------------------------------------------------------------------
TARGET_REV=""
NO_CACHE=0
SKIP_MW=0
SKIP_UI=0
ONLY_VERIFY=0
ALLOW_CONFIG_DIFF=0
FORCE=0
DRY_RUN=0
ALLOW_UNMERGED=0

# --- runtime state (for the cleanup trap) ------------------------------------
TOOK_LOCK=0
TMP_DIR=""
DEPLOY_WT=""
REPO_ROOT=""

usage() {
  cat <<'EOF'
Usage: scripts/fly-deploy.sh [options]

Deploy byte5's own Fly instance (odoo-bot-middleware + odoo-bot-harness)
from a fresh detached worktree at the target commit, stamped with
OMADIA_VERSION=sha-<8>, under the shared deploy lock, then verify it live.

Run it from a CLEAN LINKED WORKTREE of the repo (not ~/sources/odoo-bot):
  - the main checkout holds gitignored private packages
    (middleware/packages/harness-channel-teams|telegram) and is shared by
    every session; the script refuses it so nobody gets used to deploying
    from there by hand either
  - a dirty checkout means somebody is mid-change; the script refuses so a
    deploy is never mistaken for "my local edits are live"
The deploy itself always builds from a temp worktree, never from your tree.

Options:
  --sha <rev>           target commit (default: origin/main after git fetch)
  --no-cache            pass --no-cache to both fly deploy calls (use it when
                        unsure; the Depot builder once reused a layer with an
                        empty OMADIA_VERSION)
  --skip-webui          deploy only the middleware (web-ui verify skips the
                        version check)
  --skip-middleware     deploy only the web-ui (middleware verify skips the
                        version check)
  --only-verify         no lock, no git worktree, no deploy: just run the live
                        checks. Without --sha each app only has to report a
                        well-formed sha-<8> stamp; with --sha both must match
  --allow-config-diff   deploy even if middleware/sidecars, fly/ or
                        middleware/.env.example changed since the live sha
                        (only after you checked Fly secrets/sidecars!)
  --force               deploy even if the live app already contains the target
  --allow-unmerged      deploy a --sha that is not on origin/main (default:
                        refused, so only reviewed, merged code ships)
  --dry-run             do everything except fly deploy and verify; print the
                        fly commands instead
  -h, --help            this text

Environment (defaults in brackets):
  OMADIA_FLY_MIDDLEWARE_TOML  [$HOME/sources/odoo-bot/fly.toml]
  OMADIA_FLY_WEBUI_TOML       [$HOME/sources/odoo-bot/web-ui/fly.toml]
  OMADIA_FLY_MIDDLEWARE_APP   [odoo-bot-middleware]
  OMADIA_FLY_WEBUI_APP        [odoo-bot-harness]
  OMADIA_FLY_MIDDLEWARE_URL   [https://<middleware-app>.fly.dev]
  OMADIA_FLY_WEBUI_URL        [https://<webui-app>.fly.dev]
  OMADIA_FLY_LOCK_DIR         [/tmp/omadia-fly-deploy.lock]
  OMADIA_FLY_VERIFY_TIMEOUT   [300] seconds to wait for /health to flip
  OMADIA_FLY_REMOTE           [origin]

Exit codes: 0 ok / skipped (already live), 1 error or verify mismatch,
2 usage, 3 refused (dirty/main checkout, config diff, unknown live version).
EOF
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
refuse() { printf 'REFUSED: %s\n' "$*" >&2; exit 3; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha)
        [ $# -ge 2 ] || { usage >&2; exit 2; }
        TARGET_REV="$2"; shift 2 ;;
      --sha=*) TARGET_REV="${1#--sha=}"; shift ;;
      --no-cache) NO_CACHE=1; shift ;;
      --skip-webui) SKIP_UI=1; shift ;;
      --skip-middleware) SKIP_MW=1; shift ;;
      --only-verify) ONLY_VERIFY=1; shift ;;
      --allow-config-diff) ALLOW_CONFIG_DIFF=1; shift ;;
      --force) FORCE=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --allow-unmerged) ALLOW_UNMERGED=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
  done
  if [ "$SKIP_MW" = 1 ] && [ "$SKIP_UI" = 1 ]; then
    printf '%s\n' '--skip-middleware and --skip-webui together deploy nothing' >&2
    exit 2
  fi
  case "$VERIFY_TIMEOUT" in
    ''|*[!0-9]*) die "OMADIA_FLY_VERIFY_TIMEOUT must be a number of seconds" ;;
  esac
}

# --- cleanup -----------------------------------------------------------------
cleanup() {
  local status=$?
  if [ -n "$DEPLOY_WT" ] && [ -d "$DEPLOY_WT" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$DEPLOY_WT" >/dev/null 2>&1 \
      || warn "could not remove temp worktree $DEPLOY_WT (git worktree prune later)"
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$REPO_ROOT" ]; then
    git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
  fi
  # Only our own lock: if someone removed a "stale" lock and another run took
  # it, its owner file names that run's pid, and we leave it alone.
  if [ "$TOOK_LOCK" = 1 ] && grep -qx "pid=$$" "$LOCK_DIR/owner" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    TOOK_LOCK=0
    printf '==> released lock %s\n' "$LOCK_DIR" >&2
  fi
  exit "$status"
}

# --- preconditions -----------------------------------------------------------
check_checkout() {
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die "not inside a git checkout of the omadia repo (cd into a worktree first)"
  local git_dir common_dir
  git_dir="$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-dir)" && pwd -P)"
  common_dir="$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  if [ "$git_dir" = "$common_dir" ]; then
    refuse "$REPO_ROOT is the main checkout, not a linked worktree.
  The main checkout holds gitignored private packages
  (middleware/packages/harness-channel-teams|telegram) and is shared by all
  sessions. Run this script from a clean linked worktree, e.g.
    git worktree add --detach ../omadia-deploy origin/main"
  fi
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain)"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" | head -20 >&2
    refuse "$REPO_ROOT has uncommitted changes (above).
  A deploy builds from a fresh worktree at the target commit, so local edits
  would NOT ship — refusing so nobody believes they did. Commit, or run from
  a clean worktree."
  fi
}

check_tools() {
  command -v curl >/dev/null || die "curl not found"
  if [ "$ONLY_VERIFY" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    FLY="fly"
    return
  fi
  FLY="$(command -v fly || command -v flyctl || true)"
  [ -n "$FLY" ] || die "flyctl not found (https://fly.io/docs/flyctl/install/)"
}

check_tomls() {
  if [ "$SKIP_MW" = 0 ] && [ ! -f "$MW_TOML" ]; then
    die "middleware fly.toml not found: $MW_TOML (set OMADIA_FLY_MIDDLEWARE_TOML)"
  fi
  if [ "$SKIP_UI" = 0 ] && [ ! -f "$UI_TOML" ]; then
    die "web-ui fly.toml not found: $UI_TOML (set OMADIA_FLY_WEBUI_TOML)"
  fi
}

# --- lock --------------------------------------------------------------------
acquire_lock() {
  local waited=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ "$waited" = 0 ] || [ $((waited % 300)) = 0 ]; then
      log "lock $LOCK_DIR is held, waiting (poll ${LOCK_POLL_SECONDS}s). Owner:"
      if [ -f "$LOCK_DIR/owner" ]; then
        sed 's/^/      /' "$LOCK_DIR/owner"
      else
        printf '      (no owner file — probably a manual mkdir by another session)\n'
      fi
      printf '      If you are SURE it is stale: rm -rf %s\n' "$LOCK_DIR"
    fi
    sleep "$LOCK_POLL_SECONDS"
    waited=$((waited + LOCK_POLL_SECONDS))
  done
  TOOK_LOCK=1
  {
    printf 'pid=%s\n' "$$"
    printf 'host=%s\n' "$(hostname)"
    printf 'user=%s\n' "${USER:-unknown}"
    printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'cwd=%s\n' "$REPO_ROOT"
    printf 'script=scripts/fly-deploy.sh%s\n' "$([ "$DRY_RUN" = 1 ] && printf ' --dry-run')"
  } > "$LOCK_DIR/owner"
  log "took lock $LOCK_DIR"
}

note_lock_target() {
  printf 'target=%s\n' "$1" >> "$LOCK_DIR/owner"
}

# --- HTTP helpers ------------------------------------------------------------
# Prints the `version` field of <base>/health, or nothing on failure.
live_version() {
  curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$1/health" 2>/dev/null \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1
}

# --- target / live resolution ------------------------------------------------
resolve_target() {
  log "git fetch $REMOTE"
  git -C "$REPO_ROOT" fetch --quiet "$REMOTE"
  local rev="${TARGET_REV:-$REMOTE/main}"
  TARGET_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${rev}^{commit}")" \
    || die "cannot resolve target revision '$rev'"
  TARGET_VERSION="sha-$(printf '%s' "$TARGET_SHA" | cut -c1-8)"
  log "target $rev = $TARGET_SHA ($TARGET_VERSION)"
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$TARGET_SHA" "$REMOTE/main"; then
    [ "$ALLOW_UNMERGED" = 1 ] || refuse "$TARGET_VERSION is not on $REMOTE/main: only merged code ships.
  Rerun with --allow-unmerged if you really mean to deploy an unmerged commit."
    warn "$TARGET_VERSION is not on $REMOTE/main; deploying anyway (--allow-unmerged)"
  fi
}

# Sets LIVE_SHA (full sha) or empty when the live stamp is unusable.
resolve_live() {
  local ref_url="$MW_URL" ref_app="$MW_APP"
  if [ "$SKIP_MW" = 1 ]; then ref_url="$UI_URL"; ref_app="$UI_APP"; fi
  LIVE_VERSION="$(live_version "$ref_url")"
  LIVE_SHA=""
  log "live $ref_app version: ${LIVE_VERSION:-<unreachable>}"
  case "$LIVE_VERSION" in
    sha-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      LIVE_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${LIVE_VERSION#sha-}^{commit}" || true)"
      [ -n "$LIVE_SHA" ] || warn "live sha ${LIVE_VERSION} is not in the local repo after fetch"
      ;;
  esac
}

contains_target() {
  [ -n "$1" ] && git -C "$REPO_ROOT" merge-base --is-ancestor "$TARGET_SHA" "$1"
}

# Live only when EVERY app this run would deploy already contains the target:
# a run whose web-ui deploy failed after the middleware shipped must not be
# skipped next time.
already_live() {
  contains_target "$LIVE_SHA" || return 1
  if [ "$SKIP_MW" = 0 ] && [ "$SKIP_UI" = 0 ]; then
    local ui_version ui_sha=""
    ui_version="$(live_version "$UI_URL")"
    case "$ui_version" in
      sha-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ui_sha="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${ui_version#sha-}^{commit}" || true)" ;;
    esac
    if ! contains_target "$ui_sha"; then
      log "middleware already has $TARGET_VERSION, web-ui ($UI_APP) is at ${ui_version:-<unreachable>} — deploying"
      return 1
    fi
  fi
}

check_config_diff() {
  if [ -z "$LIVE_SHA" ]; then
    if [ "$ALLOW_CONFIG_DIFF" = 1 ]; then
      warn "live version '${LIVE_VERSION:-unreachable}' is unusable; config diff NOT checked (--allow-config-diff)"
      return
    fi
    refuse "live version '${LIVE_VERSION:-unreachable}' is not a resolvable sha-<8>, so the
  config diff (${CONFIG_PATHS}) cannot be computed. Check Fly secrets and
  sidecars by hand, then rerun with --allow-config-diff."
  fi
  local stat
  # shellcheck disable=SC2086  # CONFIG_PATHS is a fixed, space-separated list
  stat="$(git -C "$REPO_ROOT" diff --stat "$LIVE_SHA" "$TARGET_SHA" -- $CONFIG_PATHS)"
  if [ -z "$stat" ]; then
    log "config diff live..target (${CONFIG_PATHS}): none"
    return
  fi
  printf '%s\n' "$stat"
  if [ "$ALLOW_CONFIG_DIFF" = 1 ]; then
    warn "config paths changed since live; deploying anyway (--allow-config-diff)"
    return
  fi
  refuse "config paths changed between live ${LIVE_VERSION} and ${TARGET_VERSION} (stat above).
  New env vars or sidecars may need Fly secrets/apps before this deploy.
  Inspect: git diff ${LIVE_SHA:0:8} ${TARGET_SHA:0:8} -- ${CONFIG_PATHS}
  Then set what is needed and rerun with --allow-config-diff."
}

# --- deploy ------------------------------------------------------------------
prepare_worktree() {
  TMP_DIR="$(mktemp -d "${TMPDIR%/}/omadia-fly-deploy.XXXXXX")"
  DEPLOY_WT="$TMP_DIR/omadia"
  log "creating detached worktree at $TARGET_VERSION in $DEPLOY_WT"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$DEPLOY_WT" "$TARGET_SHA"
  if [ "$SKIP_MW" = 0 ]; then cp "$MW_TOML" "$DEPLOY_WT/fly.toml"; fi
  if [ "$SKIP_UI" = 0 ]; then cp "$UI_TOML" "$DEPLOY_WT/web-ui/fly.toml"; fi
}

# run_fly <dir> <args...> — runs (or, with --dry-run, prints) fly in <dir>.
run_fly() {
  local dir="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] (cd %s && %s' "$dir" "$FLY"
    printf ' %q' "$@"
    printf ')\n'
    return 0
  fi
  (cd "$dir" && "$FLY" "$@")
}

deploy_apps() {
  local -a extra=(--build-arg "OMADIA_VERSION=$TARGET_VERSION")
  if [ "$NO_CACHE" = 1 ]; then extra+=(--no-cache); fi
  if [ "$SKIP_MW" = 0 ]; then
    log "deploying middleware ($MW_APP) at $TARGET_VERSION"
    run_fly "$DEPLOY_WT" deploy --config fly.toml --app "$MW_APP" \
      "${extra[@]}" --build-arg INSTALL_SUBSCRIPTION_CLIS=true
  fi
  if [ "$SKIP_UI" = 0 ]; then
    log "deploying web-ui ($UI_APP) at $TARGET_VERSION"
    run_fly "$DEPLOY_WT/web-ui" deploy --config fly.toml --app "$UI_APP" "${extra[@]}"
  fi
}

# --- verify ------------------------------------------------------------------
VERIFY_FAILURES=0
SUMMARY=""

record() {
  local status="$1" msg="$2"
  SUMMARY="${SUMMARY}  [${status}] ${msg}
"
  if [ "$status" = FAIL ]; then VERIFY_FAILURES=$((VERIFY_FAILURES + 1)); fi
  printf '    [%s] %s\n' "$status" "$msg"
}

# verify_version <label> <base-url> <expected|""> — expected empty means
# "any well-formed sha-<8>"; polls until match or OMADIA_FLY_VERIFY_TIMEOUT.
verify_version() {
  local label="$1" base="$2" expected="$3" got="" deadline
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while :; do
    got="$(live_version "$base")"
    if [ -n "$expected" ]; then
      [ "$got" = "$expected" ] && { record OK "$label /health version $got"; return; }
    else
      case "$got" in
        sha-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
          record OK "$label /health version $got (well-formed)"; return ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      record FAIL "$label /health version '${got:-<unreachable>}', expected '${expected:-sha-<8>}'"
      return
    fi
    printf '    ... %s /health says %s, retrying in %ss\n' "$label" "${got:-<unreachable>}" "$VERIFY_POLL_SECONDS"
    sleep "$VERIFY_POLL_SECONDS"
  done
}

verify_well_known() {
  local label="$1" base="$2" body
  body="$(curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$base/.well-known/omadia-ui" 2>/dev/null || true)"
  case "$body" in
    *'"wsUrl":"wss://'*) record OK "$label /.well-known/omadia-ui wsUrl is wss://" ;;
    *) record FAIL "$label /.well-known/omadia-ui has no wss:// wsUrl: $(printf '%s' "$body" | head -c 200)" ;;
  esac
}

# Every Set-Cookie on the login-start response must carry Secure.
verify_secure_cookie() {
  local label="$1" url="$2" headers cookies insecure
  headers="$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" -D - -o /dev/null "$url" 2>/dev/null || true)"
  cookies="$(printf '%s\n' "$headers" | tr -d '\r' | grep -i '^set-cookie:' || true)"
  if [ -z "$cookies" ]; then
    record FAIL "$label login-start sets no cookie ($(printf '%s\n' "$headers" | head -1 | tr -d '\r'))"
    return
  fi
  insecure="$(printf '%s\n' "$cookies" | grep -iv ';[[:space:]]*secure' || true)"
  if [ -n "$insecure" ]; then
    record FAIL "$label login-start cookie without Secure: $(printf '%s' "$insecure" | cut -c1-80)"
  else
    record OK "$label login-start Set-Cookie carries Secure"
  fi
}

verify_all() {
  local expected_mw="" expected_ui=""
  if [ -n "${TARGET_VERSION:-}" ]; then
    [ "$SKIP_MW" = 1 ] || expected_mw="$TARGET_VERSION"
    [ "$SKIP_UI" = 1 ] || expected_ui="$TARGET_VERSION"
  fi
  log "verifying ${MW_URL} and ${UI_URL} (version timeout ${VERIFY_TIMEOUT}s)"
  verify_version "middleware" "$MW_URL" "$expected_mw"
  verify_version "web-ui" "$UI_URL" "$expected_ui"
  verify_well_known "middleware" "$MW_URL"
  verify_well_known "web-ui" "$UI_URL"
  verify_secure_cookie "middleware" "$MW_URL/api/v1/auth/login/entra/start"
  verify_secure_cookie "web-ui" "$UI_URL/bot-api/v1/auth/login/entra/start"
}

print_summary() {
  printf '\n--- fly-deploy summary ---\n'
  printf '  target:  %s\n' "${TARGET_VERSION:-<live stamps>}"
  printf '  apps:    %s%s\n' \
    "$([ "$SKIP_MW" = 1 ] && printf '' || printf '%s ' "$MW_APP")" \
    "$([ "$SKIP_UI" = 1 ] && printf '' || printf '%s' "$UI_APP")"
  printf '%s' "$SUMMARY"
  if [ "$VERIFY_FAILURES" -gt 0 ]; then
    printf '  RESULT: %s check(s) FAILED\n' "$VERIFY_FAILURES"
  else
    printf '  RESULT: all checks passed\n'
  fi
}

# --- main --------------------------------------------------------------------
main() {
  parse_args "$@"
  check_tools
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ "$ONLY_VERIFY" = 1 ]; then
    if [ -n "$TARGET_REV" ]; then
      REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
        || die "--sha needs a git checkout to resolve the revision"
      TARGET_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${TARGET_REV}^{commit}")" \
        || die "cannot resolve '$TARGET_REV' (git fetch first?)"
      TARGET_VERSION="sha-$(printf '%s' "$TARGET_SHA" | cut -c1-8)"
    fi
    verify_all
    print_summary
    [ "$VERIFY_FAILURES" = 0 ]
    return
  fi

  check_checkout
  check_tomls
  acquire_lock
  resolve_target
  note_lock_target "$TARGET_VERSION"
  resolve_live

  if [ "$FORCE" = 0 ] && already_live; then
    log "$TARGET_VERSION is already contained in live $LIVE_VERSION — nothing to do (--force to redeploy)"
    return 0
  fi
  check_config_diff
  prepare_worktree
  deploy_apps

  if [ "$DRY_RUN" = 1 ]; then
    log "dry-run: skipping verify; it would check /health version = $TARGET_VERSION,"
    log "         /.well-known/omadia-ui wss:// and Secure login cookies on $MW_URL and $UI_URL"
    return 0
  fi
  verify_all
  print_summary
  [ "$VERIFY_FAILURES" = 0 ]
}

main "$@"
