# SkillSpector code-scan sidecar (issue #453).
#
# Wraps NVIDIA SkillSpector (Apache-2.0, github.com/NVIDIA/skillspector) in a
# minimal HTTP shim so the Node middleware never needs a Python runtime:
# `POST /scan` with the package file tree → `skillspector scan <tmpdir>
# --no-llm --format json` → normalized findings JSON.
#
# Deterministic mode only (`--no-llm`): no API keys, no outbound calls.
# Deployment config (fly.skillspector.toml etc.) stays deployment-local.
FROM python:3.12-slim-bookworm

# libyara for SkillSpector's YARA detectors (YR1–YR4); build tools for the
# yara-python wheel when no prebuilt wheel matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libssl-dev libyara-dev git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

# Run as non-root: the shim only needs /tmp and the port.
RUN useradd --create-home scanner
USER scanner

EXPOSE 8811
CMD ["python", "server.py"]
