use super::{add_worktree::AddWorktreeState, workspace::QuickActionState, App, Mode};
use crate::{
    git,
    wtm_paths::{branch_dir_name, ensure_workspace_root, next_available_workspace_path},
};
use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind};

const SCROLL_LINES_PER_TICK: isize = 3;

pub(super) fn handle_key(app: &mut App, key: KeyEvent) -> Result<()> {
    match app.mode {
        Mode::Navigation => handle_navigation_key(app, key),
        Mode::TerminalInput => handle_terminal_key(app, key),
        Mode::Adding => handle_add_worktree_key(app, key),
        Mode::Removing => handle_remove_worktree_key(app, key),
        Mode::QuickActions => handle_quick_actions_key(app, key),
        Mode::Help => {
            if matches!(key.code, KeyCode::Esc | KeyCode::Char('?')) {
                app.mode = Mode::Navigation;
            }
            Ok(())
        }
    }
}

pub(super) fn handle_mouse(app: &mut App, event: MouseEvent) -> Result<()> {
    if !matches!(app.mode, Mode::TerminalInput) {
        return Ok(());
    }
    if let Some(workspace) = app.workspaces.get_mut(app.selected_workspace) {
        if let Some(tab) = workspace.active_tab_mut() {
            let delta = match event.kind {
                MouseEventKind::ScrollUp => SCROLL_LINES_PER_TICK,
                MouseEventKind::ScrollDown => -SCROLL_LINES_PER_TICK,
                _ => 0,
            };
            if delta != 0 {
                tab.scroll_scrollback(delta);
            }
        }
    }
    Ok(())
}

fn handle_navigation_key(app: &mut App, key: KeyEvent) -> Result<()> {
    match key.code {
        KeyCode::Char('q') => app.should_quit = true,
        KeyCode::Up => {
            if !app.workspaces.is_empty() {
                if app.selected_workspace == 0 {
                    app.selected_workspace = app.workspaces.len() - 1;
                } else {
                    app.selected_workspace -= 1;
                }
            }
        }
        KeyCode::Down => {
            if !app.workspaces.is_empty() {
                app.selected_workspace = (app.selected_workspace + 1) % app.workspaces.len();
            }
        }
        KeyCode::Left => {
            if let Some(ws) = app.workspaces.get_mut(app.selected_workspace) {
                ws.select_prev_tab();
            }
        }
        KeyCode::Right => {
            if let Some(ws) = app.workspaces.get_mut(app.selected_workspace) {
                ws.select_next_tab();
            }
        }
        KeyCode::Char('n') => {
            if let Some(ws) = app.workspaces.get_mut(app.selected_workspace) {
                let size = app.terminal_view_size.unwrap_or(app.terminal_size);
                ws.spawn_tab(&mut app.next_tab_id, size)?;
                app.clear_status();
            }
        }
        KeyCode::Char('x') => {
            if let Some(ws) = app.workspaces.get_mut(app.selected_workspace) {
                ws.close_active_tab()?;
                app.clear_status();
            }
        }
        KeyCode::Enter => {
            if let Some(ws) = app.workspaces.get(app.selected_workspace) {
                if ws.has_tabs() {
                    app.mode = Mode::TerminalInput;
                    app.clear_status();
                }
            }
        }
        KeyCode::Char('a') => match AddWorktreeState::new(&app.repo_root) {
            Ok((state, warning)) => {
                app.mode = Mode::Adding;
                app.add_state = Some(state);
                if let Some(message) = warning {
                    app.set_status(message);
                } else {
                    app.clear_status();
                }
            }
            Err(err) => {
                app.set_status(format!("Failed to prepare add workflow: {err}"));
            }
        },
        KeyCode::Char('p') => {
            if let Some(ws) = app.workspaces.get(app.selected_workspace) {
                if ws.is_primary(&app.repo_root) {
                    app.set_status("Cannot prune the primary worktree.");
                } else {
                    app.mode = Mode::Removing;
                    app.remove_state = Some(super::workspace::RemoveWorktreeState::new(ws.path()));
                    app.clear_status();
                }
            }
        }
        KeyCode::Char('?') => {
            app.mode = Mode::Help;
            app.clear_status();
        }
        KeyCode::Char('c') => {
            if app.quick_actions.is_empty() {
                app.set_status("No quick actions configured.");
            } else {
                let mut state = app.quick_action_state.take().unwrap_or_default();
                state.clamp(app.quick_actions.len());
                app.quick_action_state = Some(state);
                app.mode = Mode::QuickActions;
                app.clear_status();
            }
        }
        _ => {}
    }
    Ok(())
}

fn handle_terminal_key(app: &mut App, key: KeyEvent) -> Result<()> {
    if key.code == KeyCode::Char(' ') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.mode = Mode::Navigation;
        return Ok(());
    }

    if matches!(key.code, KeyCode::Esc) {
        app.mode = Mode::Navigation;
        return Ok(());
    }

    let Some(ws) = app.workspaces.get_mut(app.selected_workspace) else {
        return Ok(());
    };
    let Some(tab) = ws.active_tab_mut() else {
        return Ok(());
    };
    tab.handle_key_event(key)?;
    Ok(())
}

fn handle_add_worktree_key(app: &mut App, key: KeyEvent) -> Result<()> {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('r') | KeyCode::Char('R') => {
                if let Some(state) = app.add_state.as_mut() {
                    if key.modifiers.contains(KeyModifiers::SHIFT) {
                        match state.clear_cache(&app.repo_root) {
                            Ok(_) => app.set_status("Cleared Jira ticket cache."),
                            Err(err) => {
                                app.set_status(format!("Failed to clear Jira cache: {err}"))
                            }
                        }
                    } else {
                        match state.refresh_data(&app.repo_root) {
                            Ok(count) => {
                                app.set_status(format!("Refreshed Jira tickets ({count})"))
                            }
                            Err(err) => {
                                app.set_status(format!("Failed to refresh Jira tickets: {err}"))
                            }
                        }
                    }
                }
                return Ok(());
            }
            KeyCode::Char(' ') => {
                if let Some(state) = app.add_state.as_mut() {
                    state.toggle_overlay();
                }
                return Ok(());
            }
            _ => {}
        }
    }

    match key.code {
        KeyCode::Esc => {
            app.add_state = None;
            app.mode = Mode::Navigation;
        }
        KeyCode::Enter => {
            let Some(state) = app.add_state.take() else {
                app.mode = Mode::Navigation;
                return Ok(());
            };
            let branch_name = state.branch_trimmed().to_string();
            if branch_name.is_empty() {
                app.set_status("Branch name is required.");
                app.add_state = Some(state);
                return Ok(());
            }
            app.workspace_root = ensure_workspace_root(&app.repo_root)?;
            let dir_name = branch_dir_name(&branch_name);
            let worktree_path = next_available_workspace_path(&app.workspace_root, &dir_name);
            let branch_exists = state.branch_exists();
            let branch_upstream = state.branch_upstream().map(str::to_owned);
            let result = if branch_exists {
                git::add_worktree_for_branch(&app.repo_root, &worktree_path, branch_name.as_str())
            } else if let Some(ref upstream) = branch_upstream {
                git::add_worktree_from_upstream(
                    &app.repo_root,
                    &worktree_path,
                    branch_name.as_str(),
                    upstream,
                )
            } else {
                git::add_worktree(&app.repo_root, &worktree_path, Some(branch_name.as_str()))
            };
            match result {
                Ok(_) => {
                    if branch_exists {
                        app.set_status(format!(
                            "Added worktree {} for existing branch {}",
                            worktree_path.display(),
                            branch_name
                        ));
                    } else {
                        app.set_status(format!(
                            "Created worktree {} for new branch {}",
                            worktree_path.display(),
                            branch_name
                        ));
                    }
                    app.refresh_worktrees()?;
                    if let Some(idx) = app.index_of_path(&worktree_path) {
                        app.selected_workspace = idx;
                    }
                }
                Err(err) => {
                    app.set_status(format!("Failed to create worktree: {err}"));
                }
            }
            app.mode = Mode::Navigation;
        }
        KeyCode::Up => {
            if let Some(state) = app.add_state.as_mut() {
                state.move_selection_up();
            }
        }
        KeyCode::Down => {
            if let Some(state) = app.add_state.as_mut() {
                state.move_selection_down();
            }
        }
        KeyCode::Tab => {
            if let Some(state) = app.add_state.as_mut() {
                if !state.accept_selection() {
                    app.set_status("No suggestion selected.");
                }
            }
        }
        KeyCode::Backspace => {
            if let Some(state) = app.add_state.as_mut() {
                state.backspace();
            }
        }
        KeyCode::Char(c) => {
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
            {
                if let Some(state) = app.add_state.as_mut() {
                    state.push_char(c);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn handle_remove_worktree_key(app: &mut App, key: KeyEvent) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('n') => {
            app.remove_state = None;
            app.mode = Mode::Navigation;
        }
        KeyCode::Char('f') => {
            if let Some(state) = app.remove_state.as_mut() {
                state.toggle_force();
            }
        }
        KeyCode::Char('y') => {
            let Some(state) = app.remove_state.take() else {
                app.mode = Mode::Navigation;
                return Ok(());
            };
            match git::remove_worktree(&app.repo_root, state.target(), state.force()) {
                Ok(_) => {
                    app.set_status(format!("Removed worktree {}", state.target().display()));
                    app.refresh_worktrees()?;
                }
                Err(err) => {
                    app.set_status(format!("Failed to remove worktree: {err}"));
                }
            }
            app.mode = Mode::Navigation;
        }
        _ => {}
    }
    Ok(())
}

fn handle_quick_actions_key(app: &mut App, key: KeyEvent) -> Result<()> {
    let len = app.quick_actions.len();
    if len == 0 {
        app.mode = Mode::Navigation;
        app.quick_action_state = None;
        return Ok(());
    }

    let state = app
        .quick_action_state
        .get_or_insert_with(QuickActionState::default);
    state.clamp(len);

    match key.code {
        KeyCode::Esc => {
            app.mode = Mode::Navigation;
        }
        KeyCode::Up => {
            state.move_up(len);
        }
        KeyCode::Down => {
            state.move_down(len);
        }
        KeyCode::Enter => {
            let idx = state.selected.min(len - 1);
            let action = &app.quick_actions[idx];
            if let Some(ws) = app.workspaces.get_mut(app.selected_workspace) {
                let size = app.terminal_view_size.unwrap_or(app.terminal_size);
                ws.spawn_quick_action_tab(&mut app.next_tab_id, size, action)?;
                app.clear_status();
            } else {
                app.set_status("No workspace selected.");
            }
            app.mode = Mode::Navigation;
        }
        _ => {}
    }
    Ok(())
}
