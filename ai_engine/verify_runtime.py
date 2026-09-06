"""Build/start preflight for the INFERENCE service: fail the deployment if
native imports are broken. Run at build time AND before uvicorn binds so a
container never serves DEPENDENCY_FAILED at runtime.

    python verify_runtime.py            # llama_cpp (+ torch only when RAG loads it)
    python verify_runtime.py --orchestrator   # orchestrator: must NOT need them

PyTorch is verified ONLY when embeddings will actually be loaded
(``RAG_ENABLED=true``). On the Render Free inference runtime (512 MiB,
RAG_ENABLED=false) the process must never import torch — not even during a
preflight that runs right before uvicorn — so the check is gated here and the
result is reported explicitly instead of silently skipped.
"""
import json
import os
import sys

from inference.resources import ResourceManager

if "--orchestrator" in sys.argv:
    # The orchestrator must import cleanly WITHOUT llama_cpp/torch present.
    import importlib
    for name in ("fastapi", "httpx", "pydantic"):
        importlib.import_module(name)
    print(json.dumps({"runtimeVerification": "PASS", "role": "orchestrator",
                      "resources": ResourceManager().snapshot()}))
    sys.exit(0)

import llama_cpp  # noqa: E402

# Embeddings are opt-in (default off): the free 512 MiB runtime must not load
# a PyTorch embedding model at startup. Same parsing rule as config._boolean,
# kept local so this preflight never depends on process env normalization.
RAG_ENABLED = os.getenv("RAG_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}

torch_version = None
transformers_version = None
gpu_available = None
if RAG_ENABLED:
    import torch  # noqa: E402

    if tuple(int(v) for v in torch.__version__.split("+")[0].split(".")[:2]) < (2, 6):
        raise RuntimeError("PyTorch >=2.6 is required; unsafe pickle loaders are not supported")
    with torch.inference_mode():
        assert torch.tensor([2.0]).square().item() == 4.0
    torch_version = torch.__version__
    gpu_available = torch.cuda.is_available()
    try:
        import transformers

        transformers_version = transformers.__version__
    except ImportError:
        transformers_version = None

print(json.dumps({"runtimeVerification": "PASS", "role": "inference", "llamaCpp": llama_cpp.__version__,
                  "torch": torch_version, "transformers": transformers_version,
                  "embeddings": "verified" if RAG_ENABLED else "SKIPPED (RAG_ENABLED=false — torch must not be loaded)",
                  "gpuAvailable": gpu_available, "resources": ResourceManager().snapshot()}))
