"""EduNova custom Hierarchical Reasoning Model (HRM-style).

This package is the project-owned PyTorch architecture. It is not a wrapper
around Llama, Qwen, GPT-2, SmolLM, or any other external causal LM.

The production inference service still defaults to the existing llama.cpp
GGUF path on Render Free (512 MiB) because importing PyTorch alone exceeds
that budget. Set LOCAL_MODEL_RUNTIME=hrm on a >=1 GiB instance to serve
this model. llama.cpp remains the migration fallback until HRM evaluation
passes the golden suite.
"""

from .config import HRMConfig, load_hrm_config, SIZE_PRESETS
from .outputs import OUTPUT_TYPES, StructuredOutput, parse_structured_output

__all__ = [
    "HRMConfig",
    "load_hrm_config",
    "SIZE_PRESETS",
    "OUTPUT_TYPES",
    "StructuredOutput",
    "parse_structured_output",
]
