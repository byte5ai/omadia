# GLiNER multilingual PII-detector sidecar (issue #361).
#
# Wraps urchade/GLiNER (Apache-2.0) with the `gliner_multi_pii-v1` fine-tune
# in a minimal stdlib-only HTTP shim so the Node middleware never needs a
# Python runtime: `POST /detect {text}` -> scored {start, end, text, label,
# score} spans with Unicode code-point offsets.
#
# The model is baked into the image at BUILD time, pinned to an exact HF
# revision — the running container performs no network egress (HF_HUB_OFFLINE
# turns accidental download attempts into hard failures). On-prem friendly,
# fail-fast. Deployment config stays deployment-local (skillspector precedent).
FROM python:3.12-slim-bookworm

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Default: the ONNX export of urchade/gliner_multi_pii-v1 (quantized variant,
# CPU-friendly). Torch fallback: build with
#   --build-arg MODEL_ID=urchade/gliner_multi_pii-v1 \
#   --build-arg MODEL_REVISION=1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d \
#   --build-arg DETECTOR_BACKEND=torch
# (allow_patterns below covers both layouts; see README "Model pin & bump").
ARG MODEL_ID=onnx-community/gliner_multi_pii-v1
ARG MODEL_REVISION=2e0397a7e8a250d76c37122232b3cbde42c8d629
ARG DETECTOR_BACKEND=onnx
RUN python -c "\
import os; \
from huggingface_hub import snapshot_download; \
snapshot_download(\
    repo_id=os.environ['MODEL_ID'], \
    revision=os.environ['MODEL_REVISION'], \
    local_dir='/app/model', \
    allow_patterns=[\
        'gliner_config.json', 'config.json', \
        'tokenizer.json', 'tokenizer_config.json', \
        'special_tokens_map.json', 'added_tokens.json', 'spm.model', \
        'onnx/model_quantized.onnx', \
        'pytorch_model.bin', \
    ])"

ENV MODEL_ID=${MODEL_ID} \
    MODEL_REVISION=${MODEL_REVISION} \
    DETECTOR_BACKEND=${DETECTOR_BACKEND} \
    MODEL_DIR=/app/model \
    HF_HUB_OFFLINE=1

COPY server.py .

# Run as non-root: the shim only needs the model dir (read-only) and the port.
RUN useradd --create-home detector
USER detector

EXPOSE 8812
CMD ["python", "server.py"]
