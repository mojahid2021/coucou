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
    /// Which provider answers the chat: "anthropic" or "custom".
    #[serde(default = "default_chat_provider")]
    pub chat_provider: String,
    /// Base URL of the user's OpenAI-compatible endpoint, e.g. an Ollama server.
    /// Not a secret — the key, if any, lives in the keychain.
    #[serde(default)]
    pub custom_base_url: String,
    /// Model id sent to that endpoint.
    #[serde(default)]
    pub custom_model: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_chat_provider() -> String {
    PROVIDER_ANTHROPIC.to_string()
}

/// The two providers the chat knows about. Anything else in `chat_provider` is
/// rewritten to Anthropic by `clamp`, so a typo or a hand-edited file cannot
/// leave the island with no way to answer.
pub const PROVIDER_ANTHROPIC: &str = "anthropic";
pub const PROVIDER_CUSTOM: &str = "custom";

pub fn is_known_provider(value: &str) -> bool {
    matches!(value, PROVIDER_ANTHROPIC | PROVIDER_CUSTOM)
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
            chat_provider: default_chat_provider(),
            custom_base_url: String::new(),
            custom_model: String::new(),
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

        // An unknown provider would leave the island unable to answer, so it
        // falls back to the one that always works rather than being passed on.
        self.chat_provider = self.chat_provider.trim().to_lowercase();
        if !is_known_provider(&self.chat_provider) {
            self.chat_provider = default_chat_provider();
        }
        // Trailing slashes are stripped on save; the endpoints are a plain join
        // and `…/v1//chat/completions` is not the same URL.
        self.custom_base_url = self.custom_base_url.trim().trim_end_matches('/').to_string();
        self.custom_model = self.custom_model.trim().to_string();
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
