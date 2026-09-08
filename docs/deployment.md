# Deployment notes for HRM

Production on Render Free **stays on llama.cpp** (`LOCAL_MODEL_RUNTIME=llama_cpp`).
That is honest: torch CPU import (~200 MiB) plus a 20M fp32 checkpoint (~80 MiB)
plus FastAPI does not leave safe headroom in 512 MiB.

To serve the custom HRM:

```
LOCAL_MODEL_RUNTIME=hrm
HRM_SIZE=20m
HRM_CHECKPOINT=/var/data/models/hrm
HRM_CONFIG_PATH=configs/model/20m.yaml
HRM_ALLOW_UNTRAINED=false
MAX_TOOL_STEPS=8
```

Instance: **≥ 1 GiB RAM** recommended (`inference/resources.py` HRM budget).

If the checkpoint is missing and `HRM_ALLOW_UNTRAINED=false`, startup fails
with `MODEL_NOT_FOUND` — it will not pretend to be ready.

Rollback: keep llama.cpp configured; flip `LOCAL_MODEL_RUNTIME` back.
Registry rollback is `ModelRegistry.rollback()`.
