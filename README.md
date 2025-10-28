# WTM (WorkTree Manager)

WTM (WorkTree Manager) is an Electron desktop dashboard for creating, inspecting,
and pruning `git worktree` checkouts of the `~/dev/refsix/scorza` repository. It
reimplements the behaviour of the existing `./scorza-manage` script with a
graphical interface.

## Features

- List every workspace with branch name, worktree path, head SHA, and last
  commit metadata.
- Inline git status indicator showing uncommitted change counts plus upstream
  ahead/behind deltas and sample filenames.
- Highlights any stray folders in the workspace directory that are not linked
  as git worktrees so you can tidy them up.
- Create new workspaces by reusing existing branches or branching from a chosen
  base (defaults to `origin/develop`).
- Rescan a workspace to refresh status without reloading the entire list.
- Delete workspaces with dirty-tree warnings so uncommitted work is never lost
  silently.

## Prerequisites

- Node.js 18+ with npm.
- `~/dev/refsix/scorza` must exist locally, with worktrees stored under
  `~/dev/refsix/workspaces`.

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

## Tests

```bash
npm run test:unit     # Node unit tests for workspace helpers
npm run test:e2e      # Playwright electron smoke tests
```

## Project Layout

```
src/
├── main/
│   ├── main.js           # Electron entry point + IPC wiring
│   ├── preload.js        # Secure bridge exposing workspace APIs
│   └── workspaceManager.js
│                        # Git + worktree orchestration
└── renderer/
    ├── index.html        # Renderer shell markup
    ├── index.js          # Renderer logic calling preload bridge
    └── styles.css        # UI styling
```

## Notes

- Workspace creation mirrors `./scorza-manage`: it fetches remotes as needed and
  defaults to branching from `origin/develop` when the target branch does not
  exist.
- Worktree removal is performed via `git worktree remove`. The UI asks for
  confirmation if uncommitted changes are present unless deletion is forced.
- Use the **Refresh** button whenever worktrees change outside the app.

Happy hacking! ♟️
