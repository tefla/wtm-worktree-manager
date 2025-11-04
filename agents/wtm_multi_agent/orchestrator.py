"""Workflow orchestrator that wires the individual agents together."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from .agents.base import Agent
from .agents.coding import CodingAgent
from .agents.jira import JiraAgent
from .agents.react_env import ReactEnvironmentAgent
from .agents.worktree import WorktreeManagerAgent
from .config import JiraConfig, WorkflowConfig
from .context import JiraTicket, WorkspaceContext


@dataclass
class WorkflowOrchestrator:
    """Coordinates the multi-agent workflow for WTM tasks."""

    config: WorkflowConfig
    agents: List[Agent] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.config.ensure_paths()
        if not self.agents:
            self.agents = self._default_agents()

    def _default_agents(self) -> List[Agent]:
        agents: List[Agent] = [
            WorktreeManagerAgent(self.config),
            ReactEnvironmentAgent(self.config.react),
            CodingAgent(self.config.coding_agent),
        ]
        if isinstance(self.config.jira, JiraConfig):
            agents.insert(0, JiraAgent(self.config.jira))
        return agents

    def initialise_workspace(self, ticket: JiraTicket) -> WorkspaceContext:
        """Create a WorkspaceContext and ensure quick actions are loaded."""

        worktree_dir = self.config.repo_root / ".wtm" / "workspaces" / ticket.slug
        context = WorkspaceContext(
            repo_root=self.config.repo_root,
            worktree_path=worktree_dir,
            ticket=ticket,
            quick_actions=list(self.config.react.quick_actions),
            env=dict(self.config.react.extra_env),
        )
        for agent in self.agents:
            if isinstance(agent, ReactEnvironmentAgent):
                agent.handle({}, context)
        return context

    def plan(self, ticket: JiraTicket) -> Dict[str, str]:
        """Produce a plan that the coding agent can execute."""

        context = self.initialise_workspace(ticket)
        worktree_agent = self._agent_of_type(WorktreeManagerAgent)
        if worktree_agent:
            worktree_agent.handle({"action": "add", "branch": ticket.slug}, context)
        coding_agent = self._agent_of_type(CodingAgent)
        if not coding_agent:
            raise RuntimeError("Coding agent is not configured")
        prompt_payload = coding_agent.handle(
            {
                "goal": f"Implement Jira ticket {ticket.key}",
                "assistant": self.config.coding_agent,
            },
            context,
        )
        return {"prompt": prompt_payload["prompt"], "assistant": prompt_payload["assistant"]}

    def update_quick_actions(self, actions: List[str], context: Optional[WorkspaceContext] = None) -> None:
        """Push additional quick actions into the context and agents."""

        if context is None:
            raise ValueError("Workspace context is required")
        react_agent = self._agent_of_type(ReactEnvironmentAgent)
        if react_agent:
            react_agent.handle({"extra_actions": actions}, context)

    def _agent_of_type(self, agent_type):
        for agent in self.agents:
            if isinstance(agent, agent_type):
                return agent
        return None

    def describe_agents(self) -> Dict[str, str]:
        """Return a mapping of agent names to descriptions."""

        return {agent.name: agent.describe() for agent in self.agents}

    def fetch_ticket_suggestions(self) -> List[Dict[str, str]]:
        """Retrieve Jira suggestions if the Jira agent is configured."""

        jira_agent = self._agent_of_type(JiraAgent)
        if not jira_agent:
            return []
        context = WorkspaceContext(
            repo_root=self.config.repo_root,
            worktree_path=self.config.repo_root,
            ticket=JiraTicket(key="", summary=""),
            quick_actions=[],
        )
        result = jira_agent.handle({"action": "suggest"}, context)
        return result.get("tickets", [])
