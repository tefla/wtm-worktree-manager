use super::{
    add_worktree::{AddWorktreeState, Suggestion},
    App, Mode,
};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{
        Block, Borders, Clear, List, ListItem, ListState, Paragraph, Scrollbar,
        ScrollbarOrientation, ScrollbarState, Tabs, Wrap,
    },
    Frame,
};
use tui_term::widget::{Cursor, PseudoTerminal};

pub(super) fn draw(app: &mut App, frame: &mut Frame<'_>) {
    let area = frame.area();
    app.terminal_size = super::TerminalSize::from_rect(area);

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area);

    let mut body_constraints = vec![Constraint::Length(26), Constraint::Min(10)];
    if app.is_context_panel_visible() {
        body_constraints.push(Constraint::Length(32));
    }

    let body_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(body_constraints)
        .split(root[0]);

    app.sidebar_area = Some(body_chunks[0]);
    draw_sidebar(app, frame, body_chunks[0]);
    app.tabs_area = None;
    app.terminal_area = None;
    app.context_area = None;
    app.tab_regions.clear();
    draw_main(app, frame, body_chunks[1]);
    if app.is_context_panel_visible() {
        if let Some(area) = body_chunks.get(2).copied() {
            app.context_area = Some(area);
            draw_context_panel(app, frame, area);
        }
    }
    if matches!(app.mode, Mode::Help) {
        draw_help_overlay(app, frame, root[0]);
    }
    draw_status(app, frame, root[1]);
}

fn draw_sidebar(app: &App, frame: &mut Frame<'_>, area: Rect) {
    let mut state = ListState::default();
    if !app.workspaces.is_empty() {
        state.select(Some(app.selected_workspace));
    }

    let items: Vec<ListItem> = app
        .workspaces
        .iter()
        .map(|ws| ListItem::new(Line::from(ws.sidebar_label(&app.repo_root))))
        .collect();

    let list = List::new(items)
        .block(Block::default().title("Worktrees").borders(Borders::ALL))
        .highlight_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_main(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    if matches!(app.mode, Mode::QuickActions) {
        draw_quick_actions(app, frame, area);
        return;
    }

    let Some(workspace) = app.workspaces.get_mut(app.selected_workspace) else {
        frame.render_widget(
            Block::default()
                .title("No worktree selected")
                .borders(Borders::ALL),
            area,
        );
        return;
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(1)])
        .split(area);

    app.tabs_area = Some(chunks[0]);
    app.terminal_area = Some(chunks[1]);

    let titles: Vec<Line> = workspace.tab_titles().into_iter().map(Line::from).collect();

    app.tab_regions.clear();
    if let Some(tabs_rect) = app.tabs_area {
        let inner_width = tabs_rect.width.saturating_sub(2);
        let inner_x = tabs_rect.x.saturating_add(1);
        let tab_count = workspace.tabs_len();
        if inner_width > 0 && tab_count > 0 {
            let tab_count_u16 = tab_count as u16;
            let base = inner_width / tab_count_u16;
            let mut remainder = inner_width % tab_count_u16;
            let mut cursor = inner_x;
            for _ in 0..tab_count {
                let extra = if remainder > 0 {
                    remainder -= 1;
                    1
                } else {
                    0
                };
                let width = base + extra;
                let span_end = (cursor.saturating_add(width.max(1))).min(inner_x + inner_width);
                app.tab_regions.push((cursor, span_end));
                cursor = span_end;
            }
        }
    }

    let tabs = Tabs::new(titles)
        .block(
            Block::default()
                .title(workspace.display_path())
                .borders(Borders::ALL),
        )
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .select(workspace.active_tab_index());

    frame.render_widget(tabs, chunks[0]);

    let terminal_block = Block::default().borders(Borders::ALL);
    frame.render_widget(terminal_block.clone(), chunks[1]);

    let mut terminal_inner = terminal_block.inner(chunks[1]);
    let mut scrollbar_area = None;
    let terminal_size = if terminal_inner.width > 0 && terminal_inner.height > 0 {
        if terminal_inner.width > 1 {
            scrollbar_area = Some(Rect {
                x: terminal_inner.x + terminal_inner.width - 1,
                y: terminal_inner.y,
                width: 1,
                height: terminal_inner.height,
            });
            terminal_inner.width -= 1;
        }
        if let Some(area) = scrollbar_area {
            if area.width > 0 && area.height > 0 {
                frame.render_widget(Clear, area);
            }
        }
        let size = super::TerminalSize::from_rect(terminal_inner);
        app.terminal_view_size = Some(size);
        Some(size)
    } else {
        app.terminal_view_size = None;
        None
    };

    if let Some(tab) = workspace.active_tab_mut() {
        if let Some(size) = terminal_size {
            tab.resize_to(size);
            let parser = tab.parser_handle();
            let screen_guard = parser.read().expect("terminal parser poisoned");
            let cursor = Cursor::default().visibility(matches!(app.mode, Mode::TerminalInput));
            let terminal_widget = PseudoTerminal::new(screen_guard.screen()).cursor(cursor);
            frame.render_widget(terminal_widget, terminal_inner);

            if let Some(area) = scrollbar_area {
                if area.height > 0 && size.rows > 0 {
                    let screen = screen_guard.screen();
                    let history_len = screen.scrollback_buffer_len();
                    let viewport = usize::from(size.rows);
                    let total_rows = history_len + viewport;
                    if total_rows > viewport {
                        let offset = screen.scrollback();
                        let max_position = total_rows.saturating_sub(viewport);
                        let top_position = history_len.saturating_sub(offset).min(max_position);
                        let mut scrollbar_state = ScrollbarState::new(total_rows)
                            .position(top_position)
                            .viewport_content_length(viewport);
                        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight);
                        frame.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
                    }
                }
            }
        }
    } else if terminal_inner.width > 0 && terminal_inner.height > 0 {
        frame.render_widget(
            Paragraph::new("No tabs open. Press `n` to create one."),
            terminal_inner,
        );
    }

    if matches!(app.mode, Mode::Adding) {
        if let Some(state) = app.add_state.as_ref() {
            if state.overlay_visible() {
                let overlay_area = centered_rect(60, 50, chunks[1]);
                frame.render_widget(Clear, overlay_area);
                render_add_worktree_overlay(frame, overlay_area, state);
            }
        }
    }
}

fn draw_context_panel(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    let header_style = Style::default()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);

    let content = app
        .workspaces
        .get(app.selected_workspace)
        .and_then(|workspace| app.workspace_contexts.get(workspace.path()));

    if let Some(context) = content {
        if !context.git.is_empty() {
            lines.push(Line::from(Span::styled("Git", header_style)));
            for entry in &context.git {
                lines.push(Line::from(format!("  {entry}")));
            }
        }

        if !context.docker.is_empty() {
            if !lines.is_empty() {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(Span::styled("Docker", header_style)));
            for entry in &context.docker {
                lines.push(Line::from(format!("  {entry}")));
            }
        }

        if !context.errors.is_empty() {
            if !lines.is_empty() {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(Span::styled("Warnings", header_style)));
            for entry in &context.errors {
                lines.push(Line::from(format!("  {entry}")));
            }
        }

        if lines.is_empty() {
            lines.push(Line::from("No context information available."));
        }
    } else if app.workspaces.is_empty() {
        lines.push(Line::from("No worktree selected."));
    } else {
        lines.push(Line::from("Context not loaded. Press `i` to refresh."));
    }

    let paragraph = Paragraph::new(lines)
        .block(Block::default().title("Context").borders(Borders::ALL))
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, area);

    #[cfg(feature = "fx")]
    app.render_context_fx(frame, area);
}

fn draw_quick_actions(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    if app.quick_actions.is_empty() {
        frame.render_widget(
            Paragraph::new("No quick actions configured").block(
                Block::default()
                    .title("Quick Actions")
                    .borders(Borders::ALL),
            ),
            area,
        );
        return;
    }

    let items: Vec<ListItem> = app
        .quick_actions
        .iter()
        .map(|action| {
            let text = format!("{} — {}", action.label, action.command);
            ListItem::new(text)
        })
        .collect();

    let mut state = ListState::default();
    if let Some(quick_state) = app.quick_action_state.as_ref() {
        state.select(Some(quick_state.selected));
    }

    let list = List::new(items)
        .block(
            Block::default()
                .title("Quick Actions")
                .borders(Borders::ALL),
        )
        .highlight_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");

    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_help_overlay(app: &App, frame: &mut Frame<'_>, area: Rect) {
    let overlay_area = centered_rect(70, 80, area);
    frame.render_widget(Clear, overlay_area);
    frame.render_widget(
        Paragraph::new(help_text(app))
            .wrap(Wrap { trim: true })
            .block(Block::default().title("Help").borders(Borders::ALL)),
        overlay_area,
    );
}

fn draw_status(app: &mut App, frame: &mut Frame<'_>, area: Rect) {
    let text = app
        .status_message
        .as_deref()
        .unwrap_or("q: quit • a: add • p: prune • i: context • ?: help");
    frame.render_widget(
        Paragraph::new(text).style(Style::default().fg(Color::Gray)),
        area,
    );

    #[cfg(feature = "fx")]
    app.render_status_fx(frame, area);
}

fn render_add_worktree_overlay(frame: &mut Frame<'_>, area: Rect, state: &AddWorktreeState) {
    let items: Vec<ListItem> = state
        .filtered_suggestions()
        .map(|suggestion| match suggestion {
            Suggestion::Ticket(ticket) => {
                let slug = ticket.slug();
                ListItem::new(Line::from(vec![
                    Span::styled(
                        ticket.key.as_str(),
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw("  "),
                    Span::raw(ticket.summary.as_str()),
                    Span::raw("  "),
                    Span::styled(format!("[{slug}]"), Style::default().fg(Color::DarkGray)),
                ]))
            }
            Suggestion::LocalBranch(branch) => ListItem::new(Line::from(vec![
                Span::styled(
                    "[local]",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw("  "),
                Span::raw(branch.as_str()),
            ])),
            Suggestion::RemoteBranch { remote, branch, .. } => ListItem::new(Line::from(vec![
                Span::styled(
                    "[remote]",
                    Style::default()
                        .fg(Color::Magenta)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw("  "),
                Span::styled(remote.as_str(), Style::default().fg(Color::Magenta)),
                Span::raw("  "),
                Span::raw(branch.as_str()),
            ])),
        })
        .collect();

    let mut list_state = ListState::default();
    list_state.select(state.selected_filtered_index());

    let list = List::new(items)
        .highlight_style(
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ")
        .block(
            Block::default()
                .title("Jira tickets (Tab: insert • Ctrl+R: refresh • Ctrl+Shift+R: clear)")
                .borders(Borders::ALL),
        );

    frame.render_stateful_widget(list, area, &mut list_state);
}

fn help_text(app: &App) -> String {
    let mut lines = vec![
        "Navigation".to_string(),
        "  ↑/↓: switch worktree".into(),
        "  ←/→: cycle tabs".into(),
        "  Enter: focus terminal".into(),
        "  n: new tab".into(),
        "  x: close tab".into(),
        "  i: toggle context panel".into(),
        "  a: add worktree".into(),
        "  p: prune worktree".into(),
        "  c: quick actions".into(),
        "  q: quit".into(),
        String::new(),
        "Add worktree".into(),
        "  Type to filter tickets/branches".into(),
        "  ↑/↓: select suggestion".into(),
        "  Tab: accept selection".into(),
        "  Ctrl+R: refresh tickets".into(),
        "  Ctrl+Shift+R: clear cache".into(),
        "  Ctrl+Space: toggle overlay".into(),
        "  Esc: cancel".into(),
    ];

    if !app.quick_actions.is_empty() {
        lines.push(String::new());
        lines.push("Quick actions:".into());
        for action in &app.quick_actions {
            lines.push(format!("  {} — {}", action.label, action.command));
        }
    }

    lines.join("\n")
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Percentage((100 - percent_y) / 2),
                Constraint::Percentage(percent_y),
                Constraint::Percentage((100 - percent_y) / 2),
            ]
            .as_ref(),
        )
        .split(area);

    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(
            [
                Constraint::Percentage((100 - percent_x) / 2),
                Constraint::Percentage(percent_x),
                Constraint::Percentage((100 - percent_x) / 2),
            ]
            .as_ref(),
        )
        .split(vertical[1]);

    horizontal[1]
}
