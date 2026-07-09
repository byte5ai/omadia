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


def extract_findings(payload) -> list:
    """Normalize SkillSpector's JSON output into flat finding dicts."""
    if isinstance(payload, list):
        raw = payload
    elif isinstance(payload, dict):
        raw = None
        for key in ("findings", "results", "detections"):
            if isinstance(payload.get(key), list):
                raw = payload[key]
                break
        if raw is None:
            raw = []
    else:
        raw = []
    findings = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        findings.append({
            "code": str(item.get("code") or item.get("id") or item.get("detector") or "unknown"),
            "severity": str(item.get("severity") or item.get("level") or "LOW"),
            "message": str(item.get("message") or item.get("description") or item.get("title") or ""),
            "file": item.get("file") or item.get("path") or item.get("location"),
        })
    return findings


def run_scan(files: list) -> dict:
    root = tempfile.mkdtemp(prefix="skillspector-")
    try:
        materialize(files, root)
        proc = subprocess.run(
            ["skillspector", "scan", root, "--no-llm", "--format", "json"],
            capture_output=True, text=True, timeout=SCAN_TIMEOUT_S,
        )
        # SkillSpector uses non-zero exit codes to signal findings; only a
        # non-parseable stdout is treated as a scanner failure.
        try:
            payload = json.loads(proc.stdout)
        except (json.JSONDecodeError, TypeError):
            return {
                "ok": False,
                "error": f"skillspector produced no JSON (exit={proc.returncode}): {proc.stderr[:2000]}",
            }
        return {
            "ok": True,
            "scanner_version": skillspector_version(),
            "findings": extract_findings(payload),
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
