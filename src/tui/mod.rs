mod app;
mod keymap;
mod pty_tab;
mod size;

use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture},
    execute,
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
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.hide_cursor()?;
    Ok(terminal)
}

fn restore_terminal<W: io::Write>(terminal: &mut Terminal<CrosstermBackend<W>>) -> Result<()> {
    terminal.show_cursor().ok();
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    disable_raw_mode()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn restore_terminal_with_sink_backend_succeeds() {
        let backend = CrosstermBackend::new(io::sink());
        let mut terminal = Terminal::new(backend).expect("create terminal");
        restore_terminal(&mut terminal).expect("restore terminal");
    }
}
