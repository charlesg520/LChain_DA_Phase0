from __future__ import annotations

from pathlib import Path

import pytest

from hq_agent.skills_store import SkillError, SkillStore, folder_hash, read_folder, validate_skill


def skill_md(name: str, body: str = "body", description: str = "Does a thing. Use when needed.") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"


@pytest.fixture
def builtin(tmp_path: Path) -> Path:
    root = tmp_path / "repo-skills"
    (root / "coding" / "git-workflow").mkdir(parents=True)
    (root / "coding" / "git-workflow" / "SKILL.md").write_text(skill_md("git-workflow", "v1 from repo"))
    (root / "markets" / "backtest-hygiene").mkdir(parents=True)
    (root / "markets" / "backtest-hygiene" / "SKILL.md").write_text(skill_md("backtest-hygiene"))
    return root


@pytest.fixture
def store(tmp_path: Path, builtin: Path) -> SkillStore:
    s = SkillStore(tmp_path / "data" / "skills", tmp_path / "data" / "skill-store", builtin)
    s.sync_builtin()
    return s


def live(store: SkillStore, key: str) -> str:
    return (store.skills_dir / key / "SKILL.md").read_text()


# ---------------------------------------------------------------- validation
@pytest.mark.parametrize(
    ("category", "name", "files", "message"),
    [
        ("Coding", "x", {"SKILL.md": skill_md("x")}, "category"),
        ("coding", "has space", {"SKILL.md": skill_md("has space")}, "name"),
        ("coding", "x", {"README.md": "hi"}, "needs a SKILL.md"),
        ("coding", "x", {"SKILL.md": "no frontmatter"}, "frontmatter"),
        ("coding", "x", {"SKILL.md": skill_md("y")}, "must match"),
        ("coding", "x", {"SKILL.md": skill_md("x", description="")}, "description"),
        ("coding", "x", {"SKILL.md": skill_md("x"), "../escape.md": "x"}, "relative"),
        ("coding", "x", {"SKILL.md": skill_md("x"), "/etc/passwd.md": "x"}, "relative"),
        ("coding", "x", {"SKILL.md": skill_md("x"), ".hidden.md": "x"}, "hidden"),
        ("coding", "x", {"SKILL.md": skill_md("x"), "tool.exe": "x"}, "text files"),
        ("coding", "x", {"SKILL.md": skill_md("x", "y" * 300_000)}, "bytes"),
    ],
)
def test_validation_messages_are_actionable(category, name, files, message) -> None:
    with pytest.raises(SkillError, match=message):
        validate_skill(category, name, files)


def test_validation_accepts_supporting_files() -> None:
    files = validate_skill("coding", "x", {"SKILL.md": skill_md("x"), "./scripts/check.sh": "echo ok"})
    assert set(files) == {"SKILL.md", "scripts/check.sh"}


# ------------------------------------------------------------------ proposals
def test_propose_approve_creates_versions_and_keeps_baseline(store: SkillStore) -> None:
    before = live(store, "coding/git-workflow")
    proposal, diff = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "v2 learned")}, "learned v2")
    assert "-v1 from repo" in diff and "+v2 learned" in diff
    assert live(store, "coding/git-workflow") == before  # nothing live yet

    approved = store.approve(proposal.id, note="lgtm")
    assert approved.status == "approved" and approved.version == 2
    assert "v2 learned" in live(store, "coding/git-workflow")
    history = store.history("coding", "git-workflow")
    assert [(h["version"], h["source"]) for h in history] == [(1, "builtin"), (2, f"proposal:{proposal.id}")]


def test_approve_with_edits_and_reject(store: SkillStore) -> None:
    p1, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "agent text")}, "r")
    store.approve(p1.id, edited_files={"SKILL.md": skill_md("git-workflow", "C's better text")})
    assert "C's better text" in live(store, "coding/git-workflow")
    assert store.history("coding", "git-workflow")[-1]["source"].endswith("(edited)")

    p2, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "worse")}, "r")
    rejected = store.reject(p2.id, note="no")
    assert rejected.status == "rejected" and "worse" not in live(store, "coding/git-workflow")
    with pytest.raises(SkillError, match="not pending"):
        store.approve(p2.id)


def test_new_proposal_supersedes_pending_one_for_same_skill(store: SkillStore) -> None:
    p1, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "a")}, "r")
    p2, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "b")}, "r")
    assert store.get_proposal(p1.id).status == "superseded"
    assert [p.id for p in store.list_proposals(status="pending")] == [p2.id]


def test_no_op_and_reasonless_proposals_are_refused(store: SkillStore) -> None:
    with pytest.raises(SkillError, match="no change"):
        store.propose("coding", "git-workflow", read_folder(store.skills_dir / "coding" / "git-workflow"), "r")
    with pytest.raises(SkillError, match="say why"):
        store.propose("coding", "new-one", {"SKILL.md": skill_md("new-one")}, "  ")


def test_proposal_detail_flags_when_live_changed_underneath(store: SkillStore) -> None:
    proposal, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "agent")}, "r")
    assert store.proposal_detail(proposal.id)["live_changed_since_proposed"] is False
    store.save("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "C edited meanwhile")})
    assert store.proposal_detail(proposal.id)["live_changed_since_proposed"] is True


def test_proposal_ids_are_validated(store: SkillStore) -> None:
    for bad in ["../../etc", "sp-1", "sp-20260101-000000-zzzz"]:
        with pytest.raises(SkillError, match="no proposal"):
            store.get_proposal(bad)


def test_brand_new_skill_proposal(store: SkillStore) -> None:
    files = {"SKILL.md": skill_md("pine-v6"), "templates/strategy.pine": "//@version=6\n"}
    proposal, diff = store.propose("markets", "pine-v6", files, "new skill")
    assert proposal.base_hash is None and "+//@version=6" in diff
    store.approve(proposal.id)
    assert read_folder(store.skills_dir / "markets" / "pine-v6") == files
    assert store.history("markets", "pine-v6")[0]["version"] == 1


# ---------------------------------------------------------- history, rollback
def test_rollback_is_a_new_version(store: SkillStore) -> None:
    store.save("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "v2")})
    store.save("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "v3")})
    version = store.rollback("coding", "git-workflow", 1)
    assert version == 4 and "v1 from repo" in live(store, "coding/git-workflow")
    assert store.history("coding", "git-workflow")[-1]["source"] == "rollback:v1"
    with pytest.raises(SkillError, match="no version 99"):
        store.rollback("coding", "git-workflow", 99)


def test_manual_edit_of_unversioned_skill_records_baseline_first(tmp_path: Path) -> None:
    store = SkillStore(tmp_path / "skills", tmp_path / "store")
    (tmp_path / "skills" / "coding" / "old").mkdir(parents=True)
    (tmp_path / "skills" / "coding" / "old" / "SKILL.md").write_text(skill_md("old", "hand written"))
    store.save("coding", "old", {"SKILL.md": skill_md("old", "new")})
    assert [h["source"] for h in store.history("coding", "old")] == ["baseline", "manual"]
    store.rollback("coding", "old", 1)
    assert "hand written" in live(store, "coding/old")


def test_delete_keeps_history_and_can_be_restored(store: SkillStore) -> None:
    store.delete("coding", "git-workflow")
    assert not (store.skills_dir / "coding" / "git-workflow").exists()
    assert store.sync_builtin()["added"] == []  # deleting a repo skill sticks across restarts
    store.rollback("coding", "git-workflow", 1)
    assert "v1 from repo" in live(store, "coding/git-workflow")


def test_writes_are_atomic_no_leftover_staging_dirs(store: SkillStore) -> None:
    for i in range(3):
        store.save("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", f"rev {i}"), "a.md": str(i)})
    leftovers = [p.name for p in (store.skills_dir / "coding").iterdir() if p.name.startswith(".")]
    assert leftovers == []


# ------------------------------------------------------------ repo built-ins
def test_sync_seeds_once(store: SkillStore, builtin: Path) -> None:
    assert {s["name"] for s in store.list_skills()} == {"git-workflow", "backtest-hygiene"}
    assert store.sync_builtin() == {"added": [], "updated": [], "flagged": []}


def test_repo_update_flows_into_untouched_skill(store: SkillStore, builtin: Path) -> None:
    (builtin / "markets" / "backtest-hygiene" / "SKILL.md").write_text(skill_md("backtest-hygiene", "repo v2"))
    assert store.sync_builtin()["updated"] == ["markets/backtest-hygiene"]
    assert "repo v2" in live(store, "markets/backtest-hygiene")


def test_repo_update_never_clobbers_an_approved_improvement(store: SkillStore, builtin: Path) -> None:
    proposal, _ = store.propose("coding", "git-workflow", {"SKILL.md": skill_md("git-workflow", "agent improved")}, "r")
    store.approve(proposal.id)
    (builtin / "coding" / "git-workflow" / "SKILL.md").write_text(skill_md("git-workflow", "repo v2"))

    assert store.sync_builtin()["flagged"] == ["coding/git-workflow"]
    assert "agent improved" in live(store, "coding/git-workflow")
    entry = next(s for s in store.list_skills() if s["name"] == "git-workflow")
    assert entry["builtin_update_available"] is True

    store.adopt_builtin("coding", "git-workflow")
    assert "repo v2" in live(store, "coding/git-workflow")
    assert store.sync_builtin() == {"added": [], "updated": [], "flagged": []}
    assert next(s for s in store.list_skills() if s["name"] == "git-workflow")["builtin_update_available"] is False


def test_folder_hash_is_order_independent() -> None:
    assert folder_hash({"a": "1", "b": "2"}) == folder_hash({"b": "2", "a": "1"})
    assert folder_hash({"a": "1"}) != folder_hash({"a": "2"})


@pytest.mark.parametrize(("category", "name"), [("..", ".."), ("coding", "../../etc"), ("a/b", "c"), ("", "x")])
def test_every_entry_point_rejects_path_tricks(store: SkillStore, category: str, name: str) -> None:
    for call in (
        lambda: store.get(category, name),
        lambda: store.history(category, name),
        lambda: store.version_files(category, name, 1),
        lambda: store.rollback(category, name, 1),
        lambda: store.delete(category, name),
        lambda: store.adopt_builtin(category, name),
    ):
        with pytest.raises(SkillError):
            call()
