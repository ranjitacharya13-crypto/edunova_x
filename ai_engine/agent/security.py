"""Data-boundary helpers. Authorization remains in the tool/backend services."""
import re

_CONTROL_MARKERS = re.compile(r"<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|endoftext|end|assistant|user|system)\|>|</?s>|<start_of_turn>|<end_of_turn>|\[/?INST\]", re.I)

def escape_chat_controls(text: str) -> str:
    # Untrusted text must not manufacture a tokenizer-level system/assistant
    # turn. This complements (does not replace) owner scoping and confirmations.
    return _CONTROL_MARKERS.sub(lambda m: m.group().replace('<', '‹').replace('>', '›').replace('[', '［').replace(']', '］'), text)

def requests_external_data(goal: str) -> bool:
    return bool(re.search(r"\b(latest|current|recent|news|research|search|online|web|internet|verify|updates?|developments?|today|yesterday)\b|https?://", goal, re.I))
