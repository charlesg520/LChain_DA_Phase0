"""Owner authentication shared by the Agent Protocol routes (auth.py) and the ops API.

The ops API enforces this itself rather than relying on Aegra's
`enable_custom_route_auth`: in aegra-api 0.6.0 that flag adds the dependency to
routes after FastAPI has already compiled them, so it has no effect (verified in
the Phase 0 boot test: /ops/info answered 200 without a token).
"""

from __future__ import annotations

import hmac
import os

MIN_TOKEN_LENGTH = 32


class AuthError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def check_bearer(authorization: str | None) -> None:
    """Raise AuthError unless `authorization` is `Bearer <HQ_API_TOKEN>`. Fails closed."""
    expected = os.environ.get("HQ_API_TOKEN", "")
    if len(expected) < MIN_TOKEN_LENGTH:
        raise AuthError(503, "Server auth is not configured (HQ_API_TOKEN).")
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise AuthError(401, "Invalid or missing bearer token.")
