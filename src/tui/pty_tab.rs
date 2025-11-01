use crate::tui::{keymap::key_event_to_bytes, size::TerminalSize};
use anyhow::{Context, Result};
use crossterm::event::KeyEvent;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    io::{self, Read, Write},
    path::Path,
    sync::{Arc, Mutex, RwLock},
    thread,
};
use tui_term::vt100;

pub(super) struct PtyTab {
    title: String,
    parser: Arc<RwLock<vt100::Parser>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    reader_handle: Option<thread::JoinHandle<()>>,
    exit_status: Arc<Mutex<Option<bool>>>,
    size: TerminalSize,
}

impl PtyTab {
    pub fn new(title: &str, cwd: &Path, size: TerminalSize) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = CommandBuilder::new(default_shell());
        command.cwd(cwd);

        let child = pair
            .slave
            .spawn_command(command)
            .context("failed to spawn shell for terminal tab")?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let master = pair.master;
        let writer = master
            .take_writer()
            .context("failed to acquire pty writer")?;
        let writer = Arc::new(Mutex::new(writer));

        let parser = Arc::new(RwLock::new(vt100::Parser::new(size.rows, size.cols, 0)));

        let parser_clone = parser.clone();
        let exit_status = Arc::new(Mutex::new(None));
        let exit_flag = exit_status.clone();
        let child_handle = Arc::new(Mutex::new(child));
        let reader_child = child_handle.clone();

        let writer_clone = writer.clone();
        let reader_handle = thread::spawn(move || {
            reader_loop(reader, parser_clone, exit_flag, reader_child, writer_clone);
        });

        Ok(Self {
            title: title.to_string(),
            parser,
            writer,
            child: child_handle,
            master: Arc::new(Mutex::new(master)),
            reader_handle: Some(reader_handle),
            exit_status,
            size,
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn parser_handle(&self) -> Arc<RwLock<vt100::Parser>> {
        Arc::clone(&self.parser)
    }

    pub fn resize_to(&mut self, size: TerminalSize) {
        if self.size == size {
            return;
        }
        self.size = size;
        if let Ok(mut guard) = self.parser.write() {
            guard.set_size(size.rows, size.cols);
        }
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn handle_key_event(&self, key: KeyEvent) -> Result<()> {
        if let Some(bytes) = key_event_to_bytes(key) {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(&bytes)?;
            writer.flush()?;
        }
        Ok(())
    }

    pub fn send_command(&self, command: &str) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(command.as_bytes())?;
        writer.write_all(b"\r\n")?;
        writer.flush()?;
        Ok(())
    }

    pub fn is_terminated(&self) -> bool {
        self.exit_status
            .lock()
            .map(|opt| opt.is_some())
            .unwrap_or(false)
    }
}

impl Drop for PtyTab {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
        if let Ok(mut status) = self.exit_status.lock() {
            if status.is_none() {
                *status = Some(false);
            }
        }
    }
}

fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    parser: Arc<RwLock<vt100::Parser>>,
    exit_flag: Arc<Mutex<Option<bool>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
) {
    let mut buf = [0u8; 8192];
    let mut dsr_state = 0;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                break;
            }
            Ok(n) => {
                for &byte in &buf[..n] {
                    dsr_state = match (dsr_state, byte) {
                        (0, 0x1b) => 1,
                        (1, b'[') => 2,
                        (2, b'6') => 3,
                        (3, b'n') => {
                            respond_with_cursor(&parser, &writer);
                            0
                        }
                        _ => 0,
                    };
                }
                if let Ok(mut guard) = parser.write() {
                    guard.process(&buf[..n]);
                }
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }

    if let Ok(mut child) = child.lock() {
        if let Ok(Some(status)) = child.try_wait() {
            let _ = exit_flag
                .lock()
                .map(|mut flag| *flag = Some(status.success()));
        } else if let Ok(status) = child.wait() {
            let _ = exit_flag
                .lock()
                .map(|mut flag| *flag = Some(status.success()));
        }
    }
}

fn respond_with_cursor(
    parser: &Arc<RwLock<vt100::Parser>>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
) {
    let (row, col) = parser
        .read()
        .map(|guard| guard.screen().cursor_position())
        .unwrap_or((0, 0));
    let response = format!("\u{1b}[{};{}R", row + 1, col + 1);
    if let Ok(mut handle) = writer.lock() {
        let _ = handle.write_all(response.as_bytes());
        let _ = handle.flush();
    }
}

pub fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_not_empty() {
        assert!(!default_shell().is_empty());
    }
}
