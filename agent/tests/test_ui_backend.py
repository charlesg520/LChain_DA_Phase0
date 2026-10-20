"""Backend features the web console uses: browsing, memory, tool registry,
skill enable/disable, MCP management and approval settings."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from hq_agent import browse, mcp
from hq_agent.config import load_settings
from hq_agent.graph import build_agent, skill_store, tool_registry
from tests.conftest import scripted, tool_call

TOKEN = "u" * 48
H = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(hq_env: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HQ_API_TOKEN", TOKEN)
    monkeypatch.setenv("HQ_MCP_CONFIG", str(hq_env / "data" / "mcp.json"))
    from hq_agent.ops import app

    skill_store(load_settings()).sync_builtin()
    mcp.set_current(mcp.MCPToolset())
    return TestClient(app)


# ------------------------------------------------------------------ browsing
def test_root_lists_the_three_areas(client) -> None:
    r = client.get("/ops/fs", params={"path": "/"}, headers=H).json()
    assert [e["name"] for e in r["entries"]] == ["workspace", "memories", "skills"]
    assert all(e["type"] == "dir" for e in r["entries"])


def test_skills_and_memories_are_browsable(client, hq_env: Path) -> None:
    build_agent(load_settings(), model_override=scripted(AIMessage(content="x")))  # seeds AGENTS.md
    mems = client.get("/ops/fs", params={"path": "/memories"}, headers=H).json()
    assert "AGENTS.md" in [e["name"] for e in mems["entries"]]
    f = client.get("/ops/fs/file", params={"path": "/memories/AGENTS.md"}, headers=H).json()
    assert f["encoding"] == "utf8" and f["mime"] == "text/markdown" and "HQ memory" in f["content"]
    cats = client.get("/ops/fs", params={"path": "/skills"}, headers=H).json()
    assert {"coding", "markets"} <= {e["name"] for e in cats["entries"]}
    sk = client.get("/ops/fs/file", params={"path": "/skills/coding/git-workflow/SKILL.md"}, headers=H).json()
    assert sk["content"].startswith("---\nname: git-workflow")


def test_binary_files_come_back_base64(client, hq_env: Path) -> None:
    settings = load_settings()
    settings.memories_dir.mkdir(parents=True, exist_ok=True)
    (settings.memories_dir / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00binary")
    f = client.get("/ops/fs/file", params={"path": "/memories/pic.png"}, headers=H).json()
    assert f["encoding"] == "base64" and f["mime"] == "image/png"
    assert base64.b64decode(f["content"]).startswith(b"\x89PNG")


@pytest.mark.parametrize("path", ["/memories/../../etc/passwd", "/skills/../../../etc", "/etc/passwd", "/memories/nope.md"])
def test_browsing_refuses_escapes_and_unknown_paths(client, path: str) -> None:
    r = client.get("/ops/fs/file", params={"path": path}, headers=H)
    assert r.status_code in (400, 404), r.text


def test_workspace_without_sandbox_is_a_clear_error(client) -> None:
    r = client.get("/ops/fs", params={"path": "/workspace"}, headers=H)
    assert r.status_code == 409 and "disabled" in r.json()["detail"]


# -------------------------------------------------------------------- memory
def test_memory_read_and_save(client, hq_env: Path) -> None:
    build_agent(load_settings(), model_override=scripted(AIMessage(content="x")))
    files = client.get("/ops/memory", headers=H).json()["files"]
    assert files[0]["path"] == "/AGENTS.md"
    saved = client.put("/ops/memory", headers=H, json={"path": "/AGENTS.md", "content": "# HQ memory\n- new rule\n"}).json()
    assert saved["saved"] == "/AGENTS.md"
    assert (load_settings().memories_dir / "AGENTS.md").read_text() == "# HQ memory\n- new rule\n"
    new = client.put("/ops/memory", headers=H, json={"path": "/projects/app.md", "content": "notes"}).json()
    assert "/projects/app.md" in [f["path"] for f in new["files"]]


@pytest.mark.parametrize(
    ("path", "status"),
    [("/x.py", 400), ("/../escape.md", 400), ("/.hidden.md", 400), ("/", 400)],
)
def test_memory_save_validation(client, path: str, status: int) -> None:
    assert client.put("/ops/memory", headers=H, json={"path": path, "content": "x"}).status_code == status


def test_memory_size_limit(client) -> None:
    r = client.put("/ops/memory", headers=H, json={"path": "/big.md", "content": "x" * (browse.MAX_MEMORY_BYTES + 1)})
    assert r.status_code == 413


# ------------------------------------------------------------ skill enable
def test_disable_hides_a_skill_from_agents_and_survives_restarts(client, hq_env: Path) -> None:
    r = client.post("/ops/skills/coding/git-workflow/enabled", headers=H, json={"enabled": False})
    assert r.json()["enabled"] is False
    listed = {s["name"]: s for s in client.get("/ops/skills", headers=H).json()}
    assert listed["git-workflow"]["enabled"] is False
    settings = load_settings()
    assert not (settings.skills_dir / "coding" / "git-workflow").exists()

    model = scripted(AIMessage(content="ok"))
    build_agent(settings, model_override=model).invoke({"messages": [HumanMessage("hi")]}, {"configurable": {"thread_id": "t"}})
    system = model.seen_prompts[0][0].content
    text = system if isinstance(system, str) else " ".join(str(b) for b in system)
    assert "git-workflow" not in text and "test-first-change" in text

    skill_store(settings).sync_builtin()  # repo skill must not come back on restart
    assert not (settings.skills_dir / "coding" / "git-workflow").exists()
    # editing a disabled skill keeps it disabled; history and get still work
    assert client.get("/ops/skills/coding/git-workflow", headers=H).json()["enabled"] is False
    client.put("/ops/skills/coding/git-workflow", headers=H, json={"files": {"SKILL.md": "---\nname: git-workflow\ndescription: d\n---\nv2\n"}})
    assert not (settings.skills_dir / "coding" / "git-workflow").exists()

    client.post("/ops/skills/coding/git-workflow/enabled", headers=H, json={"enabled": True})
    assert (settings.skills_dir / "coding" / "git-workflow" / "SKILL.md").read_text().endswith("v2\n")
    assert client.post("/ops/skills/coding/missing/enabled", headers=H, json={"enabled": False}).status_code == 404


# ------------------------------------------------------------- tool registry
def test_tool_registry_lists_harness_and_hq_tools_with_schemas(hq_env: Path, monkeypatch) -> None:
    monkeypatch.setenv("HQ_REQUIRE_APPROVAL", "execute,write_file")
    tools = {t["name"]: t for t in tool_registry(load_settings(), mcp.MCPToolset())}
    for name in ["ls", "read_file", "write_file", "edit_file", "grep", "execute", "task", "web_search", "fetch_url", "propose_skill"]:
        assert name in tools, name
        assert json.loads(tools[name]["schema"])["type"] == "object"
    assert tools["read_file"]["source"] == "harness"
    assert tools["propose_skill"]["source"] == "hq"
    assert "reviewer" in tools["read_file"]["agents"] and "reviewer" not in tools["write_file"]["agents"]
    assert tools["task"]["agents"] == ["orchestrator"]
    assert tools["execute"]["approval"] and tools["write_file"]["approval"] and not tools["ls"]["approval"]


def test_tools_endpoint(client) -> None:
    tools = client.get("/ops/tools", headers=H).json()
    assert any(t["name"] == "task" for t in tools)


# ------------------------------------------------------------- approvals
def test_require_approval_pauses_matching_tools(hq_env: Path, monkeypatch) -> None:
    monkeypatch.setenv("HQ_REQUIRE_APPROVAL", "write_file")
    model = scripted(tool_call("write_file", {"file_path": "/memories/x.md", "content": "hi"}), AIMessage(content="done"))
    agent = build_agent(load_settings(), model_override=model).copy(update={"checkpointer": InMemorySaver()})
    result = agent.invoke({"messages": [HumanMessage("write it")]}, {"configurable": {"thread_id": "a1"}})
    assert "__interrupt__" in result
    req = result["__interrupt__"][0].value
    assert req["action_requests"][0]["name"] == "write_file"
    assert not (load_settings().memories_dir / "x.md").exists()


# ----------------------------------------------------------------- MCP edit
def test_server_from_form_validation() -> None:
    name, cfg = mcp.server_from_form(
        {"name": "gh", "transport": "http", "url": "https://x.example/mcp", "headers": {"Authorization": "Bearer ${GH_TOKEN}"}, "agents": {"coder": ["get_*"]}},
        allow_stdio=False,
    )
    assert name == "gh" and cfg["transport"] == "streamable_http" and cfg["requires_env"] == ["GH_TOKEN"]
    assert cfg["agents"] == {"coder": ["get_*"]}
    _, default_agents = mcp.server_from_form({"name": "a", "transport": "sse", "url": "https://x/sse"}, allow_stdio=False)
    assert default_agents["agents"] == {"orchestrator": ["*"]}
    for bad, msg in [
        ({"name": "Bad Name", "url": "https://x"}, "name"),
        ({"name": "a", "transport": "ftp"}, "transport"),
        ({"name": "a", "transport": "http", "url": "file:///x"}, "url"),
        ({"name": "a", "transport": "http", "url": "https://x", "headers": {"A": 1}}, "headers"),
        ({"name": "a", "transport": "stdio", "command": "rm -rf /"}, "HQ_ALLOW_STDIO_MCP"),
    ]:
        with pytest.raises(mcp.MCPConfigError, match=msg):
            mcp.server_from_form(bad, allow_stdio=False)
    _, stdio = mcp.server_from_form({"name": "fs", "transport": "stdio", "command": "npx -y @mcp/fs '/data dir'"}, allow_stdio=True)
    assert stdio["command"] == "npx" and stdio["args"] == ["-y", "@mcp/fs", "/data dir"]


def test_mcp_crud_over_http_masks_secrets_and_reloads(client, hq_env: Path) -> None:
    add = client.post(
        "/ops/mcp/servers",
        headers=H,
        json={"name": "dead", "transport": "http", "url": "http://127.0.0.1:1/mcp", "headers": {"X-Key": "sk-live-1234567890abcd", "Auth": "Bearer ${SOME_TOKEN}"}},
    )
    assert add.status_code == 200, add.text
    view = next(s for s in add.json() if s["id"] == "dead")
    assert view["status"] == "connecting"
    assert view["headers"]["X-Key"].endswith("abcd") and "sk-live" not in view["headers"]["X-Key"]
    assert view["headers"]["Auth"] == "Bearer ${SOME_TOKEN}"
    saved = json.loads((hq_env / "data" / "mcp.json").read_text())
    assert saved["servers"]["dead"]["headers"]["X-Key"] == "sk-live-1234567890abcd"  # stored for real, only masked in views

    # after the reload finishes the server reports waiting_for_env (SOME_TOKEN unset) as an error with a fix
    r = client.post("/ops/mcp/reload", headers=H).json()
    dead = next(s for s in r if s["id"] == "dead")
    assert dead["status"] == "error" and "SOME_TOKEN" in dead["error"]

    off = client.post("/ops/mcp/servers/dead/enabled", headers=H, json={"enabled": False}).json()
    assert next(s for s in off if s["id"] == "dead")["status"] == "disconnected"
    assert json.loads((hq_env / "data" / "mcp.json").read_text())["servers"]["dead"]["enabled"] is False
    gone = client.delete("/ops/mcp/servers/dead", headers=H).json()
    assert not any(s["id"] == "dead" for s in gone)
    assert client.delete("/ops/mcp/servers/dead", headers=H).status_code == 404
    bad = client.post("/ops/mcp/servers", headers=H, json={"name": "x", "transport": "stdio", "command": "sh"})
    assert bad.status_code == 400 and "HQ_ALLOW_STDIO_MCP" in bad.json()["detail"]


def test_seed_config_copies_once(tmp_path: Path) -> None:
    seed = tmp_path / "seed.json"
    seed.write_text('{"servers": {}}')
    target = tmp_path / "data" / "mcp.json"
    mcp.seed_config(target, seed)
    assert target.read_text() == '{"servers": {}}'
    target.write_text('{"servers": {"mine": {"url": "https://x"}}}')
    mcp.seed_config(target, seed)
    assert "mine" in target.read_text()


def test_new_routes_require_the_token(client) -> None:
    for method, path in [("get", "/ops/fs"), ("get", "/ops/fs/file?path=/x"), ("get", "/ops/memory"), ("put", "/ops/memory"), ("get", "/ops/tools"), ("get", "/ops/mcp/servers"), ("post", "/ops/mcp/servers"), ("post", "/ops/mcp/reload")]:
        assert getattr(client, method)(path).status_code == 401, path
