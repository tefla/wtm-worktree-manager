"""Agent responsible for fetching Jira tickets via acli."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from ..config import JiraConfig
from ..context import JiraTicket, WorkspaceContext
from ..utils import cli
from .base import ToolAgent


class JiraAgent(ToolAgent):
    """Loads Jira context and converts it into prompt-friendly structures."""

    def __init__(self, config: JiraConfig) -> None:
        super().__init__(name="jira-context")
        self.config = config

    def describe(self) -> str:
        return "Fetches assigned Jira tickets and caches them locally."

    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        action = payload.get("action", "suggest")
        if action == "suggest":
            tickets = self._fetch()
            return {"tickets": [ticket.__dict__ for ticket in tickets]}
        if action == "detail":
            key = payload["key"]
            return {"ticket": self._fetch_ticket(key).__dict__}
        raise ValueError(f"Unsupported Jira action: {action}")

    def _cache_path(self) -> Path:
        return self.config.cache_path

    def _fetch(self) -> List[JiraTicket]:
        cache_path = self._cache_path()
        if cache_path.exists():
            try:
                with cache_path.open("r", encoding="utf-8") as handle:
                    cached = json.load(handle)
                return [self._ticket_from_json(item) for item in cached]
            except Exception:
                cache_path.unlink(missing_ok=True)
        command = [
            "acli",
            "jira",
            "issue",
            "list",
            f"--site={self.config.site}",
            f"--user={self.config.email}",
            f"--token={self.config.api_token}",
            f"--limit={self.config.max_results}",
            "--json",
        ]
        data = cli.run_json(command) or []
        tickets = [self._ticket_from_json(item) for item in data]
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as handle:
            json.dump([ticket.__dict__ for ticket in tickets], handle, indent=2)
        return tickets

    def _fetch_ticket(self, key: str) -> JiraTicket:
        command = [
            "acli",
            "jira",
            "issue",
            "get",
            key,
            f"--site={self.config.site}",
            f"--user={self.config.email}",
            f"--token={self.config.api_token}",
            "--json",
        ]
        data = cli.run_json(command) or {}
        return self._ticket_from_json(data)

    @staticmethod
    def _ticket_from_json(data: Dict[str, Any]) -> JiraTicket:
        fields = data.get("fields", {})
        return JiraTicket(
            key=data.get("key", ""),
            summary=fields.get("summary", ""),
            url=data.get("self"),
            labels=fields.get("labels", []),
            extra={
                "status": fields.get("status", {}).get("name", ""),
                "assignee": (fields.get("assignee") or {}).get("displayName", ""),
            },
        )
