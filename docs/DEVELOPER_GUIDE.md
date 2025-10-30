# WTM Developer Guide

This document explains the architectural layout, extension points, and workflows for contributing to WTM (WorkTree Manager). It complements the user-oriented instructions in `docs/USER_GUIDE.md`.

---

## 1. Repository Layout

```
src/
├── main/                     # Electron main process
│   ├── main.ts               # App bootstrap + BrowserWindow lifecycle
│   ├── preload.ts            # Controlled bridge for renderer IPC
│   ├── ipc/                  # IPC route registration modules
│   ├── services/             # Domain-layer services
│   │   ├── gitService.ts     # Generic git child-process wrapper
│   │   ├── workspaceService.ts
│   │   ├── terminalService.ts
│   │   └── projectService.ts
│   ├── workspaceManager.ts   # Worktree aggregation & git orchestration
│   ├── projectManager.ts     # `.wtm` structure and compose inspector wiring
│   ├── terminalManager.ts    # PTY session lifecycle + persistence
│   └── dockerComposeInspector.ts / jiraTicketCache.ts / etc.
├── renderer/                 # React + Redux renderer
│   ├── App.tsx               # Shell; consumes widget registry + hooks
│   ├── index.tsx             # Entry; sets up store + widget provider
│   ├── components/           # Presentational components
│   ├── hooks/                # Custom hooks (e.g. quick-access settings)
│   ├── services/             # Renderer helpers (IPC clients, normalisers)
│   ├── store/                # Redux store (RTK slices + hooks)
│   │   ├── slices/           # Feature-specific reducers
│   │   └── persistence.ts    # LocalStorage helpers (recent projects etc.)
│   ├── widgets/              # Widget + row-action registry
│   └── stateTypes.ts / types.ts
├── shared/                   # Types shared between main + renderer
└── tests/                    # Node test suite (unit + integration)
```

---

## 2. Build & Scripts

| Command                | Description                                                     |
|------------------------|-----------------------------------------------------------------|
| `npm run dev`          | Build + launch Electron app (disables GPU for compatibility).   |
| `npm run build`        | Compile main, type-check renderer, build renderer bundle, copy static assets. |
| `npm run test:unit`    | Node’s native test runner (`node --test`) for backend/frontend utilities. |
| `npm run test:e2e`     | Playwright-driven smoke tests against the packaged Electron app. |
| `npm run coverage`     | Coverage via `c8`, produces `coverage/` directory & lcov reports. |

Under the hood:
- `build:main` uses `tsc` with `tsconfig.main.json`.
- Renderer bundling uses custom scripts under `scripts/`.
- During dev, `scripts/ensure-node-pty.cjs` recompiles the PTY native module if needed.

---

## 3. Architectural Highlights

### 3.1 Renderer Slices & Hooks

State is partitioned into Redux slices (RTK):

| Slice           | Responsibility                                  |
|-----------------|--------------------------------------------------|
| `workspaces`    | Workspace list/order/status + creation flow      |
| `project`       | Active project metadata, compose snapshot        |
| `settings`      | Quick-access settings overlay state              |
| `jira`          | Cached Jira tickets                              |
| `notifications` | Toast queue                                      |

Use `useAppSelector` / `useAppDispatch` from `src/renderer/store/hooks.ts`. Feature hooks (e.g. `useQuickAccessSettings`) coordinate overlay logic and dispatch the relevant slice actions.

### 3.2 Widget Registry

`src/renderer/widgets/registry.tsx` exposes:
- `<WidgetRegistryProvider widgets rowActions>` – supply extra widgets/actions.
- `useWidgets(slot)` – returns widgets registered for `sidebar`, `main`, or `aux`.
- `useWorkspaceRowActions()` – custom row-level controls for the sidebar.

**Extending**:
```tsx
const myWidgets = [
  { id: "custom.sidebar.shortcuts", slot: "sidebar", render: (ctx) => <MySidebar {...ctx} /> },
];

<WidgetRegistryProvider widgets={myWidgets}>
  <App />
</WidgetRegistryProvider>;
```

Widget context (`WidgetRenderContext`) includes workspace info, project metadata, compose snapshot, and callbacks (select workspace, add terminal, etc.), enabling deep integrations.

### 3.3 Backend Services

Managers (`workspaceManager`, `terminalManager`, `projectManager`) focus on core domain logic. Services wrap managers to expose extension-friendly hooks:

| Service            | Extension Points                          | Used By                           |
|--------------------|-------------------------------------------|-----------------------------------|
| `WorkspaceService` | `registerListTransform` for workspace list | `registerWorkspaceHandlers`       |
| `TerminalService`  | `registerEnsureTransform` for sessions     | `registerTerminalHandlers`        |
| `ProjectService`   | `registerStateTransform` for project state | `registerProjectHandlers`         |
| `GitService`       | Uniform git command runner + path existence | `WorkspaceManager`               |

IPC handlers now depend on services (not managers), making it easier to add plugins that manipulate results before they reach the renderer.

---

## 4. Extending Functionality

### 4.1 Renderer Widgets and Actions
See §3.2. Provide additional widgets or row actions by registering definitions when bootstrapping the renderer. Future work could load widget bundles dynamically via user configuration—current setup expects compile-time registration.

### 4.2 Workspace List Transforms
```ts
const workspaceService = new WorkspaceService(manager);
workspaceService.registerListTransform((list) =>
  list.map((workspace) => ({ ...workspace, badges: [...(workspace.badges ?? []), "CI"] })),
);
```
Transforms run sequentially; always return a new array to avoid mutation side-effects.

### 4.3 Terminal Session Transforms
Add metadata or modify command line:
```ts
terminalService.registerEnsureTransform((result) => ({
  ...result,
  command: `${result.command} --login`,
}));
```

### 4.4 Project State Transforms
Used to inject extra metadata into renderer state (e.g., last deployment time).
```ts
projectService.registerStateTransform((state) => {
  if (!state) return state;
  return { ...state, custom: { lastDeploy: Date.now() } };
});
```

---

## 5. Testing Strategy

- **Unit tests** leveraging `node:test` live under `tests/unit`. Use the existing patterns:
  - Renderer tests transpile TS modules on the fly (see `tests/unit/persistence.test.js` helpers).
  - New service tests ensure transforms and extension hooks behave as expected.
- **Integration tests** (Playwright) ensure the Electron UI boots and critical actions work.
- Run `npm run coverage` to execute all unit tests and produce coverage reports; coverage currently emphasises backend services and store logic.

When adding new functionality:
1. Prefer writing tests near similar existing ones (e.g. workspace tests alongside others in `tests/unit/workspaceManager.test.js`).
2. For renderer logic, consider extracting pure functions/hooks to ease testing without a full DOM.

---

## 6. Coding Guidelines

- **TypeScript** across main + renderer; keep shared types in `src/shared`.
- **RTK** for state; use Immer-friendly immutable updates.
- **IPC**: Keep payloads serialisable & typed; update `src/shared/ipc.ts` when adding channels.
- **Comments** sparingly—only where behaviour isn’t self-evident.
- **Formatting**: Respect existing style (Prettier-style). CI hooks currently rely on reviewer vigilance.

---

## 7. Releasing

1. Update version in `package.json`.
2. Run `npm run build` and `npm run coverage`.
3. Build distributables via `npm run package` (uses `electron-builder`).
4. Attach artifacts to GitHub release or desired distribution channel.

---

## 8. Future Improvements / TODOs

- Plugin loading (from config files, remote registry).
- Additional widget slots (per-workspace header/footer).
- UI component tests (e.g. using React Testing Library).
- Telemetry hooks for extension monitoring.

---

Questions? Reach out via project issues/PR templates. Happy hacking! 🎯
