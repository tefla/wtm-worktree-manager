const ToastKind = {
  INFO: "info",
  SUCCESS: "success",
  ERROR: "error",
};

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
    this.toast = new ToastManager("toast-container");
    this.listEl = this.requireElement("workspace-list");
    this.createForm = this.requireElement("create-form");
    this.branchInput = this.requireElement("branch-input");
    this.baseInput = this.requireElement("base-input");
    this.createButton = this.requireElement("create-button");
    this.refreshButton = this.requireElement("refresh-button");

    this.workspaces = [];
    this.isRefreshing = false;

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

    const cards = this.workspaces.map((workspace) => this.renderWorkspaceCard(workspace)).join("");
    console.log("render() inserting", this.workspaces.length, "cards");
    console.log(cards);
    this.listEl.innerHTML = cards;

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
        const originalText = button.textContent;
        button.textContent = "Rescanning…";
        void this.refreshSingle(targetPath).finally(() => {
          button.disabled = false;
          button.textContent = originalText;
        });
      });
    });
  }

  renderWorkspaceCard(workspace) {
    const status = workspace.status;
    const isFolder = workspace.kind === "folder";
    const statusClass = isFolder ? "folder" : status.clean ? "clean" : "dirty";
    const statusLabel = status.summary;

    const aheadBehindParts = [];
    if (status.ahead) aheadBehindParts.push(`↑ ${status.ahead}`);
    if (status.behind) aheadBehindParts.push(`↓ ${status.behind}`);
    const aheadBehind = aheadBehindParts.length > 0 ? aheadBehindParts.join(" · ") : "Up to date";

    const upstreamInfo = status.upstream
      ? `<div>Tracking: <code>${escapeHtml(status.upstream)}</code> — ${escapeHtml(aheadBehind)}</div>`
      : `<div>Tracking: <code>—</code> — ${escapeHtml(aheadBehind)}</div>`;

    let changesDetail = "";
    if (!status.clean) {
      const extra = status.sampleChanges.length < status.changeCount
        ? `<div><code>…and ${status.changeCount - status.sampleChanges.length} more</code></div>`
        : "";
      changesDetail = `<div class="changes">${status.sampleChanges
        .map((line) => `<div><code>${escapeHtml(line)}</code></div>`)
        .join("")}${extra}</div>`;
    }

    const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";

    const commitDetail = workspace.lastCommit
      ? `<div>Last commit: <code>${escapeHtml(workspace.lastCommit.shortSha)}</code> ${escapeHtml(
          workspace.lastCommit.relativeTime,
        )} — ${escapeHtml(workspace.lastCommit.subject)}</div>`
      : "";

    const actionsHtml = isFolder
      ? '<div class="workspace-actions info">Not linked as a git worktree.</div>'
      : `
        <div class="workspace-actions">
          <button class="ghost-button" data-action="refresh" data-path="${escapeHtml(workspace.path)}">Rescan</button>
          <button class="danger-button" data-action="delete" data-path="${escapeHtml(workspace.path)}">Delete</button>
        </div>`;

    return `
      <article class="workspace-card" data-path="${escapeHtml(workspace.path)}">
        <div class="workspace-heading">
          <div class="workspace-title">
            <h2>${escapeHtml(branchLabel)}</h2>
            <span class="status-pill ${statusClass}">
              <span class="dot"></span>
              ${escapeHtml(statusLabel)}
            </span>
          </div>
          <div class="workspace-meta">
            <div>Worktree: <code>${escapeHtml(workspace.relativePath)}</code></div>
            <div>Path: <code>${escapeHtml(workspace.path)}</code></div>
            <div>HEAD: <code>${escapeHtml(workspace.headSha || "—")}</code></div>
            ${upstreamInfo}
            ${commitDetail}
            ${changesDetail}
          </div>
        </div>
        ${actionsHtml}
      </article>
    `;
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
