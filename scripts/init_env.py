"""Fill in secrets in .env without touching values you already set.

Usage: python3 scripts/init_env.py .env
"""

from __future__ import annotations

import os
import re
import secrets
import sys
from pathlib import Path

GENERATED = {
    "HQ_API_TOKEN": lambda: secrets.token_urlsafe(48),
    "POSTGRES_PASSWORD": lambda: secrets.token_urlsafe(32),
    "SEARXNG_SECRET": lambda: secrets.token_hex(32),
    "GIT_GATEWAY_SECRET": lambda: secrets.token_urlsafe(32),
    "HQ_UID": lambda: str(os.getuid()),
    "HQ_GID": lambda: str(os.getgid()),
}


def main(path: Path) -> None:
    text = path.read_text()
    changed = []
    for key, make in GENERATED.items():
        pattern = re.compile(rf"^{key}=(.*)$", re.MULTILINE)
        match = pattern.search(text)
        if match and match.group(1).strip():
            continue
        line = f"{key}={make()}"
        text = pattern.sub(line, text, count=1) if match else text + f"\n{line}\n"
        changed.append(key)
    path.write_text(text)
    path.chmod(0o600)
    print("Generated: " + (", ".join(changed) if changed else "nothing (all set)"))


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else ".env"))
