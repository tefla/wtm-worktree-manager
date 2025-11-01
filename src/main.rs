mod commands;
mod config;
mod docker;
mod git;
mod gui;
mod jira;
mod tui;
mod wtm_paths;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use commands::init::init_command;
use config::QuickAction;
use git::{add_worktree, find_repo_root, list_worktrees, remove_worktree, WorktreeInfo};
use std::path::PathBuf;
use wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path};

/// WTM command line interface.
#[derive(Parser, Debug)]
#[command(
    name = "wtm",
    version,
    about = "WTM worktree manager (Rust CLI prototype)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Initialise a default `.wtm` folder in the target directory
    Init {
        /// Root directory where `.wtm` should be created (defaults to the current directory)
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Manage git worktrees via the CLI
    Worktree {
        #[command(subcommand)]
        command: WorktreeCommands,
    },
    /// Launch the experimental desktop GUI
    Gui,
}

#[derive(Subcommand, Debug)]
enum WorktreeCommands {
    /// List discovered worktrees
    List,
    /// Add a new worktree for the specified branch
    Add {
        /// Branch name to create for the worktree
        branch: String,
    },
    /// Remove an existing worktree by its path
    Remove {
        /// Path to the worktree to remove
        path: PathBuf,
        /// Force removal even if there are unmerged changes
        #[arg(long)]
        force: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Init { path }) => init_command(&path),
        Some(Commands::Worktree { command }) => run_worktree_cli(command),
        Some(Commands::Gui) => run_gui_frontend(),
        None => run_dashboard(),
    }
}

fn run_dashboard() -> Result<()> {
    let context = load_workspace_context()?;
    tui::run_tui(context.repo_root, context.worktrees, context.quick_actions)
}

fn run_gui_frontend() -> Result<()> {
    let context = load_workspace_context()?;
    gui::run_gui(context.repo_root, context.worktrees, context.quick_actions)
}

struct WorkspaceContext {
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
}

fn load_workspace_context() -> Result<WorkspaceContext> {
    let cwd = std::env::current_dir().context("unable to determine current directory")?;
    let wtm_dir = cwd.join(".wtm");
    if !wtm_dir.exists() {
        bail!(
            "No .wtm directory found in {}. Run `wtm init` first.",
            cwd.display()
        );
    }

    let repo_root = find_repo_root(&cwd)?;
    let worktrees = list_worktrees(&repo_root)?;
    if worktrees.is_empty() {
        bail!(
            "No git worktrees found for {}. Use `wtm worktree add` to create one.",
            repo_root.display()
        );
    }

    let quick_actions = match config::load_quick_actions(&wtm_dir) {
        Ok(actions) => actions,
        Err(err) => {
            eprintln!(
                "warning: failed to load quick actions from {}: {err}",
                wtm_dir.join("config.json").display()
            );
            Vec::new()
        }
    };

    Ok(WorkspaceContext {
        repo_root,
        worktrees,
        quick_actions,
    })
}

fn run_worktree_cli(command: WorktreeCommands) -> Result<()> {
    let cwd = std::env::current_dir().context("unable to determine current directory")?;
    let repo_root = find_repo_root(&cwd)?;
    match command {
        WorktreeCommands::List => {
            let worktrees = list_worktrees(&repo_root)?;
            for wt in worktrees {
                let mut columns = vec![wt.path.display().to_string()];
                if let Some(branch) = wt.branch.as_deref() {
                    columns.push(format!("branch: {branch}"));
                }
                if let Some(head) = wt.head.as_deref() {
                    columns.push(format!("HEAD: {}", &head[..std::cmp::min(7, head.len())]));
                }
                if wt.is_locked {
                    columns.push("locked".into());
                }
                if wt.is_prunable {
                    columns.push("prunable".into());
                }
                println!("{}", columns.join(" | "));
            }
            Ok(())
        }
        WorktreeCommands::Add { branch } => {
            let workspace_root = ensure_workspace_root(&repo_root)?;
            let dir_name = branch_dir_name(&branch);
            let worktree_path = next_available_workspace_path(&workspace_root, &dir_name);
            add_worktree(&repo_root, &worktree_path, Some(branch.as_str()))?;
            println!(
                "Created worktree for branch {branch} at {}",
                worktree_path.display()
            );
            Ok(())
        }
        WorktreeCommands::Remove { path, force } => {
            let workspace_root = ensure_workspace_root(&repo_root)?;
            let full_path = if path.is_absolute() {
                path
            } else {
                workspace_root.join(path)
            };
            remove_worktree(&repo_root, &full_path, force)?;
            println!("Removed worktree {}", full_path.display());
            Ok(())
        }
    }
}
