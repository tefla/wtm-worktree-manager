# WTM Worktree Manager

WTM (WorkTree Manager) is a Rust CLI and TUI for working with Git worktrees. It keeps
local repositories organised under a dedicated `.wtm` workspace directory, lets you
spin up additional worktrees quickly, and exposes a terminal-based dashboard for
working across branches without leaving the keyboard.

## Features

- **Workspace scaffold:** `wtm init` prepares a `.wtm` directory with metadata and
  default configuration.
- **Worktree lifecycle:** `wtm worktree add/list/remove` wraps common Git
  `worktree` commands and keeps paths predictable.
- **TUI dashboard:** `wtm` without arguments launches an interactive dashboard
  showing worktrees, embedded terminals, quick actions, and Jira ticket
  suggestions.
- **Jira integration:** Suggestions within the add-worktree flow are fetched via
  the Atlassian CLI (`acli`), cached locally, and converted into branch-friendly
  slugs.

## Getting Started

```bash
cargo install --path .            # install locally
wtm init /path/to/repository      # bootstrap .wtm scaffold
wtm worktree add feature/foo      # create a new worktree
wtm                               # launch the dashboard
```

The TUI expects the Atlassian CLI (`acli`) to be installed and authenticated when
fetching Jira issues.

## Workspace Layout

`wtm init` generates the following structure inside the target repository:

```
.wtm/
  config.json        # quick actions + misc configuration
  terminals.json     # persisted state for embedded terminals
  workspaces/        # worktree directories managed by WTM (created as needed)
```

Because the `.wtm` directory holds environment-specific artefacts, it is excluded
from version control by default.

## Architecture Overview

The codebase is organised around small, focused modules:

| Module | Responsibility |
| ------ | -------------- |
| `src/tui/app/mod.rs` | Application state container and high-level orchestration for the dashboard. |
| `src/tui/app/ui.rs` | All rendering logic for the sidebar, main terminal view, overlays, and help panes. |
| `src/tui/app/input.rs` | Keyboard event handling, mode switching, and command execution. |
| `src/tui/app/workspace.rs` | Worktree/tab state management, quick-action selection, and removal prompts. |
| `src/tui/app/add_worktree.rs` | Jira-powered suggestion engine and form state when creating new worktrees. |
| `src/git` | Thin wrappers around Git CLI invocations. |
| `src/jira` | Cache-aware Jira ticket fetching via `acli`. |
| `src/commands` | Subcommands for the CLI entry point (initialisation, worktree management). |

Each module includes unit tests covering parsing and state transitions. To check
overall coverage run:

```bash
cargo llvm-cov --summary-only
```

More detail can be found in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
future ideas live in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Development

```bash
cargo fmt        # format
cargo test       # run unit + integration tests
```

The project targets stable Rust. Some commands (e.g. coverage) install additional
toolchain components automatically when needed.

## Contributing

1. Fork and clone the repository.
2. Create a feature branch and make your changes.
3. Ensure `cargo fmt`, `cargo test`, and `cargo llvm-cov --summary-only` run
   cleanly.
4. Submit a pull request outlining the motivation and testing performed.

## Licence

This project is released under the MIT licence. See `Cargo.toml` for details.
