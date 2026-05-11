"""
Presidio sidecar for the Privacy-Proxy Slice 3.4 detector plugin.

Wraps Microsoft's `presidio-analyzer` in a thin FastAPI HTTP service so
the byte5-Harness `harness-plugin-privacy-detector-presidio` can stay a
plain TypeScript plugin.

Endpoints:
  - GET  /health  → JSON probe with loaded language list (boot smoke)
  - POST /analyze → run presidio-analyzer over `text`, return hits

Language strategy: a single Presidio AnalyzerEngine instance manages all
configured languages via spaCy NLP pipelines. Default loadout is
`de_core_news_lg` (German) + `en_core_web_lg` (English) — covers the
typical byte5-DE tenant plus en-language tool docs that may slip in.
Operators can change languages via the `PRESIDIO_LANGUAGES` env var.

Performance notes:
  - First request after startup pays the spaCy model-load cost (~1-2s
    per language). Subsequent calls finish in <50ms for typical tenant
    text lengths (1-32kb).
  - The analyzer is stateless — a single instance handles concurrent
    requests safely. uvicorn workers should be set to 1 CPU-bound
    worker for predictable latency; horizontal scale via container
    replicas, not workers.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

LOG = logging.getLogger("presidio-sidecar")
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(name)s %(levelname)s %(message)s")


def _languages() -> list[str]:
    raw = os.environ.get("PRESIDIO_LANGUAGES", "de,en")
    return [s.strip() for s in raw.split(",") if s.strip()]


SPACY_MODELS_BY_LANG: dict[str, str] = {
    "de": "de_core_news_lg",
    "en": "en_core_web_lg",
    "fr": "fr_core_news_lg",
    "es": "es_core_news_lg",
    "it": "it_core_news_lg",
}


def _build_analyzer(languages: list[str]) -> AnalyzerEngine:
    """Build a Presidio AnalyzerEngine with the requested spaCy models."""
    nlp_config: dict[str, Any] = {
        "nlp_engine_name": "spacy",
        "models": [
            {"lang_code": lang, "model_name": SPACY_MODELS_BY_LANG.get(lang, f"{lang}_core_news_lg")}
            for lang in languages
        ],
    }
    provider = NlpEngineProvider(nlp_configuration=nlp_config)
    nlp_engine = provider.create_engine()
    engine = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=languages)
    LOG.info("AnalyzerEngine ready (languages=%s)", languages)
    return engine


# Engine is built once at startup, reused across requests. We use an
# asynccontextmanager so a future shutdown hook can dispose cleanly.
ANALYZER: AnalyzerEngine | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global ANALYZER
    languages = _languages()
    LOG.info("starting presidio sidecar (languages=%s)", languages)
    ANALYZER = _build_analyzer(languages)
    yield
    ANALYZER = None
    LOG.info("presidio sidecar stopped")


app = FastAPI(
    title="byte5-Harness Privacy-Proxy: Presidio Sidecar",
    version="0.1.0",
    lifespan=lifespan,
)


class AnalyzeRequest(BaseModel):
    text: str = Field(..., description="Text to scan for PII.")
    language: str = Field("de", description="ISO 639-1 language code; must be one of the loaded languages.")
    score_threshold: float = Field(0.4, ge=0.0, le=1.0, description="Drop hits below this confidence.")
    entities: list[str] | None = Field(
        None,
        description=(
            "Optional explicit entity-type whitelist. Omit to use Presidio's "
            "full set of supported recognizers for the language."
        ),
    )


class AnalyzeHit(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


class AnalyzeResponse(BaseModel):
    hits: list[AnalyzeHit]


@app.get("/health")
async def health() -> dict[str, Any]:
    """Boot-smoke probe. Returns 200 + the loaded language list."""
    if ANALYZER is None:
        raise HTTPException(status_code=503, detail="analyzer not ready")
    return {
        "ok": True,
        "languages": list(ANALYZER.supported_languages),
        "version": "0.1.0",
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    """Run Presidio over `text` and return hits."""
    if ANALYZER is None:
        raise HTTPException(status_code=503, detail="analyzer not ready")
    if request.language not in ANALYZER.supported_languages:
        raise HTTPException(
            status_code=400,
            detail=(
                f"language '{request.language}' not loaded — available: "
                f"{list(ANALYZER.supported_languages)}"
            ),
        )

    results = ANALYZER.analyze(
        text=request.text,
        language=request.language,
        score_threshold=request.score_threshold,
        entities=request.entities,
    )

    hits = [
        AnalyzeHit(
            entity_type=r.entity_type,
            start=r.start,
            end=r.end,
            score=float(r.score),
        )
        for r in results
    ]
    return AnalyzeResponse(hits=hits)
