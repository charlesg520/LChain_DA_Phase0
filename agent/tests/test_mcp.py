"""MCP: config parsing, and a real MCP server (streamable HTTP) driven through the agent graph."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from hq_agent import mcp
from hq_agent.config import load_settings
from hq_agent.graph import build_agent, make_graph
from tests.conftest import scripted, tool_call
from tests.gitserver import free_port


# ------------------------------------------------------------------- config
def test_env_expansion_and_requires_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEMO_TOKEN", "abc")
    monkeypatch.delenv("NOT_SET", raising=False)
    specs = mcp.parse_config(
        {
            "servers": {
                "demo": {
                    "url": "https://example.com/mcp",
                    "headers": {"Authorization": "Bearer ${DEMO_TOKEN}", "X-Region": "${REGION:-us}"},
                    "requires_env": ["DEMO_TOKEN"],
                    "agents": {"coder": ["*"]},
                },
                "later": {"url": "https://example.com/x", "requires_env": ["NOT_SET"]},
            }
        }
    )
    demo, later = specs
    assert demo.connection == {
        "transport": "streamable_http",
        "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer abc", "X-Region": "us"},
    }
    assert demo.missing_env == [] and later.missing_env == ["NOT_SET"]


@pytest.mark.parametrize(
    ("config", "message"),
    [
        ({"nope": {}}, "top level"),
        ({"servers": {"Bad Name": {"url": "x"}}}, "server name"),
        ({"servers": {"a": {"transport": "carrier-pigeon", "url": "x"}}}, "transport"),
        ({"servers": {"a": {"url": "x", "agents": {"intern": ["*"]}}}}, "unknown agents"),
        ({"servers": {"a": {}}}, "url is required"),
        ({"servers": {"a": {"transport": "stdio"}}}, "command is required"),
    ],
)
def test_config_errors_are_specific(config: dict, message: str) -> None:
    with pytest.raises(mcp.MCPConfigError, match=message):
        mcp.parse_config(config)


async def test_invalid_config_file_is_reported_not_fatal(tmp_path: Path) -> None:
    path = tmp_path / "mcp.json"
    path.write_text("{not json")
    toolset = await mcp.load_mcp_tools_from_config(path)
    assert toolset.status["_config"].status == "error"
    assert (await mcp.load_mcp_tools_from_config(tmp_path / "missing.json")).status == {}


# ------------------------------------------------------- a real MCP server
@pytest.fixture(scope="module")
def mcp_server():
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("demo", stateless_http=True, json_response=True)
    calls: list[str] = []

    @server.tool()
    def get_weather(city: str) -> str:
        """Current weather for a city."""
        calls.append(f"get_weather:{city}")
        return f"Sunny in {city}"

    @server.tool()
    def create_ticket(title: str) -> str:
        """Create a ticket."""
        calls.append(f"create_ticket:{title}")
        return f"Created ticket: {title}"

    @server.tool()
    def delete_everything() -> str:
        """Dangerous."""
        calls.append("delete_everything")
        return "boom"

    port = free_port()
    uv = uvicorn.Server(uvicorn.Config(server.streamable_http_app(), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    while not uv.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/mcp", calls
    uv.should_exit = True
    thread.join(timeout=5)


def _write_config(tmp_path: Path, url: str, **extra) -> Path:
    path = tmp_path / "mcp.json"
    server = {
        "transport": "streamable_http",
        "url": url,
        "agents": {
            "orchestrator": ["get_*"],
            "coder": ["get_*", "create_ticket"],
            "researcher": ["get_weather"],
        },
        **extra,
    }
    path.write_text(json.dumps({"servers": {"demo": server, "dead": {"url": "http://127.0.0.1:1/mcp", "timeout_seconds": 3}}}))
    return path


async def test_tools_are_split_per_agent_and_dangerous_ones_never_exposed(mcp_server, tmp_path: Path) -> None:
    url, _ = mcp_server
    toolset = await mcp.load_mcp_tools_from_config(_write_config(tmp_path, url))

    assert toolset.status["demo"].status == "loaded"
    assert toolset.status["demo"].tools == ["demo_create_ticket", "demo_delete_everything", "demo_get_weather"]
    assert [t.name for t in toolset.tools_for("orchestrator")] == ["demo_get_weather"]
    assert sorted(t.name for t in toolset.tools_for("coder")) == ["demo_create_ticket", "demo_get_weather"]
    assert toolset.tools_for("reviewer") == []
    assert not any("delete_everything" in t.name for role in mcp.AGENT_ROLES for t in toolset.tools_for(role))
    # A server that's down is reported and skipped, never fatal.
    assert toolset.status["dead"].status == "error"


async def test_agent_calls_an_mcp_tool_end_to_end(mcp_server, hq_env: Path, tmp_path: Path) -> None:
    url, calls = mcp_server
    toolset = await mcp.load_mcp_tools_from_config(_write_config(tmp_path, url))
    model = scripted(tool_call("demo_get_weather", {"city": "Houston"}), AIMessage(content="It's sunny."))
    agent = build_agent(load_settings(), model_override=model, mcp_tools=toolset)

    result = await agent.ainvoke({"messages": [HumanMessage("weather?")]}, {"configurable": {"thread_id": "m1"}})

    reply = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert "Sunny in Houston" in str(reply.content)
    assert "get_weather:Houston" in calls
    assert toolset.status["demo"].calls == 1


async def test_approval_listed_tools_pause_for_c(mcp_server, hq_env: Path, tmp_path: Path) -> None:
    url, calls = mcp_server
    toolset = await mcp.load_mcp_tools_from_config(_write_config(tmp_path, url, approve=["get_weather"]))
    assert toolset.interrupt_on("orchestrator") == {"demo_get_weather": True}
    model = scripted(tool_call("demo_get_weather", {"city": "Austin"}), AIMessage(content="done"))
    agent = build_agent(load_settings(), model_override=model, mcp_tools=toolset).copy(update={"checkpointer": InMemorySaver()})

    result = await agent.ainvoke({"messages": [HumanMessage("weather?")]}, {"configurable": {"thread_id": "m2"}})

    assert "__interrupt__" in result
    assert "get_weather:Austin" not in calls  # paused before the call


async def test_server_dying_mid_run_becomes_a_tool_error(hq_env: Path) -> None:
    status = mcp.ServerStatus(status="loaded")
    broken = await _tool_with_dead_connection(status)
    model = scripted(tool_call(broken.name, {"city": "Dallas"}), AIMessage(content="ok"))
    agent = build_agent(load_settings(), model_override=model, mcp_tools=_single(broken))

    result = await agent.ainvoke({"messages": [HumanMessage("weather?")]}, {"configurable": {"thread_id": "m3"}})

    reply = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert "MCP server 'demo' failed" in str(reply.content)
    assert result["messages"][-1].content == "ok"  # the run carried on
    assert (status.calls, status.errors) == (1, 1)


async def _tool_with_dead_connection(status: mcp.ServerStatus):
    """A tool built exactly like the loader builds it, but whose server is gone."""
    from langchain_core.tools import StructuredTool
    from langchain_mcp_adapters.tools import convert_mcp_tool_to_langchain_tool
    from mcp.types import Tool

    spec = Tool(name="get_weather", description="weather", inputSchema={"type": "object", "properties": {"city": {"type": "string"}}})
    tool = convert_mcp_tool_to_langchain_tool(
        None,
        spec,
        connection={"transport": "streamable_http", "url": "http://127.0.0.1:1/mcp", "timeout": 2},
        server_name="demo",
        tool_name_prefix=True,
        tool_interceptors=[mcp._interceptor(status)],
    )
    assert isinstance(tool, StructuredTool)
    return tool


def _single(tool) -> mcp.MCPToolset:
    toolset = mcp.MCPToolset()
    toolset.by_role["orchestrator"].append(tool)
    return toolset


async def test_make_graph_loads_mcp_and_reports_status(mcp_server, hq_env: Path, tmp_path: Path, monkeypatch) -> None:
    url, _ = mcp_server
    monkeypatch.setenv("HQ_MCP_CONFIG", str(_write_config(tmp_path, url)))
    graph = await make_graph()
    assert graph.name == "hq"
    status = mcp.current().as_dict()["servers"]
    assert status["demo"]["status"] == "loaded" and status["dead"]["status"] == "error"


def test_shipped_config_is_valid_and_github_waits_for_its_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GITHUB_MCP_TOKEN", raising=False)
    shipped = Path(__file__).resolve().parents[2] / "config" / "mcp.json"
    [github] = mcp.parse_config(json.loads(shipped.read_text()))
    assert github.missing_env == ["GITHUB_MCP_TOKEN"]
    assert "create_pull_request" in github.patterns_for("coder")
    assert not any("merge" in p or "delete" in p for patterns in github.agents.values() for p in patterns)
