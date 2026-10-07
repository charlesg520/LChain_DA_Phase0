"""Aegra authentication: single-owner bearer token.

Every API call must send `Authorization: Bearer <HQ_API_TOKEN>`. The web UI
(Phase 2) holds the token server-side, so it never reaches the browser.
`make init` generates the token.
"""

from __future__ import annotations

from langgraph_sdk import Auth

from hq_agent.security import AuthError, check_bearer

auth = Auth()


@auth.authenticate
async def authenticate(headers: dict) -> Auth.types.MinimalUserDict:
    # Aegra passes the request headers as a dict; normalize names and bytes defensively.
    normalized = {
        (k.decode() if isinstance(k, bytes) else k).lower(): (v.decode() if isinstance(v, bytes) else v)
        for k, v in headers.items()
    }
    try:
        check_bearer(normalized.get("authorization"))
    except AuthError as exc:
        raise Auth.exceptions.HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return {"identity": "owner", "display_name": "C", "permissions": ["owner"], "is_authenticated": True}
