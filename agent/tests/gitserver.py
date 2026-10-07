"""A tiny stand-in for GitHub: real `git http-backend` behind HTTP basic auth.

- Every repo requires the token for pushes.
- Repos whose owner is "private" also require it for fetches.
"""

from __future__ import annotations

import base64
import contextlib
import os
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class FakeGitHub:
    def __init__(self, root: Path, token: str) -> None:
        self.root = root
        self.token = token
        self.seen_auth: list[tuple[str, bool]] = []  # (path, had valid auth)
        handler = self._handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self) -> FakeGitHub:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()

    def create_repo(self, owner: str, name: str, *, with_commit: bool = True) -> Path:
        bare = self.root / owner / f"{name}.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
        if with_commit:
            work = self.root / "_seed" / owner / name
            subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
            (work / "README.md").write_text(f"# {owner}/{name}\n")
            git = ["git", "-C", str(work), "-c", "user.name=t", "-c", "user.email=t@t"]
            subprocess.run([*git, "add", "."], check=True)
            subprocess.run([*git, "commit", "-q", "-m", "init"], check=True)
            subprocess.run([*git, "push", "-q", str(bare), "main"], check=True)
        return bare

    def branches(self, owner: str, name: str) -> list[str]:
        out = subprocess.run(
            ["git", "--git-dir", str(self.root / owner / f"{name}.git"), "for-each-ref", "--format=%(refname:short)", "refs/heads"],
            check=True, capture_output=True, text=True,
        )
        return sorted(out.stdout.split())

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def _body(self) -> bytes:
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    data = bytearray()
                    while True:
                        size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                        if size == 0:
                            self.rfile.readline()
                            return bytes(data)
                        data += self.rfile.read(size)
                        self.rfile.readline()
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _handle(self) -> None:
                path, _, query = self.path.partition("?")
                expected = "Basic " + base64.b64encode(f"x-access-token:{fake.token}".encode()).decode()
                authed = self.headers.get("Authorization") == expected
                fake.seen_auth.append((path, authed))
                needs_auth = "git-receive-pack" in self.path or path.startswith("/private/")
                body = self._body() if self.command == "POST" else b""
                if needs_auth and not authed:
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="fake"')
                    self.end_headers()
                    return
                env = {
                    **os.environ,
                    "GIT_PROJECT_ROOT": str(fake.root),
                    "GIT_HTTP_EXPORT_ALL": "1",
                    "REQUEST_METHOD": self.command,
                    "PATH_INFO": path,
                    "QUERY_STRING": query,
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": str(len(body)),
                    "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding", ""),
                    "GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
                    "REMOTE_ADDR": "127.0.0.1",
                }
                if authed:
                    env["REMOTE_USER"] = "x-access-token"  # enables receive-pack in http-backend
                out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True, check=False).stdout
                head, _, payload = out.partition(b"\r\n\r\n")
                status = 200
                headers = []
                for line in head.decode().split("\r\n"):
                    key, _, value = line.partition(":")
                    if key.lower() == "status":
                        status = int(value.strip().split()[0])
                    elif key:
                        headers.append((key, value.strip()))
                self.send_response(status)
                for key, value in headers:
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = _handle
            do_POST = _handle

        return Handler


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def run_gateway(config, host: str = "127.0.0.1") -> Iterator[int]:
    """Serve the git gateway with uvicorn in a thread; yields the port."""
    import uvicorn

    from hq_agent.git_gateway import create_app

    port = free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(config), host=host, port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("gateway did not start")
        time.sleep(0.05)
    try:
        yield port
    finally:
        server.should_exit = True
        thread.join(timeout=5)
