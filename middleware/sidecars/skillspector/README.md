# SkillSpector code-scan sidecar (issue #453)

HTTP shim around [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector)
(Apache-2.0) so the Node middleware never needs a Python runtime. The
middleware posts the extracted package's file tree to `POST /scan`; the shim
materializes it into a temp dir, runs
`skillspector scan <dir> --no-llm --format json`, and answers a normalized
`{ok, scanner_version, findings: [{code, severity, message, file}]}`.

Deterministic mode only (`--no-llm`): no API keys, no outbound calls.
Enable in the middleware via `SKILLSPECTOR_URL` (see
`docker-compose.skillspector.yaml`).

## Fail-closed response contract

The shim positively verifies SkillSpector's report schema (observed on the
pinned commit, CLI v2.3.11): exit code `0` **and** parseable JSON **and** a
top-level object with an `issues` list plus a `risk_assessment` object.
"Ran clean" is exit 0 with `issues: []`. Everything else — non-zero exit,
non-JSON stdout, or an unrecognized schema — answers `ok: false`, which the
middleware records as a `scan_failed` verdict. An unrecognized schema must
never read as a clean scan (`no_signals`).

## Dependency pin & bump procedure

`requirements.txt` pins SkillSpector to an **exact commit SHA** — never a
moving branch (supply chain: the sidecar executes third-party scanner code
against every uploaded package tree). To bump the pin:

1. Pick the new upstream commit (`git ls-remote https://github.com/NVIDIA/skillspector.git HEAD`
   or a reviewed release tag) and review the upstream diff since the current pin.
2. Update the SHA in `requirements.txt`, rebuild the image
   (`docker build middleware/sidecars/skillspector`), and re-run the schema
   probe: one benign fixture (expect `ok:true, findings: []`) and one with an
   obvious exfiltration pattern (expect an `E*` / YARA finding). If the report
   schema changed, align `extract_findings` in `server.py` — it fails closed
   on any mismatch, so a silent schema drift surfaces as `scan_failed`, not
   as a false all-clear.
3. Bump `PLUGIN_SCANNER_VERSION` in `middleware/src/services/pluginScanner.ts`
   if the detector set changed in a way that should invalidate cached verdicts.
4. Switch to a versioned `skillspector==X.Y.Z` pin as soon as a PyPI release
   exists.
