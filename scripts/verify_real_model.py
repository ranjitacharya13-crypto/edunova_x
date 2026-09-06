"""CI/staging evidence from actual pretrained weights, never canned responses.

This does NOT certify the production site, Mongo identity integration, camera
hardware, or semantic answer correctness. It records text and real throughput
for review, plus explicit mechanical checks. No commercial model/API is used.
"""
import argparse
import asyncio
import ast
import json
from pathlib import Path
import re
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ai_engine'))
from config import load_settings
from agent.local_llm import create_llm
from agent.router import IntentRouter, run_fast_path, validate_quiz_payload, _QUIZ_SCHEMA
from agent.tools.base import ToolRegistry
from inference.rag import Embedder, RagIndex
from inference.manager import resources, safe_error

async def verify(output):
    settings = load_settings()
    llm, manager = create_llm(settings)
    report = {'scope': 'Actual model/embedding inference on this CI or staging machine, NOT deployed-site acceptance',
              'hardware': resources(), 'model': settings.local_model_id, 'checks': [], 'status': 'FAIL'}
    manager.ensure_loading()
    try:
        await asyncio.wait_for(manager._ready_event.wait(), settings.local_model_startup_timeout + 10)
        report['startup'] = manager.snapshot(include_source=True)
        if not manager.is_ready():
            raise RuntimeError(manager.last_error or manager.phase)
        pid = manager._process.pid
        history = []
        registry = ToolRegistry(allowed_permissions={'READ_INTERNAL', 'READ_EXTERNAL', 'WRITE_INTERNAL', 'UTILITY'})
        prompts = ['Hello', 'What is ML?', 'Explain it simply.', 'Give a real-life example.', 'Write a complete Python binary search function with an example.']
        for prompt in prompts:
            streamed = []
            first = None
            started = time.monotonic()
            async def event(e):
                nonlocal first
                if e.get('type') == 'token':
                    if first is None: first = time.monotonic()
                    streamed.append(e.get('delta', ''))
            result = await run_fast_path(settings=settings, llm=llm, registry=registry, decision=IntentRouter(settings).classify(prompt, history),
                goal=prompt, conversation=history, conversation_id='ci-real-model', user_id='ci-model-only', user_name='CI learner', event_callback=event)
            answer = result['message']
            record = {'prompt': prompt, 'answer': answer, 'metrics': manager.last_generation_metrics,
                      'totalMs': round((time.monotonic()-started)*1000), 'streamEvents': len(streamed),
                      'firstEventMs': round((first-started)*1000) if first else None,
                      'sameResidentWorker': pid == manager._process.pid, 'mechanicalPass': bool(answer.strip() and streamed)}
            if 'binary search' in prompt.lower():
                blocks = re.findall(r'```(?:python)?\s*\n(.*?)```', answer, re.S)
                try:
                    record['pythonSyntaxValid'] = bool(blocks) and bool(ast.parse(blocks[0]))
                except SyntaxError:
                    record['pythonSyntaxValid'] = False
                record['mechanicalPass'] &= record['pythonSyntaxValid']
            report['checks'].append(record)
            if not record['mechanicalPass']: raise RuntimeError(f'Mechanical generation check failed: {prompt}')
            history.extend([{'role': 'user', 'content': prompt}, {'role': 'assistant', 'content': answer}])
        # Cancel a real generation; a healthy resident model must remain usable.
        cancellation_seen = asyncio.Event()
        task = asyncio.create_task(llm.complete_text(system_prompt='Teach fully.', user_prompt='Explain all the steps of binary search with detailed examples.',
            max_output_tokens=512, on_token=lambda _: cancellation_seen.set()))
        await asyncio.wait_for(cancellation_seen.wait(), 90)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert manager.is_ready() and manager._process.pid == pid, 'Cancellation must not kill/reload the model'
        report['cancelResidentWorker'] = 'PASS'
        # PyTorch mean-pooled semantic vectors from the actual MiniLM weights.
        index = RagIndex(Embedder('sentence-transformers/all-MiniLM-L6-v2'))
        await asyncio.to_thread(index.sync_documents, 'owner-a', [
            {'id': 'curriculum-retina', 'title': 'Eye curriculum', 'text': 'The retina contains photoreceptors that detect light. Rods and cones turn it into neural signals.'},
            {'id': 'curriculum-binary-search', 'title': 'Algorithms', 'text': 'Binary search halves a sorted array each iteration and takes logarithmic time.'},
        ])
        hits = await asyncio.to_thread(index.search, 'owner-a', 'Which eye tissue converts light into nerve signals?')
        assert hits and hits[0]['documentId'] == 'curriculum-retina', 'Actual embedding relevance test failed'
        assert index.search('owner-b', 'eye tissue') == [], 'Owner isolation failed'
        report['pytorchRag'] = {'backend': index.embedder.backend, 'model': index.embedder.model_name, 'hits': hits, 'ownerIsolation': 'PASS'}
        lesson = json.loads((Path(__file__).resolve().parents[1] / 'server/catalog/ar-lessons.json').read_text())[0]
        raw = await llm.complete_json(system_prompt='Create a two-question multiple-choice quiz from the provided curriculum. Return only the required JSON.',
            user_prompt=json.dumps({'subject': lesson['subject'], 'description': lesson['description'], 'learningObjectives': lesson['learningObjectives'], 'parts': lesson['hotspots']}),
            json_schema=_QUIZ_SCHEMA, max_output_tokens=settings.llm_max_output_tokens)
        report['arQuiz'] = validate_quiz_payload(raw)
        report['quizMetrics'] = manager.last_generation_metrics
        report['status'] = 'PASS_MECHANICAL_CHECKS_REQUIRES_ANSWER_REVIEW'
    except Exception as exc:
        report['failure'] = {'type': type(exc).__name__, 'reason': safe_error(exc), 'state': manager.snapshot(include_source=True)}
        raise
    finally:
        await manager.close()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, default=str) + '\n')
        print(json.dumps({'status': report['status'], 'evidence': str(output), 'completedChecks': len(report['checks'])}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('evidence/ci-real-inference.json'))
    args = parser.parse_args()
    asyncio.run(verify(args.output))
