"""Per-request timing context; never log prompts, answers, credentials or keys."""
from contextvars import ContextVar
import json
import logging
import time

_current = ContextVar("ai_request_metrics", default=None)
log = logging.getLogger("edunova.metrics")

def begin(request_id, user_id, intent):
    metrics = {"requestId": request_id, "userId": user_id, "intent": intent, "tools": [],
               "databaseMs": 0, "ragMs": 0, "webMs": 0, "started": time.monotonic()}
    _current.set(metrics)
    return metrics

def tool(name, source, elapsed_ms, success, result=None, code=None):
    metric = _current.get()
    if metric is None:
        return
    metric["tools"].append({"name": name, "durationMs": elapsed_ms, "success": success, "code": code})
    if name in {"web_search", "open_url", "extract_webpage"}:
        metric["webMs"] += elapsed_ms
    elif name == "retrieve_learning_materials":
        metric["ragMs"] += (result or {}).get("ragMs", elapsed_ms)
        metric["databaseMs"] += (result or {}).get("databaseMs", 0)
    elif source == "database":
        metric["databaseMs"] += elapsed_ms
    log.info(json.dumps({"event": "tool.completed", "requestId": metric["requestId"], "tool": name,
                         "durationMs": elapsed_ms, "success": success, "failureStage": code}))

def finish(metrics, model=None, failure=None):
    result = {k: v for k, v in metrics.items() if k != "started"}
    result.update({"totalMs": round((time.monotonic() - metrics["started"]) * 1000),
                   "generation": model or {}, "failureStage": failure})
    log.info(json.dumps({"event": "request.completed", **result}))
    return {k: v for k, v in result.items() if k != "userId"}
