# 0137 — Generated diagrams and office files live in object storage, content-addressed, and are served through HMAC-signed expiring URLs

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); diagrams
  since the initial public release, office files in #161, provenance marking in #656 (epic #642)
- **Supersedes:** —

## Context and Problem Statement

Two built-in tool plugins produce binary artifacts from model-authored descriptions:
`@omadia/diagrams` renders Mermaid, PlantUML, Graphviz and Vega-Lite to PNG through a Kroki
gateway, `@omadia/plugin-office` renders `.xlsx` and `.docx`. The bytes must not enter the
model context, must reach people in Teams or Telegram who have no operator session, and must
not be re-rendered and re-stored on every repeat. This record is retroactive. Where do the
bytes live, how are they addressed, and how does a channel user get them?

## Decision Drivers

- The tool result stays small: a URL and metadata, never the file.
- Teams does not follow redirects on card images.
- Channel users open the link without a session, so the link itself must carry the proof.
- Re-rendering the same input must be free after the first time.
- Rendering runs code paths with a history of unsafe features (includes, remote references).

## Considered Options

- **A — Object storage with content-addressed keys; a middleware proxy route that verifies an
  HMAC signature and an expiry and streams the bytes; rendering in a sidecar.**
- **B — Presigned object-storage URLs** handed to the client.
- **C — Inline bytes** in the tool result or the channel message.

## Decision Outcome

Chosen option: **A**.

- **Storage.** One thin S3 wrapper (`exists`, `put`, stream) for Tigris in production and
  SeaweedFS in Compose (`harness-diagrams/src/tigrisStore.ts`).
- **Content-addressed keys.** Diagrams: `<tenant>/<sha256(kind + "\n" + source)>.png`
  (`cacheKey.ts`). Office: `documents/<tenant>/<sha256 of the bytes>/<filename>`
  (`officeService.ts`). A hit skips rendering or the write.
- **Bytes are deterministic, by rule.** The office pipeline re-emits the zip with every entry
  dated 1980-01-01 and without `dcterms:created`/`modified` (`ooxmlNormalize.ts`); the PNG
  provenance chunk and the OOXML provenance properties are static constants. A timestamp, turn
  id or model id in the file is "a correctness bug, not a tweak" (`provenance.ts`).
  Turn-scoped provenance belongs to the API envelope and the audit trail.
- **Signed proxy URLs.** `/diagrams/dl/<key>?exp=&sig=` and `/documents/dl/<key>?exp=&sig=`;
  the HMAC-SHA256 covers `<key>.<exp>`; expired or tampered is `403`, unknown `404`. Default
  lifetime 3600 s (`signed_url_ttl_sec`). The middleware streams the bytes itself instead of
  redirecting. Rotating the secret invalidates every URL in flight.
- **Session-less only by grant.** The routes register with `auth: 'custom'` and declare
  `permissions.public_paths` (`/diagrams/dl`, `/documents/dl`); they are served without the
  session gate only once the operator grants the prefix, and fail closed to the session gate
  before that. A public-path claim must be at least two segments deep.
- **Rendering in a sidecar.** Kroki and its Mermaid companion run as separate containers
  (`docker-compose.diagrams.yaml`, images pinned to `0.29.1`) with `KROKI_SAFE_MODE: SECURE`;
  the client POSTs the source because Mermaid sources exceed URL limits. Diagram kinds are a
  closed list (`ALLOWED_DIAGRAM_KINDS`); source and PNG sizes are capped. Brand-asset
  substitution accepts only an allowlisted key prefix, so `render_diagram` is no arbitrary
  blob fetcher.
- **The plugin stays inactive without a signing secret** (`DIAGRAM_URL_SECRET`).

### Consequences

- 🟢 **Good:** The model sees a link; repeats cost one `exists` call.
- 🟢 **Good:** Works in Teams cards; access is logged by the middleware.
- 🔴 **Bad:** Access is gated by the signed URL alone: anyone who holds an unexpired link can
  fetch the file. `documentsRouter.ts` records this as deferred hardening that "must be
  tightened before durable documents with real business data are served in production".
- 🔴 **Bad:** The signing code is copied between the two plugins because the route prefix is
  part of the URL builder; a plugin must not import kernel code.
- 🔴 **Bad:** `.xlsx` carries only a coarse core-property marker; exceljs exposes no reliable
  custom-property API.
- ⚪ **Neutral:** Diagrams need the storage overlay and the Kroki overlay to be composed
  together.

## Pros and Cons of the Options

### A — Content-addressed storage behind a signed proxy

- 🟢 Small results, cacheable, channel-compatible.
- 🔴 The middleware carries the download traffic.

### B — Presigned storage URLs

- 🟢 No proxy traffic.
- 🔴 Teams does not follow redirects on card images; the storage endpoint becomes
  user-facing; access leaves the middleware's logs.

### C — Inline bytes

- 🟢 No storage.
- 🔴 Megabytes in the model context and in channel payloads.

## More Information

- Related: ADR-0003 (capabilities), [ADR-0140](0140-office-formulas-compute-only-over-their-own-workbook.md);
  `docs/ai-act-transparency.md` (provenance marking).
- Code: `middleware/packages/harness-diagrams/src/`, `middleware/packages/harness-plugin-office/src/`.
- Tests: `middleware/test/diagramService.test.ts`, `diagramSigning.test.ts`,
  `diagramsRouter.test.ts`, `pngTextChunk.test.ts`, `office.test.ts`.
