from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from hq_agent.config import load_settings
from hq_agent.graph import build_agent, make_graph, skill_sources, skill_store
from tests.conftest import scripted, tool_call


def _config(thread: str = "t1") -> dict:
    return {"configurable": {"thread_id": thread, "project": "demo"}}


def test_default_graph_builds_with_real_model_config(hq_env: Path) -> None:
    """The production factory builds with the default model routing (no network calls at build time)."""
    import asyncio

    graph = asyncio.run(make_graph())
    assert graph.name == "hq"


def test_tools_subagents_skills_and_memory_are_wired(hq_env: Path) -> None:
    model = scripted(AIMessage(content="ready"))
    agent = build_agent(load_settings(), model_override=model)
    result = agent.invoke({"messages": [HumanMessage("hello")]}, _config())

    assert result["messages"][-1].content == "ready"
    for expected in ["web_search", "fetch_url", "task", "read_file", "write_file", "edit_file"]:
        assert expected in model.seen_tools, expected
    assert "execute" not in model.seen_tools  # sandbox disabled in this test -> no shell

    system = model.seen_prompts[0][0].content
    system_text = system if isinstance(system, str) else " ".join(str(b) for b in system)
    assert "You are HQ" in system_text
    assert "HQ memory" in system_text  # /memories/AGENTS.md seeded and loaded
    assert "test-first-change" in system_text and "backtest-hygiene" in system_text  # skills listed


def test_skill_sources_are_category_folders(hq_env: Path) -> None:
    assert skill_sources(load_settings()) == ["/skills/coding/", "/skills/markets/"]


def test_sandbox_enabled_exposes_execute(hq_env: Path, monkeypatch) -> None:
    """With the Docker sandbox on, the shell tool is offered. Containers start lazily, so no Docker needed here."""
    monkeypatch.setenv("SANDBOX_ENABLED", "true")
    monkeypatch.setenv("SANDBOX_DOCKER_HOSTS", "tcp://127.0.0.1:1")
    model = scripted(AIMessage(content="ok"))
    build_agent(load_settings(), model_override=model).invoke({"messages": [HumanMessage("hi")]}, _config())
    assert "execute" in model.seen_tools


def test_memory_writes_land_on_disk(hq_env: Path) -> None:
    model = scripted(
        tool_call("write_file", {"file_path": "/memories/projects.md", "content": "# Projects\n- demo\n"}),
        AIMessage(content="saved"),
    )
    agent = build_agent(load_settings(), model_override=model)
    agent.invoke({"messages": [HumanMessage("remember the demo project")]}, _config())

    saved = hq_env / "data" / "memories" / "projects.md"
    assert saved.read_text() == "# Projects\n- demo\n"


def test_direct_skill_writes_are_denied(hq_env: Path) -> None:
    model = scripted(
        tool_call(
            "write_file",
            {"file_path": "/skills/coding/sneaky/SKILL.md", "content": "---\nname: sneaky\ndescription: x\n---\n"},
        ),
        AIMessage(content="done"),
    )
    settings = load_settings()
    result = build_agent(settings, model_override=model).invoke({"messages": [HumanMessage("add a skill")]}, _config())

    denied = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert denied and "permission" in denied[0].content.lower()
    assert not (settings.skills_dir / "coding" / "sneaky").exists()


def test_agent_proposes_a_skill_and_it_waits_for_review(hq_env: Path) -> None:
    skill = "---\nname: deploy-checklist\ndescription: Steps before any deploy. Use before deploying.\n---\n\n- run tests\n"
    model = scripted(
        tool_call("propose_skill", {"category": "coding", "name": "deploy-checklist", "skill_md": skill, "reason": "C asked twice"}),
        AIMessage(content="proposed"),
    )
    settings = load_settings()
    result = build_agent(settings, model_override=model).invoke({"messages": [HumanMessage("remember this")]}, _config())

    reply = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert "waiting for C's review" in reply.content
    assert not (settings.skills_dir / "coding" / "deploy-checklist").exists()  # not live until approved
    store = skill_store(settings)
    [pending] = store.list_proposals(status="pending")
    store.approve(pending.id)
    assert (settings.skills_dir / "coding" / "deploy-checklist" / "SKILL.md").read_text() == skill


def test_bad_skill_proposals_come_back_as_fixable_errors(hq_env: Path) -> None:
    model = scripted(
        tool_call("propose_skill", {"category": "coding", "name": "x", "skill_md": "no frontmatter", "reason": "r"}),
        AIMessage(content="ok"),
    )
    result = build_agent(load_settings(), model_override=model).invoke({"messages": [HumanMessage("hi")]}, _config())
    reply = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert reply.content.startswith("Not proposed:") and "frontmatter" in reply.content


def test_skill_approval_can_be_turned_off(hq_env: Path, monkeypatch) -> None:
    monkeypatch.setenv("REQUIRE_SKILL_APPROVAL", "false")
    skill = "---\nname: quick\ndescription: d\n---\nbody\n"
    model = scripted(
        tool_call("propose_skill", {"category": "coding", "name": "quick", "skill_md": skill, "reason": "r"}),
        AIMessage(content="ok"),
    )
    settings = load_settings()
    result = build_agent(settings, model_override=model).invoke({"messages": [HumanMessage("hi")]}, _config())
    assert "live as version" in next(m for m in result["messages"] if isinstance(m, ToolMessage)).content
    assert (settings.skills_dir / "coding" / "quick" / "SKILL.md").exists()


def test_coder_sees_skills_and_can_propose(hq_env: Path) -> None:
    model = scripted(
        tool_call("task", {"subagent_type": "coder", "description": "say hi"}),
        AIMessage(content="coder done"),
        AIMessage(content="all done"),
    )
    build_agent(load_settings(), model_override=model).invoke({"messages": [HumanMessage("delegate")]}, _config())
    coder_system = model.seen_prompts[1][0].content
    coder_text = coder_system if isinstance(coder_system, str) else " ".join(str(b) for b in coder_system)
    assert "git-workflow" in coder_text  # skills listed for the coder too
    assert model.seen_tools.count("propose_skill") >= 2  # orchestrator + coder


def test_seed_memory_is_never_overwritten(hq_env: Path) -> None:
    settings = load_settings()
    build_agent(settings, model_override=scripted(AIMessage(content="x")))
    memory = settings.memories_dir / "AGENTS.md"
    memory.write_text("learned stuff")
    build_agent(settings, model_override=scripted(AIMessage(content="x")))
    assert memory.read_text() == "learned stuff"
