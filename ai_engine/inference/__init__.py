"""EduNova AI inference subsystem (runs ONLY inside the inference service).

- ``resources``  — ResourceManager + model memory compatibility check (pure
                   Python; also used by the orchestrator for /system/resources).
- ``manager``    — THE single authoritative model lifecycle (supervised
                   llama.cpp worker: resource check -> load -> warmup -> real
                   inference test -> READY). Imported by ``inference_server.py``
                   only.
- ``rag``        — chunking + embeddings (PyTorch in the inference service,
                   ``RemoteEmbedder`` in the orchestrator) + user-isolated
                   vector retrieval.
- ``telemetry``  — per-request timing context.

Design rule: a user request never triggers a model download or a cold load,
and the lightweight orchestrator never imports llama_cpp or torch.
"""
