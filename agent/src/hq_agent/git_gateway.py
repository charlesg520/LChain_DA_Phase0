"""Git gateway: lets sandboxes clone and push without ever holding a credential.

Sandboxes are configured (via GIT_CONFIG_* env vars, see docker_sandbox.py) so
that `https://github.com/...` and `git@github.com:...` URLs are rewritten to
`http://git-gateway:8080/github.com/...`. This service speaks git's smart-HTTP
protocol on one side and GitHub on the other:

- Fetch/clone: allowed for any repo. The token is added only for repos on the
  allowlist; everything else is fetched anonymously (public repos still work).
- Push: only to allowlisted repos, and only to branches under the push prefix
  (default `hq/`). The ref names are read from the start of the push stream, so
  a push to `main` is refused before a single byte reaches GitHub, and the
  client sees a normal `! [remote rejected]` line with the reason.
- Every request is appended to an audit log (JSONL) that the ops API serves.

The token never enters a sandbox. Anything inside a sandbox can be read by the
code the model writes (env vars, /proc, git hooks), so a token in there would be
a token the model could leak. Here the worst a compromised sandbox can do is
push an `hq/*` branch to a repo you already allowed.

Run: `python -m hq_agent.git_gateway` (its own container in compose.yaml).
"""

from __future__ import annotations

import base64
import contextlib
import fnmatch
import hmac
import json
import logging
import os
import re
import threading
import time
import zlib
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.routing import Route

logger = logging.getLogger("hq.git_gateway")

SECRET_HEADER = "x-hq-gateway"
SERVICES = ("git-upload-pack", "git-receive-pack")
_PATH = re.compile(
    r"^/(?P<host>[A-Za-z0-9.-]+)/(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<repo>[A-Za-z0-9._-]{1,100}?)(?:\.git)?"
    r"/(?P<endpoint>info/refs|git-upload-pack|git-receive-pack)$"
)
_ZERO_OID = re.compile(r"^0+$")
# Request headers git sends that GitHub needs. Everything else (incl. our secret) is dropped.
_FORWARD_REQUEST_HEADERS = ("content-type", "accept", "accept-encoding", "content-encoding", "git-protocol", "user-agent")
_FORWARD_RESPONSE_HEADERS = ("content-type", "content-encoding", "cache-control", "expires", "pragma", "location")
_MAX_COMMAND_BYTES = 1 << 20  # ref list of a push; the pack after it is streamed, never buffered
_AUDIT_ROTATE_BYTES = 5 << 20


@dataclass(frozen=True)
class GatewayConfig:
    secret: str
    tokens: dict[str, str] = field(default_factory=dict)  # host -> token
    allowed_repos: tuple[str, ...] = ()  # "owner/repo" patterns, case-insensitive, fnmatch
    push_prefix: str = "hq/"
    upstreams: dict[str, str] = field(default_factory=dict)  # host -> base URL (tests point this at a local server)
    audit_path: Path | None = None

    @classmethod
    def from_env(cls) -> GatewayConfig:
        from hq_agent.config import parse_host_map

        tokens = {}
        if token := os.environ.get("GIT_GATEWAY_GITHUB_TOKEN", "").strip():
            tokens["github.com"] = token
        audit = os.environ.get("GIT_GATEWAY_AUDIT", "/data/audit/git-gateway.jsonl").strip()
        return cls(
            secret=os.environ.get("GIT_GATEWAY_SECRET", "").strip(),
            tokens=tokens,
            allowed_repos=tuple(
                p.strip().lower() for p in os.environ.get("GIT_GATEWAY_ALLOWED_REPOS", "").split(",") if p.strip()
            ),
            push_prefix=os.environ.get("GIT_GATEWAY_PUSH_PREFIX", "hq/").strip() or "hq/",
            upstreams=parse_host_map(os.environ.get("GIT_GATEWAY_UPSTREAMS", "")),
            audit_path=Path(audit) if audit else None,
        )

    @property
    def hosts(self) -> set[str]:
        return {"github.com", *self.tokens, *self.upstreams}

    def upstream_base(self, host: str) -> str:
        return self.upstreams.get(host, f"https://{host}").rstrip("/")

    def repo_allowed(self, owner: str, repo: str) -> bool:
        name = f"{owner}/{repo}".lower()
        return any(fnmatch.fnmatchcase(name, pattern) for pattern in self.allowed_repos)


# --------------------------------------------------------------------- pkt-line
def pkt(data: bytes) -> bytes:
    return f"{len(data) + 4:04x}".encode() + data


@dataclass
class PushCommands:
    commands: list[tuple[str, str, str]]  # (old_oid, new_oid, ref)
    capabilities: set[str]


class ProtocolError(Exception):
    pass


def parse_push_commands(buf: bytes) -> PushCommands | None:
    """Parse the command list at the start of a receive-pack request.

    Returns None while the buffer doesn't yet hold the terminating flush-pkt.
    """
    pos, commands, caps = 0, [], set()
    while True:
        if len(buf) - pos < 4:
            return None
        try:
            length = int(buf[pos : pos + 4], 16)
        except ValueError as exc:
            raise ProtocolError("malformed pkt-line") from exc
        if length == 0:  # flush-pkt: end of the command list
            return PushCommands(commands, caps)
        if length < 4:
            raise ProtocolError("unexpected special pkt-line in command list")
        if len(buf) - pos < length:
            return None
        line = buf[pos + 4 : pos + length]
        pos += length
        if b"\0" in line:
            line, _, raw_caps = line.partition(b"\0")
            caps.update(raw_caps.decode(errors="replace").split())
        text = line.decode(errors="replace").rstrip("\n")
        if text.startswith("shallow "):
            continue
        if text.startswith("push-cert"):
            raise ProtocolError("signed pushes are not supported by the HQ gateway")
        parts = text.split(" ")
        if len(parts) != 3:
            raise ProtocolError(f"unexpected command line: {text[:120]!r}")
        commands.append((parts[0], parts[1], parts[2]))


def rejection_report(push: PushCommands, reasons: dict[str, str], banner: str) -> bytes:
    """A receive-pack result that makes git print `! [remote rejected] <ref> (<reason>)`."""
    report = pkt(b"unpack ok\n")
    for _, _, ref in push.commands:
        report += pkt(f"ng {ref} {reasons.get(ref, 'rejected with the rest of this push')}\n".encode())
    report += b"0000"
    if push.capabilities & {"side-band-64k", "side-band"}:
        return pkt(b"\x02" + banner.encode() + b"\n") + pkt(b"\x01" + report) + b"0000"
    return report


# ------------------------------------------------------------------------ audit
class AuditLog:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._lock = threading.Lock()

    def write(self, **event: Any) -> None:
        event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **event}
        logger.info("git %s", json.dumps(event))
        if self.path is None:
            return
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size > _AUDIT_ROTATE_BYTES:
                    self.path.replace(self.path.with_suffix(self.path.suffix + ".1"))
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(event) + "\n")
        except OSError as exc:  # never fail a git operation because the log disk is unhappy
            logger.warning("audit write failed: %s", exc)


def read_audit(path: Path, limit: int = 100) -> list[dict[str, Any]]:
    """Newest-first tail of the audit log, for the ops API."""
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    events = []
    for line in reversed(lines):
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


# ---------------------------------------------------------------------- service
def create_app(config: GatewayConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> Starlette:
    audit = AuditLog(config.audit_path)
    client = httpx.AsyncClient(
        transport=transport,
        follow_redirects=False,
        timeout=httpx.Timeout(connect=15, read=None, write=None, pool=15),
    )

    def deny(status: int, message: str, **event: Any) -> PlainTextResponse:
        audit.write(decision="denied", status=status, reason=message, **event)
        return PlainTextResponse(f"HQ git gateway: {message}\n", status_code=status)

    async def healthz(_: Request) -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "secret_configured": bool(config.secret),
                "token_configured": sorted(config.tokens),
                "hosts": sorted(config.hosts),
                "allowed_repos": list(config.allowed_repos),
                "push_prefix": config.push_prefix,
            }
        )

    async def git(request: Request) -> Response:
        client_ip = request.client.host if request.client else None
        if not config.secret:
            return deny(503, "GIT_GATEWAY_SECRET is not configured", client=client_ip)
        if not hmac.compare_digest(request.headers.get(SECRET_HEADER, "").encode(), config.secret.encode()):
            # 403, not 401: a 401 makes git prompt for a username, which hides the real problem.
            return deny(403, "missing or wrong gateway secret", client=client_ip, path=request.url.path)

        match = _PATH.match(request.url.path)
        if not match:
            return deny(404, "not a smart-HTTP git path", client=client_ip, path=request.url.path)
        host, owner, repo, endpoint = match["host"], match["owner"], match["repo"], match["endpoint"]
        if not repo.strip("."):
            return deny(404, "not a repository name", client=client_ip, path=request.url.path)
        event: dict[str, Any] = {"client": client_ip, "host": host, "repo": f"{owner}/{repo}"}
        if host not in config.hosts:
            return deny(404, f"host {host} is not configured", **event)

        if endpoint == "info/refs":
            if request.method != "GET":
                return deny(405, "method not allowed", **event)
            service = request.query_params.get("service", "")
            if service not in SERVICES:
                return deny(403, "only the smart-HTTP protocol is supported", **event)
        else:
            if request.method != "POST":
                return deny(405, "method not allowed", **event)
            service = endpoint
        event["service"] = service

        allowed = config.repo_allowed(owner, repo)
        if service == "git-receive-pack" and not allowed:
            return deny(403, f"pushes to {owner}/{repo} are not allowed (add it to GIT_GATEWAY_ALLOWED_REPOS)", **event)

        headers = {k: v for k, v in request.headers.items() if k.lower() in _FORWARD_REQUEST_HEADERS}
        headers.setdefault("accept-encoding", "identity")
        token = config.tokens.get(host) if allowed else None
        if token:
            headers["authorization"] = "Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()
        event["authenticated"] = bool(token)

        body: AsyncIterator[bytes] | None = None
        if request.method == "POST":
            chunks = request.stream().__aiter__()
            prefix = b""
            if service == "git-receive-pack":
                try:
                    prefix, push = await _read_push_commands(chunks, gzipped="gzip" in headers.get("content-encoding", ""))
                except ProtocolError as exc:
                    return deny(400, str(exc), **event)
                event["refs"] = [ref for _, _, ref in push.commands]
                wanted = f"refs/heads/{config.push_prefix}"
                bad = {ref: f"HQ only pushes branches under {config.push_prefix}" for _, _, ref in push.commands if not ref.startswith(wanted)}
                if bad:
                    async for _ in chunks:  # drain the pack so the client reads our answer, not a broken pipe
                        pass
                    audit.write(decision="denied", status=200, reason="ref outside push prefix", **event)
                    return Response(
                        rejection_report(push, bad, f"HQ git gateway: refused; push to an {config.push_prefix}<name> branch"),
                        media_type="application/x-git-receive-pack-result",
                        headers={"cache-control": "no-cache"},
                    )
                event["deletes"] = [ref for _, new, ref in push.commands if _ZERO_OID.match(new)]
            body = _replay(prefix, chunks)

        url = f"{config.upstream_base(host)}/{owner}/{repo}.git/{endpoint}"
        if request.url.query:
            url += f"?{request.url.query}"
        try:
            upstream = await client.send(client.build_request(request.method, url, headers=headers, content=body), stream=True)
        except httpx.HTTPError as exc:
            audit.write(decision="error", status=502, reason=str(exc), **event)
            return PlainTextResponse(f"HQ git gateway: upstream error: {exc}\n", status_code=502)

        if upstream.status_code == 401:
            await upstream.aclose()
            if token:
                return deny(403, "GitHub rejected the gateway token (expired, or it lacks access to this repo)", **event)
            if allowed:
                return deny(403, f"no token configured for {host} (set GIT_GATEWAY_GITHUB_TOKEN)", **event)
            return deny(
                403, f"{owner}/{repo} is private or doesn't exist, and it's not in GIT_GATEWAY_ALLOWED_REPOS", **event
            )
        audit.write(decision="forwarded", status=upstream.status_code, **event)
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            headers={k: v for k, v in upstream.headers.items() if k.lower() in _FORWARD_RESPONSE_HEADERS},
            background=BackgroundTask(upstream.aclose),
        )

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        yield
        await client.aclose()

    methods = ["GET", "POST", "PUT", "DELETE", "PATCH"]
    app = Starlette(
        routes=[Route("/healthz", healthz, methods=["GET"]), Route("/{path:path}", git, methods=methods)],
        lifespan=lifespan,
    )
    app.state.audit = audit
    return app


async def _read_push_commands(chunks: AsyncIterator[bytes], *, gzipped: bool) -> tuple[bytes, PushCommands]:
    """Read just enough of a push to see its ref updates. Returns the raw bytes consumed."""
    raw = bytearray()
    plain = bytearray()
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS) if gzipped else None
    while True:
        try:
            chunk = await chunks.__anext__()
        except StopAsyncIteration:
            parsed = parse_push_commands(bytes(plain))
            if parsed is None:
                raise ProtocolError("push request ended before its command list did") from None
            return bytes(raw), parsed
        raw += chunk
        if inflater:
            # Bounded: a tiny gzip bomb must not balloon in memory before the size check.
            budget = _MAX_COMMAND_BYTES + 1 - len(plain)
            plain += inflater.decompress(inflater.unconsumed_tail + chunk, max(budget, 1))
        else:
            plain += chunk
        parsed = parse_push_commands(bytes(plain))
        if parsed is not None:
            return bytes(raw), parsed
        if len(plain) > _MAX_COMMAND_BYTES:
            raise ProtocolError("push command list is too large")


async def _replay(prefix: bytes, rest: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    if prefix:
        yield prefix
    async for chunk in rest:
        yield chunk


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = GatewayConfig.from_env()
    if not config.secret:
        logger.error("GIT_GATEWAY_SECRET is empty: every request will be refused (run `make init`)")
    if not config.tokens:
        logger.warning("No GIT_GATEWAY_GITHUB_TOKEN: clones of public repos work, private repos and pushes won't")
    logger.info("allowed repos: %s; push prefix: %s", ", ".join(config.allowed_repos) or "(none)", config.push_prefix)
    uvicorn.run(create_app(config), host="0.0.0.0", port=int(os.environ.get("GIT_GATEWAY_PORT", "8080")), log_level="warning")


if __name__ == "__main__":
    main()
