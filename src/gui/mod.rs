use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{anyhow, Context, Result};
use eframe::{egui, App};

use crate::{
    config::QuickAction,
    git::{self, WorktreeInfo},
    wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path},
};

trait GuiBackend {
    fn list_worktrees(&mut self, repo_root: &Path) -> Result<Vec<WorktreeInfo>>;
    fn add_worktree(&mut self, repo_root: &Path, path: &Path, branch: Option<&str>) -> Result<()>;
    fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()>;
    fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()>;
}

#[derive(Default)]
struct DefaultBackend;

impl GuiBackend for DefaultBackend {
    fn list_worktrees(&mut self, repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
        git::list_worktrees(repo_root)
    }

    fn add_worktree(&mut self, repo_root: &Path, path: &Path, branch: Option<&str>) -> Result<()> {
        git::add_worktree(repo_root, path, branch)
    }

    fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()> {
        git::remove_worktree(repo_root, path, force)
    }

    fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()> {
        spawn_quick_command(repo_root, command)
    }
}

pub fn run_gui(
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
) -> Result<()> {
    let init = GuiInitState {
        repo_root,
        worktrees,
        quick_actions,
    };
    let native_options = eframe::NativeOptions::default();
    eframe::run_native(
        "WTM Worktree Manager",
        native_options,
        Box::new(move |_cc| Box::new(WtmGui::new(init, DefaultBackend::default()))),
    )
    .map_err(|err| anyhow!("failed to launch GUI: {err}"))
}

struct GuiInitState {
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
}

struct WtmGui<B: GuiBackend> {
    backend: B,
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
    new_branch: String,
    status: Option<StatusMessage>,
    pending_removal: Option<PathBuf>,
    force_remove: bool,
}

#[derive(Clone)]
struct StatusMessage {
    text: String,
    kind: StatusKind,
}

#[derive(Clone)]
enum StatusKind {
    Info,
    Error,
}

impl<B: GuiBackend> WtmGui<B> {
    fn new(init: GuiInitState, backend: B) -> Self {
        Self {
            backend,
            repo_root: init.repo_root,
            worktrees: init.worktrees,
            quick_actions: init.quick_actions,
            new_branch: String::new(),
            status: None,
            pending_removal: None,
            force_remove: false,
        }
    }

    fn create_worktree(&mut self) {
        let branch = self.new_branch.trim();
        if branch.is_empty() {
            self.status = Some(StatusMessage::error(
                "Enter a branch name before creating a worktree",
            ));
            return;
        }

        let workspace_root = match ensure_workspace_root(&self.repo_root) {
            Ok(path) => path,
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to prepare workspace: {err}"
                )));
                return;
            }
        };

        let dir_name = branch_dir_name(branch);
        let worktree_path = next_available_workspace_path(&workspace_root, &dir_name);

        match self
            .backend
            .add_worktree(&self.repo_root, &worktree_path, Some(branch))
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!(
                    "Created worktree at {}",
                    worktree_path.display()
                )));
                self.new_branch.clear();
                self.pending_removal = None;
                if let Err(err) = self.reload_worktrees() {
                    self.status = Some(StatusMessage::error(err.to_string()));
                }
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to create worktree: {err}"
                )))
            }
        }
    }

    fn remove_worktree(&mut self, path: &Path) {
        match self
            .backend
            .remove_worktree(&self.repo_root, path, self.force_remove)
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!(
                    "Removed worktree {}",
                    path.display()
                )));
                self.pending_removal = None;
                if let Err(err) = self.reload_worktrees() {
                    self.status = Some(StatusMessage::error(err.to_string()));
                }
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to remove worktree: {err}"
                )));
            }
        }
    }

    fn reload_worktrees(&mut self) -> Result<()> {
        self.worktrees = self.backend.list_worktrees(&self.repo_root)?;
        Ok(())
    }

    fn run_quick_action(&mut self, action: &QuickAction) {
        match self
            .backend
            .spawn_quick_command(&self.repo_root, &action.command)
        {
            Ok(_) => {
                self.status = Some(StatusMessage::info(format!("Started `{}`", action.label)));
            }
            Err(err) => {
                self.status = Some(StatusMessage::error(format!(
                    "Failed to start `{}`: {err}",
                    action.label
                )));
            }
        }
    }

    fn handle_row_action(&mut self, action: RowAction) {
        match action {
            RowAction::StageRemoval(path, name) => {
                self.pending_removal = Some(path);
                self.status = Some(StatusMessage::info(format!("Confirm removal of {name}")));
            }
            RowAction::Remove(path) => {
                self.remove_worktree(&path);
            }
            RowAction::Cancel => {
                self.pending_removal = None;
                self.status = Some(StatusMessage::info("Cancelled removal"));
            }
        }
    }
}

impl StatusMessage {
    fn info(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: StatusKind::Info,
        }
    }

    fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kind: StatusKind::Error,
        }
    }
}

impl StatusKind {
    fn color(&self) -> egui::Color32 {
        match self {
            StatusKind::Info => egui::Color32::from_rgb(0, 130, 65),
            StatusKind::Error => egui::Color32::from_rgb(200, 0, 0),
        }
    }
}

impl<B> App for WtmGui<B>
where
    B: GuiBackend + 'static,
{
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::TopBottomPanel::top("wtm_gui_top").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("WTM Worktree Manager");
                ui.separator();
                ui.label(self.repo_root.display().to_string());
                if ui.button("Refresh").clicked() {
                    if let Err(err) = self.reload_worktrees() {
                        self.status = Some(StatusMessage::error(err.to_string()));
                    } else {
                        self.status = Some(StatusMessage::info("Refreshed worktrees"));
                    }
                }
            });

            let mut dismiss_status = false;
            if let Some(status) = self.status.clone() {
                ui.horizontal(|ui| {
                    ui.colored_label(status.kind.color(), &status.text);
                    if ui.button("Dismiss").clicked() {
                        dismiss_status = true;
                    }
                });
            }
            if dismiss_status {
                self.status = None;
            }
        });

        egui::SidePanel::right("wtm_gui_actions")
            .resizable(false)
            .default_width(200.0)
            .show(ctx, |ui| {
                ui.heading("Quick actions");
                if self.quick_actions.is_empty() {
                    ui.label("No quick actions configured.");
                } else {
                    let mut to_run: Option<QuickAction> = None;
                    for action in self.quick_actions.clone() {
                        if ui.button(&action.label).clicked() && to_run.is_none() {
                            to_run = Some(action);
                        }
                    }
                    if let Some(action) = to_run {
                        self.run_quick_action(&action);
                    }
                }
            });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Worktrees");

            if self.worktrees.is_empty() {
                ui.label("No worktrees available. Use the form below to create one.");
            } else {
                let worktrees = self.worktrees.clone();
                let pending = self.pending_removal.clone();
                let mut next_action: Option<RowAction> = None;
                egui::ScrollArea::vertical()
                    .id_source("worktrees_scroll")
                    .show(ui, |ui| {
                        for worktree in worktrees {
                            ui.group(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(egui::RichText::new(worktree.name()).strong());
                                    if let Some(branch) = &worktree.branch {
                                        ui.label(format!("branch: {}", branch));
                                    }
                                    if let Some(head) = &worktree.head {
                                        let short_head = head.chars().take(7).collect::<String>();
                                        ui.label(format!("HEAD: {}", short_head));
                                    }
                                    if worktree.is_locked {
                                        ui.label(
                                            egui::RichText::new("locked")
                                                .color(egui::Color32::from_rgb(200, 120, 0)),
                                        );
                                    }
                                    if worktree.is_prunable {
                                        ui.label(
                                            egui::RichText::new("prunable")
                                                .color(egui::Color32::from_rgb(200, 120, 0)),
                                        );
                                    }
                                });

                                ui.horizontal(|ui| {
                                    let is_pending = pending
                                        .as_ref()
                                        .map(|p| p == worktree.path())
                                        .unwrap_or(false);
                                    if is_pending {
                                        if ui.button("Confirm removal").clicked() {
                                            if next_action.is_none() {
                                                next_action =
                                                    Some(RowAction::Remove(worktree.path.clone()));
                                            }
                                        }
                                        if ui.button("Cancel").clicked() {
                                            if next_action.is_none() {
                                                next_action = Some(RowAction::Cancel);
                                            }
                                        }
                                    } else if ui.button("Remove").clicked() {
                                        if next_action.is_none() {
                                            next_action = Some(RowAction::StageRemoval(
                                                worktree.path.clone(),
                                                worktree.name(),
                                            ));
                                        }
                                    }
                                });
                            });
                        }
                    });
                if let Some(action) = next_action {
                    self.handle_row_action(action);
                }
            }

            ui.separator();
            ui.heading("Create worktree");
            ui.horizontal(|ui| {
                ui.label("Branch name");
                ui.text_edit_singleline(&mut self.new_branch);
                if ui.button("Create").clicked() {
                    self.create_worktree();
                }
            });
            ui.checkbox(
                &mut self.force_remove,
                "Force removal (discard unmerged changes)",
            );
        });
    }
}

fn spawn_quick_command(repo_root: &Path, command: &str) -> Result<()> {
    if command.trim().is_empty() {
        return Err(anyhow!("quick action command is empty"));
    }

    #[cfg(target_os = "windows")]
    let child = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C");
        cmd.arg(command);
        cmd.current_dir(repo_root);
        cmd.spawn()
            .with_context(|| format!("failed to run quick action `{command}`"))?
    };

    #[cfg(not(target_os = "windows"))]
    let child = {
        let mut cmd = Command::new("sh");
        cmd.arg("-c");
        cmd.arg(command);
        cmd.current_dir(repo_root);
        cmd.spawn()
            .with_context(|| format!("failed to run quick action `{command}`"))?
    };

    // Allow command to continue without waiting in the UI thread.
    drop(child);
    Ok(())
}

enum RowAction {
    StageRemoval(PathBuf, String),
    Remove(PathBuf),
    Cancel,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, path::PathBuf};
    use tempfile::tempdir;

    #[derive(Default)]
    struct MockBackend {
        list_results: VecDeque<Result<Vec<WorktreeInfo>>>,
        add_results: VecDeque<Result<()>>,
        remove_results: VecDeque<Result<()>>,
        quick_results: VecDeque<Result<()>>,
        add_calls: Vec<AddCall>,
        remove_calls: Vec<RemoveCall>,
        quick_calls: Vec<QuickCall>,
    }

    struct AddCall {
        repo_root: PathBuf,
        path: PathBuf,
        branch: Option<String>,
    }

    struct RemoveCall {
        repo_root: PathBuf,
        path: PathBuf,
        force: bool,
    }

    struct QuickCall {
        repo_root: PathBuf,
        command: String,
    }

    impl GuiBackend for MockBackend {
        fn list_worktrees(&mut self, _repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
            self.list_results
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        fn add_worktree(
            &mut self,
            repo_root: &Path,
            path: &Path,
            branch: Option<&str>,
        ) -> Result<()> {
            self.add_calls.push(AddCall {
                repo_root: repo_root.to_path_buf(),
                path: path.to_path_buf(),
                branch: branch.map(|b| b.to_string()),
            });
            self.add_results.pop_front().unwrap_or_else(|| Ok(()))
        }

        fn remove_worktree(&mut self, repo_root: &Path, path: &Path, force: bool) -> Result<()> {
            self.remove_calls.push(RemoveCall {
                repo_root: repo_root.to_path_buf(),
                path: path.to_path_buf(),
                force,
            });
            self.remove_results.pop_front().unwrap_or_else(|| Ok(()))
        }

        fn spawn_quick_command(&mut self, repo_root: &Path, command: &str) -> Result<()> {
            self.quick_calls.push(QuickCall {
                repo_root: repo_root.to_path_buf(),
                command: command.to_string(),
            });
            self.quick_results.pop_front().unwrap_or_else(|| Ok(()))
        }
    }

    fn sample_worktree(path: &Path) -> WorktreeInfo {
        WorktreeInfo {
            path: path.to_path_buf(),
            head: Some("deadbeef".into()),
            branch: Some("feature/test".into()),
            is_locked: false,
            is_prunable: false,
        }
    }

    fn build_gui(backend: MockBackend, repo_root: PathBuf) -> WtmGui<MockBackend> {
        WtmGui::new(
            GuiInitState {
                repo_root,
                worktrees: Vec::new(),
                quick_actions: Vec::new(),
            },
            backend,
        )
    }

    #[test]
    fn create_worktree_rejects_empty_branch() {
        let temp_repo = tempdir().unwrap();
        let backend = MockBackend::default();
        let mut gui = build_gui(backend, temp_repo.path().to_path_buf());

        gui.create_worktree();

        let status = gui.status.expect("status set");
        assert!(status.text.contains("Enter a branch name"));
        assert!(matches!(status.kind, StatusKind::Error));
        assert!(gui.backend.add_calls.is_empty());
    }

    #[test]
    fn create_worktree_invokes_backend_and_resets_state() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let expected_path = repo_root.join(".wtm/workspaces/feature-test");

        let mut backend = MockBackend::default();
        backend.add_results.push_back(Ok(()));
        backend
            .list_results
            .push_back(Ok(vec![sample_worktree(&expected_path)]));

        let mut gui = build_gui(backend, repo_root.clone());
        gui.new_branch = "feature/test".into();

        gui.create_worktree();

        assert!(matches!(
            gui.status.as_ref().map(|s| &s.kind),
            Some(StatusKind::Info)
        ));
        assert!(gui.new_branch.is_empty());
        assert!(gui.pending_removal.is_none());
        assert_eq!(gui.worktrees.len(), 1);
        assert_eq!(gui.worktrees[0].path(), expected_path.as_path());

        assert_eq!(gui.backend.add_calls.len(), 1);
        let call = &gui.backend.add_calls[0];
        assert_eq!(call.repo_root, repo_root);
        assert_eq!(call.path, expected_path);
        assert_eq!(call.branch.as_deref(), Some("feature/test"));
    }

    #[test]
    fn handle_row_action_stage_and_cancel() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let backend = MockBackend::default();
        let mut gui = build_gui(backend, repo_root);

        let target_path = PathBuf::from("/tmp/worktree");
        gui.handle_row_action(RowAction::StageRemoval(
            target_path.clone(),
            "target".into(),
        ));

        assert_eq!(gui.pending_removal.as_ref(), Some(&target_path));
        assert!(gui
            .status
            .as_ref()
            .map(|s| s.text.contains("Confirm removal"))
            .unwrap_or(false));

        gui.handle_row_action(RowAction::Cancel);
        assert!(gui.pending_removal.is_none());
        assert!(gui
            .status
            .as_ref()
            .map(|s| s.text == "Cancelled removal")
            .unwrap_or(false));
    }

    #[test]
    fn handle_row_action_remove_invokes_backend() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let mut backend = MockBackend::default();
        backend.remove_results.push_back(Ok(()));
        backend.list_results.push_back(Ok(Vec::new()));

        let mut gui = build_gui(backend, repo_root.clone());
        gui.force_remove = true;
        let target_path = repo_root.join("wt");
        gui.pending_removal = Some(target_path.clone());

        gui.handle_row_action(RowAction::Remove(target_path.clone()));

        assert!(gui.pending_removal.is_none());
        assert_eq!(gui.backend.remove_calls.len(), 1);
        let call = &gui.backend.remove_calls[0];
        assert_eq!(call.repo_root, repo_root);
        assert_eq!(call.path, target_path);
        assert!(call.force);
        assert!(matches!(
            gui.status.as_ref().map(|s| &s.kind),
            Some(StatusKind::Info)
        ));
    }

    #[test]
    fn run_quick_action_records_backend_invocation() {
        let temp_repo = tempdir().unwrap();
        let repo_root = temp_repo.path().to_path_buf();
        let mut backend = MockBackend::default();
        backend.quick_results.push_back(Ok(()));

        let mut gui = build_gui(backend, repo_root.clone());
        let action = QuickAction {
            label: "Deploy".into(),
            command: "echo ok".into(),
        };

        gui.run_quick_action(&action);

        assert_eq!(gui.backend.quick_calls.len(), 1);
        let call = &gui.backend.quick_calls[0];
        assert_eq!(call.repo_root, repo_root);
        assert_eq!(call.command, "echo ok");
        assert!(matches!(
            gui.status.as_ref().map(|s| &s.kind),
            Some(StatusKind::Info)
        ));
    }
}
