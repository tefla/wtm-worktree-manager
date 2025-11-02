#![cfg(feature = "fx")]

use std::time::Instant;

use crossterm::style::Color as CtColor;
use ratatui::{layout::Rect, Frame};
use tachyonfx::{fx, Duration, Effect, EffectRenderer, Interpolation, Motion, Shader};

/// Controls ornamental effects rendered on top of the core TUI.
pub(super) struct FxController {
    last_frame: Instant,
    frame_delta: Duration,
    context_visible: bool,
    context_effect: Option<Effect>,
    status_effect: Option<Effect>,
}

impl FxController {
    pub fn new(context_visible: bool) -> Self {
        Self {
            last_frame: Instant::now(),
            frame_delta: Duration::ZERO,
            context_visible,
            context_effect: None,
            status_effect: None,
        }
    }

    /// Capture the duration since the previous frame so effects can advance smoothly.
    pub fn begin_frame(&mut self) {
        let now = Instant::now();
        self.frame_delta = now.saturating_duration_since(self.last_frame).into();
        self.last_frame = now;
    }

    pub fn on_context_visibility_change(&mut self, visible: bool) {
        self.context_visible = visible;
        if visible {
            self.context_effect = Some(context_intro_effect());
        } else {
            self.context_effect = None;
        }
    }

    pub fn on_status_update(&mut self) {
        self.status_effect = Some(status_flash_effect());
    }

    pub fn render_context(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if !self.context_visible {
            return;
        }
        Self::render_effect(frame, area, &mut self.context_effect, self.frame_delta);
    }

    pub fn render_status(&mut self, frame: &mut Frame<'_>, area: Rect) {
        Self::render_effect(frame, area, &mut self.status_effect, self.frame_delta);
    }

    fn render_effect(
        frame: &mut Frame<'_>,
        area: Rect,
        effect: &mut Option<Effect>,
        delta: Duration,
    ) {
        let should_clear = match effect.as_mut() {
            Some(effect_ref) => {
                if !effect_ref.done() {
                    frame.render_effect(effect_ref, area, delta);
                }
                effect_ref.done()
            }
            None => false,
        };

        if should_clear {
            *effect = None;
        }
    }
}

fn context_intro_effect() -> Effect {
    let duration = Duration::from_millis(520);
    fx::parallel(&[
        fx::slide_in(
            Motion::RightToLeft,
            18,
            4,
            context_backdrop(),
            (duration, Interpolation::CubicInOut),
        ),
        fx::fade_from_fg(context_accent(), (duration, Interpolation::QuadOut)),
    ])
}

fn status_flash_effect() -> Effect {
    let duration = Duration::from_millis(320);
    fx::parallel(&[
        fx::fade_from_fg(status_accent(), (duration, Interpolation::CubicOut)),
        fx::hsl_shift_fg([18.0, 12.0, 18.0], (duration, Interpolation::CubicOut)),
    ])
}

fn context_backdrop() -> CtColor {
    CtColor::Rgb {
        r: 16,
        g: 24,
        b: 36,
    }
}

fn context_accent() -> CtColor {
    CtColor::Rgb {
        r: 140,
        g: 208,
        b: 255,
    }
}

fn status_accent() -> CtColor {
    CtColor::Rgb {
        r: 255,
        g: 214,
        b: 122,
    }
}
