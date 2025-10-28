const ToastKind = {
  INFO: "info",
  SUCCESS: "success",
  ERROR: "error",
};

const DEFAULT_TERMINALS = [
  {
    key: "npm-install",
    label: "npm i",
    command: "npm",
    args: ["i"],
  },
  {
    key: "lerna-bootstrap",
    label: "npm run lerna:bootstrap",
    command: "npm",
    args: ["run", "lerna:bootstrap"],
  },
];

function escapeHtml(value) {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class ToastManager {
  constructor(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Toast container #${containerId} not found`);
    }
    this.container = container;
  }

  show(message, kind = ToastKind.INFO, duration = 4200) {
    const toast = document.createElement("div");
    toast.className = ["toast", kind].join(" ").trim();
    toast.textContent = message;
    this.container.appendChild(toast);

    const remove = () => toast.remove();
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(4px)";
      setTimeout(remove, 240);
    }, duration - 240);
  }

  info(message) {
    this.show(message, ToastKind.INFO);
  }

  success(message) {
    this.show(message, ToastKind.SUCCESS);
  }

  error(message) {
    this.show(message, ToastKind.ERROR, 5600);
  }
}

class WorkspaceApp {
  constructor(workspaceAPI) {
    this.workspaceAPI = workspaceAPI;
    this.terminalAPI = window.terminalAPI;
    if (!this.terminalAPI) {
      throw new Error("Terminal API bridge missing from preload context.");
    }
    this.TerminalCtor = window.Terminal;
    this.FitAddonCtor = window.FitAddon?.FitAddon;
    if (!this.TerminalCtor || !this.FitAddonCtor) {
      throw new Error("Terminal dependencies failed to load.");
    }
    this.toast = new ToastManager("toast-container");
    this.listEl = this.requireElement("workspace-list");
    this.createForm = this.requireElement("create-form");
    this.branchInput = this.requireElement("branch-input");
    this.baseInput = this.requireElement("base-input");
    this.createButton = this.requireElement("create-button");
    this.refreshButton = this.requireElement("refresh-button");
    this.tabsContainer = this.requireElement("workspace-tabs");
    this.tabBar = this.requireElement("workspace-tab-bar");
    this.tabPanels = this.requireElement("workspace-tab-panels");
    this.placeholderEl = this.requireElement("workspace-detail-placeholder");

    this.workspaces = [];
    this.isRefreshing = false;
    this.openWorkspaces = new Map();
    this.activeWorkspacePath = null;
    this.sessionMap = new Map();
    this.rowElements = new Map();
    this.unsubscribe = [];
    this.defaultTerminals = DEFAULT_TERMINALS;

    this.unsubscribe.push(this.terminalAPI.onData((payload) => this.handleTerminalData(payload)));
    this.unsubscribe.push(this.terminalAPI.onExit((payload) => this.handleTerminalExit(payload)));

    this.handleWindowResizeBound = () => this.handleWindowResize();
    window.addEventListener("resize", this.handleWindowResizeBound);
    window.addEventListener("beforeunload", () => this.teardown());

    this.setupEventListeners();
    this.renderLoading();
    this.loadWorkspaces();
  }

  requireElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Expected element with id '${id}'`);
    }
    return element;
  }

  setupEventListeners() {
    this.createForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.handleCreate();
    });

    this.refreshButton.addEventListener("click", () => {
      void this.loadWorkspaces(true);
    });
  }

  async loadWorkspaces(showToast = false) {
    if (this.isRefreshing) return;

    this.isRefreshing = true;
    this.refreshButton.disabled = true;
    this.refreshButton.textContent = "Refreshing…";

    try {
      const workspaces = await this.workspaceAPI.list();
      this.workspaces = this.sortWorkspaces(workspaces);
      this.render();
      if (showToast) {
        this.toast.success("Workspace list refreshed");
      }
    } catch (error) {
      console.error("Failed to load workspaces", error);
      this.toast.error(this.normaliseError(error));
      this.renderError();
    } finally {
      this.isRefreshing = false;
      this.refreshButton.disabled = false;
      this.refreshButton.textContent = "Refresh";
    }
  }

  async handleCreate() {
    const branch = this.branchInput.value.trim();
    const baseRef = this.baseInput.value.trim();

    if (!branch) {
      this.toast.error("Branch name is required");
      this.branchInput.focus();
      return;
    }

    this.createButton.disabled = true;
    this.createButton.textContent = "Creating…";

    try {
      const workspace = await this.workspaceAPI.create({
        branch,
        baseRef: baseRef || undefined,
      });

      const index = this.workspaces.findIndex((item) => item.path === workspace.path);
      if (index >= 0) {
        this.workspaces[index] = workspace;
      } else {
        this.workspaces.push(workspace);
        this.workspaces = this.sortWorkspaces(this.workspaces);
      }

      this.render();
      this.toast.success(`Workspace ready for ${workspace.branch}`);
      this.createForm.reset();
      this.branchInput.focus();
    } catch (error) {
      console.error("Failed to create workspace", error);
      this.toast.error(this.normaliseError(error));
    } finally {
      this.createButton.disabled = false;
      this.createButton.textContent = "Create Workspace";
    }
  }

  async handleDelete(path) {
    const workspace = this.workspaces.find((item) => item.path === path);
    if (!workspace) return;

    let force = false;
    if (!workspace.status.clean) {
      const confirmMessage =
        `${workspace.branch} has ${workspace.status.changeCount} uncommitted change` +
        (workspace.status.changeCount === 1 ? "." : "s.") +
        "\nDeleting the workspace will discard them. Continue?";
      const confirmed = window.confirm(confirmMessage);
      if (!confirmed) return;
      force = true;
    }

    try {
      const result = await this.workspaceAPI.delete({ path, force });
      if (!result.success) {
        if (result.reason === "dirty") {
          this.toast.error("Workspace still has uncommitted changes. Delete with force to continue.");
        } else {
          this.toast.error(result.message ?? "Unable to delete workspace");
        }
        void this.refreshSingle(path);
        return;
      }

      this.workspaces = this.workspaces.filter((item) => item.path !== path);
      this.render();
      this.toast.info("Workspace removed");
    } catch (error) {
      console.error("Failed to delete workspace", error);
      this.toast.error(this.normaliseError(error));
      void this.refreshSingle(path);
    }
  }

  async refreshSingle(path) {
    try {
      const updated = await this.workspaceAPI.refresh({ path });
      const index = this.workspaces.findIndex((item) => item.path === path);
      if (index >= 0) {
        this.workspaces[index] = updated;
        this.render();
      }
    } catch (error) {
      console.warn("Failed to refresh workspace", error);
    }
  }

  renderLoading() {
    this.listEl.innerHTML = "<div class=\"empty-state\">Loading workspaces…</div>";
  }

  renderError() {
    this.listEl.innerHTML = "<div class=\"empty-state\">Unable to load workspaces. Try refreshing.</div>";
  }

  render() {
    if (this.workspaces.length === 0) {
      this.listEl.innerHTML =
        "<div class=\"empty-state\">No workspaces yet. Create one to get started.</div>";
      return;
    }

    const rows = this.workspaces.map((workspace) => this.renderWorkspaceRow(workspace)).join("");
    this.listEl.innerHTML = rows;
    this.rowElements.clear();

    const pathsToRemove = [];
    this.openWorkspaces.forEach((state, path) => {
      const updated = this.workspaces.find((item) => item.path === path);
      if (updated) {
        state.workspace = updated;
        const label = updated.branch || updated.relativePath || updated.path;
        state.tabButton.textContent = label;
        state.tabButton.title = `${label}\n${updated.path}`;
      } else {
        pathsToRemove.push(path);
      }
    });
    pathsToRemove.forEach((path) => this.closeWorkspaceTab(path));

    this.listEl.querySelectorAll(".workspace-row").forEach((row) => {
      const targetPath = row.dataset.path;
      if (!targetPath) {
        return;
      }
      this.rowElements.set(targetPath, row);
      row.addEventListener("dblclick", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button")) {
          return;
        }
        this.handleWorkspaceRowDoubleClick(targetPath);
      });
    });

    this.listEl.querySelectorAll("button[data-action=\"delete\"]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetPath = button.dataset.path;
        if (!targetPath) return;
        button.disabled = true;
        void this.handleDelete(targetPath).finally(() => {
          button.disabled = false;
        });
      });
    });

    this.listEl.querySelectorAll("button[data-action=\"refresh\"]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetPath = button.dataset.path;
        if (!targetPath) return;
        button.disabled = true;
        button.classList.add("is-loading");
        void this.refreshSingle(targetPath).finally(() => {
          button.disabled = false;
          button.classList.remove("is-loading");
        });
      });
    });

    this.updateActiveRowHighlight();
  }

  renderWorkspaceRow(workspace) {
    const status = workspace.status;
    const isFolder = workspace.kind === "folder";
    const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";
    const statusClass = isFolder ? "folder" : status.clean ? "clean" : "dirty";
    const tooltipLines = [
      `Branch: ${branchLabel}`,
      `Worktree: ${workspace.relativePath || "—"}`,
      `Path: ${workspace.path}`,
      `HEAD: ${workspace.headSha || "—"}`,
      status.upstream ? `Upstream: ${status.upstream}` : "Upstream: —",
      `Status: ${status.summary}`,
    ];

    if (!status.clean && status.changeCount) {
      tooltipLines.push(
        `${status.changeCount} uncommitted change${status.changeCount === 1 ? "" : "s"}`,
      );
    }

    if (workspace.lastCommit) {
      tooltipLines.push(
        `Last commit: ${workspace.lastCommit.shortSha} ${workspace.lastCommit.relativeTime} — ${workspace.lastCommit.subject}`,
      );
    }

    const tooltip = tooltipLines.map((line) => escapeHtml(line)).join("&#10;");
    const icons = this.buildStatusIcons(workspace);

    const actionsHtml = isFolder
      ? ""
      : `
        <div class="workspace-row-actions">
          <button
            class="row-icon-button"
            data-action="refresh"
            data-path="${escapeHtml(workspace.path)}"
            aria-label="Rescan workspace"
            title="Rescan workspace"
          >⟳</button>
          <button
            class="row-icon-button danger"
            data-action="delete"
            data-path="${escapeHtml(workspace.path)}"
            aria-label="Delete workspace"
            title="Delete workspace"
          >✖</button>
        </div>`;

    return `
      <div
        class="workspace-row ${statusClass}"
        data-path="${escapeHtml(workspace.path)}"
        data-kind="${isFolder ? "folder" : "worktree"}"
        title="${tooltip}"
      >
        <div class="workspace-primary">
          <span class="workspace-marker"></span>
          <span class="workspace-name">${escapeHtml(branchLabel)}</span>
        </div>
        <div class="workspace-icons">${icons}</div>
        ${actionsHtml}
      </div>
    `;
  }

  handleWorkspaceRowDoubleClick(path) {
    const workspace = this.workspaces.find((item) => item.path === path);
    if (!workspace || workspace.kind === "folder") {
      return;
    }
    this.openWorkspaceTab(workspace);
  }

  openWorkspaceTab(workspace) {
    const existing = this.openWorkspaces.get(workspace.path);
    if (existing) {
      this.activateWorkspaceTab(workspace.path);
      return;
    }

    const tabButton = document.createElement("button");
    tabButton.className = "workspace-tab";
    tabButton.type = "button";
    const label = workspace.branch || workspace.relativePath || workspace.path;
    tabButton.textContent = label;
    tabButton.title = `${label}\n${workspace.path}`;
    tabButton.addEventListener("click", () => {
      this.activateWorkspaceTab(workspace.path);
    });

    const panel = document.createElement("div");
    panel.className = "workspace-panel";
    panel.dataset.path = workspace.path;

    const terminalTabs = document.createElement("div");
    terminalTabs.className = "terminal-tabs";

    const terminalPanels = document.createElement("div");
    terminalPanels.className = "terminal-panels";

    panel.appendChild(terminalTabs);
    panel.appendChild(terminalPanels);

    this.tabBar.appendChild(tabButton);
    this.tabPanels.appendChild(panel);

    const workspaceState = {
      workspace,
      tabButton,
      panel,
      terminalTabs,
      terminalPanels,
      terminals: new Map(),
      activeTerminalKey: null,
    };

    this.openWorkspaces.set(workspace.path, workspaceState);
    this.updateWorkspacePlaceholderVisibility();

    this.defaultTerminals.forEach((terminalDef) => {
      void this.ensureWorkspaceTerminal(workspaceState, terminalDef);
    });

    this.activateWorkspaceTab(workspace.path);
  }

  activateWorkspaceTab(path) {
    this.activeWorkspacePath = path;
    this.openWorkspaces.forEach((state, key) => {
      const isActive = key === path;
      state.tabButton.classList.toggle("is-active", isActive);
      state.panel.classList.toggle("is-active", isActive);
      if (isActive) {
        if (!state.activeTerminalKey && this.defaultTerminals.length > 0) {
          state.activeTerminalKey = this.defaultTerminals[0].key;
        }
        if (state.activeTerminalKey) {
          this.activateTerminal(state, state.activeTerminalKey);
        }
      }
    });
    this.updateActiveRowHighlight();
  }

  activateTerminal(workspaceState, terminalKey) {
    const record = workspaceState.terminals.get(terminalKey);
    if (!record) return;

    workspaceState.activeTerminalKey = terminalKey;
    workspaceState.terminals.forEach((entry, key) => {
      const isActive = key === terminalKey;
      entry.tabButton.classList.toggle("is-active", isActive);
      entry.panel.classList.toggle("is-active", isActive);
      if (isActive) {
        requestAnimationFrame(() => {
          entry.fitAddon.fit();
          if (!entry.closed) {
            this.terminalAPI.resize(entry.sessionId, entry.terminal.cols, entry.terminal.rows);
          }
          entry.terminal.focus();
        });
      }
    });
  }

  async ensureWorkspaceTerminal(workspaceState, terminalDef) {
    if (workspaceState.terminals.has(terminalDef.key)) {
      const existing = workspaceState.terminals.get(terminalDef.key);
      if (existing) {
        existing.tabButton.classList.remove("is-exited");
      }
      return workspaceState.terminals.get(terminalDef.key);
    }

    const tabButton = document.createElement("button");
    tabButton.className = "terminal-tab";
    tabButton.type = "button";
    tabButton.textContent = terminalDef.label;
    tabButton.title = terminalDef.label;

    const panel = document.createElement("div");
    panel.className = "terminal-panel";
    panel.dataset.key = terminalDef.key;

    const view = document.createElement("div");
    view.className = "terminal-view";
    panel.appendChild(view);

    workspaceState.terminalTabs.appendChild(tabButton);
    workspaceState.terminalPanels.appendChild(panel);

    const terminal = new this.TerminalCtor({
      convertEol: true,
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "SFMono-Regular", monospace',
      theme: {
        background: "#070d1d",
        foreground: "#d1d5db",
        cursor: "#38bdf8",
        selectionBackground: "#1e293b",
      },
      scrollback: 2000,
    });

    const fitAddon = new this.FitAddonCtor();
    terminal.loadAddon(fitAddon);

    terminal.open(view);
    fitAddon.fit();

    let sessionInfo;
    try {
      sessionInfo = await this.terminalAPI.ensureSession({
        workspacePath: workspaceState.workspace.path,
        slot: terminalDef.key,
        command: terminalDef.command,
        args: terminalDef.args,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    } catch (error) {
      console.error("Failed to create terminal session", error);
      this.toast.error(`Failed to start terminal: ${terminalDef.label}`);
      terminal.dispose();
      workspaceState.terminalTabs.removeChild(tabButton);
      workspaceState.terminalPanels.removeChild(panel);
      return null;
    }

    this.terminalAPI.resize(sessionInfo.sessionId, terminal.cols, terminal.rows);

    terminal.onData((data) => {
      this.terminalAPI.write(sessionInfo.sessionId, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      this.terminalAPI.resize(sessionInfo.sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(view);

    const record = {
      key: terminalDef.key,
      sessionId: sessionInfo.sessionId,
      terminal,
      fitAddon,
      view,
      tabButton,
      panel,
      resizeObserver,
      closed: false,
    };

    tabButton.addEventListener("click", () => {
      this.activateTerminal(workspaceState, terminalDef.key);
    });

    workspaceState.terminals.set(terminalDef.key, record);
    this.sessionMap.set(sessionInfo.sessionId, record);

    if (
      !workspaceState.activeTerminalKey ||
      workspaceState.activeTerminalKey === terminalDef.key
    ) {
      this.activateTerminal(workspaceState, terminalDef.key);
    }

    return record;
  }

  closeWorkspaceTab(path, options = {}) {
    const { silent = false } = options;
    const workspaceState = this.openWorkspaces.get(path);
    if (!workspaceState) return;

    workspaceState.terminals.forEach((record) => {
      record.resizeObserver?.disconnect();
      record.terminal.dispose();
      this.sessionMap.delete(record.sessionId);
      void this.terminalAPI.dispose(record.sessionId);
    });
    workspaceState.terminals.clear();

    workspaceState.tabButton.remove();
    workspaceState.panel.remove();
    this.openWorkspaces.delete(path);

    if (this.activeWorkspacePath === path) {
      this.activeWorkspacePath = null;
      if (!silent) {
        const iterator = this.openWorkspaces.keys();
        const next = iterator.next();
        if (!next.done) {
          this.activateWorkspaceTab(next.value);
        }
      }
    }

    this.updateWorkspacePlaceholderVisibility();
    this.updateActiveRowHighlight();
  }

  updateWorkspacePlaceholderVisibility() {
    if (this.openWorkspaces.size === 0) {
      this.placeholderEl.classList.remove("is-hidden");
      this.tabsContainer.classList.add("is-hidden");
    } else {
      this.placeholderEl.classList.add("is-hidden");
      this.tabsContainer.classList.remove("is-hidden");
    }
  }

  updateActiveRowHighlight() {
    this.rowElements.forEach((row, path) => {
      row.classList.toggle("is-active", path === this.activeWorkspacePath);
    });
  }

  handleTerminalData(payload) {
    const record = payload ? this.sessionMap.get(payload.sessionId) : undefined;
    if (!record) {
      return;
    }
    record.terminal.write(payload.data);
  }

  handleTerminalExit(payload) {
    const record = payload ? this.sessionMap.get(payload.sessionId) : undefined;
    if (!record || record.closed) {
      return;
    }
    record.closed = true;
    record.tabButton.classList.add("is-exited");
    const exitCode = payload.exitCode ?? 0;
    const signal = payload.signal ? ` (signal ${payload.signal})` : "";
    record.terminal.write(
      `\r\n\x1b[38;5;110mProcess exited with code ${exitCode}${signal}\x1b[0m\r\n`,
    );
  }

  handleWindowResize() {
    if (!this.activeWorkspacePath) return;
    const workspaceState = this.openWorkspaces.get(this.activeWorkspacePath);
    if (!workspaceState || !workspaceState.activeTerminalKey) return;
    const record = workspaceState.terminals.get(workspaceState.activeTerminalKey);
    if (!record || record.closed) return;
    record.fitAddon.fit();
    this.terminalAPI.resize(record.sessionId, record.terminal.cols, record.terminal.rows);
  }

  teardown() {
    window.removeEventListener("resize", this.handleWindowResizeBound);
    this.unsubscribe.forEach((unsubscribe) => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn("Failed to remove terminal listener", error);
      }
    });
    this.unsubscribe = [];

    const openPaths = Array.from(this.openWorkspaces.keys());
    openPaths.forEach((path) => this.closeWorkspaceTab(path, { silent: true }));
  }

  buildStatusIcons(workspace) {
    const status = workspace.status;
    if (workspace.kind === "folder") {
      return '<span class="status-icon folder" title="Folder not linked to a git worktree">📁</span>';
    }

    const icons = [];
    if (status.clean) {
      icons.push('<span class="status-icon clean" title="Clean working tree">✔</span>');
    } else {
      const changeCount = status.changeCount ?? 0;
      const changeLabel =
        changeCount > 0
          ? `${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`
          : status.summary;
      const warningText =
        changeCount > 0 ? `⚠${escapeHtml(String(changeCount))}` : "⚠";
      icons.push(
        `<span class="status-icon dirty" title="${escapeHtml(changeLabel)}">${warningText}</span>`,
      );
    }

    if (status.ahead) {
      icons.push(
        `<span class="status-icon ahead" title="Ahead by ${escapeHtml(
          String(status.ahead),
        )} commit${status.ahead === 1 ? "" : "s"}">↑${escapeHtml(String(status.ahead))}</span>`,
      );
    }

    if (status.behind) {
      icons.push(
        `<span class="status-icon behind" title="Behind by ${escapeHtml(
          String(status.behind),
        )} commit${status.behind === 1 ? "" : "s"}">↓${escapeHtml(String(status.behind))}</span>`,
      );
    }

    if (icons.length === 0) {
      icons.push('<span class="status-icon" title="No status information">•</span>');
    }

    return icons.join("");
  }

  sortWorkspaces(workspaces) {
    return [...workspaces].sort((a, b) => {
      const aKey = a.branch || a.relativePath || a.path;
      const bKey = b.branch || b.relativePath || b.path;
      const branchCompare = aKey.localeCompare(bKey);
      if (branchCompare !== 0) return branchCompare;
      return a.path.localeCompare(b.path);
    });
  }

  normaliseError(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
    return "Unexpected error";
  }
}

async function bootstrapWorkspaceApp() {
  if (window.workspaceAPI) {
    void new WorkspaceApp(window.workspaceAPI);
    return;
  }
  const maxAttempts = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (window.workspaceAPI) {
      void new WorkspaceApp(window.workspaceAPI);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  console.error("workspaceAPI preload bridge missing after waiting");
}

void bootstrapWorkspaceApp();
