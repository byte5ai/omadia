# Privacy-Proxy Slice 3.4 — Presidio Sidecar
#
# Two-stage Python container:
#   1. install presidio-analyzer + spaCy + DE/EN models
#   2. drop in our FastAPI wrapper, run uvicorn on :5001
#
# The German `de_core_news_lg` model is the one that does the
# spaCy-PERSON heavy lifting on byte5 tenant text. English keeps
# tool-doc + system-prompt fragments covered.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PRESIDIO_LANGUAGES=de,en

# System deps for spaCy (gcc for some wheels) — slim image is tight.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

# spaCy models (~600 MB DE + ~600 MB EN). Download once, bake into image.
RUN python -m spacy download de_core_news_lg \
 && python -m spacy download en_core_web_lg

# Strip the toolchain after install to keep the image smaller.
RUN apt-get purge -y --auto-remove gcc g++ \
 && rm -rf /var/lib/apt/lists/*

COPY app.py ./

EXPOSE 5001

# Single worker — analyzer is CPU-bound and a single instance handles
# concurrency safely. Scale horizontally via container replicas.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001", "--workers", "1"]
