#[test]
fn vt100_scrollback_handles_large_offsets_without_panicking() {
    let mut parser = vt100::Parser::new(24, 80, 5_000);
    let mut data = String::new();
    for i in 0..600 {
        data.push_str(&format!("line {i:04}\n"));
    }
    parser.process(data.as_bytes());

    parser.set_scrollback(400);
    let screen = parser.screen();
    for row in 0..24 {
        let _ = screen.cell(row, 0);
    }
}

#[test]
fn vt100_scrollback_buffer_len_matches_excess_rows() {
    let rows: usize = 10;
    let extra: usize = 6;
    let mut parser = vt100::Parser::new(rows as u16, 40, 100);
    let mut data = String::new();
    for i in 0..(rows + extra) {
        data.push_str(&format!("line {i:04}\n"));
    }
    parser.process(data.as_bytes());

    let screen = parser.screen();
    let buffer_len = screen.scrollback_buffer_len();
    assert!(
        buffer_len >= extra && buffer_len <= rows,
        "expected scrollback between {extra} and {rows}, got {buffer_len}"
    );
}

#[test]
fn vt100_scrollback_buffer_len_clamps_to_limit() {
    let rows: usize = 8;
    let scrollback_limit: usize = 4;
    let mut parser = vt100::Parser::new(rows as u16, 40, scrollback_limit);
    let mut data = String::new();
    for i in 0..(rows + scrollback_limit * 3) {
        data.push_str(&format!("line {i:04}\n"));
    }
    parser.process(data.as_bytes());

    let screen = parser.screen();
    assert_eq!(screen.scrollback_buffer_len(), scrollback_limit);
}
