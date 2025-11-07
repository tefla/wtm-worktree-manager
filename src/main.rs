mod commands;
mod config;
mod docker;
mod git;
mod gui;
mod jira;
mod tui;
mod wtm_paths;

use anyhow::{bail, Context, Result};
use clap::{ArgAction, Parser, Subcommand};
use commands::completions::{
    collect_suggestions, current_repo_root, format_suggestions, generate_shell_completion,
    CompletionShell, SuggestionDomain, SuggestionShellFormat,
};
use commands::init::init_command;
use commands::workspace::{
    attach_workspace, create_workspace, delete_workspace, list_workspaces, move_workspace,
    workspace_telemetry, TelemetryOptions, WorkspaceSelector, WorkspaceSummary, WorkspaceTelemetry,
};
use config::QuickAction;
use git::{find_repo_root, list_worktrees, WorktreeInfo};
use serde_json::to_string_pretty;
use std::cmp::min;
use std::path::PathBuf;

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
    /// Shell completion utilities
    Completions {
        #[command(subcommand)]
        command: CompletionCommands,
    },
    /// Manage git worktree-backed workspaces via the CLI
    #[command(alias = "worktree")]
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommands,
    },
    /// Launch the experimental desktop GUI
    Gui,
}

#[derive(Subcommand, Debug)]
enum WorkspaceCommands {
    /// List discovered workspaces
    List {
        /// Emit JSON instead of a human readable table
        #[arg(long)]
        json: bool,
    },
    /// Create a new workspace with a freshly created branch
    Create {
        /// Name of the branch to create for this workspace
        branch: String,
        /// Optional upstream reference used as the starting point
        #[arg(long = "from", value_name = "UPSTREAM")]
        upstream: Option<String>,
        /// Optional path where the workspace should be created (relative paths are resolved under `.wtm/workspaces`)
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
        /// Emit JSON describing the created workspace
        #[arg(long)]
        json: bool,
    },
    /// Attach a workspace to an existing branch without creating a new one
    Attach {
        /// Name of the branch to attach
        branch: String,
        /// Optional path where the workspace should be created (relative paths are resolved under `.wtm/workspaces`)
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
        /// Emit JSON describing the attached workspace
        #[arg(long)]
        json: bool,
    },
    /// Delete an existing workspace by path, branch or name
    #[command(alias = "remove")]
    Delete {
        #[command(flatten)]
        selector: WorkspaceSelector,
        /// Force removal even if there are unmerged changes
        #[arg(long)]
        force: bool,
        /// Emit JSON describing the removed workspace
        #[arg(long)]
        json: bool,
    },
    /// Move or rename an existing workspace to a new path
    #[command(alias = "rename")]
    Move {
        #[command(flatten)]
        selector: WorkspaceSelector,
        /// Destination path for the workspace (relative paths are resolved under `.wtm/workspaces`)
        #[arg(long, value_name = "PATH")]
        to: PathBuf,
        /// Force the move even if git detects a potential issue
        #[arg(long)]
        force: bool,
        /// Emit JSON describing the moved workspace
        #[arg(long)]
        json: bool,
    },
    /// Gather telemetry information about one or more workspaces
    Telemetry {
        #[command(flatten)]
        selector: WorkspaceSelector,
        /// Emit telemetry as JSON
        #[arg(long)]
        json: bool,
        /// Skip git status collection
        #[arg(long = "no-status", action = ArgAction::SetFalse, default_value_t = true)]
        include_status: bool,
        /// Skip disk usage calculation
        #[arg(long = "no-size", action = ArgAction::SetFalse, default_value_t = true)]
        include_disk_usage: bool,
    },
}

#[derive(Subcommand, Debug)]
enum CompletionCommands {
    /// Generate shell completion scripts
    Generate {
        #[arg(value_enum)]
        shell: CompletionShell,
    },
    /// Provide dynamic suggestions for shell completion integrations
    Suggest {
        #[arg(value_enum)]
        domain: SuggestionDomain,
        /// Filter suggestions by a case-insensitive query
        #[arg(long, value_name = "QUERY")]
        contains: Option<String>,
        /// Format suggestions for shell integration
        #[arg(long, value_enum)]
        shell: Option<SuggestionShellFormat>,
        /// Emit JSON instead of plain text
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Init { path }) => init_command(&path),
        Some(Commands::Completions { command }) => run_completions_cli(command),
        Some(Commands::Workspace { command }) => run_workspace_cli(command),
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
            "No git worktrees found for {}. Use `wtm workspace create` to create one.",
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

fn run_workspace_cli(command: WorkspaceCommands) -> Result<()> {
    let cwd = std::env::current_dir().context("unable to determine current directory")?;
    let repo_root = find_repo_root(&cwd)?;
    match command {
        WorkspaceCommands::List { json } => {
            let summaries = list_workspaces(&repo_root)?;
            if json {
                println!("{}", to_string_pretty(&summaries)?);
            } else {
                for summary in &summaries {
                    print_workspace_summary(summary);
                }
            }
            Ok(())
        }
        WorkspaceCommands::Create {
            branch,
            upstream,
            path,
            json,
        } => {
            let summary =
                create_workspace(&repo_root, &branch, upstream.as_deref(), path.as_deref())?;
            if json {
                println!("{}", to_string_pretty(&summary)?);
            } else {
                println!(
                    "Created workspace for branch {} at {}",
                    summary.branch.as_deref().unwrap_or(branch.trim()),
                    summary.path.display()
                );
                print_workspace_summary(&summary);
            }
            Ok(())
        }
        WorkspaceCommands::Attach { branch, path, json } => {
            let summary = attach_workspace(&repo_root, &branch, path.as_deref())?;
            if json {
                println!("{}", to_string_pretty(&summary)?);
            } else {
                println!(
                    "Attached workspace to branch {} at {}",
                    branch.trim(),
                    summary.path.display()
                );
                print_workspace_summary(&summary);
            }
            Ok(())
        }
        WorkspaceCommands::Delete {
            selector,
            force,
            json,
        } => {
            let summary = delete_workspace(&repo_root, &selector, force)?;
            if json {
                println!("{}", to_string_pretty(&summary)?);
            } else {
                println!(
                    "Removed workspace {} at {}",
                    summary.name,
                    summary.path.display()
                );
            }
            Ok(())
        }
        WorkspaceCommands::Move {
            selector,
            to,
            force,
            json,
        } => {
            let summary = move_workspace(&repo_root, &selector, &to, force)?;
            if json {
                println!("{}", to_string_pretty(&summary)?);
            } else {
                println!(
                    "Moved workspace {} to {}",
                    summary.name,
                    summary.path.display()
                );
                print_workspace_summary(&summary);
            }
            Ok(())
        }
        WorkspaceCommands::Telemetry {
            selector,
            json,
            include_status,
            include_disk_usage,
        } => {
            let telemetry = workspace_telemetry(
                &repo_root,
                &selector,
                TelemetryOptions {
                    include_status,
                    include_disk_usage,
                },
            )?;
            if json {
                println!("{}", to_string_pretty(&telemetry)?);
            } else {
                for entry in &telemetry {
                    print_workspace_telemetry(entry);
                }
            }
            Ok(())
        }
    }
}

fn run_completions_cli(command: CompletionCommands) -> Result<()> {
    match command {
        CompletionCommands::Generate { shell } => {
            let script = generate_shell_completion(shell)?;
            print!("{script}");
            Ok(())
        }
        CompletionCommands::Suggest {
            domain,
            contains,
            shell,
            json,
        } => {
            let repo_root = current_repo_root()?;
            let suggestions = collect_suggestions(domain, &repo_root)?;
            if json {
                println!("{}", to_string_pretty(&suggestions)?);
            } else {
                for line in format_suggestions(&suggestions, contains.as_deref(), shell) {
                    println!("{line}");
                }
            }
            Ok(())
        }
    }
}

fn print_workspace_summary(summary: &WorkspaceSummary) {
    let mut columns = vec![summary.name.clone(), summary.path.display().to_string()];
    if let Some(branch) = summary.branch.as_deref() {
        columns.push(format!("branch: {branch}"));
    }
    if let Some(head) = summary.head.as_deref() {
        columns.push(format!("HEAD: {}", &head[..min(7, head.len())]));
    }
    if summary.is_locked {
        columns.push("locked".into());
    }
    if summary.is_prunable {
        columns.push("prunable".into());
    }
    println!("{}", columns.join(" | "));
}

fn print_workspace_telemetry(entry: &WorkspaceTelemetry) {
    println!("{}", entry.summary.name);
    println!("  Path: {}", entry.summary.path.display());
    if let Some(branch) = entry.summary.branch.as_deref() {
        println!("  Branch: {branch}");
    }
    if let Some(head) = entry.summary.head.as_deref() {
        println!("  HEAD: {}", head);
    }
    println!(
        "  Flags: {}",
        format_flags(entry.summary.is_locked, entry.summary.is_prunable)
    );
    match (&entry.status, &entry.status_error) {
        (Some(status), _) => {
            println!(
                "  Git status: branch={}, upstream={}, ahead={}, behind={}, staged={}, unstaged={}, untracked={}, conflicts={}",
                status.branch.as_deref().unwrap_or("-"),
                status.upstream.as_deref().unwrap_or("-"),
                status.ahead,
                status.behind,
                status.staged,
                status.unstaged,
                status.untracked,
                status.conflicts
            );
        }
        (None, Some(error)) => println!("  Git status: unavailable ({error})"),
        _ => {}
    }
    match (entry.disk_usage_bytes, &entry.disk_usage_error) {
        (Some(bytes), _) => println!("  Disk usage: {bytes} bytes"),
        (None, Some(error)) => println!("  Disk usage: unavailable ({error})"),
        _ => {}
    }
    println!();
}

fn format_flags(is_locked: bool, is_prunable: bool) -> String {
    let mut flags = Vec::new();
    if is_locked {
        flags.push("locked");
    }
    if is_prunable {
        flags.push("prunable");
    }
    if flags.is_empty() {
        "none".to_string()
    } else {
        flags.join(", ")
    }
}
