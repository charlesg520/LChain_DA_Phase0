"""Read-only file browsing for the web UI, over the same layout the agent sees:

    /workspace/...  the project's Docker sandbox
    /memories/...   long-term memory files
    /skills/...     live skills

Plus memory editing (the one place the UI writes files directly).
"""

from __future__ import annotations

import base64
import mimetypes
import posixpath
from pathlib import Path
from typing import Any

from hq_agent.config import Settings

MAX_VIEW_BYTES = 20 * 1024 * 1024
MAX_MEMORY_BYTES = 256 * 1024
MEMORY_SUFFIXES = {".md", ".txt"}
_TEXT_MIMES = {"application/json", "application/x-ndjson", "application/xml", "image/svg+xml", "application/toml", "application/x-sh", "application/x-yaml"}
_EXTRA_MIMES = {
    ".md": "text/markdown",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".sh": "text/x-sh",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/x-toml",
    ".pine": "text/x-pine",
    ".jsonl": "application/x-ndjson",
    ".lock": "text/plain",
    ".env": "text/plain",
}
_TEXT_NAMES = {"Makefile", "Dockerfile", "LICENSE", "README", ".gitignore", ".dockerignore", ".env.example"}


class BrowseError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def mime_for(path: str) -> str:
    name = posixpath.basename(path)
    if name in _TEXT_NAMES:
        return "text/plain"
    ext = posixpath.splitext(name)[1].lower()
    return _EXTRA_MIMES.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def _is_text(mime: str, data: bytes) -> bool:
    if mime.startswith("text/") or mime in _TEXT_MIMES:
        return True
    head = data[:8192]
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return mime == "application/octet-stream"


def clean(path: str) -> str:
    raw = (path or "/").replace("\\", "/")
    if ".." in raw.split("/"):
        raise BrowseError(400, "path must not contain ..")
    # POSIX keeps a leading "//", so strip slashes before normalizing
    p = posixpath.normpath("/" + raw.lstrip("/"))
    if ".." in p.split("/"):
        raise BrowseError(400, "path must not contain ..")
    return p


def _local_root(settings: Settings, top: str) -> Path:
    return settings.memories_dir if top == "memories" else settings.skills_dir


def _resolve_local(settings: Settings, path: str) -> Path:
    parts = path.strip("/").split("/", 1)
    root = _local_root(settings, parts[0]).resolve()
    target = (root / (parts[1] if len(parts) > 1 else "")).resolve()
    if target != root and root not in target.parents:
        raise BrowseError(400, "path escapes its root")
    return target


def _entry(path: str, name: str, kind: str, size: int, modified_ms: int) -> dict[str, Any]:
    full = posixpath.join(path, name)
    return {
        "name": name,
        "path": full,
        "type": kind,
        "size": size if kind == "file" else 0,
        "mime": "inode/directory" if kind == "dir" else mime_for(name),
        "modified_at": modified_ms,
    }


def list_dir(settings: Settings, sandbox: Any, project: str, raw_path: str) -> dict[str, Any]:
    path = clean(raw_path)
    if path == "/":
        entries = [_entry("/", n, "dir", 0, 0) for n in ("workspace", "memories", "skills")]
        return {"path": "/", "entries": entries}
    top = path.strip("/").split("/", 1)[0]
    if top == "workspace":
        if sandbox is None:
            raise BrowseError(409, "sandboxes are disabled (SANDBOX_ENABLED=false)")
        try:
            raw = sandbox.list_dir(project, path)
        except FileNotFoundError as exc:
            raise BrowseError(404, str(exc)) from exc
        except RuntimeError as exc:
            raise BrowseError(503, str(exc)) from exc
        return {"path": path, "entries": [_entry(path, e["name"], e["type"], e["size"], e["modified_at"]) for e in raw]}
    if top in ("memories", "skills"):
        target = _resolve_local(settings, path)
        if not target.is_dir():
            raise BrowseError(404, f"no such directory: {path}")
        entries = []
        for child in sorted(target.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
            if child.name.startswith(".") and child.name not in _TEXT_NAMES:
                continue
            st = child.stat()
            entries.append(_entry(path, child.name, "dir" if child.is_dir() else "file", st.st_size, int(st.st_mtime * 1000)))
        return {"path": path, "entries": entries[:1000]}
    raise BrowseError(404, f"no such directory: {path}")


def read_file(settings: Settings, sandbox: Any, project: str, raw_path: str) -> dict[str, Any]:
    path = clean(raw_path)
    top = path.strip("/").split("/", 1)[0]
    if top == "workspace":
        if sandbox is None:
            raise BrowseError(409, "sandboxes are disabled (SANDBOX_ENABLED=false)")
        try:
            data = sandbox.read_bytes(project, path, MAX_VIEW_BYTES)
        except FileNotFoundError as exc:
            raise BrowseError(404, str(exc)) from exc
        except IsADirectoryError as exc:
            raise BrowseError(400, f"{path} is a directory") from exc
        except ValueError as exc:
            raise BrowseError(413, str(exc)) from exc
        except RuntimeError as exc:
            raise BrowseError(503, str(exc)) from exc
    elif top in ("memories", "skills"):
        target = _resolve_local(settings, path)
        if not target.is_file():
            raise BrowseError(404, f"no such file: {path}")
        if target.stat().st_size > MAX_VIEW_BYTES:
            raise BrowseError(413, f"{path} is larger than the viewer limit")
        data = target.read_bytes()
    else:
        raise BrowseError(404, f"no such file: {path}")
    mime = mime_for(path)
    text = _is_text(mime, data)
    if text and mime == "application/octet-stream":
        mime = "text/plain"
    return {
        "path": path,
        "content": data.decode("utf-8", errors="replace") if text else base64.b64encode(data).decode(),
        "encoding": "utf8" if text else "base64",
        "mime": mime,
        "size": len(data),
    }


# ------------------------------------------------------------------ memory
def memory_files(settings: Settings, limit: int = 50) -> list[dict[str, str]]:
    root = settings.memories_dir
    if not root.exists():
        return []
    files = []
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in MEMORY_SUFFIXES or any(part.startswith(".") for part in f.relative_to(root).parts):
            continue
        if f.stat().st_size > MAX_MEMORY_BYTES:
            continue
        files.append({"path": "/" + f.relative_to(root).as_posix(), "content": f.read_text(encoding="utf-8", errors="replace")})
    # AGENTS.md (loaded into every conversation) first
    files.sort(key=lambda x: (x["path"] != "/AGENTS.md", x["path"]))
    return files[:limit]


def save_memory(settings: Settings, raw_path: str, content: str) -> str:
    path = clean(raw_path)
    rel = path.strip("/")
    if rel.startswith("memories/"):
        rel = rel[len("memories/") :]
    if not rel or posixpath.splitext(rel)[1].lower() not in MEMORY_SUFFIXES:
        raise BrowseError(400, "memory files must be .md or .txt")
    if any(part.startswith(".") for part in rel.split("/")):
        raise BrowseError(400, "hidden paths are not allowed")
    if len(content.encode("utf-8")) > MAX_MEMORY_BYTES:
        raise BrowseError(413, f"memory files are limited to {MAX_MEMORY_BYTES // 1024} KB")
    root = settings.memories_dir.resolve()
    target = (root / rel).resolve()
    if root not in target.parents:
        raise BrowseError(400, "path escapes the memories folder")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(target)
    return "/" + rel
