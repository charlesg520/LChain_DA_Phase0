"""A scripted, Anthropic-compatible Messages API for end-to-end tests.

It plays one coding job, step by step, for each agent (decided from the system
prompt), and streams like a real provider: thinking blocks with an empty
signature (as GLM through Anthropic-compatible endpoints does), text deltas,
and tool_use blocks with input_json_delta.

    python fake_llm.py 58900
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

TODOS_1 = [
    {"content": "Create calc.py", "status": "in_progress"},
    {"content": "Get an independent review", "status": "pending"},
    {"content": "Fix and verify", "status": "pending"},
]
TODOS_2 = [
    {"content": "Create calc.py", "status": "completed"},
    {"content": "Get an independent review", "status": "completed"},
    {"content": "Fix and verify", "status": "in_progress"},
]
TODOS_3 = [{**t, "status": "completed"} for t in TODOS_2]

ORCHESTRATOR = [
    ("I'll set up a small module, get it reviewed, then fix what the review finds.", ("write_todos", {"todos": TODOS_1})),
    ("Creating the module.", ("execute", {"command": "mkdir -p demo && printf 'def add(a, b):\\n    return a - b\\n' > demo/calc.py && cat demo/calc.py"})),
    ("Asking the reviewer for an independent look.", ("task", {"description": "Review /workspace/demo/calc.py for bugs. Report findings by severity.", "subagent_type": "reviewer"})),
    ("", ("write_todos", {"todos": TODOS_2})),
    ("The reviewer found the bug. Fixing it needs your approval.", ("edit_file", {"file_path": "/workspace/demo/calc.py", "old_string": "a - b", "new_string": "a + b"})),
    ("Verifying.", ("execute", {"command": "cd demo && python3 -c 'import calc; print(calc.add(2, 3))'"})),
    ("", ("read_file", {"file_path": "/skills/coding/test-first-change/SKILL.md"})),
    ("", ("write_todos", {"todos": TODOS_3})),
    (
        "## Done\n\n`add` subtracted instead of adding. Fixed and verified:\n\n```python\ndef add(a, b):\n    return a + b\n```\n\n| check | result |\n|---|---|\n| review | 1 blocker fixed |\n| `add(2, 3)` | `5` |\n",
        None,
    ),
]
REVIEWER = [
    ("Reading the file under review.", ("read_file", {"file_path": "/workspace/demo/calc.py"})),
    ("**blocker** `demo/calc.py:2`: `add` returns `a - b`. Use `a + b`.", None),
]
GENERIC = [("Done.", None)]

# "[scenario:coder-approval]" in the chat: the orchestrator delegates to the coder,
# whose edit needs approval (an interrupt raised inside a sub-agent).
ORCH_CODER = [
    ("Handing this to the coder.", ("task", {"description": "In /workspace/demo/calc.py make add return a + b. [scenario:coder-approval]", "subagent_type": "coder"})),
    ("The coder fixed `add`.", None),
]
CODER = [
    ("Creating the file.", ("execute", {"command": "mkdir -p demo && printf 'def add(a, b):\\n    return a - b\\n' > demo/calc.py"})),
    ("Fixing it.", ("edit_file", {"file_path": "/workspace/demo/calc.py", "old_string": "a - b", "new_string": "a + b"})),
    ("Fixed `add` in demo/calc.py.", None),
]


def which_agent(system: str) -> str:
    if "meticulous code reviewer" in system:
        return "reviewer"
    if "senior software engineer" in system:
        return "coder"
    if "You are HQ" in system:
        return "orchestrator"
    return "generic"


def step_for(messages: list) -> int:
    return sum(1 for m in messages if m.get("role") == "assistant")


def system_text(body: dict) -> str:
    s = body.get("system", "")
    if isinstance(s, list):
        return " ".join(b.get("text", "") for b in s if isinstance(b, dict))
    return str(s)


def plan(body: dict):
    agent = which_agent(system_text(body))
    scenario = "[scenario:coder-approval]" in json.dumps(body.get("messages", []))
    script = {"orchestrator": ORCH_CODER if scenario else ORCHESTRATOR, "reviewer": REVIEWER, "coder": CODER}.get(agent, GENERIC)
    step = step_for(body.get("messages", []))
    if step >= len(script):
        return agent, ("Done.", None)
    return agent, script[step]


def blocks(agent: str, text: str, tool):
    out = [{"type": "thinking", "thinking": f"{agent}: next step.", "signature": ""}]
    if text:
        out.append({"type": "text", "text": text})
    if tool:
        out.append({"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:20], "name": tool[0], "input": tool[1]})
    return out


def usage(body: dict) -> dict:
    return {"input_tokens": max(1, len(json.dumps(body)) // 4), "output_tokens": 0}


async def messages(request: Request):
    body = await request.json()
    agent, (text, tool) = plan(body)
    content = blocks(agent, text, tool)
    stop = "tool_use" if tool else "end_turn"
    msg_id = "msg_" + uuid.uuid4().hex[:20]
    out_tokens = max(1, len(json.dumps(content)) // 4)
    if not body.get("stream"):
        return JSONResponse(
            {"id": msg_id, "type": "message", "role": "assistant", "model": body.get("model"), "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {**usage(body), "output_tokens": out_tokens}}
        )

    async def gen():
        def ev(name, data):
            return f"event: {name}\ndata: {json.dumps(data)}\n\n"

        yield ev("message_start", {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant", "model": body.get("model"), "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage(body)}})
        for i, b in enumerate(content):
            if b["type"] == "thinking":
                yield ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
                yield ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "thinking_delta", "thinking": b["thinking"]}})
                yield ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "signature_delta", "signature": ""}})
            elif b["type"] == "text":
                yield ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                words = b["text"].split(" ")
                for j in range(0, len(words), 3):
                    piece = " ".join(words[j : j + 3]) + (" " if j + 3 < len(words) else "")
                    yield ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": piece}})
                    await asyncio.sleep(0.03)
            else:
                yield ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}})
                raw = json.dumps(b["input"])
                for j in range(0, len(raw), 40):
                    yield ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": raw[j : j + 40]}})
            yield ev("content_block_stop", {"type": "content_block_stop", "index": i})
        yield ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {**usage(body), "output_tokens": out_tokens}})
        yield ev("message_stop", {"type": "message_stop"})

    return StreamingResponse(gen(), media_type="text/event-stream")


async def models(_request: Request):
    return JSONResponse({"data": [{"id": "fake-glm", "type": "model", "display_name": "fake"}], "has_more": False})


app = Starlette(routes=[Route("/v1/messages", messages, methods=["POST"]), Route("/v1/models", models)])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1] if len(sys.argv) > 1 else 58900), log_level="warning")
