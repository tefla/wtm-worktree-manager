# WTM Multi-Agent Workflow

This package adapts the OpenAI Codex multi-agent CLI template to the Worktree Manager
(WTM) toolchain. It defines an orchestrated set of agents that collaborate to
provision Git worktrees, hydrate Jira context, bootstrap React Native
workspaces, and hand off execution to a coding agent.

## Quick start

```bash
python -m wtm_multi_agent.cli --help
```

Configure the environment variables described in `config.py`, then launch the
CLI to spawn an orchestrated session.
