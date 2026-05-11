# Presidio Sidecar — Privacy-Proxy Slice 3.4

FastAPI wrapper around Microsoft's `presidio-analyzer` plus spaCy
DE+EN models. Provides the deterministic, ms-fast PII-detection layer
that complements the Slice-3.2 Ollama NER detector.

## API

- `GET /health` → `{ ok: true, languages: ["de", "en"], version }`
- `POST /analyze` → `{ hits: [{ entity_type, start, end, score }] }`
  - body: `{ text, language: "de", score_threshold: 0.4, entities?: [...] }`

## Run via OSS docker-compose (recommended for the demo stack)

The Privacy-Proxy is opt-in. The sidecar is not part of the default
`docker compose up` set — build and run it separately when the
`privacy-detector-presidio` plugin is activated:

```bash
docker build -t omadia-presidio middleware/sidecars/privacy-detector-presidio/
docker run -d --name omadia-presidio --network omadia_omadia \
  -p 127.0.0.1:5001:5001 omadia-presidio
```

The first build is ~1.5 GB (spaCy models bundled into the image);
subsequent runs are cache-hot. Joining the `omadia_omadia` network
created by the main `docker compose up` lets the middleware container
reach the sidecar at `http://omadia-presidio:5001` — set that as the
`presidio_endpoint` in the plugin's setup form after activating it
in the admin UI.

For a quick standalone smoke (without the rest of the stack):

```bash
cd middleware/sidecars/privacy-detector-presidio
docker build -t byte5/privacy-detector-presidio:dev .
docker run --rm -p 5001:5001 byte5/privacy-detector-presidio:dev
```

## Deploy to Fly.io (production)

```bash
cd middleware/sidecars/privacy-detector-presidio

# First time only:
fly apps create odoo-bot-presidio --org byte5

# Every deploy:
fly deploy --config fly.presidio.toml --app odoo-bot-presidio
```

The container is Flycast-only (no public IP). The middleware reaches
it at `http://odoo-bot-presidio.flycast:5001` — set this in the
plugin's `presidio_endpoint` setup-field on the production tenant.

The Dockerfile bakes the spaCy DE+EN models into the image, so first
boot is ~5 s of model-load and there is no persistent volume to
provision.

Smoke probe:

```bash
curl -s http://localhost:5001/health | jq
curl -s -X POST http://localhost:5001/analyze \
  -H 'content-type: application/json' \
  -d '{"text":"John Doe wohnt in Berlin und seine IBAN ist DE89370400440532013000.","language":"de"}' | jq
```

## Run via Python venv (local dev)

If you'd rather avoid Docker:

```bash
cd middleware/sidecars/privacy-detector-presidio
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m spacy download de_core_news_lg
python -m spacy download en_core_web_lg
uvicorn app:app --host 0.0.0.0 --port 5001 --workers 1
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PRESIDIO_LANGUAGES` | `de,en` | Comma-separated ISO codes. Models named `<code>_core_news_lg` (or `en_core_web_lg`) must be installed. |

## Plugin wiring

The TypeScript plugin `harness-plugin-privacy-detector-presidio` reads
the endpoint URL from its `presidio_endpoint` setup-field (default
`http://localhost:5001`). It registers itself with the
`privacyDetectorRegistry` published by `harness-plugin-privacy-guard`,
so detector hits flow through the same span-overlap-dedup pipeline as
regex and Ollama NER.
