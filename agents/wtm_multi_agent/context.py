"""Shared context objects used by multiple agents."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class JiraTicket:
    """Represents the subset of Jira ticket data we care about."""

    key: str
    summary: str
    url: Optional[str] = None
    labels: List[str] = field(default_factory=list)
    extra: Dict[str, str] = field(default_factory=dict)

    @property
    def slug(self) -> str:
        """Return a filesystem-friendly slug suitable for branch names."""

        normalised = self.summary.lower().replace(" ", "-")
        safe = "".join(ch for ch in normalised if ch.isalnum() or ch in {"-", "_"})
        return f"{self.key.lower()}-{safe}"[:80]


@dataclass
class WorkspaceContext:
    """Aggregated view of the active worktree workspace."""

    repo_root: Path
    worktree_path: Path
    ticket: JiraTicket
    quick_actions: List[str]
    env: Dict[str, str] = field(default_factory=dict)

    def to_prompt(self) -> str:
        """Render a human-readable summary for coding agents."""

        actions = "\n".join(f"- {action}" for action in self.quick_actions)
        env_lines = "\n".join(f"{key}={value}" for key, value in sorted(self.env.items()))
        return (
            f"Repository root: {self.repo_root}\n"
            f"Worktree path: {self.worktree_path}\n"
            f"Ticket: {self.ticket.key} — {self.ticket.summary}\n"
            f"Quick actions:\n{actions or '  (none)'}\n"
            f"Environment:\n{env_lines or '  (none)'}"
        )
