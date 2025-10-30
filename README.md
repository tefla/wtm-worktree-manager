# WTM (WorkTree Manager)

WTM (WorkTree Manager) is an Electron desktop dashboard for creating, inspecting,
and pruning `git worktree` checkouts for any git repository. It provides a
compact, IDE-inspired view over multiple worktrees alongside built-in terminal
tabs for common project commands.

## Documentation

- 📘 **User Guide** – `docs/USER_GUIDE.md`
- 🛠️ **Developer Guide** – `docs/DEVELOPER_GUIDE.md`

The guides cover everyday use, widget-based customisation, and the backend/frontend architecture for contributors.

## Feature Highlights

- Rich workspace list with git status, ahead/behind counters, and last-commit metadata.
- Per-project `.wtm/` structure for quick-access commands and persisted terminals.
- Built-in terminal tabs with session persistence and quick command support.
- Modular widget/row-action registry so teams can extend the sidebar, main panel, and compose area.
- Detached PTY host process keeps terminals alive between restarts.
- Jira ticket suggestions in the branch input (when configured).

## Prerequisites

- Node.js 18+ with npm.
- A git repository you want to manage. When you open a folder in WTM the app
  will look for a `.wtm` directory inside it (creating one for you if missing).
  That folder holds the per-project config and workspaces directory.

## Install Dependencies

```bash
npm install
```

## Run The App

```bash
npm run dev
```

This launches Electron and loads the renderer UI. Hot reload is not wired up
yet, so restart the process after larger code changes. On systems without GPU
support for Electron you may need to remove or adjust the GPU-disabling flags in
`package.json`.

The dev script will automatically rebuild the `node-pty` native module for the
current Electron version. If you switch Node.js or upgrade Electron manually,
you can trigger the rebuild yourself via `npm run rebuild:native`.

## Tests

```bash
npm run test:unit     # Node unit tests for workspace helpers
npm run test:e2e      # Playwright electron smoke tests
```

## Project Layout

A bridged Electron architecture:

- `src/main/` – Electron main process, IPC handlers, domain managers, and modular services (`services/`).
- `src/renderer/` – React renderer (Redux slices, widget registry, components).
- `src/shared/` – Shared IPC contracts and domain types.
- `tests/` – Node-based unit tests (run via `node --test`).

## Project Configuration

Each project you open contains a `.wtm` folder in the repository root. Inside
you'll find:

```
.wtm/
├── config.json        # Project icon and quick access settings
├── workspaces/        # Git worktrees and standalone folders live here
└── terminals.json     # Terminal session persistence for this project
```

The `config.json` file configures the optional project icon plus the preset quick-access terminals
that appear for every workspace in that project:

```json
{
  "icon": "🚀",
  "quickAccess": [
    { "key": "npm-install", "label": "npm i", "quickCommand": "npm i" },
    {
      "key": "lerna-bootstrap",
      "label": "npm run lerna:bootstrap",
      "quickCommand": "npm run lerna:bootstrap"
    }
  ]
}
```

Set the `icon` to any short string (emoji or text) to display it beside the project name and in the selector,
or leave it empty to hide it. Update the quick access list to match the commands you want in your project.
Use an empty array if you prefer to rely entirely on ad-hoc terminals. WTM normalises keys for uniqueness
automatically.

The `workspaces/` directory is where `git worktree` checkouts are created. You
can safely add existing worktree folders here before opening the project and
they will be picked up on the next refresh.

`terminals.json` stores the terminal history per workspace so that reopening a
workspace restores its tabs. It is safe to delete when you want to start fresh.

once you've migrated each environment into its project’s `.wtm` directory.

## Jira Ticket Cache

WTM can suggest workspace names based on Jira tickets. Populate the cache by
setting `WTM_JIRA_TICKET_COMMAND` to a shell command that outputs a JSON array
of ticket objects (each with a `key`, `summary`, and optional `url`). The app
stores the most recent result under `~/.wtm/jira-ticket-cache.json` and refreshes
it automatically. Override the refresh interval by exporting
`WTM_JIRA_CACHE_TTL` with a value in milliseconds.

## Notes

- Workspace creation fetches remotes as needed and defaults to branching from
  the repo's currently checked out branch when the target branch does not exist.
- Worktree removal is performed via `git worktree remove`. The UI asks for
  confirmation if uncommitted changes are present unless deletion is forced.
- Use the **Refresh** button whenever worktrees change outside the app.
- Terminal tabs can now be closed individually. Preset tabs remain available
  (turning red when stopped) while ad-hoc tabs disappear once closed.

Happy hacking! ♟️
