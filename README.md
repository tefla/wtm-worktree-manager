# WTM (WorkTree Manager)

WTM (WorkTree Manager) is an Electron desktop dashboard for creating, inspecting,
and pruning `git worktree` checkouts for any git repository. It provides a
compact, IDE-inspired view over multiple worktrees alongside built-in terminal
tabs for common project commands.

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
- Launch integrated terminals for customizable quick commands or ad-hoc shells.

## Prerequisites

- Node.js 18+ with npm.
- A git repository to manage plus a directory where worktrees should be created.
  These paths are configured via the settings file (see below).

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
│   ├── settingsManager.js
│   └── workspaceManager.js
│                        # Git + worktree orchestration and settings IO
└── renderer/
    ├── index.html        # Renderer shell markup
    ├── index.js          # Renderer logic calling preload bridge
    └── styles.css        # UI styling
```

## Settings

WTM stores its configuration in a simple JSON file so you can manage settings
alongside the rest of your dotfiles. By default the app creates
`~/.wtm/settings.json` on first launch with the following shape:

```json
{
  "environments": {
    "default": {
      "repoDir": "/absolute/path/to/your/repo",
      "workspaceRoot": "/absolute/path/to/worktrees"
    }
  },
  "activeEnvironment": "default",
  "quickCommands": [
    {
      "key": "npm-install",
      "label": "npm i",
      "quickCommand": "npm i"
    },
    {
      "key": "lerna-bootstrap",
      "label": "npm run lerna:bootstrap",
      "quickCommand": "npm run lerna:bootstrap"
    }
  ]
}
```

Add additional environments to the `environments` object when you need to work
with multiple repositories. The app exposes a dropdown in the header that lets
you switch between the configured environments at runtime. The
`activeEnvironment` key selects which environment is used when the app starts.
All paths are resolved to absolute locations automatically.

Populate the optional `quickCommands` array to configure the quick access tabs
displayed for each workspace. Provide a stable `key`, a `label` for the tab
title, and an optional `quickCommand` string to run automatically once the
terminal session starts. Tabs created from this list stay available even after
closing the running process, while ad-hoc shells can be spawned or removed on
the fly inside the workspace view.

To use an alternative settings location (useful for scripting or tests), set
the `WTM_SETTINGS_PATH` environment variable to your desired JSON file.

## Notes

- Workspace creation fetches remotes as needed and defaults to branching from
  `origin/develop` when the target branch does not exist.
- Worktree removal is performed via `git worktree remove`. The UI asks for
  confirmation if uncommitted changes are present unless deletion is forced.
- Use the **Refresh** button whenever worktrees change outside the app.

Happy hacking! ♟️
