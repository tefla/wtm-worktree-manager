# Architecture Overview

WTM’s codebase is intentionally modular: each major concern lives in its own
crate module to keep responsibilities narrow and re-use straightforward.

## High-Level Flow

```
main.rs → commands::* + tui::run_tui
                   ↘
                     git::* (Git helpers)
                     jira::* (Jira helpers via `acli`)
```

Running `wtm` with no arguments launches the TUI:

1. `tui::run_tui` prepares the alternate-screen terminal and constructs an
   `App` from the current repository state.
2. The event loop polls for keyboard input, hands it to `App`, and re-renders
   the UI at ~10 FPS.
3. `App` delegates to specialist modules for input handling, rendering, and
   state transitions.

## Module Breakdown

### CLI Entrypoint (`main.rs`, `src/commands/*`)

- Uses `clap` for argument parsing.
- `commands::init::init_command` scaffolds the `.wtm` directory.
- `commands::worktree` wraps `git worktree` operations.
- Shared logic for path resolution lives in `wtm_paths.rs`.

### Git Helpers (`src/git`)

- Thin wrappers that call the Git CLI and parse output.
- `list_worktrees` consumes `git worktree list --porcelain`.
- `list_branches`/`list_remote_branches` supply data for the add-worktree overlay.

### Jira Integration (`src/jira`)

- Uses the Atlassian CLI (`acli`) to fetch issues.
- Supports JSON and plain-text output, storing results in `.wtm/jira_cache.json`.
- Provides `cached_tickets`, `refresh_cache`, and `invalidate_cache` helpers.

### TUI (`src/tui`)

- `run_tui` configures the Crossterm backend and drives the event loop.
- `App` (in `src/tui/app/mod.rs`) holds all mutable UI state: workspaces, tabs,
  quick actions, active mode, the optional context panel, and status messages.
- Rendering and user interaction is split across four modules:
  - `app/ui.rs` — draws the sidebar, terminal panes, overlays, and status bar.
  - `app/input.rs` — keyboard handling for navigation, terminal input, add/remove
    worktree flows, and quick actions.
  - `app/workspace.rs` — workspace/tab management plus quick-action selection
    state.
  - `app/add_worktree.rs` — suggestion engine that merges Jira tickets, local
    branches, and remote branches into a searchable list.
- `app/context.rs` enriches the optional context panel with git status and
  Docker compose metadata gathered per workspace.
- Embedded terminals are implemented via `portable-pty` and rendered with
  `tui-term` (`src/tui/pty_tab.rs`).

### Tests

- Unit tests for parsing and state transitions live alongside their modules.
- CLI smoke tests live in `tests/cli.rs` and create ephemeral repositories to
  exercise the command surface.
- Coverage (via `cargo llvm-cov`) currently sits around 39% by region, with
  deeper coverage across transformation-heavy modules.

## Data Flow in the Add Worktree Overlay

1. `AddWorktreeState::new` loads cached tickets and discovers local/remote
   branches.
2. Suggestions are unified into a single vector and filtered live as the user
   types.
3. Accepting a suggestion either reuses an existing branch or creates a new one
   from a remote upstream when adding a worktree.
4. The `input` module performs the Git operation and refreshes worktree state.

## Extending the System

- **New quick actions:** append to `.wtm/config.json` and they will appear in the
  TUI automatically.
- **Additional data sources:** follow the pattern in `add_worktree.rs` to merge
  new suggestion providers (e.g. pull requests, issue trackers).
- **UI widgets:** add new draw helpers under `app/ui.rs` and update the layout to
  incorporate them.
- **Workspace context:** press `i` to toggle the context panel, which displays
  git status information alongside docker compose containers discovered in the
  selected worktree.
