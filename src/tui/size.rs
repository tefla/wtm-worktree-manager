use ratatui::layout::{Rect, Size};

/// Terminal dimensions used to size Ratatui widgets and pseudoterminals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl TerminalSize {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            rows: rows.max(1),
            cols: cols.max(1),
        }
    }

    pub fn from_rect(rect: Rect) -> Self {
        Self::new(rect.height, rect.width)
    }

    pub fn from_size(size: Size) -> Self {
        Self::new(size.height, size.width)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_enforces_minimums() {
        let size = TerminalSize::new(0, 0);
        assert_eq!(size.rows, 1);
        assert_eq!(size.cols, 1);
    }

    #[test]
    fn terminal_size_from_rect_matches_dimensions() {
        let rect = Rect::new(0, 0, 40, 12);
        let size = TerminalSize::from_rect(rect);
        assert_eq!(size.rows, 12);
        assert_eq!(size.cols, 40);
    }
}
