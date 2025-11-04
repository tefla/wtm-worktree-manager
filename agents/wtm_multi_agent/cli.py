"""Command-line interface for the WTM multi-agent workflow."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import JiraConfig, WorkflowConfig
from .context import JiraTicket
from .orchestrator import WorkflowOrchestrator


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the WTM multi-agent workflow.")
    parser.add_argument("ticket", help="Jira ticket key (e.g., MOB-123)")
    parser.add_argument("summary", help="Short summary of the ticket")
    parser.add_argument("repo", type=Path, help="Path to the Git repository root")
    parser.add_argument("--wtm", dest="wtm_binary", default="wtm", help="Path to the WTM binary")
    parser.add_argument("--assistant", default="claude", help="Coding assistant identifier")
    parser.add_argument("--jira-site", dest="jira_site", help="Jira site identifier for acli")
    parser.add_argument("--jira-email", dest="jira_email", help="Email used for Jira authentication")
    parser.add_argument("--jira-token", dest="jira_token", help="API token used for Jira authentication")
    parser.add_argument(
        "--extra-action",
        dest="extra_actions",
        action="append",
        default=[],
        help="Additional quick action command to enqueue",
    )
    parser.add_argument("--json", action="store_true", help="Return output as JSON")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    jira_config = None
    if args.jira_site and args.jira_email and args.jira_token:
        jira_config = JiraConfig(site=args.jira_site, email=args.jira_email, api_token=args.jira_token)

    workflow_config = WorkflowConfig(
        repo_root=args.repo.resolve(),
        wtm_binary=args.wtm_binary,
        coding_agent=args.assistant,
        jira=jira_config,
    )

    orchestrator = WorkflowOrchestrator(workflow_config)
    ticket = JiraTicket(key=args.ticket, summary=args.summary)
    context = orchestrator.initialise_workspace(ticket)
    if args.extra_actions:
        orchestrator.update_quick_actions(args.extra_actions, context)
    plan = orchestrator.plan(ticket)

    if args.json:
        print(json.dumps({"prompt": plan["prompt"], "assistant": plan["assistant"]}, indent=2))
    else:
        print(f"Assistant: {plan['assistant']}")
        print("Prompt:\n")
        print(plan["prompt"])


if __name__ == "__main__":  # pragma: no cover
    main()
