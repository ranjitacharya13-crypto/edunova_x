"""Build/start preflight: fail the deployment if native imports are broken."""
import json
import platform
import llama_cpp
import torch
import transformers
from safetensors import safe_open
from inference.manager import resources

if tuple(int(v) for v in torch.__version__.split('+')[0].split('.')[:2]) < (2, 6):
    raise RuntimeError('PyTorch >=2.6 is required; unsafe pickle loaders are not supported')
with torch.inference_mode():
    assert torch.tensor([2.0]).square().item() == 4.0
print(json.dumps({'runtimeVerification': 'PASS', 'llamaCpp': llama_cpp.__version__,
                  'torch': torch.__version__, 'transformers': transformers.__version__,
                  'gpuAvailable': torch.cuda.is_available(), 'resources': resources()}))
