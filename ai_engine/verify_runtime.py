"""Build/start preflight for the INFERENCE service: fail the deployment if
native imports are broken. Run at build time AND before uvicorn binds so a
container never serves DEPENDENCY_FAILED at runtime.

    python verify_runtime.py            # llama_cpp + torch + resources
    python verify_runtime.py --orchestrator   # orchestrator: must NOT need them
"""
import json
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
import torch  # noqa: E402

if tuple(int(v) for v in torch.__version__.split("+")[0].split(".")[:2]) < (2, 6):
    raise RuntimeError("PyTorch >=2.6 is required; unsafe pickle loaders are not supported")
with torch.inference_mode():
    assert torch.tensor([2.0]).square().item() == 4.0
try:
    import transformers
    transformers_version = transformers.__version__
except ImportError:
    transformers_version = None
print(json.dumps({"runtimeVerification": "PASS", "role": "inference", "llamaCpp": llama_cpp.__version__,
                  "torch": torch.__version__, "transformers": transformers_version,
                  "gpuAvailable": torch.cuda.is_available(), "resources": ResourceManager().snapshot()}))
