# Roadmap & Feature Ideas

This document collects ideas for future improvements. They are intentionally
unordered – pick what excites you.

## UX & TUI Enhancements

- **Workspace search:** Type-to-filter the sidebar when many worktrees exist.
- **Tab persistence:** Restore open PTY tabs, commands, and scrollback on the
  next launch.
- **Theme support:** Allow configuring colour palettes / light mode via
  `config.json`.
- **Inline status widgets:** Surface Git status (dirty/clean), last fetch time,
  or CI status per worktree in the sidebar.

## Jira & Integrations

- **Custom queries:** Read a JQL query from `.wtm/config.json` so teams can scope
  suggestions beyond “current user”.
- **Multiple issuers:** Support additional providers (e.g. Linear, Shortcut) by
  making the suggestion pipeline pluggable.
- **Two-way updates:** Offer actions to transition Jira issues or add comments
  from inside the TUI.

## Workflow Automation

- **Quick action templates:** Parameterised commands with prompts (e.g. deploy to
  chosen environment) instead of static strings.
- **Worktree health checks:** Run lint/test hooks automatically when switching to
  a worktree and display the result in the status bar.
- **Bulk operations:** Select multiple worktrees and prune/update all at once.

## Developer Experience

- **Telemetry plugin:** Optional logging of command durations and UI actions to
  help optimise workflows.
- **Plugin system:** Allow embedding custom panes (logs, analytics) by exposing a
  plugin API.
- **Config schema validation:** Provide `wtm config validate` to check local
  `.wtm/config.json` against a schema before launching the TUI.

## Performance & Reliability

- **Async event loop:** Move the TUI to an async-friendly architecture to reduce
  blocking when running long-lived commands.
- **Cache invalidation:** Detect stale Jira cache entries automatically after a
  configurable TTL.
- **Portable snapshots:** Export and import workspace layouts to share across
  machines.

Got more ideas? Add them here and tag them in issues so they can turn into
contributions quickly.

