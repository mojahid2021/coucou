// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// GitHub Copilot hooks, written to ~/.copilot/hooks/coucou.json. Separate
    /// from `hooks_installed` because they are different files for different
    /// harnesses, and one being present says nothing about the other.
    #[serde(default)]
    pub copilot_hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            copilot_hooks_installed: false,
            model: default_model(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    let mut s = match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    s.clamp();
    s
}

/// Keeps the auto-close delay inside the range the UI offers. A 0 here would
/// collapse the island the instant it opened, and a hand-edited settings.json
/// must not be able to do that either. Mirrors `clampAutoClose` in state.ts.
fn clamp_range() -> (f64, f64) {
    (3.0, 300.0)
}

impl Settings {
    pub fn clamp(&mut self) {
        let (lo, hi) = clamp_range();
        if !self.auto_close_interval.is_finite() || self.auto_close_interval <= 0.0 {
            self.auto_close_interval = 15.0;
        }
        self.auto_close_interval = self.auto_close_interval.clamp(lo, hi);
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let mut settings = settings.clone();
    settings.clamp();
    let json = serde_json::to_vec_pretty(&settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
