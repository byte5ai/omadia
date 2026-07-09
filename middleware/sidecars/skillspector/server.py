"""HTTP shim around the SkillSpector CLI (issue #453).

Endpoints:
    GET  /health  -> {"ok": true}
    POST /scan    -> body {"files": [{"path": "...", "content_b64": "..."}]}
                     writes the tree to a temp dir, runs
                     `skillspector scan <dir> --no-llm --format json`,
                     responds {"ok": true, "scanner_version": "...",
                               "findings": [{"code","severity","message","file"}]}

Deliberately stdlib-only (the single dependency is SkillSpector itself) and
stateless: every request gets a fresh temp dir that is removed afterwards.
The middleware-side contract lives in
middleware/src/services/pluginScanner.ts (`parseSidecarResponse`).
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8811"))
SCAN_TIMEOUT_S = int(os.environ.get("SCAN_TIMEOUT_S", "120"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(64 * 1024 * 1024)))


def skillspector_version() -> str:
    try:
        out = subprocess.run(
            ["skillspector", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        return (out.stdout or out.stderr).strip()
    except Exception:  # noqa: BLE001 — version string is cosmetic only
        return "unknown"


def materialize(files: list, root: str) -> None:
    """Write the posted file tree below `root`, rejecting path escapes."""
    for entry in files:
        rel = entry.get("path")
        content_b64 = entry.get("content_b64")
        if not isinstance(rel, str) or not isinstance(content_b64, str):
            raise ValueError("file entries need string 'path' and 'content_b64'")
        target = os.path.realpath(os.path.join(root, rel))
        if not target.startswith(os.path.realpath(root) + os.sep):
            raise ValueError(f"path escapes scan root: {rel!r}")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(base64.b64decode(content_b64))


class SchemaMismatch(ValueError):
    """The scanner's output is not the positively-recognized report schema."""


def extract_findings(payload) -> list:
    """Normalize SkillSpector's JSON report into flat finding dicts.

    FAIL-CLOSED (#453 second-review fix): only the positively-verified
    SkillSpector report schema is accepted — observed on the pinned commit
    (v2.3.11): a top-level object with `issues` (list) and `risk_assessment`
    (dict); each issue carries `id`, `severity`, `explanation`, and
    `location.file`. Anything else raises `SchemaMismatch`, so the caller
    answers ok:false and the middleware records `scan_failed` — an
    unrecognized schema must NEVER read as a clean scan.
    """
    if not isinstance(payload, dict):
        raise SchemaMismatch(f"report is not an object (got {type(payload).__name__})")
    issues = payload.get("issues")
    if not isinstance(issues, list):
        raise SchemaMismatch("report has no 'issues' list — unrecognized schema")
    if not isinstance(payload.get("risk_assessment"), dict):
        raise SchemaMismatch("report has no 'risk_assessment' object — unrecognized schema")
    findings = []
    for item in issues:
        if not isinstance(item, dict):
            raise SchemaMismatch("issue entry is not an object — unrecognized schema")
        location = item.get("location")
        file_ = location.get("file") if isinstance(location, dict) else None
        findings.append({
            "code": str(item.get("id") or "unknown"),
            "severity": str(item.get("severity") or "LOW"),
            "message": str(
                item.get("explanation") or item.get("finding") or item.get("category") or ""
            ),
            "file": file_ if isinstance(file_, str) else None,
        })
    return findings


def report_version(payload) -> str:
    """Scanner version, preferring the report's own metadata over the CLI."""
    metadata = payload.get("metadata") if isinstance(payload, dict) else None
    if isinstance(metadata, dict):
        v = metadata.get("skillspector_version")
        if isinstance(v, str) and v:
            return f"SkillSpector v{v}" if not v.startswith("SkillSpector") else v
    return skillspector_version()


def run_scan(files: list) -> dict:
    root = tempfile.mkdtemp(prefix="skillspector-")
    try:
        materialize(files, root)
        proc = subprocess.run(
            ["skillspector", "scan", root, "--no-llm", "--format", "json"],
            capture_output=True, text=True, timeout=SCAN_TIMEOUT_S,
        )
        # Observed on the pinned commit: a completed scan exits 0 whether or
        # not it found issues (findings do NOT change the exit code); usage/
        # input errors exit non-zero with a prose message on stdout/stderr.
        # Positive verification, fail-closed: success requires exit 0 AND
        # parseable JSON AND the recognized report schema. 'Ran clean' is
        # exit 0 + `issues: []`; everything ambiguous is a failure.
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "")[:2000]
            return {
                "ok": False,
                "error": f"skillspector exited {proc.returncode}: {detail}",
            }
        try:
            payload = json.loads(proc.stdout)
        except (json.JSONDecodeError, TypeError):
            return {
                "ok": False,
                "error": f"skillspector produced no JSON (exit={proc.returncode}): {proc.stderr[:2000]}",
            }
        try:
            findings = extract_findings(payload)
        except SchemaMismatch as err:
            return {"ok": False, "error": f"unrecognized scanner output: {err}"}
        return {
            "ok": True,
            "scanner_version": report_version(payload),
            "findings": findings,
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def _respond(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 — http.server API
        if self.path == "/health":
            self._respond(200, {"ok": True})
        else:
            self._respond(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802 — http.server API
        if self.path != "/scan":
            self._respond(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"ok": False, "error": "body missing or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            files = body.get("files")
            if not isinstance(files, list):
                raise ValueError("body needs a 'files' array")
            self._respond(200, run_scan(files))
        except subprocess.TimeoutExpired:
            self._respond(504, {"ok": False, "error": "scan timed out"})
        except Exception as err:  # noqa: BLE001 — shim must answer, not die
            self._respond(400, {"ok": False, "error": str(err)})

    def log_message(self, fmt, *args):  # quiet default access log
        pass


if __name__ == "__main__":
    print(f"[skillspector-sidecar] listening on :{PORT} (scan timeout {SCAN_TIMEOUT_S}s)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
