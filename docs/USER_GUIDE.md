# WTM User Guide

Welcome to **WTM (WorkTree Manager)**—an Electron desktop dashboard for creating, inspecting, and tidying `git worktree` checkouts. This guide walks through everything you need to get productive, from installation through advanced workspace customisation.

---

## 1. Installation & First Run

### Prerequisites
- **Node.js 18+** (bundled npm is required)
- **Git** installed and available on `PATH`

```bash
git clone https://github.com/your-org/wtm-worktree-manager.git
cd wtm-worktree-manager
npm install
npm run dev
```

Launching `npm run dev` starts Electron with GPU disabled (safe defaults for most Linux / remote environments). When prompted, select a repository to manage; WTM creates a `.wtm/` folder to store project-specific data.

---

## 2. Core Concepts

### 2.1 Project Structure

When you open a repo, WTM creates or reuses:

```
.wtm/
├── config.json        # Quick-access terminal presets & future per-project settings
├── workspaces/        # Git worktrees and ad-hoc folders
└── terminals.json     # Persisted terminal history per workspace
```

- **config.json** – Define quick-access commands (terminals available in every workspace).
- **workspaces/** – Each git worktree is placed here by default.
- **terminals.json** – Stores terminal tab state/history so sessions survive restarts.

### 2.2 Layout Overview

| Area                | Description                                                                                             |
|---------------------|---------------------------------------------------------------------------------------------------------|
| **Header**          | Project selector, quick-create worktree form, settings, refresh.                                       |
| **Sidebar**         | Worktree list (customisable via widgets & row actions).                                                 |
| **Main Panel**      | Workspace tabs and terminals (also widget-based).                                                       |
| **Aux Panel**       | Docker Compose service snapshot (customisable widget slot).                                             |
| **Settings Overlay**| Modify quick-access commands (per project).                                                             |

---

## 3. Everyday Workflow

### 3.1 Creating a Workspace
1. Use the **“Branch or ticket name”** field in the header.
2. Optionally provide a base branch (defaults to current repo branch).
3. Submit—WTM runs `git worktree add` and opens the workspace in the main panel.

### 3.2 Managing Workspaces
- **Refresh**: Re-scan status (per row or globally).
- **Update**: If behind upstream, click the pull badge or use a custom action.
- **Delete**: Available from the workspace row; warns on dirty trees.
- **Loose folders**: Sidebar highlights directories under `.wtm/workspaces` that aren’t registered worktrees.

### 3.3 Terminal Tabs
- Default quick-access commands populate per workspace.
- Add ephemeral terminals via the “+” button.
- Sessions persist across app restarts via `terminals.json`.

---

## 4. Customisation & Widgets

WTM’s UI is composed of **widgets** and **row actions** registered in the renderer at start-up. Three slots are available:

| Slot     | Default widget                                               |
|----------|--------------------------------------------------------------|
| `sidebar`| Workspace list (with customizable row actions)               |
| `main`   | Workspace tabs & terminals                                   |
| `aux`    | Docker Compose services snapshot                             |

### 4.1 Extending via Configuration
For basic scenarios (no code changes), adjust `config.json` to rewrite quick-access commands:

```json
{
  "quickAccess": [
    { "key": "install", "label": "pnpm install", "quickCommand": "pnpm install" },
    { "key": "launch", "label": "pnpm dev", "quickCommand": "pnpm dev" }
  ]
}
```

### 4.2 Advanced: Custom Widgets & Actions (code required)
1. Create a widget definition that matches the `WidgetDefinition` interface (see `src/renderer/widgets/types.ts`).
2. Register it in the `<WidgetRegistryProvider widgets=[…] />` in `src/renderer/index.tsx` (or create a plugin entry point).
3. For per-row actions, provide `WorkspaceRowActionDefinition` entries to render custom controls (e.g., push/pull buttons).

Example (pseudo):
```tsx
const customWidgets = [
  {
    id: "wtm.aux.git-shortcuts",
    slot: "aux",
    order: 1,
    render: ({ workspace, callbacks }) => (
      <button onClick={() => callbacks.updateWorkspace(workspace.list[0])}>Pull Latest</button>
    ),
  },
];

<WidgetRegistryProvider widgets={customWidgets}>
  <App />
</WidgetRegistryProvider>
```

### 4.3 Row Actions Example
```tsx
const customRowActions = [
  {
    id: "git-push",
    render: ({ workspace, isUpdating, onUpdate }) => (
      <button disabled={isUpdating} onClick={onUpdate}>Push</button>
    ),
  },
];
```

---

## 5. Settings & Preferences

| Setting                            | Location                      | Notes                                |
|------------------------------------|-------------------------------|--------------------------------------|
| Quick access commands              | `.wtm/config.json` / overlay  | Per project                          |
| Open projects in new window        | Settings overlay toggle       | Persists locally in browser storage |
| Recent projects                    | Local storage (`RECENT_PROJECTS`) | Managed automatically                |

---

## 6. Keyboard / Accessibility
- Esc closes the settings overlay.
- Sidebar rows and buttons are fully focusable; custom actions should provide `aria-label`.
- Terminal tabs use keyboard-friendly controls (`Tab`, `Shift+Tab`, `Enter`).

---

## 7. Troubleshooting

| Issue                                      | Fix                                                                                      |
|-------------------------------------------|------------------------------------------------------------------------------------------|
| App reports “No project configured”       | Open a repository folder with `.wtm/` directory (let WTM create it if missing).         |
| Worktree creation fails (dir exists)      | Delete or rename the existing folder under `.wtm/workspaces/`.                          |
| Terminals not restoring history           | Ensure `.wtm/terminals.json` is writable; delete to reset if corrupted.                 |
| Docker compose panel empty                | Confirm compose file exists & WTM has access; check logs for parsing errors.            |
| Custom widget not rendering               | Verify widget `slot` matches `sidebar`/`main`/`aux` and you registered via provider.     |

---

## 8. Need Help?
- Run `npm run coverage` to execute the full unit suite and generate coverage reports (`coverage/`).
- Check `docs/DEVELOPER_GUIDE.md` for architecture and extension hooks.
- File issues or feature requests in the repository.

Enjoy managing your worktrees! 🛠️🌳
