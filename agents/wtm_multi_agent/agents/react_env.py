"""Agent that prepares quick actions for React Native workspaces."""

from __future__ import annotations

from typing import Any, Dict

from ..config import ReactConfig
from ..context import WorkspaceContext
from .base import ToolAgent


class ReactEnvironmentAgent(ToolAgent):
    """Enriches workspace context with React-specific quick actions."""

    def __init__(self, config: ReactConfig) -> None:
        super().__init__(name="react-environment")
        self.config = config

    def describe(self) -> str:
        return "Adds React Native quick actions and environment hints to the workspace."

    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        extra_actions = payload.get("extra_actions", [])
        merged_actions = list(dict.fromkeys([*self.config.quick_actions, *extra_actions]))
        context.quick_actions[:] = merged_actions
        context.env.update(self.config.extra_env)
        return {
            "quick_actions": merged_actions,
            "env": context.env,
        }
