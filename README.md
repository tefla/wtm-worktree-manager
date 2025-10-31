# WTM (WorkTree Manager)

WTM is a terminal-first worktree manager designed to keep multi-branch Git
projects tidy. It ships as a single CLI (`wtm`) with an Ink-powered TUI that
you can drive entirely from the keyboard. tmux integration gives every
workspace a set of persistent terminal tabs without having to embed a terminal
emulator.

## Features

- Detect and initialise project metadata under `.wtm/`
- Create and list Git worktrees from a simple sidebar
- Keyboard-driven navigation with a built-in shortcut reference (`?`)
- Optional tmux session orchestration for rich terminal tabs
- Works anywhere Node 18+ and Git are available

## Requirements

- Node.js 18 or newer
- Git (used for worktree management)
- tmux (optional, recommended for terminal tabs)

## Install Dependencies

```bash
npm install
```

## Initialise a Repository

```bash
npm exec -- wtm init
```

`wtm init` creates the `.wtm/` folder, populates a default `config.json`, and
initialises the `workspaces/` directory in the current Git repository.

## Launch the TUI

```bash
npx wtm
```

The app detects the surrounding Git repo, offers to run `wtm init` if needed,
and then opens the TUI. When raw-mode input is supported you can use the
following shortcuts:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select workspace |
| `←` / `→` | Switch terminal tab |
| `n` | Create a new worktree |
| `t` | Create another tmux tab |
| `r` | Refresh workspace list |
| `Enter` | Attach to the active tmux tab |
| `?` | Toggle the help overlay |
| `q` / `Esc` / `Ctrl+C` | Exit |

If raw mode is unavailable (for example when piping output) the help overlay is
shown automatically and keybindings are disabled.

## Project Layout

- `src/core/` – Git, project, and worktree helpers shared by the CLI
- `src/shared/` – Common TypeScript contracts reused across modules
- `src/tui/` – CLI entry point, Ink UI, and tmux integration
- `bin/wtm.js` – Small Node shim that loads the compiled CLI entry point

A deeper architecture outline lives in `docs/tui-architecture.md`.

## Developing

```bash
npm run build      # Compile TypeScript to dist/
npm exec -- wtm    # Launch the TUI in the current repo
```

The project currently has no automated tests (`npm test` prints a message).

Happy hacking!
