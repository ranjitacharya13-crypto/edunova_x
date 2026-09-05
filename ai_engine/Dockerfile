# EduNova AI engine (FastAPI) — self-hosted model runtime (llama.cpp GGUF)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # PyPI ships llama-cpp-python as source only; the official prebuilt CPU
    # wheels live on this extra index, so builds avoid compiling C++.
    PIP_EXTRA_INDEX_URL=https://abetlen.github.io/llama-cpp-python/whl/cpu

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The GGUF model weights are downloaded at runtime into ./models_cache
# (never baked into the image; overridable via LOCAL_MODEL_* env vars).
EXPOSE 8001
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8001}"]
