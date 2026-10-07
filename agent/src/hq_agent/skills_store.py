"""Skills: live copies, the agent's upgrade proposals, and version history.

Layout (all under HQ_DATA_DIR, so none of it is tracked by git):

    skills/<category>/<name>/SKILL.md        live skills the agent reads at /skills/
    skill-store/proposals/<id>/              proposal.json + files/ (the full proposed folder)
    skill-store/versions/<category>/<name>/  v1/, v2/ ... snapshots + history.jsonl
    skill-store/seed.json                    hashes of what was copied from the repo

How a skill changes:

1. The agent can't write to /skills/ (denied by a filesystem permission). It calls
   `propose_skill` instead, which validates the skill and stores a proposal.
2. C reviews the diff in the ops API / UI and approves (optionally after editing)
   or rejects it. Approving snapshots a new version and swaps it in atomically.
3. Any earlier version can be restored; a rollback is itself a new version, so
   history is never rewritten.

Skills that ship in the repo (`skills/`) are copied in on startup. If you later
change one in the repo, the update flows through automatically unless the live
copy was changed by an approval, in which case it's flagged for you instead of
overwriting the agent's improvements.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
_TEXT_SUFFIXES = {".md", ".txt", ".py", ".sh", ".js", ".ts", ".json", ".yaml", ".yml", ".toml", ".pine", ".sql", ".csv"}
MAX_FILES = 20
MAX_TOTAL_BYTES = 256 * 1024
MAX_DESCRIPTION = 1024


class SkillError(ValueError):
    """Validation or state error; the message is meant for the agent or C to read."""


def frontmatter(text: str) -> dict[str, str]:
    match = _FRONTMATTER.match(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() and not key.startswith((" ", "\t")):
            fields[key.strip()] = value.strip().strip("\"'")
    return fields


def read_folder(folder: Path) -> dict[str, str]:
    if not folder.is_dir():
        return {}
    return {
        p.relative_to(folder).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(folder.rglob("*"))
        if p.is_file()
    }


def folder_hash(files: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode() + b"\0" + files[rel].encode() + b"\0")
    return digest.hexdigest()[:16]


def write_folder_atomic(target: Path, files: dict[str, str]) -> None:
    """Write a whole skill folder so readers never see a half-written skill."""
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".{target.name}.new-{secrets.token_hex(4)}"
    for rel, content in files.items():
        dest = staging / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
    old = None
    if target.exists():
        old = target.parent / f".{target.name}.old-{secrets.token_hex(4)}"
        target.rename(old)
    staging.rename(target)
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)


def validate_skill(category: str, name: str, files: dict[str, str]) -> dict[str, str]:
    """Return the files (normalized) or raise SkillError with a fixable message."""
    if not SLUG.match(category or ""):
        raise SkillError(f"category {category!r}: use lowercase letters, digits and hyphens (e.g. 'coding', 'markets')")
    if not SLUG.match(name or ""):
        raise SkillError(f"name {name!r}: use lowercase letters, digits and hyphens, at most 64 characters")
    normalized: dict[str, str] = {}
    for raw, content in files.items():
        cleaned = raw.strip()
        rel = PurePosixPath(cleaned[2:] if cleaned.startswith("./") else cleaned)
        if rel.is_absolute() or ".." in rel.parts or not rel.parts or any(part.startswith(".") for part in rel.parts):
            raise SkillError(f"file path {raw!r} must be relative to the skill folder, without '..' or hidden parts")
        if rel.suffix.lower() not in _TEXT_SUFFIXES:
            raise SkillError(f"file {raw!r}: only text files are allowed ({', '.join(sorted(_TEXT_SUFFIXES))})")
        normalized[rel.as_posix()] = content
    if "SKILL.md" not in normalized:
        raise SkillError("a skill needs a SKILL.md")
    if len(normalized) > MAX_FILES:
        raise SkillError(f"too many files ({len(normalized)}); keep a skill under {MAX_FILES}")
    size = sum(len(c.encode()) for c in normalized.values())
    if size > MAX_TOTAL_BYTES:
        raise SkillError(f"skill is {size} bytes; keep it under {MAX_TOTAL_BYTES} (move bulk reference data elsewhere)")
    meta = frontmatter(normalized["SKILL.md"])
    if not meta:
        raise SkillError("SKILL.md must start with YAML frontmatter:\n---\nname: <name>\ndescription: <when to use it>\n---")
    if meta.get("name") != name:
        raise SkillError(f"frontmatter name is {meta.get('name')!r} but the skill folder is {name!r}; they must match")
    description = meta.get("description", "")
    if not description:
        raise SkillError("frontmatter needs a description saying what the skill does and when to use it")
    if len(description) > MAX_DESCRIPTION:
        raise SkillError(f"description is {len(description)} characters; keep it under {MAX_DESCRIPTION}")
    return normalized


def unified_diff(old: dict[str, str], new: dict[str, str]) -> str:
    chunks = []
    for rel in sorted(set(old) | set(new)):
        a, b = old.get(rel), new.get(rel)
        if a == b:
            continue
        chunks.extend(
            difflib.unified_diff(
                (a or "").splitlines(keepends=True),
                (b or "").splitlines(keepends=True),
                fromfile=f"a/{rel}" if a is not None else "/dev/null",
                tofile=f"b/{rel}" if b is not None else "/dev/null",
            )
        )
    return "".join(chunks)


@dataclass
class Proposal:
    id: str
    category: str
    name: str
    reason: str
    status: str  # pending | approved | rejected | superseded
    created_at: float
    proposed_by: str
    base_hash: str | None  # live hash when proposed; None for a new skill
    decided_at: float | None = None
    decision_note: str | None = None
    version: int | None = None  # version created on approval

    @property
    def key(self) -> str:
        return f"{self.category}/{self.name}"


class SkillStore:
    def __init__(self, skills_dir: Path, store_dir: Path, builtin_dir: Path | None = None) -> None:
        self.skills_dir = skills_dir
        self.store_dir = store_dir
        self.builtin_dir = builtin_dir
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ paths
    @property
    def proposals_dir(self) -> Path:
        return self.store_dir / "proposals"

    @staticmethod
    def _check(category: str, name: str) -> None:
        # Every path below is built from these; never let '..' or '/' through.
        if not SLUG.match(category or "") or not SLUG.match(name or ""):
            raise SkillError(f"no skill {category}/{name}")

    def _live(self, category: str, name: str) -> Path:
        self._check(category, name)
        return self.skills_dir / category / name

    def _versions(self, category: str, name: str) -> Path:
        self._check(category, name)
        return self.store_dir / "versions" / category / name

    def _seed_path(self) -> Path:
        return self.store_dir / "seed.json"

    # ------------------------------------------------------------------ reads
    def list_skills(self) -> list[dict[str, Any]]:
        seed = self._load_seed()
        skills = []
        for skill_md in sorted(self.skills_dir.glob("*/*/SKILL.md")):
            category, name = skill_md.parent.parent.name, skill_md.parent.name
            meta = frontmatter(skill_md.read_text(encoding="utf-8"))
            history = self.history_versions(category, name)
            entry = seed.get(f"{category}/{name}", {})
            skills.append(
                {
                    "category": category,
                    "name": meta.get("name", name),
                    "description": meta.get("description", ""),
                    "path": f"/skills/{category}/{name}/SKILL.md",
                    "version": history[-1]["version"] if history else None,
                    "updated_at": history[-1]["ts"] if history else None,
                    "builtin": bool(entry),
                    "builtin_update_available": bool(entry.get("update_available")),
                }
            )
        return skills

    def get(self, category: str, name: str) -> dict[str, Any]:
        files = read_folder(self._live(category, name))
        if not files:
            raise SkillError(f"no skill {category}/{name}")
        return {"category": category, "name": name, "files": files, "hash": folder_hash(files), "history": self.history(category, name)}

    def history(self, category: str, name: str) -> list[dict[str, Any]]:
        path = self._versions(category, name) / "history.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def version_files(self, category: str, name: str, version: int) -> dict[str, str]:
        files = read_folder(self._versions(category, name) / f"v{version}")
        if not files:
            raise SkillError(f"{category}/{name} has no version {version}")
        return files

    # ------------------------------------------------------------- versioning
    def _record_version(self, category: str, name: str, files: dict[str, str], source: str, note: str = "") -> int:
        numbered = [h["version"] for h in self.history(category, name) if h.get("version") is not None]
        version = max(numbered, default=0) + 1
        vdir = self._versions(category, name)
        write_folder_atomic(vdir / f"v{version}", files)
        with (vdir / "history.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"version": version, "ts": time.time(), "source": source, "note": note, "hash": folder_hash(files)}) + "\n")
        return version

    def _ensure_baseline(self, category: str, name: str) -> None:
        """Snapshot the live copy before the first change, so it can always be rolled back to."""
        live = read_folder(self._live(category, name))
        history = self.history_versions(category, name)
        if live and (not history or history[-1]["hash"] != folder_hash(live)):
            self._record_version(category, name, live, source="baseline", note="live copy before this change")

    def _publish(self, category: str, name: str, files: dict[str, str], source: str, note: str = "") -> int:
        with self._lock:
            self._ensure_baseline(category, name)
            write_folder_atomic(self._live(category, name), files)
            return self._record_version(category, name, files, source=source, note=note)

    # --------------------------------------------------------------- proposals
    def propose(
        self, category: str, name: str, files: dict[str, str], reason: str, *, proposed_by: str = "agent"
    ) -> tuple[Proposal, str]:
        files = validate_skill(category, name, files)
        if not reason.strip():
            raise SkillError("say why: what did you learn that makes this skill better?")
        live = read_folder(self._live(category, name))
        if live == files:
            raise SkillError(f"no change: {category}/{name} already has exactly this content")
        with self._lock:
            for existing in self.list_proposals(status="pending"):
                if existing.key == f"{category}/{name}":
                    self._update_proposal(existing, status="superseded", decided_at=time.time(), decision_note="replaced by a newer proposal")
            proposal = Proposal(
                id=f"sp-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}",
                category=category,
                name=name,
                reason=reason.strip(),
                status="pending",
                created_at=time.time(),
                proposed_by=proposed_by,
                base_hash=folder_hash(live) if live else None,
            )
            pdir = self.proposals_dir / proposal.id
            write_folder_atomic(pdir / "files", files)
            (pdir / "proposal.json").write_text(json.dumps(proposal.__dict__, indent=2), encoding="utf-8")
        return proposal, unified_diff(live, files)

    def _update_proposal(self, proposal: Proposal, **changes: Any) -> Proposal:
        for key, value in changes.items():
            setattr(proposal, key, value)
        (self.proposals_dir / proposal.id / "proposal.json").write_text(json.dumps(proposal.__dict__, indent=2), encoding="utf-8")
        return proposal

    def get_proposal(self, proposal_id: str) -> Proposal:
        if not re.fullmatch(r"sp-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}", proposal_id):
            raise SkillError(f"no proposal {proposal_id}")
        path = self.proposals_dir / proposal_id / "proposal.json"
        if not path.exists():
            raise SkillError(f"no proposal {proposal_id}")
        return Proposal(**json.loads(path.read_text(encoding="utf-8")))

    def proposal_files(self, proposal_id: str) -> dict[str, str]:
        return read_folder(self.proposals_dir / self.get_proposal(proposal_id).id / "files")

    def proposal_detail(self, proposal_id: str) -> dict[str, Any]:
        proposal = self.get_proposal(proposal_id)
        files = self.proposal_files(proposal_id)
        live = read_folder(self._live(proposal.category, proposal.name))
        stale = proposal.status == "pending" and (folder_hash(live) if live else None) != proposal.base_hash
        return {**proposal.__dict__, "files": files, "diff": unified_diff(live, files), "live_changed_since_proposed": stale}

    def list_proposals(self, status: str | None = None) -> list[Proposal]:
        if not self.proposals_dir.exists():
            return []
        proposals = []
        for path in sorted(self.proposals_dir.glob("*/proposal.json"), reverse=True):
            proposal = Proposal(**json.loads(path.read_text(encoding="utf-8")))
            if status is None or proposal.status == status:
                proposals.append(proposal)
        return proposals

    def approve(self, proposal_id: str, *, edited_files: dict[str, str] | None = None, note: str = "") -> Proposal:
        with self._lock:
            proposal = self.get_proposal(proposal_id)
            if proposal.status != "pending":
                raise SkillError(f"{proposal_id} is {proposal.status}, not pending")
            files = validate_skill(proposal.category, proposal.name, edited_files) if edited_files else self.proposal_files(proposal_id)
            source = f"proposal:{proposal.id}" + (" (edited)" if edited_files else "")
            version = self._publish(proposal.category, proposal.name, files, source=source, note=proposal.reason)
            return self._update_proposal(proposal, status="approved", decided_at=time.time(), decision_note=note or None, version=version)

    def reject(self, proposal_id: str, *, note: str = "") -> Proposal:
        with self._lock:
            proposal = self.get_proposal(proposal_id)
            if proposal.status != "pending":
                raise SkillError(f"{proposal_id} is {proposal.status}, not pending")
            return self._update_proposal(proposal, status="rejected", decided_at=time.time(), decision_note=note or None)

    # ------------------------------------------------------- direct edits by C
    def save(self, category: str, name: str, files: dict[str, str], *, note: str = "") -> int:
        files = validate_skill(category, name, files)
        return self._publish(category, name, files, source="manual", note=note)

    def rollback(self, category: str, name: str, version: int) -> int:
        """Restore an earlier version (also how a deleted skill comes back)."""
        files = self.version_files(category, name, version)
        with self._lock:
            new_version = self._publish(category, name, files, source=f"rollback:v{version}")
            seed = self._load_seed()
            if seed.get(f"{category}/{name}", {}).pop("removed", None):
                self._save_seed(seed)
            return new_version

    def delete(self, category: str, name: str) -> None:
        """Remove a live skill. Its history stays, so it can be restored with rollback."""
        with self._lock:
            live = self._live(category, name)
            if not live.exists():
                raise SkillError(f"no skill {category}/{name}")
            self._ensure_baseline(category, name)
            shutil.rmtree(live)
            with (self._versions(category, name) / "history.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"version": None, "ts": time.time(), "source": "deleted", "note": "", "hash": None}) + "\n")
            seed = self._load_seed()
            if f"{category}/{name}" in seed:
                seed[f"{category}/{name}"]["removed"] = True
                self._save_seed(seed)

    def history_versions(self, category: str, name: str) -> list[dict[str, Any]]:
        return [h for h in self.history(category, name) if h.get("version") is not None]

    # --------------------------------------------------------- repo built-ins
    def _load_seed(self) -> dict[str, Any]:
        try:
            return json.loads(self._seed_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_seed(self, seed: dict[str, Any]) -> None:
        self._seed_path().parent.mkdir(parents=True, exist_ok=True)
        self._seed_path().write_text(json.dumps(seed, indent=2, sort_keys=True), encoding="utf-8")

    def sync_builtin(self) -> dict[str, list[str]]:
        """Copy repo skills in; update untouched ones; flag ones the agent has improved."""
        report: dict[str, list[str]] = {"added": [], "updated": [], "flagged": []}
        if self.builtin_dir is None or not self.builtin_dir.is_dir():
            return report
        with self._lock:
            seed = self._load_seed()
            for skill_md in sorted(self.builtin_dir.glob("*/*/SKILL.md")):
                category, name = skill_md.parent.parent.name, skill_md.parent.name
                key = f"{category}/{name}"
                builtin = read_folder(skill_md.parent)
                b_hash = folder_hash(builtin)
                entry = seed.get(key)
                live = read_folder(self._live(category, name))
                if entry is None:
                    if not live:
                        self._publish(category, name, builtin, source="builtin")
                        report["added"].append(key)
                    seed[key] = {"hash": b_hash}
                    continue
                if entry.get("removed") or b_hash == entry["hash"]:
                    entry.pop("update_available", None)
                    continue
                if live and folder_hash(live) == entry["hash"]:
                    self._publish(category, name, builtin, source="builtin-update")
                    seed[key] = {"hash": b_hash}
                    report["updated"].append(key)
                else:
                    entry["update_available"] = b_hash
                    report["flagged"].append(key)
            self._save_seed(seed)
        return report

    def adopt_builtin(self, category: str, name: str) -> int:
        """Replace the live skill with the repo's version (C's call when both changed)."""
        self._check(category, name)
        if self.builtin_dir is None:
            raise SkillError("no built-in skills directory configured")
        builtin = read_folder(self.builtin_dir / category / name)
        if not builtin:
            raise SkillError(f"the repo has no skill {category}/{name}")
        with self._lock:
            version = self._publish(category, name, builtin, source="builtin-adopted")
            seed = self._load_seed()
            seed[f"{category}/{name}"] = {"hash": folder_hash(builtin)}
            self._save_seed(seed)
            return version
