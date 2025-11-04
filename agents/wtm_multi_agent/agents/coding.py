"""Adapter agent for delegating to LLM-based coding assistants."""

from __future__ import annotations

from typing import Any, Dict

from ..context import WorkspaceContext
from .base import Agent


class CodingAgent(Agent):
    """Produces prompts for an external coding assistant."""

    def __init__(self, name: str = "coding-agent") -> None:
        super().__init__(name=name)

    def describe(self) -> str:
        return "Forms a rich prompt for the external coding assistant."

    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        goal = payload.get("goal", "Implement the requested feature")
        prompt = (
            f"{goal}\n\n"
            f"Context:\n{context.to_prompt()}\n\n"
            f"Please plan the changes, execute them, and report status."
        )
        return {"prompt": prompt, "assistant": payload.get("assistant", self.name)}
