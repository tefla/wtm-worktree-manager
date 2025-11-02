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
