"""EduNova AI inference subsystem (self-hosted, PyTorch-first).

This package owns the *model compute layer* of the EduNova AI architecture:

- ``lifecycle``        — canonical model lifecycle state machine
                        (STARTING/LOADING/WARMING/READY/BUSY/DEGRADED/ERROR).
- ``torch_runtime``    — PyTorch-based inference runtime (transformers +
                        ``torch.inference_mode()``, dynamic KV cache streaming,
                        optional int8/bf16 quantization, adaptive CPU threads).
- ``adaptive``         — environment detection used to pick safe runtime
                        settings (dtype, threads, context) before loading.

Design rule enforced here and at the API layer: **a normal user request never
triggers a model download or a cold load.**  Model download + load + warmup
happen during service startup (lifespan), the service only advertises READY
after a successful warm-up inference, and requests that arrive while the model
is still warming are queued (with an honest "preparing" status), never dropped
with a "try again shortly" error.

The legacy llama.cpp (GGUF) runtime from ``agent.local_llm`` remains available
for operators who prefer it via ``LOCAL_MODEL_RUNTIME=llama_cpp``.
"""

from .lifecycle import LIFECYCLE_STATES, ModelLifecycle, state_machine_view

__all__ = ["LIFECYCLE_STATES", "ModelLifecycle", "state_machine_view"]
