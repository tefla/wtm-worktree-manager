const ToastKind = {
  INFO: "info",
  SUCCESS: "success",
  ERROR: "error",
};

const DEFAULT_QUICK_ACCESS = [
  {
    key: "npm-install",
    label: "npm i",
    quickCommand: "npm i",
  },
  {
    key: "lerna-bootstrap",
    label: "npm run lerna:bootstrap",
    quickCommand: "npm run lerna:bootstrap",
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
    this.settingsAPI = window.settingsAPI;
    if (!this.settingsAPI) {
      throw new Error("Settings API bridge missing from preload context.");
    }
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
    this.environmentSelect = this.requireElement("environment-select");
    this.tabsContainer = this.requireElement("workspace-tabs");
    this.tabBar = this.requireElement("workspace-tab-bar");
    this.tabPanels = this.requireElement("workspace-tab-panels");
    this.placeholderEl = this.requireElement("workspace-detail-placeholder");
    this.deleteDialog = this.setupDeleteDialog();

    this.workspaces = [];
    this.isRefreshing = false;
    this.refreshPromise = null;
    this.openWorkspaces = new Map();
    this.activeWorkspacePath = null;
    this.sessionMap = new Map();
    this.rowElements = new Map();
    this.unsubscribe = [];
    this.defaultTerminals = this.normaliseQuickAccessList(DEFAULT_QUICK_ACCESS, {
      fallbackToDefault: true,
    });
    this.hasRestoredWorkspaces = false;
    this.environments = [];
    this.activeEnvironmentName = "";

    this.environmentSelect.innerHTML = "";
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = "Loading…";
    loadingOption.disabled = true;
    loadingOption.selected = true;
    this.environmentSelect.appendChild(loadingOption);
    this.environmentSelect.disabled = true;

    this.unsubscribe.push(this.terminalAPI.onData((payload) => this.handleTerminalData(payload)));
    this.unsubscribe.push(this.terminalAPI.onExit((payload) => this.handleTerminalExit(payload)));

    this.handleWindowResizeBound = () => this.handleWindowResize();
    window.addEventListener("resize", this.handleWindowResizeBound);
    window.addEventListener("beforeunload", () => this.teardown());

    this.setupEventListeners();
    this.renderLoading();
    void this.initialize();
  }

  requireElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Expected element with id '${id}'`);
    }
    return element;
  }

  slugify(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  normaliseQuickAccessList(list, options = {}) {
    const { fallbackToDefault = false } = options;
    const source = Array.isArray(list) ? list : [];
    const normalized = [];
    const seenKeys = new Set();

    source.forEach((entry, index) => {
      const normalizedEntry = this.normalizeQuickAccessEntry(entry, index);
      if (!normalizedEntry) {
        return;
      }
      let { key } = normalizedEntry;
      let counter = 1;
      while (seenKeys.has(key)) {
        key = `${normalizedEntry.key}-${(counter += 1)}`;
      }
      seenKeys.add(key);
      normalized.push({
        key,
        label: normalizedEntry.label,
        quickCommand: normalizedEntry.quickCommand,
      });
    });

    if (normalized.length === 0 && fallbackToDefault) {
      return DEFAULT_QUICK_ACCESS.map((item) => ({ ...item }));
    }

    return normalized;
  }

  normalizeQuickAccessEntry(entry, index) {
    if (!entry || (typeof entry !== "string" && typeof entry !== "object")) {
      return null;
    }

    if (typeof entry === "string") {
      const value = entry.trim();
      if (!value) {
        return null;
      }
      return {
        key: this.slugify(value) || `slot-${index + 1}`,
        label: value,
        quickCommand: value,
      };
    }

    const labelCandidate =
      (typeof entry.label === "string" && entry.label.trim()) ||
      (typeof entry.name === "string" && entry.name.trim()) ||
      "";
    const commandCandidate =
      (typeof entry.quickCommand === "string" && entry.quickCommand.trim()) ||
      (typeof entry.command === "string" && entry.command.trim()) ||
      "";

    if (!labelCandidate && !commandCandidate) {
      return null;
    }

    const label = labelCandidate || commandCandidate || `Command ${index + 1}`;
    const quickCommand = commandCandidate || label;
    const keySource =
      (typeof entry.key === "string" && entry.key.trim()) || label || `slot-${index + 1}`;

    return {
      key: this.slugify(keySource) || `slot-${index + 1}`,
      label,
      quickCommand,
    };
  }

  generateEphemeralKey(workspaceState) {
    const hasRandomUUID = typeof window.crypto?.randomUUID === "function";
    let candidate = "";
    let attempts = 0;
    do {
      if (hasRandomUUID) {
        candidate = `custom-${window.crypto.randomUUID()}`;
      } else {
        const salt = Math.floor(Math.random() * 1e6 + attempts);
        candidate = `custom-${Date.now().toString(36)}-${salt.toString(36)}`;
      }
      attempts += 1;
    } while (workspaceState.terminals.has(candidate));
    return candidate;
  }

  generateEphemeralLabel(workspaceState) {
    const label = `Terminal ${workspaceState.ephemeralCounter}`;
    workspaceState.ephemeralCounter += 1;
    return label;
  }

  registerEphemeralLabel(workspaceState, label) {
    if (!label) {
      return;
    }
    const match = /([0-9]+)\s*$/.exec(label);
    if (!match) {
      return;
    }
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value + 1 > workspaceState.ephemeralCounter) {
      workspaceState.ephemeralCounter = value + 1;
    }
  }

  setupDeleteDialog() {
    const overlay = this.requireElement("delete-dialog-overlay");
    const panel = this.requireElement("delete-dialog-panel");
    const title = this.requireElement("delete-dialog-title");
    const message = this.requireElement("delete-dialog-message");
    const warning = this.requireElement("delete-dialog-warning");
    const summary = this.requireElement("delete-dialog-summary");
    const confirmButton = this.requireElement("delete-dialog-confirm");
    const cancelButton = this.requireElement("delete-dialog-cancel");
    const backdrop = this.requireElement("delete-dialog-backdrop");

    return {
      overlay,
      panel,
      title,
      message,
      warning,
      summary,
      confirmButton,
      cancelButton,
      backdrop,
    };
  }

  setupEventListeners() {
    this.createForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.handleCreate();
    });

    this.refreshButton.addEventListener("click", () => {
      void this.loadWorkspaces(true);
    });

    this.environmentSelect.addEventListener("change", () => {
      void this.handleEnvironmentChange();
    });
  }

  async initialize() {
    try {
      await this.loadEnvironments();
    } catch (error) {
      console.error("Failed to load environments", error);
      this.renderError();
      return;
    }

    await this.loadWorkspaces();
  }

  async loadEnvironments() {
    try {
      const result = await this.settingsAPI.listEnvironments();
      const environments = Array.isArray(result?.environments) ? result.environments : [];
      this.environments = environments;
      const active =
        typeof result?.activeEnvironment === "string"
          ? result.activeEnvironment
          : environments[0]?.name ?? "";
      this.activeEnvironmentName = active;
      const hasQuickAccessConfig = Array.isArray(result?.quickAccess);
      this.defaultTerminals = this.normaliseQuickAccessList(result?.quickAccess, {
        fallbackToDefault: !hasQuickAccessConfig,
      });
      this.renderEnvironmentOptions();
    } catch (error) {
      const message = this.normaliseError(error);
      this.environmentSelect.innerHTML = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No environments configured";
      option.disabled = true;
      option.selected = true;
      this.environmentSelect.appendChild(option);
      this.environmentSelect.disabled = true;
      this.environmentSelect.title = "";
      this.toast.error(message);
      throw error;
    }
  }

  renderEnvironmentOptions(options = {}) {
    const { preserveDisabled = false } = options;
    this.environmentSelect.innerHTML = "";

    if (this.environments.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No environments configured";
      option.disabled = true;
      option.selected = true;
      this.environmentSelect.appendChild(option);
      this.environmentSelect.disabled = true;
      this.environmentSelect.title = "";
      return;
    }

    let active = this.environments.find((env) => env.name === this.activeEnvironmentName);
    if (!active) {
      active = this.environments[0];
      this.activeEnvironmentName = active.name;
    }

    for (const environment of this.environments) {
      const option = document.createElement("option");
      option.value = environment.name;
      option.textContent = environment.name;
      option.selected = environment.name === this.activeEnvironmentName;
      option.dataset.repoDir = environment.repoDir;
      option.dataset.workspaceRoot = environment.workspaceRoot;
      option.title = `Repo: ${environment.repoDir}\nWorkspaces: ${environment.workspaceRoot}`;
      this.environmentSelect.appendChild(option);
    }

    this.environmentSelect.value = this.activeEnvironmentName;
    this.environmentSelect.title = `Repo: ${active.repoDir}\nWorkspaces: ${active.workspaceRoot}`;

    if (!preserveDisabled) {
      this.environmentSelect.disabled = false;
    }
  }

  async handleEnvironmentChange() {
    const target = this.environmentSelect.value;
    if (!target || target === this.activeEnvironmentName) {
      this.environmentSelect.value = this.activeEnvironmentName;
      return;
    }

    this.environmentSelect.disabled = true;

    try {
      const result = await this.settingsAPI.setActiveEnvironment({ name: target });
      if (Array.isArray(result?.environments)) {
        this.environments = result.environments;
      }

      const active =
        typeof result?.activeEnvironment === "string" ? result.activeEnvironment : target;
      this.activeEnvironmentName = active;
      const hasQuickAccessConfig = Array.isArray(result?.quickAccess);
      this.defaultTerminals = this.normaliseQuickAccessList(result?.quickAccess, {
        fallbackToDefault: !hasQuickAccessConfig,
      });
      this.renderEnvironmentOptions({ preserveDisabled: true });
      this.toast.success(`Switched to ${this.activeEnvironmentName}`);

      this.resetWorkspaceTabs();
      this.workspaces = [];
      this.renderLoading();
      await this.loadWorkspaces();
    } catch (error) {
      console.error("Failed to switch environment", error);
      this.toast.error(this.normaliseError(error));
      this.environmentSelect.value = this.activeEnvironmentName;
    } finally {
      this.environmentSelect.disabled = false;
    }
  }

  resetWorkspaceTabs() {
    const openPaths = Array.from(this.openWorkspaces.keys());
    openPaths.forEach((path) => this.closeWorkspaceTab(path, { silent: true }));
    this.sessionMap.clear();
    this.activeWorkspacePath = null;
    this.rowElements.clear();
    this.updateWorkspacePlaceholderVisibility();
    this.updateActiveRowHighlight();
  }

  async restoreWorkspacesFromStore() {
    let savedWorkspaces;
    try {
      savedWorkspaces = await this.terminalAPI.listSavedWorkspaces();
    } catch (error) {
      console.warn("Failed to restore workspace terminals", error);
      return;
    }

    if (!Array.isArray(savedWorkspaces)) {
      return;
    }

    for (const entry of savedWorkspaces) {
      const workspace = this.workspaces.find((item) => item.path === entry.workspacePath);
      if (!workspace) {
        continue;
      }

      await this.openWorkspaceTab(workspace, { savedState: entry });
      const workspaceState = this.openWorkspaces.get(workspace.path);
      if (!workspaceState) {
        continue;
      }

      const terminals = entry.terminals ?? {};
      const createdTerminals = [];
      for (const [slot, terminalState] of Object.entries(terminals)) {
        const record = workspaceState.terminals.get(slot);
        if (!record) {
          continue;
        }
        record.quickCommandExecuted = Boolean(terminalState.quickCommandExecuted);
        record.savedHistory = terminalState.history ?? "";
        record.lastExitCode = terminalState.lastExitCode ?? null;
        record.lastSignal = terminalState.lastSignal ?? null;
        const shouldAutoLaunch = record.quickCommandExecuted || (record.savedHistory && record.savedHistory.length > 0);
        if (shouldAutoLaunch) {
          const created = await this.createTerminalForRecord(workspaceState, record);
          if (created) {
            createdTerminals.push(slot);
          }
        }
      }

      const preferredActive = entry.activeTerminal;
      const fallbackActive = createdTerminals[0] ?? null;
      const targetActive = preferredActive && workspaceState.terminals.has(preferredActive)
        ? preferredActive
        : fallbackActive;
      if (targetActive) {
        this.setActiveTerminal(workspaceState, targetActive);
      } else {
        this.setActiveTerminal(workspaceState, null);
      }
    }
  }

  async loadWorkspaces(showToast = false) {
    if (this.isRefreshing) {
      if (this.refreshPromise) {
        await this.refreshPromise;
      }
    }

    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    this.refreshButton.disabled = true;
    this.refreshButton.textContent = "Refreshing…";

    const loadTask = (async () => {
      try {
        const workspaces = await this.workspaceAPI.list();
        this.workspaces = this.sortWorkspaces(workspaces);
        this.render();
        if (!this.hasRestoredWorkspaces) {
          this.hasRestoredWorkspaces = true;
          await this.restoreWorkspacesFromStore();
        }
        if (showToast) {
          this.toast.success("Workspace list refreshed");
        }
      } catch (error) {
        console.error("Failed to load workspaces", error);
        this.toast.error(this.normaliseError(error));
        this.renderError();
      } finally {
        this.isRefreshing = false;
        this.refreshPromise = null;
        this.refreshButton.disabled = false;
        this.refreshButton.textContent = "Refresh";
      }
    })();

    this.refreshPromise = loadTask;
    await loadTask;
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

  showDeleteDialog(workspace) {
    const status = workspace.status ?? { clean: true, changeCount: 0, summary: "" };
    const {
      overlay,
      panel,
      title,
      message,
      warning,
      summary,
      confirmButton,
      cancelButton,
      backdrop,
    } = this.deleteDialog;

    const branchLabel = workspace.branch || workspace.relativePath || workspace.path;
    const isFolder = workspace.kind === "folder";
    const changeCount = status.changeCount ?? 0;
    const changeLabel = `${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    title.textContent = isFolder
      ? `Remove folder "${branchLabel}"?`
      : `Remove workspace "${branchLabel}"?`;
    message.textContent = isFolder
      ? "The folder will be removed from the workspace directory."
      : "This action detaches the worktree and removes the folder from disk.";

    if (!status.clean) {
      warning.textContent = `${changeLabel} will be lost.`;
      warning.classList.remove("is-hidden");
    } else {
      warning.textContent = "";
      warning.classList.add("is-hidden");
    }

    const details = [];
    if (workspace.branch) {
      details.push(`Branch: ${workspace.branch}`);
    } else if (!isFolder) {
      details.push("Branch: Detached HEAD");
    }
    if (workspace.relativePath) {
      details.push(`Folder: ${workspace.relativePath}`);
    }
    details.push(`Path: ${workspace.path}`);
    if (workspace.headSha) {
      details.push(`HEAD: ${workspace.headSha}`);
    }
    if (workspace.lastCommit) {
      details.push(
        `Last commit: ${workspace.lastCommit.shortSha} — ${workspace.lastCommit.subject}`,
      );
    }
    if (!status.clean) {
      details.push(changeLabel);
    }

    const summaryItems = details
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("");

    let changeSamples = "";
    if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
      const samples = status.sampleChanges
        .slice(0, 5)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("");
      changeSamples = `<li>${escapeHtml("Recent changes:")}<ul class="dialog-sublist">${samples}</ul></li>`;
    }

    summary.innerHTML = summaryItems + changeSamples;

    const confirmLabel = !status.clean && !isFolder ? "Delete and discard changes" : "Delete workspace";
    confirmButton.textContent = isFolder ? "Delete folder" : confirmLabel;

    overlay.classList.remove("is-hidden");
    overlay.setAttribute("aria-hidden", "false");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        overlay.classList.add("is-hidden");
        overlay.setAttribute("aria-hidden", "true");
        confirmButton.removeEventListener("click", onConfirm);
        cancelButton.removeEventListener("click", onCancel);
        backdrop.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKeydown);
        const isDisabled = Boolean(
          previousFocus &&
            typeof previousFocus === "object" &&
            "disabled" in previousFocus &&
            previousFocus.disabled,
        );
        if (previousFocus && typeof previousFocus.focus === "function" && !isDisabled) {
          previousFocus.focus();
        } else if (panel && typeof panel.blur === "function") {
          panel.blur();
        }
        resolve(confirmed);
      };

      const onConfirm = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (event) => {
        event.preventDefault();
        finish(false);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      };

      confirmButton.addEventListener("click", onConfirm);
      cancelButton.addEventListener("click", onCancel);
      backdrop.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKeydown);

      queueMicrotask(() => {
        confirmButton.focus();
      });
    });
  }

  async handleDelete(path) {
    const workspace = this.workspaces.find((item) => item.path === path);
    if (!workspace || workspace.kind === "folder") return;

    const confirmed = await this.showDeleteDialog(workspace);
    if (!confirmed) return;

    const force = !workspace.status.clean;

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
      row.addEventListener("click", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button")) {
          return;
        }
        this.handleWorkspaceRowSelect(targetPath);
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

  handleWorkspaceRowSelect(path) {
    const workspace = this.workspaces.find((item) => item.path === path);
    if (!workspace || workspace.kind === "folder") {
      return;
    }
    void this.openWorkspaceTab(workspace);
  }

  async openWorkspaceTab(workspace, options = {}) {
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

    const placeholder = document.createElement("div");
    placeholder.className = "terminal-placeholder";
    placeholder.textContent = "Select a quick action or use the + button to start a terminal.";
    terminalPanels.appendChild(placeholder);

    const savedStateRaw = options.savedState ?? (await this.terminalAPI.getWorkspaceState(workspace.path));
    const savedState = savedStateRaw && typeof savedStateRaw === "object"
      ? savedStateRaw
      : { activeTerminal: null, terminals: {} };

    const workspaceState = {
      workspace,
      tabButton,
      panel,
      terminalTabs,
      terminalPanels,
      placeholder,
      terminals: new Map(),
      terminalDefs: new Map(),
      activeTerminalKey: null,
      savedState,
      addTerminalButton: null,
      ephemeralCounter: 1,
    };

    this.openWorkspaces.set(workspace.path, workspaceState);
    this.updateWorkspacePlaceholderVisibility();

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "terminal-tab-add";
    addButton.textContent = "+";
    addButton.title = "New terminal";
    addButton.setAttribute("aria-label", "New terminal");
    addButton.addEventListener("click", () => {
      this.handleAddTerminal(workspaceState);
    });
    terminalTabs.appendChild(addButton);
    workspaceState.addTerminalButton = addButton;

    this.defaultTerminals.forEach((terminalDef) => {
      this.setupTerminalTab(workspaceState, { ...terminalDef, isEphemeral: false });
    });

    const savedTerminals = (savedState?.terminals && typeof savedState.terminals === "object"
      ? savedState.terminals
      : {}) || {};
    for (const [key, terminalState] of Object.entries(savedTerminals)) {
      if (workspaceState.terminals.has(key)) {
        continue;
      }
      const label =
        typeof terminalState?.label === "string" && terminalState.label.trim()
          ? terminalState.label.trim()
          : this.generateEphemeralLabel(workspaceState);
      this.setupTerminalTab(workspaceState, {
        key,
        label,
        quickCommand: null,
        isEphemeral: true,
      });
    }

    this.activateWorkspaceTab(workspace.path);
  }

  activateWorkspaceTab(path) {
    this.activeWorkspacePath = path;
    this.openWorkspaces.forEach((state, key) => {
      const isActive = key === path;
      state.tabButton.classList.toggle("is-active", isActive);
      state.panel.classList.toggle("is-active", isActive);
      if (isActive && state.activeTerminalKey) {
        this.setActiveTerminal(state, state.activeTerminalKey);
      } else if (!isActive) {
        this.setActiveTerminal(state, null);
      }
    });
    this.updateActiveRowHighlight();
  }

  setupTerminalTab(workspaceState, terminalDef) {
    const tabElement = document.createElement("div");
    tabElement.className = "terminal-tab";
    tabElement.dataset.key = terminalDef.key;
    tabElement.title = terminalDef.label;

    if (terminalDef.isEphemeral) {
      tabElement.classList.add("is-ephemeral");
    }

    const triggerButton = document.createElement("button");
    triggerButton.type = "button";
    triggerButton.className = "terminal-tab-button";
    triggerButton.textContent = terminalDef.label;
    triggerButton.title = terminalDef.label;
    triggerButton.addEventListener("click", () => {
      void this.handleTerminalTabClick(workspaceState, terminalDef.key);
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "terminal-tab-close";
    closeButton.setAttribute("aria-label", `Close ${terminalDef.label}`);
    closeButton.textContent = "×";
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handleTerminalClose(workspaceState, terminalDef.key);
    });

    tabElement.appendChild(triggerButton);
    tabElement.appendChild(closeButton);

    const insertionTarget = workspaceState.addTerminalButton;
    if (insertionTarget && insertionTarget.parentElement === workspaceState.terminalTabs) {
      workspaceState.terminalTabs.insertBefore(tabElement, insertionTarget);
    } else {
      workspaceState.terminalTabs.appendChild(tabElement);
    }

    const savedTerminal = workspaceState.savedState?.terminals?.[terminalDef.key];

    const record = {
      key: terminalDef.key,
      def: { ...terminalDef },
      tabButton: tabElement,
      tabTrigger: triggerButton,
      closeButton,
      panel: null,
      view: null,
      terminal: null,
      fitAddon: null,
      resizeObserver: null,
      sessionId: null,
      closed: false,
      quickCommandExecuted: Boolean(savedTerminal?.quickCommandExecuted),
      savedHistory: savedTerminal?.history ?? "",
      lastExitCode: savedTerminal?.lastExitCode ?? null,
      lastSignal: savedTerminal?.lastSignal ?? null,
      isEphemeral: Boolean(terminalDef.isEphemeral),
      ignoreSavedHistory: false,
    };

    workspaceState.terminals.set(terminalDef.key, record);
    workspaceState.terminalDefs.set(terminalDef.key, record.def);

    if (workspaceState.savedState && typeof workspaceState.savedState === "object") {
      if (!workspaceState.savedState.terminals || typeof workspaceState.savedState.terminals !== "object") {
        workspaceState.savedState.terminals = {};
      }
      if (!workspaceState.savedState.terminals[terminalDef.key]) {
        workspaceState.savedState.terminals[terminalDef.key] = {};
      }
      workspaceState.savedState.terminals[terminalDef.key].label = terminalDef.label;
    }

    if (record.lastExitCode !== null) {
      tabElement.classList.add("is-exited");
    }

    if (record.isEphemeral) {
      this.registerEphemeralLabel(workspaceState, terminalDef.label);
    }

    return record;
  }

  handleAddTerminal(workspaceState) {
    if (!workspaceState) {
      return;
    }
    const key = this.generateEphemeralKey(workspaceState);
    const label = this.generateEphemeralLabel(workspaceState);
    this.setupTerminalTab(workspaceState, {
      key,
      label,
      quickCommand: null,
      isEphemeral: true,
    });
    const record = workspaceState.terminals.get(key);
    if (record) {
      void this.handleTerminalTabClick(workspaceState, key);
    }
  }

  findFallbackTerminalKey(workspaceState, excludeKey) {
    for (const [key] of workspaceState.terminals.entries()) {
      if (key === excludeKey) {
        continue;
      }
      return key;
    }
    return null;
  }

  handleTerminalClose(workspaceState, terminalKey) {
    if (!workspaceState) {
      return;
    }
    const record = workspaceState.terminals.get(terminalKey);
    if (!record) {
      return;
    }

    const wasActive = workspaceState.activeTerminalKey === terminalKey;
    const fallbackKey = wasActive ? this.findFallbackTerminalKey(workspaceState, terminalKey) : null;

    record.resizeObserver?.disconnect();
    if (record.terminal) {
      record.terminal.dispose();
    }

    if (record.sessionId) {
      this.sessionMap.delete(record.sessionId);
      const preserve = !record.isEphemeral;
      void this.terminalAPI
        .dispose(record.sessionId, { preserve })
        .catch((error) => console.warn("Failed to dispose terminal", error));
      record.sessionId = null;
    }

    if (record.panel?.isConnected) {
      record.panel.remove();
    }

    record.panel = null;
    record.view = null;
    record.terminal = null;
    record.fitAddon = null;
    record.resizeObserver = null;
    record.closed = true;
    record.savedHistory = "";
    record.lastExitCode = null;
    record.lastSignal = null;
    record.ignoreSavedHistory = !record.isEphemeral;

    if (record.tabButton) {
      record.tabButton.classList.add("is-exited");
      record.tabButton.classList.remove("is-active");
    }

    if (record.isEphemeral) {
      record.tabButton?.remove();
      workspaceState.terminals.delete(terminalKey);
      workspaceState.terminalDefs.delete(terminalKey);
      if (workspaceState.savedState?.terminals && typeof workspaceState.savedState.terminals === "object") {
        delete workspaceState.savedState.terminals[terminalKey];
      }
    }

    if (wasActive) {
      if (fallbackKey && workspaceState.terminals.has(fallbackKey)) {
        this.setActiveTerminal(workspaceState, fallbackKey);
      } else {
        this.setActiveTerminal(workspaceState, null);
      }
    }
  }

  async handleTerminalTabClick(workspaceState, terminalKey) {
    const record = workspaceState.terminals.get(terminalKey);
    if (!record) return;

    if (!record.terminal) {
      const created = await this.createTerminalForRecord(workspaceState, record);
      if (!created) {
        return;
      }
      if (record.def.quickCommand && !record.quickCommandExecuted) {
        setTimeout(() => {
          this.terminalAPI.write(record.sessionId, `${record.def.quickCommand}\n`);
          record.quickCommandExecuted = true;
          void this.terminalAPI
            .markQuickCommand(workspaceState.workspace.path, record.key)
            .catch((error) => console.warn("Failed to persist quick command flag", error));
        }, 30);
      }
    }

    this.setActiveTerminal(workspaceState, terminalKey);
  }

  setActiveTerminal(workspaceState, terminalKey) {
    workspaceState.activeTerminalKey = terminalKey;
    workspaceState.terminals.forEach((entry, key) => {
      const isActive = key === terminalKey;
      entry.tabButton?.classList.toggle("is-active", isActive);
      if (entry.panel) {
        entry.panel.classList.toggle("is-active", isActive);
      }
      if (isActive && entry.terminal) {
        requestAnimationFrame(() => {
          entry.fitAddon.fit();
          if (!entry.closed) {
            this.terminalAPI.resize(entry.sessionId, entry.terminal.cols, entry.terminal.rows);
          }
          entry.terminal.focus();
        });
      }
    });

    if (terminalKey && workspaceState.placeholder?.isConnected) {
      workspaceState.placeholder.remove();
    }

    if (!terminalKey && workspaceState.placeholder && !workspaceState.placeholder.isConnected) {
      workspaceState.terminalPanels.appendChild(workspaceState.placeholder);
    }

    void this.terminalAPI
      .setActiveTerminal(workspaceState.workspace.path, terminalKey)
      .catch((error) => console.warn("Failed to persist active terminal", error));
  }

  async createTerminalForRecord(workspaceState, record) {
    if (workspaceState.placeholder?.isConnected) {
      workspaceState.placeholder.remove();
    }

    const panel = document.createElement("div");
    panel.className = "terminal-panel";
    panel.dataset.key = record.key;

    const view = document.createElement("div");
    view.className = "terminal-view";
    panel.appendChild(view);

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
        slot: record.key,
        cols: terminal.cols,
        rows: terminal.rows,
        label: record.def.label,
      });
    } catch (error) {
      console.error("Failed to create terminal session", error);
      this.toast.error(`Failed to start terminal: ${record.def.label}`);
      terminal.dispose();
      workspaceState.terminalPanels.removeChild(panel);
      if (workspaceState.placeholder && !workspaceState.placeholder.isConnected) {
        workspaceState.terminalPanels.appendChild(workspaceState.placeholder);
      }
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

    record.sessionId = sessionInfo.sessionId;
    record.terminal = terminal;
    record.fitAddon = fitAddon;
    record.view = view;
    record.panel = panel;
    record.resizeObserver = resizeObserver;
    record.closed = false;
    record.quickCommandExecuted = record.quickCommandExecuted || Boolean(sessionInfo.quickCommandExecuted);
    record.lastExitCode = sessionInfo.lastExitCode ?? null;
    record.lastSignal = sessionInfo.lastSignal ?? null;

    const shouldRestoreHistory = !record.ignoreSavedHistory;
    const history = shouldRestoreHistory ? record.savedHistory || sessionInfo.history || "" : "";
    if (history) {
      terminal.write(history);
    }
    record.ignoreSavedHistory = false;
    record.savedHistory = "";

    if (record.lastExitCode !== null) {
      record.tabButton?.classList.add("is-exited");
    } else {
      record.tabButton?.classList.remove("is-exited");
    }

    this.sessionMap.set(sessionInfo.sessionId, record);

    return record;
  }

  closeWorkspaceTab(path, options = {}) {
    const { silent = false, preserveState = false } = options;
    const workspaceState = this.openWorkspaces.get(path);
    if (!workspaceState) return;

    workspaceState.terminals.forEach((record) => {
      record.resizeObserver?.disconnect();
      if (record.terminal) {
        record.terminal.dispose();
      }
      if (record.sessionId) {
        this.sessionMap.delete(record.sessionId);
        void this.terminalAPI.dispose(record.sessionId, { preserve: preserveState }).catch((error) => {
          console.warn("Failed to dispose terminal", error);
        });
      }
      record.tabButton?.remove();
      record.panel?.remove();
    });
    if (!preserveState) {
      void this.terminalAPI
        .clearWorkspaceState(path)
        .catch((error) => console.warn("Failed to clear workspace terminal state", error));
    }
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
    record.tabButton?.classList.add("is-exited");
    record.lastExitCode = payload.exitCode ?? null;
    record.lastSignal = payload.signal ?? null;
    const exitCode = payload.exitCode ?? 0;
    const signal = payload.signal ? ` (signal ${payload.signal})` : "";
    if (record.terminal) {
      record.terminal.write(
        `\r\n\x1b[38;5;110mProcess exited with code ${exitCode}${signal}\x1b[0m\r\n`,
      );
    }
  }

  handleWindowResize() {
    if (!this.activeWorkspacePath) return;
    const workspaceState = this.openWorkspaces.get(this.activeWorkspacePath);
    if (!workspaceState || !workspaceState.activeTerminalKey) return;
    const record = workspaceState.terminals.get(workspaceState.activeTerminalKey);
    if (!record || record.closed || !record.terminal) return;
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
    openPaths.forEach((path) => this.closeWorkspaceTab(path, { silent: true, preserveState: true }));
  }

  buildStatusTooltip(status) {
    if (!status) {
      return "Status unavailable";
    }

    const lines = [];
    const changeCount = status.changeCount ?? 0;

    if (status.clean) {
      const cleanLabel =
        status.summary && status.summary.trim().toLowerCase() !== "clean"
          ? status.summary.trim()
          : "Clean working tree";
      lines.push(cleanLabel);
    } else if (changeCount > 0) {
      lines.push(`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`);
    } else if (status.summary) {
      lines.push(status.summary.trim());
    }

    if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
      lines.push(...status.sampleChanges.slice(0, 5).map((line) => line.trim()));
    }

    const filtered = lines
      .map((line) => (typeof line === "string" ? line.trim() : ""))
      .filter((line, index, arr) => line && arr.indexOf(line) === index);

    if (filtered.length === 0) {
      filtered.push("Status unavailable");
    }

    return filtered.map((line) => escapeHtml(line)).join("&#10;");
  }

  buildStatusIcons(workspace) {
    const status = workspace.status;
    if (workspace.kind === "folder") {
      return '<span class="status-icon folder" title="Folder not linked to a git worktree">📁</span>';
    }

    const tooltip = this.buildStatusTooltip(status);
    const icons = [];
    if (status.clean) {
      icons.push(`<span class="status-icon clean" title="${tooltip}">✔</span>`);
    } else {
      const changeCount = status.changeCount ?? 0;
      const warningText =
        changeCount > 0 ? `⚠${escapeHtml(String(changeCount))}` : "⚠";
      icons.push(`<span class="status-icon dirty" title="${tooltip}">${warningText}</span>`);
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
