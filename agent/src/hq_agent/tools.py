"""Custom tools. Web search runs on a self-hosted SearXNG instance: no API bill, no tracking.
`propose_skill` is how the agent upgrades its own skills (with C's approval)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx
from langchain_core.tools import BaseTool, tool
from markdownify import markdownify

from hq_agent.config import load_settings
from hq_agent.skills_store import SkillError, SkillStore

_USER_AGENT = "Mozilla/5.0 (compatible; hq-agent/0.1)"
_MAX_PAGE_CHARS = 40_000


@tool
async def web_search(query: str, max_results: int = 8) -> str:
    """Search the web. Returns titles, URLs and snippets; use fetch_url to read a result in full.

    Args:
        query: What to search for. Be specific; add a year for anything time-sensitive.
        max_results: How many results to return (1-20).
    """
    base = load_settings().searxng_url
    if not base:
        return "web_search is not configured (set SEARXNG_URL)."
    max_results = max(1, min(max_results, 20))
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": _USER_AGENT}) as client:
        resp = await client.get(f"{base.rstrip('/')}/search", params={"q": query, "format": "json"})
        resp.raise_for_status()
        results = resp.json().get("results", [])[:max_results]
    if not results:
        return "No results."
    lines = [f"{i}. {r.get('title', '').strip()}\n   {r.get('url')}\n   {r.get('content', '').strip()}" for i, r in enumerate(results, 1)]
    return "\n".join(lines)


def _is_public_host(url: str) -> bool:
    """Block fetches to private/internal addresses (Postgres, the Docker proxy, cloud metadata)."""
    host = urlparse(url).hostname
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
            return False
    return True


@tool
async def fetch_url(url: str) -> str:
    """Fetch a public web page and return it as Markdown (truncated for long pages).

    Args:
        url: Full http(s) URL.
    """
    if urlparse(url).scheme not in {"http", "https"}:
        return "Only http(s) URLs are supported."
    async with httpx.AsyncClient(timeout=30, follow_redirects=False, headers={"User-Agent": _USER_AGENT}) as client:
        # Follow redirects by hand so every hop is checked before any request is sent to it.
        for _ in range(6):
            if not _is_public_host(url):
                return "Refusing to fetch a private or internal address."
            resp = await client.get(url)
            if resp.is_redirect and "location" in resp.headers:
                url = str(resp.url.join(resp.headers["location"]))
                continue
            break
        else:
            return "Too many redirects."
    if resp.status_code >= 400:
        return f"HTTP {resp.status_code} fetching {url}"
    content_type = resp.headers.get("content-type", "")
    text = markdownify(resp.text, heading_style="ATX") if "html" in content_type else resp.text
    if len(text) > _MAX_PAGE_CHARS:
        text = text[:_MAX_PAGE_CHARS] + f"\n\n[truncated: page is {len(text)} characters]"
    return text


RESEARCH_TOOLS = [web_search, fetch_url]


def make_skill_tools(store: SkillStore, *, require_approval: bool, proposed_by: str) -> list[BaseTool]:
    """`propose_skill`: the only way the agent changes /skills/ (direct writes are denied)."""

    @tool
    def propose_skill(
        category: str,
        name: str,
        skill_md: str,
        reason: str,
        extra_files: dict[str, str] | None = None,
    ) -> str:
        """Propose a new skill, or an improved version of an existing one, for C to review.

        Use this when you learn something reusable: a convention, a recipe that worked,
        a mistake worth never repeating. Read the current SKILL.md first and send the
        COMPLETE new version (not a diff). Skills change only after C approves.

        Args:
            category: Skill category folder, e.g. "coding" or "markets".
            name: Skill folder name in kebab-case. Must equal `name:` in the frontmatter.
            skill_md: Full SKILL.md content, starting with frontmatter that has `name` and
                `description` (what it does and when to use it).
            reason: What you learned and why this makes the skill better. C reads this.
            extra_files: Optional supporting text files, path (relative to the skill
                folder) -> full content, e.g. {"scripts/check.sh": "..."}.
        """
        files = {"SKILL.md": skill_md, **(extra_files or {})}
        try:
            proposal, diff = store.propose(category, name, files, reason, proposed_by=proposed_by)
        except SkillError as exc:
            return f"Not proposed: {exc}"
        changed = sum(1 for line in diff.splitlines() if line[:1] in "+-" and not line.startswith(("+++", "---")))
        if not require_approval:
            approved = store.approve(proposal.id, note="auto-approved (REQUIRE_SKILL_APPROVAL=false)")
            return f"Skill {proposal.key} updated and live as version {approved.version} ({changed} lines changed)."
        return (
            f"Proposal {proposal.id} for {proposal.key} is waiting for C's review ({changed} lines changed). "
            "It is NOT live yet; keep working from the current version until C approves it."
        )

    return [propose_skill]
