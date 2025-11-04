"""Configuration dataclasses for the workflow orchestrator."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class JiraConfig:
    """Settings required to query Jira via the Atlassian CLI."""

    site: str
    email: str
    api_token: str
    cache_path: Path = Path(".wtm/jira_cache.json")
    max_results: int = 10


@dataclass
class ReactConfig:
    """Commands and settings for React Native quick actions."""

    quick_actions: List[str] = field(
        default_factory=lambda: [
            "npm install",
            "npm run lint",
            "npm run test",
            "npx expo start --dev-client",
        ]
    )
    extra_env: Dict[str, str] = field(default_factory=dict)


@dataclass
class WorkflowConfig:
    """Top-level configuration for orchestrator and agents."""

    repo_root: Path
    openai_model: str = "gpt-4.1"
    wtm_binary: str = "wtm"
    coding_agent: str = "claude"
    jira: Optional[JiraConfig] = None
    react: ReactConfig = field(default_factory=ReactConfig)

    def ensure_paths(self) -> None:
        """Make sure cache directories exist."""

        if self.jira:
            self.jira.cache_path.parent.mkdir(parents=True, exist_ok=True)
