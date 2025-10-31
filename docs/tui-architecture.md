# WTM TUI — Architecture Options and Migration Plan

This doc explores how to build a terminal UI (TUI) as a new application (not a refactor of the Electron app). It focuses on two primary approaches you called out — tmux/screen and Ink — plus a pragmatic hybrid. It maps each to the existing code so we can reuse logic without dragging in Electron.

Goals

- Fast, reliable worktree management fully in terminal
- Robust interactive terminals per workspace
- Good cross‑platform story where feasible
- Reuse existing business logic (git/dockerd/jira/project state) written in TypeScript

Non‑Goals (for the first pass)

- Feature parity with all Electron niceties (animations, rich terminal embedding)
- Perfect terminal emulation inside React

High‑Level Approaches

1) tmux‑first (or GNU screen) orchestrator

- Description: A Node CLI manages tmux sessions/windows/panes per workspace. The TUI acts as a control plane: list/select worktrees, create/delete, then open/attach the appropriate tmux layout. Shell interactivity is handled natively by tmux.
- Pros:
  - Terminal interactivity “just works” (full shell, Vim, FZF, long‑running processes)
  - Process resilience (tmux keeps sessions alive if the TUI exits)
  - Simple rendering needs for the TUI (lists/menus/status only)
  - Low maintenance; tmux is battle‑tested
- Cons:
  - Requires tmux (or screen) installed; weaker Windows story (WSL okay)
  - UI inside panes is tmux; harder to embed scrolling logs or rich visualizations within the TUI view itself
  - Layout persistence and pane discovery needs a small state layer
- Screen variant:
  - GNU screen can be supported similarly, but has fewer modern features and more fragmentation. Recommend tmux as primary, screen as fallback.

2) Ink (React renderer for terminal) TUI in Node.js

- Description: Build a React TUI with Ink. Reuse TypeScript services to list worktrees, compose services, and Jira. For terminals, either embed PTYs and render output or delegate to external terminals.
- Pros:
  - Stays in TypeScript/React (similar mental model to current codebase)
  - Cross‑platform (Node required; no tmux dependency)
  - Extensible UI components, keybindings, command palette, etc.
- Cons:
  - Rendering a fully interactive shell inside Ink is tricky; high‑volume PTY output stresses React reconciliation
  - Handling raw‑mode key events, scrollback, selection, and resizing is non‑trivial
  - Requires careful perf engineering (buffering, throttling) if we stream PTY output

3) Hybrid: Ink control plane + tmux for terminals

- Description: Use Ink for the navigation, lists, Jira search, project config. When the user opens a terminal slot, the TUI launches/attaches a tmux window/pane. The Ink app can show context/status but defers shell interactivity to tmux.
- Pros:
  - Best of both: polished TypeScript UI + robust terminals
  - Minimal risk and strong ergonomics for users already on tmux
- Cons:
  - Still requires tmux; TUI can fall back to read‑only logs on systems w/o tmux
  - Split UX between Ink window and tmux session (acceptable if “attach” is a top‑level action)

Mapping Existing Code to a TUI

The Electron app originally separated business logic into Node modules. After
the CLI migration, the reusable pieces now live in:

- `src/core/workspaceManager.ts`: Git worktree operations (list/create/delete/update)
- `src/core/projectConfig.ts`: `.wtm/config.json` helpers and defaults
- `src/core/gitService.ts`: Small wrapper around spawning git commands
- `src/shared/`: Shared IPC/domain contracts (still plain TypeScript interfaces)

What to reuse directly:

- Workspace, Docker Compose, Jira, Project logic: Pure Node TypeScript; import directly
- Terminal host: The client/server already speak JSON over a socket and spawn PTYs

What to avoid in TUI:

- Electron IPC/WebContents: `TerminalManager` broadcasts to BrowserWindow; for TUI use `TerminalHostClient` directly
- Electron `dialog`: In `ProjectManager.setCurrentProjectWithPrompt()`, replace the Electron prompt with a simple TUI confirm step or CLI flag

Option Details

tmux‑first orchestrator

- Concept:
  - One tmux session per project, e.g. `wtm:<repo-slug>`
  - Windows per workspace (`<branch>`) with panes per “slot” (e.g., `shell`, `app`, `tests`, `services`)
  - A Node CLI orchestrates: `init`, `attach`, `ensure-layout`, `focus <workspace>:<slot>`, `run <workspace>:<slot> <cmd>`
- Commands used (examples):
  - Create session: `tmux new-session -d -s wtm:proj -c <workspacePath>`
  - Create window: `tmux new-window -t wtm:proj -n <branch> -c <path>`
  - Split: `tmux split-window -t wtm:proj:<branch> -h -c <path>`
  - Send keys: `tmux send-keys -t wtm:proj:<branch>.<pane> "<cmd>" C-m`
  - Detect panes: `tmux list-panes -F '#{pane_id} #{pane_current_path} #{pane_title}'`
- State:
  - Maintain a small JSON index mapping `<workspace,slot>` → `{window,pane_id}` to avoid brittle parsing
  - Recover by re‑discovering panes with `list-windows`/`list-panes` if JSON is stale
- Fallback to screen:
  - Mirror a smaller subset with `screen -S`, `screen -X`, and per‑window shell commands
- Windows story:
  - Prefer WSL+tmux
  - Native Windows can use Windows Terminal (`wt`) profiles/tabs as a fallback

Ink TUI with embedded PTY

- Baseline UI:
  - Sidebar: projects/worktrees
  - Main: selected workspace details (status, last commit, quick actions)
  - Bottom bar: hints, keybindings, running tasks
- PTY integration options:
  1) Full interactive shell in Ink
     - Use `TerminalHostClient` to create PTY sessions
     - Forward keystrokes from `useInput` to the PTY when a “terminal view” is focused
     - Render PTY output into a scrollback buffer and draw with `<Text>`; throttle writes to ~60 FPS to avoid excessive re‑renders
     - Caveats: terminal control sequences, wrapping, cursor positioning; you’ll need minimal ANSI parser or rely on Ink’s string rendering; selection/copy remains terminal‑dependent
  2) “Open externally” for heavy terminals
     - Use Ink for everything except deep interactive shells; on “Open Terminal”, spawn `tmux` (if present) or platform terminal (`wezterm`, `alacritty`, `gnome-terminal`, `wt`) and attach to the PTY/working dir
- Key considerations:
  - Use `useStdin({isRawMode:true})` carefully; toggle raw mode only when terminal view is focused
  - Coalesce PTY output chunks; avoid setState per chunk; batch into frames
  - Keep scrollback capped (e.g., 5–10k lines per terminal)

Hybrid (Ink control plane + tmux terminals)

- Navigation, Jira search, compose status, quick actions in Ink
- “Open” sends users into a tmux window/pane. On exit, the Ink app still shows status
- Works well incrementally and is easiest to ship quickly with stability

CLI and Packaging

- New package (examples):
  - `packages/wtm-tui/` (Ink app)
  - `packages/wtm-cli/` (tmux/screen orchestrator; can be merged with TUI if preferred)
- Publish as an npm binary (`bin: { "wtm": "dist/cli.js" }`)
- Bundle with `esbuild` for a single fast executable JS

Suggested Phased Plan

Phase 0 — Bootstrap (Hybrid baseline)

- Create `wtm` CLI with: `wtm project open <path>`, `wtm ws list|create|delete`, `wtm tmux attach`
- Reuse: `WorkspaceManager`, `ProjectManager`, `DockerComposeInspector`, `jiraTicketCache`
- Implement tmux session/window/pane orchestration; Windows: detect `tmux`, else fall back to external terminal

Phase 1 — Ink control plane

- Ink app for list/navigation/search
- Integrate Jira search; list branches; create workspace flow
- Actions trigger tmux windows for terminals

Phase 2 — Embedded terminal (optional)

- Add a focused “Terminal View” using `TerminalHostClient`
- Provide at least one slot with live output (non‑interactive or limited interactivity); optimize perf

Phase 3 — Polish

- Keybinding palette, configurable layouts, quick actions, compose controls
- Persist preferences in project `.wtm/config.json`

Technical Notes and Reuse

- Terminal host/client:
  - Already independent from Electron; spawnable from Node TUI
  - Configure socket via `WTM_TERMINAL_HOST_SOCKET` env var (client already supports)
- Workspace/Docker/Jira logic:
  - Import directly; factor out any Electron `dialog` usage (use prompt/flags)
- State and persistence:
  - Reuse `TerminalSessionStore` and project config; both are simple file stores

Minimal Skeletons

Ink entry (TypeScript)

```ts
// packages/wtm-tui/src/index.tsx
import React from 'react';
import {render} from 'ink';
import App from './ui/App.js';

render(<App />);
```

```ts
// packages/wtm-tui/src/ui/App.tsx
import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {WorkspaceManager} from '../../../src/core/workspaceManager.js';

export default function App() {
  const [items, setItems] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    (async () => {
      const wm = new WorkspaceManager({
        repoDir: process.cwd(),
        workspaceRoot: `${process.cwd()}/.wtm/workspaces`,
      });
      const list = await wm.listWorkspaces();
      setItems(list.map((w) => w.relativePath));
    })();
  }, []);

  useInput((input, key) => {
    if (key.downArrow) setIdx((i) => Math.min(i + 1, items.length - 1));
    if (key.upArrow) setIdx((i) => Math.max(i - 1, 0));
    if (key.return) {
      // trigger action: open tmux window for selected workspace
    }
  });

  return (
    <Box flexDirection="column">
      <Text>WTM — Worktrees</Text>
      {items.map((it, i) => (
        <Text key={it}>{i === idx ? '> ' : '  '}{it}</Text>
      ))}
    </Box>
  );
}
```

tmux orchestration helper (Node)

```ts
// packages/wtm-cli/src/tmux.ts
import {execa} from 'execa';

export async function ensureSession(session: string, cwd: string) {
  const {stdout} = await execa('tmux', ['list-sessions', '-F', '#S'], {reject: false});
  if (!stdout.split('\n').includes(session)) {
    await execa('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
  }
}

export async function ensureWindow(session: string, window: string, cwd: string) {
  const {stdout} = await execa('tmux', ['list-windows', '-t', session, '-F', '#W'], {reject: false});
  if (!stdout.split('\n').includes(window)) {
    await execa('tmux', ['new-window', '-t', session, '-n', window, '-c', cwd]);
  }
}

export async function attach(session: string) {
  await execa('tmux', ['attach', '-t', session], {stdio: 'inherit'});
}
```

Recommendation

- Start with the Hybrid approach:
  - Ship a small Ink control plane for navigation and actions
  - Use tmux for terminals to deliver robust interactivity from day one
  - Later, add an embedded terminal view behind a feature flag if desired

Risks and Mitigations

- Availability of tmux
  - Detect at runtime; if missing, fall back to external terminal launcher or a read‑only Ink log view
- Windows compatibility
  - Support WSL+tmux; otherwise use Windows Terminal tabs via `wt` as a partial replacement
- PTY spam overwhelming Ink
  - Use batching/throttling, cap scrollback, and prefer tmux for heavy shells

Testing Strategy

- Unit test the git and project logic (already in repo)
- CLI e2e with Playwright in headless terminal or `expect`/`script` harness
- tmux orchestrator via ephemeral sessions in CI (namespaced by run ID)
