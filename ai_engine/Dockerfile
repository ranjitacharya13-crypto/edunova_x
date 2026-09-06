# EduNova AI — Python image for BOTH AI services (select with SERVICE_ROLE).
#
#   SERVICE_ROLE=inference  (default)  -> inference_server:app  (THE model)
#   SERVICE_ROLE=orchestrator          -> main:app              (no model)
#
# The inference role runs llama.cpp with SmolLM2-135M-Instruct Q4_K_M and fits
# Render's FREE 512 MiB plan (RAG disabled => torch is installed for RAG
# instances but NEVER imported at startup). For a free-tier image with zero
# torch footprint, swap the full requirements install for
# requirements-inference-free.txt. verify_runtime.py fails the build if a
# required import is broken (torch is only required when RAG_ENABLED=true).
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_EXTRA_INDEX_URL=https://abetlen.github.io/llama-cpp-python/whl/cpu \
    LOCAL_MODEL_DIR=/var/lib/edunova/models \
    SERVICE_ROLE=inference

WORKDIR /app
COPY requirements.txt requirements-orchestrator.txt ./
RUN pip install --no-cache-dir "torch==2.8.0" --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt \
    && python -c "import llama_cpp, torch; print('runtime OK', llama_cpp.__version__, torch.__version__)"

COPY . .
RUN python verify_runtime.py
RUN mkdir -p "$LOCAL_MODEL_DIR"
VOLUME ["/var/lib/edunova/models"]
EXPOSE 8001 8002

# Liveness only — /health never implies model readiness; use /ready for that.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8002')+'/health', timeout=8)" || exit 1

CMD ["sh", "-c", "if [ \"$SERVICE_ROLE\" = orchestrator ]; then python verify_runtime.py --orchestrator && exec uvicorn main:app --host 0.0.0.0 --workers 1 --port ${PORT:-8001}; else python verify_runtime.py && exec uvicorn inference_server:app --host 0.0.0.0 --workers 1 --port ${PORT:-8002}; fi"]
