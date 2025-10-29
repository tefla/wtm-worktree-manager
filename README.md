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
  base (defaults to the repo's current branch).
- Per-project configuration stored alongside your repository in a `.wtm`
  folder, so teams can keep presets in source control.
- Rescan a workspace to refresh status without reloading the entire list.
- Delete workspaces with dirty-tree warnings so uncommitted work is never lost
  silently.
- Branch name input provides Jira ticket suggestions from a cached issue list.

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

```
src/
├── main/
│   ├── main.ts              # Electron entry point + IPC wiring
│   ├── preload.ts           # Secure bridge exposing workspace & project APIs
│   ├── projectConfig.ts     # Project config normalisation helpers
│   ├── projectManager.ts    # Handles `.wtm` detection/creation per project
│   ├── terminalManager.ts   # node-pty orchestration
│   ├── terminalSessionStore.ts
│   └── workspaceManager.ts  # Git + worktree orchestration
└── renderer/
    ├── index.html           # Renderer shell markup
    ├── index.tsx            # Renderer entry
    ├── App.tsx              # Main UI shell
    └── styles.css           # UI styling
```

## Project Configuration

Each project you open contains a `.wtm` folder in the repository root. Inside
you'll find:

```
.wtm/
├── config.json        # Project-level quick access + future settings
├── workspaces/        # Git worktrees and standalone folders live here
└── terminals.json     # Terminal session persistence for this project
```

The `config.json` file currently configures the preset quick-access terminals
that appear for every workspace in that project:

```json
{
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

Update the list to match the commands you want in your project. Use an empty
array if you prefer to rely entirely on ad-hoc terminals. WTM normalises keys
for uniqueness automatically.

The `workspaces/` directory is where `git worktree` checkouts are created. You
can safely add existing worktree folders here before opening the project and
they will be picked up on the next refresh.

`terminals.json` stores the terminal history per workspace so that reopening a
workspace restores its tabs. It is safe to delete when you want to start fresh.

WTM persists the list of recently opened projects locally, making it quick to
switch between repositories without re-browsing the filesystem.

## Migration from the global settings file

Earlier versions of WTM used a single `~/.wtm/settings.json` that listed
“environments” with `repoDir` and `workspaceRoot` paths. On first launch after
upgrading, the new UI will ask you to open a project folder. To migrate an old
environment:

1. Open the repository folder you previously referenced as `repoDir`.
2. When prompted, allow WTM to create a default `.wtm` folder (or create it
   manually and move your existing worktrees under `.wtm/workspaces`).
3. Copy any custom quick-access entries from the old `quickAccess` array into
   `.wtm/config.json`.
4. Move or re-clone your worktrees into `.wtm/workspaces/` so the app can detect
   them automatically.
5. *(Optional)* If you want to keep terminal history, copy the relevant entries
   from `~/.wtm/terminals.json` into the new `.wtm/terminals.json` file. The
   format is unchanged, so you can either copy the entire file (if it only
   contained this project) or merge the `workspaces` keys for the paths you
   still use.

The old `~/.wtm/settings.json` file is no longer read. You can safely remove it
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
