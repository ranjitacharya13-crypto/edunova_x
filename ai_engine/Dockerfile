# EduNova AI engine (FastAPI) — self-hosted model runtime (llama.cpp GGUF)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # PyPI ships llama-cpp-python as source only; the official prebuilt CPU
    # wheels live on this extra index, so builds avoid compiling C++.
    # (requirements.txt declares the same index, this is belt-and-braces.)
    PIP_EXTRA_INDEX_URL=https://abetlen.github.io/llama-cpp-python/whl/cpu \
    # Weights cache. Mount a volume here to avoid re-downloading the GGUF on
    # every container start.
    LOCAL_MODEL_DIR=/var/lib/edunova/models

WORKDIR /app

# requirements.txt installs the llama_cpp runtime (llama-cpp-python from the
# prebuilt-wheel index above) together with the REST/tooling stack.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    # Build-time proof the llama_cpp runtime really is installed in the image
    # (not just declared): fail the build loudly if the import breaks.
    && python -c "import llama_cpp; print('llama_cpp runtime OK', getattr(llama_cpp, '__version__', ''))"

COPY . .

RUN mkdir -p "$LOCAL_MODEL_DIR"
VOLUME ["/var/lib/edunova/models"]

# The GGUF model weights are downloaded at runtime into LOCAL_MODEL_DIR
# (never baked into the image; overridable via LOCAL_MODEL_* env vars).
EXPOSE 8001

# Liveness only — /health reports `modelReady` separately so an orchestrator
# never kills the container while the weights are still downloading.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
    CMD python -c "import os,urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8001')+'/health', timeout=8)" || exit 1

# Start-time verification of the llama_cpp runtime before serving traffic.
CMD ["sh", "-c", "python -c \"import llama_cpp; print('llama_cpp runtime OK')\" && uvicorn main:app --host 0.0.0.0 --port ${PORT:-8001}"]
