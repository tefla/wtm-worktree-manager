mod app;
mod keymap;
mod pty_tab;
mod size;

use anyhow::Result;
use crossterm::{
    event, execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::{io, path::PathBuf, time::Duration};

use crate::{config::QuickAction, git::WorktreeInfo};
use app::App;
use size::TerminalSize;

/// Run the Ratatui dashboard for the provided workspace directories.
pub fn run_tui(
    repo_root: PathBuf,
    worktrees: Vec<WorktreeInfo>,
    quick_actions: Vec<QuickAction>,
) -> Result<()> {
    let mut terminal = setup_terminal()?;
    let size = terminal.size()?;
    let mut app = App::new(
        repo_root,
        worktrees,
        quick_actions,
        TerminalSize::from_size(size),
    )?;

    let tick_rate = Duration::from_millis(100);

    let result = (|| -> Result<()> {
        loop {
            terminal.draw(|frame| app.draw(frame))?;

            if app.should_quit() {
                break;
            }

            if event::poll(tick_rate)? {
                let evt = event::read()?;
                app.handle_event(evt)?;
            }

            app.reap_finished_children();
        }
        Ok(())
    })();

    restore_terminal(&mut terminal)?;
    result
}

fn setup_terminal() -> Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.hide_cursor()?;
    Ok(terminal)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    terminal.show_cursor().ok();
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    disable_raw_mode()?;
    Ok(())
}
