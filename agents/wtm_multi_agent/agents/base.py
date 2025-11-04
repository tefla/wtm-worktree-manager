"""Base agent interfaces."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict

from ..context import WorkspaceContext


class Agent(ABC):
    """A simple synchronous agent contract."""

    name: str

    def __init__(self, name: str) -> None:
        self.name = name

    @abstractmethod
    def describe(self) -> str:
        """Return a short description of the agent."""

    @abstractmethod
    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        """Process a message and return structured output."""


class ToolAgent(Agent):
    """Agent that executes a single tool action."""

    def handle(self, payload: Dict[str, Any], context: WorkspaceContext) -> Dict[str, Any]:
        raise NotImplementedError("Tool agents must implement handle().")
