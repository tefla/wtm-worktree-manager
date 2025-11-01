use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Map key events to escape sequences for the active pseudo terminal.
pub fn key_event_to_bytes(key: KeyEvent) -> Option<Vec<u8>> {
    let mut modifiers = key.modifiers;

    match key.code {
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Some(vec![0x03]);
        }
        KeyCode::Char('d') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Some(vec![0x04]);
        }
        KeyCode::Char('z') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Some(vec![0x1A]);
        }
        KeyCode::Char('l') if modifiers.contains(KeyModifiers::CONTROL) => {
            return Some(vec![0x0C]);
        }
        KeyCode::Char(c) => {
            if modifiers.contains(KeyModifiers::CONTROL) {
                let upper = c.to_ascii_uppercase();
                if ('A'..='Z').contains(&upper) {
                    return Some(vec![(upper as u8) - b'@']);
                }
            }
            return Some(c.to_string().into_bytes());
        }
        KeyCode::Enter => return Some(vec![b'\r']),
        KeyCode::Tab => return Some(vec![b'\t']),
        KeyCode::Backspace => return Some(vec![0x7f]),
        KeyCode::Esc => return Some(vec![0x1b]),
        KeyCode::Delete => return Some(b"\x1b[3~".to_vec()),
        KeyCode::Home => return Some(b"\x1bOH".to_vec()),
        KeyCode::End => return Some(b"\x1bOF".to_vec()),
        KeyCode::PageUp => return Some(b"\x1b[5~".to_vec()),
        KeyCode::PageDown => return Some(b"\x1b[6~".to_vec()),
        KeyCode::Left => return Some(b"\x1b[D".to_vec()),
        KeyCode::Right => return Some(b"\x1b[C".to_vec()),
        KeyCode::Up => return Some(b"\x1b[A".to_vec()),
        KeyCode::Down => return Some(b"\x1b[B".to_vec()),
        KeyCode::F(n @ 1..=12) => {
            let seq = format!("\x1b[{}~", 10 + n);
            return Some(seq.into_bytes());
        }
        _ => {}
    }

    let _ = modifiers.remove(KeyModifiers::SHIFT);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_event_to_bytes_emits_expected_sequences() {
        let normal = KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(normal), Some(vec![b'a']));

        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_bytes(ctrl_c), Some(vec![0x03]));

        let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(enter), Some(vec![b'\r']));

        let left = KeyEvent::new(KeyCode::Left, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(left), Some(b"\x1b[D".to_vec()));

        let unsupported = KeyEvent::new(KeyCode::Null, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(unsupported), None);
    }
}
