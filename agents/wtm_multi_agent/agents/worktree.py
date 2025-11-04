"""Agent responsible for creating and cleaning up worktrees via WTM."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from ..config import WorkflowConfig
from ..context import WorkspaceContext
from ..utils import cli
from .base import ToolAgent


@dataclass
class WorktreeManagerAgent(ToolAgent):
    """Wraps `wtm worktree` commands."""

    config: WorkflowConfig

    def __init__(self, config: WorkflowConfig) -> None:
        super().__init__(name="worktree-manager")
        self.config = config

    def describe(self) -> str:
        return "Creates, lists, and prunes WTM-managed worktrees."

    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        action = payload.get("action")
        if action == "add":
            return self._add(payload, context)
        if action == "remove":
            return self._remove(payload, context)
        if action == "list":
            return self._list(payload)
        raise ValueError(f"Unsupported worktree action: {action}")

    def _add(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        branch = payload.get("branch") or context.ticket.slug
        path_hint: Optional[str] = payload.get("path")
        args = [self.config.wtm_binary, "worktree", "add", branch]
        if path_hint:
            args.append(path_hint)
        cli.run(args, cwd=self.config.repo_root)
        worktrees = self._list({})["worktrees"]
        worktree_path = next((Path(item["path"]) for item in worktrees if item["branch"] == branch), None)
        return {
            "branch": branch,
            "path": str(worktree_path) if worktree_path else None,
        }

    def _remove(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        branch = payload.get("branch") or context.ticket.slug
        force = payload.get("force", False)
        args = [self.config.wtm_binary, "worktree", "remove", branch]
        if force:
            args.append("--force")
        cli.run(args, cwd=self.config.repo_root)
        return {"branch": branch, "removed": True}

    def _list(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        args = [self.config.wtm_binary, "worktree", "list", "--json"]
        result = cli.run_json(args, cwd=self.config.repo_root)
        return {"worktrees": result or []}
