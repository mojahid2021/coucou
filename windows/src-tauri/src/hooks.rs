// Hook installation for every agent Coucou drives.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read the target settings file, take a dated backup, merge without touching
// anybody else's hooks, show the diff, and write only after an explicit click.
// Uninstall removes Coucou's entries and nothing else.
//
// Two harnesses, two formats:
//
//   Claude Code — ~/.claude/settings.json. Entries are nested groups
//   (`{"hooks": [{"hooks": [{…}]}]}`) and the timeout key is `timeout`.
//
//   GitHub Copilot — ~/.copilot/hooks/coucou.json (or $COPILOT_HOME/hooks).
//   Entries are flat, the timeout key is `timeoutSec`, and the file carries a
//   numeric `"version": 1`. See
//   https://docs.github.com/en/copilot/reference/hooks-reference
//
// The command is only the quoted exe path in forward slashes plus the event name:
// on Windows Claude Code runs hook commands through Git Bash, and anything with
// PowerShell or cmd in it breaks.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use crate::{platform, settings};

/// Which harness a hook file belongs to. Serialised as the lower-case name the
/// front end sends back, so adding a target never breaks an older settings UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HookTarget {
    #[default]
    Claude,
    Copilot,
}

impl HookTarget {
    /// The `--agent` tag the relay is invoked with, or None for Claude Code,
    /// which is identified by having no tag at all.
    pub fn agent_tag(self) -> Option<&'static str> {
        match self {
            HookTarget::Claude => None,
            HookTarget::Copilot => Some("copilot"),
        }
    }
}

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// The same lifecycle in Copilot's own event names.
///
/// Deliberately narrower than HOOK_EVENTS, and the differences are not cosmetic:
///
///   • `agentStop` replaces `Stop`. Copilot's `Stop` alias exists only in the
///     VS Code-compatible PascalCase form, and the `Stop` payload carries
///     `stop_hook_active`, which we would have to reason about for no gain.
///   • `StopFailure` has no Copilot equivalent — a failed turn surfaces through
///     `errorOccurred` instead, which we do not need: the island already shows
///     `PostToolUseFailure` on the tool that actually failed.
///   • `permissionRequest` is installed deliberately. Copilot's `preToolUse` hook
///     is fail-closed — a crash or non-zero exit *denies* the tool call even when
///     stdout says "allow" — so it is the wrong place for a UI that may be closed,
///     paused or crashed. `permissionRequest` is fail-open on a crash, which
///     degrades to "Copilot asks in its own terminal", exactly as we want.
const COPILOT_EVENTS: &[(&str, u64)] = &[
    ("sessionStart", 10),
    ("sessionEnd", 10),
    ("userPromptSubmitted", 10),
    ("preToolUse", 10),
    ("postToolUse", 10),
    ("postToolUseFailure", 10),
    ("permissionRequest", 120),
    ("agentStop", 10),
    ("subagentStart", 10),
    ("subagentStop", 10),
    ("notification", 10),
];

/// Marker that identifies a Coucou entry inside a hook file.
const MARKER: &str = "coucou-hook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

/// ~/.claude/settings.json, or ~/.copilot/hooks/coucou.json.
///
/// Copilot's home is `$COPILOT_HOME` when set — its own docs say so, and ignoring
/// it would install hooks where Copilot never looks.
pub fn hook_path(target: HookTarget) -> PathBuf {
    match target {
        HookTarget::Claude => platform::home_dir().join(".claude").join("settings.json"),
        HookTarget::Copilot => {
            let home = std::env::var_os("COPILOT_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| platform::home_dir().join(".copilot"));
            home.join("hooks").join("coucou.json")
        }
    }
}

/// Reads the hook file for `target`.
///
/// The only error that means "start from nothing" is the file not being there.
/// Everything else — a lock held by another process, a permission problem, JSON
/// we cannot parse — is reported, because the alternative is treating somebody's
/// unreadable settings as an empty object and then writing that back over them.
fn read_settings(target: HookTarget) -> Result<Value, String> {
    let path = hook_path(target);
    match std::fs::read(&path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        // A lock, a permission problem, a bad drive: all of them mean we do not
        // know what is in there, and not knowing is not the same as empty.
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

/// The parsing half of `read_settings`, split out so it can be tested without a
/// home directory.
fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`, and
    // serde_json refuses it. Stripping it is safe and well defined; guessing at
    // anything else is not.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Coucou won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again — Coucou won't overwrite it."
        )),
    }
}

/// The settings as they are, or an empty object when we cannot tell. Only for
/// read-only paths like `status()`, which must never fail loudly; anything that
/// writes uses `read_settings()` and surfaces the error instead.
fn read_settings_lossy(target: HookTarget) -> Value {
    read_settings(target).unwrap_or_else(|_| json!({}))
}

/// The shell command for one event, per harness.
///
/// Claude Code gets a bare shell string. Copilot splits the same string across
/// `bash` and `powershell` keys and picks by OS, so both get it verbatim —
/// GitHub's docs are explicit that the command is run through a shell there too,
/// so the Unix quoting is correct for the `bash` value.
fn hook_command(event: &str, target: HookTarget) -> String {
    let exe = settings::hook_exe_path().to_string_lossy().into_owned();
    let arg = match target.agent_tag() {
        // The agent tag routes the event to the Copilot pill and tells the relay
        // which answer syntax to write.
        Some(tag) => format!("--agent {tag} {event}"),
        None => event.to_string(),
    };
    #[cfg(windows)]
    {
        format!("\"{}\" {arg}", exe.replace('\\', "/"))
    }
    // Claude Code runs the command through `sh`, which still reads `$`, `` ` ``
    // and `\` inside double quotes. Single quotes keep the path a path, whatever
    // the home directory is called.
    #[cfg(unix)]
    {
        format!("{} {arg}", sh_quote(&exe))
    }
}

/// `s` as one single-quoted shell word: `'` becomes `'\''`, nothing else is
/// special inside single quotes.
#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// True when a Copilot entry is one of ours. Copilot entries are flat, so this
/// looks at `bash`/`powershell`/`command` rather than a nested `hooks` array.
fn copilot_entry_is_ours(entry: &Value) -> bool {
    ["bash", "powershell", "command"].iter().any(|key| {
        entry
            .get(*key)
            .and_then(Value::as_str)
            .map(|c| c.contains(MARKER))
            .unwrap_or(false)
    })
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Settings with Coucou's hooks added; everything else is left untouched.
fn merged(existing: &Value, target: HookTarget) -> Value {
    match target {
        HookTarget::Claude => merged_claude(existing),
        HookTarget::Copilot => merged_copilot(existing),
    }
}

fn merged_claude(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    for (event, timeout) in HOOK_EVENTS {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(json!({
            "hooks": [{
                "type": "command",
                "command": hook_command(event, HookTarget::Claude),
                "timeout": timeout,
            }]
        }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// Copilot's file: a numeric version, flat entries, and `timeoutSec`.
fn merged_copilot(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    for (event, timeout) in COPILOT_EVENTS {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !copilot_entry_is_ours(entry));
        let command = hook_command(event, HookTarget::Copilot);
        // Copilot picks `bash` or `powershell` by OS; both carry the same shell
        // command, which is what its docs prescribe for a cross-platform hook.
        list.push(json!({
            "type": "command",
            "bash": command,
            "powershell": command,
            "timeoutSec": timeout,
        }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("version".into(), json!(1));
    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// Settings with every Coucou entry removed, and nothing else changed.
fn without_ours(existing: &Value, target: HookTarget) -> Value {
    let is_ours: fn(&Value) -> bool = match target {
        HookTarget::Claude => entry_is_ours,
        HookTarget::Copilot => copilot_entry_is_ours,
    };
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> = list.iter().filter(|e| !is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    // An uninstalled Copilot file keeps its version key: it is part of the file's
    // schema, and Copilot's own docs reject a hooks file without it.
    Value::Object(root)
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// Down to the second: installing then uninstalling in the same minute must not
/// quietly overwrite the first backup.
fn stamp() -> String {
    let t = platform::local_time();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

fn backup_path(target: HookTarget) -> PathBuf {
    let p = hook_path(target);
    // Keeps the sibling name in the diff the user reads, so a Copilot backup
    // cannot be mistaken for a Claude Code one.
    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    p.with_file_name(format!("{name}.bak-{}", stamp()))
}

/// Identifies the exact bytes a preview was computed from. FNV-1a is plenty:
/// the question is only "is this still the file I showed the user?".
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_fingerprint(target: HookTarget) -> String {
    match std::fs::read(hook_path(target)) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status(target: HookTarget) -> HookStatus {
    let current = read_settings_lossy(target);
    let is_ours: fn(&Value) -> bool = match target {
        HookTarget::Claude => entry_is_ours,
        HookTarget::Copilot => copilot_entry_is_ours,
    };
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(is_ours)
        })
        .unwrap_or(false);
    let relay = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: hook_path(target).to_string_lossy().to_string(),
        hook_ready: relay.exists(),
        hook_path: relay.to_string_lossy().to_string(),
    }
}

pub fn preview(target: HookTarget, install: bool) -> Result<HookPreview, String> {
    let current = read_settings(target)?;
    let next = if install { merged(&current, target) } else { without_ours(&current, target) };
    Ok(HookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path(target).to_string_lossy().to_string(),
        settings_path: hook_path(target).to_string_lossy().to_string(),
        fingerprint: current_fingerprint(target),
    })
}

/// Writes the merged (or cleaned) settings after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file changed
/// in between — another tool, another window, the user's own editor — we stop
/// and make them look at a fresh diff, because the only thing worse than not
/// installing the hooks is silently reverting somebody else's edit.
pub fn write(target: HookTarget, install: bool, fingerprint: &str) -> Result<String, String> {
    let path = hook_path(target);
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Read before the backup: an unreadable file must abort before we touch
    // anything at all.
    let current = read_settings(target)?;
    if current_fingerprint(target) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let backup = backup_path(target);
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }

    let next = if install { merged(&current, target) } else { without_ours(&current, target) };
    let mut text = pretty(&next);
    text.push('\n');

    // A dotfiles setup often makes settings.json a symlink: write to the file it
    // points at, so the link survives the rename below.
    #[cfg(unix)]
    let path = std::fs::canonicalize(&path).unwrap_or(path);

    // Write beside the target and rename over it: a crash or a full disk leaves
    // the original settings.json intact rather than half a file.
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    if let Err(err) = write_like(&temp, &path, text.as_bytes()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup.to_string_lossy().to_string())
}

/// Writes `bytes` to `temp`, which is about to replace `original`.
///
/// On Linux a fresh file would get the umask's 0644, and settings.json can hold
/// API keys in its `env` block: the new file is created readable by us only,
/// then given the original's permissions, so the rename never widens them.
fn write_like(temp: &Path, original: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(temp)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(original)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = original;
    Ok(())
}

/// Copies the relay (coucou-hook.exe / coucou-hook) into the local data dir's
/// bin/ on launch. In a bundled install it comes from the app resources; in
/// `tauri dev` it sits next to the app binary in the workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: `resources` used to be a glob, which made NSIS
/// mirror the source path into `_up_\target\release\`, no candidate matched, and
/// the relay was simply never installed. It only looked healthy on a developer
/// machine, where a leftover copy from `tauri dev` was already sitting in bin/.
pub fn ensure_hook_exe(app: &AppHandle) {
    let dest = settings::hook_exe_path();
    let Some(dir) = dest.parent() else { return };
    // Nobody else may swap the relay Claude Code runs: its folder is ours only.
    if platform::ensure_private_dir(&settings::local_dir()).is_err()
        || std::fs::create_dir_all(dir).is_err()
    {
        return;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(platform::HOOK_EXE, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release hook the pre-build step produces.
            candidates.push(parent.join(platform::HOOK_EXE));
            candidates.push(parent.join("../release").join(platform::HOOK_EXE));
            // Belt and braces: where the old glob form used to land it.
            candidates.push(parent.join("_up_/target/release").join(platform::HOOK_EXE));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        crate::log::line(format!(
            "{} not found — Claude Code hooks cannot work. Looked in: {}",
            platform::HOOK_EXE,
            tried.join(", ")
        ));
        return;
    };
    install_relay(&src, &dest);
}

#[cfg(windows)]
fn install_relay(src: &Path, dest: &Path) {
    let same = match (std::fs::metadata(src), std::fs::metadata(dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    // A hook may be running right now and hold the file open; keeping the old
    // copy is fine, it is the same relay.
    if let Err(err) = std::fs::copy(src, dest) {
        if !dest.exists() {
            crate::log::line(format!("could not install {}: {err}", platform::HOOK_EXE));
        }
    }
}

/// Linux does not keep the modification time on copy, so the contents decide.
/// The new relay is written beside the old one and renamed over it: a hook
/// starting at that moment runs either the old relay or the new one, never half
/// of one, and a relay that is running right now does not block the update.
#[cfg(unix)]
fn install_relay(src: &Path, dest: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if matches!((std::fs::read(src), std::fs::read(dest)), (Ok(a), Ok(b)) if a == b) {
        return;
    }
    let temp = dest.with_extension(format!("new-{}", std::process::id()));
    let result = std::fs::copy(src, &temp)
        .and_then(|_| std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&temp, dest));
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        crate::log::line(format!("could not install {}: {err}", platform::HOOK_EXE));
    }
}

// ── Minimal unified diff (LCS) ────────────────────────────────────────────────

/// settings.json is short, so a plain O(n·m) LCS is the simplest honest diff.
fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    // Keep three lines of context around each change so the panel stays readable.
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        for k in lo..hi {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHERE: &str = "settings.json";

    /// These tests point HOME at a temp directory, which is a process-wide
    /// environment variable: two of them running at once would read each other's
    /// files and fail for reasons that have nothing to do with the code. The
    /// lock is the fix; it is held for the whole test, never across one.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Sets HOME to a fresh directory and hands back the guard that keeps any
    /// other test out until the caller is done with it.
    fn temp_home(tag: &str) -> (std::path::PathBuf, std::sync::MutexGuard<'static, ()>) {
        let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("coucou-hooks-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var(platform::HOME_VAR, &tmp);
        (tmp, guard)
    }

    #[test]
    fn a_utf8_bom_is_stripped_not_treated_as_corruption() {
        // PowerShell 5's `Set-Content -Encoding utf8` produces exactly this.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus","hooks":{}}"#);
        let parsed = parse_settings(&bytes, WHERE).expect("a BOM must not defeat the parser");
        assert_eq!(parsed["model"], "opus");
    }

    #[test]
    fn unreadable_content_is_an_error_never_an_empty_object() {
        // This is the whole bug: returning {} here meant `merged()` produced a
        // file containing nothing but Coucou's hooks, and the write replaced
        // everything the user had.
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"a string\""[..]] {
            assert!(
                parse_settings(bad, WHERE).is_err(),
                "content we cannot use must refuse, not come back empty"
            );
        }
    }

    #[test]
    fn empty_and_whitespace_files_start_from_nothing() {
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
        assert_eq!(parse_settings(b"  
	 ", WHERE).unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        let after = merged(&existing, HookTarget::Claude);
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("someone-elses-tool.exe")),
            "another tool's hook was dropped"
        );
        assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
        assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());

        // And removing ours puts it back exactly as it was.
        let cleaned = without_ours(&after, HookTarget::Claude);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn a_fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
        assert_ne!(fingerprint(b""), fingerprint(b"{}"));
    }

    #[cfg(unix)]
    #[test]
    fn the_hook_path_is_one_shell_word_whatever_it_contains() {
        assert_eq!(sh_quote("/home/a b/x"), "'/home/a b/x'");
        // $, backticks, backslashes and double quotes stay literal in single quotes.
        assert_eq!(sh_quote(r#"/h/$(id)`x`\"y"#), r#"'/h/$(id)`x`\"y'"#);
        // A single quote closes, escapes and reopens.
        assert_eq!(sh_quote("/h/it's"), r"'/h/it'\''s'");
    }

    /// settings.json can carry API keys in its `env` block: rewriting it must
    /// never make it readable by more people than before.
    #[cfg(unix)]
    #[test]
    fn rewriting_settings_never_widens_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("coucou-perm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("settings.json");
        let temp = dir.join("settings.json.new");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;

        for wanted in [0o600, 0o640, 0o644] {
            std::fs::write(&original, b"{}").unwrap();
            std::fs::set_permissions(&original, std::fs::Permissions::from_mode(wanted)).unwrap();
            let _ = std::fs::remove_file(&temp);
            write_like(&temp, &original, b"{\"a\":1}").unwrap();
            assert_eq!(mode(&temp), wanted, "the rewrite must keep {wanted:o}");
        }

        // No original: ours only.
        std::fs::remove_file(&original).unwrap();
        let _ = std::fs::remove_file(&temp);
        write_like(&temp, &original, b"{}").unwrap();
        assert_eq!(mode(&temp), 0o600);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// the home directory at a temp directory, and that is process-wide.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        let (tmp, _home) = temp_home("claude");
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();

        let path = hook_path(HookTarget::Claude);
        assert!(path.starts_with(&tmp), "the test must not touch the real home");

        // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
        let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(original.as_bytes());
        std::fs::write(&path, &bytes).unwrap();

        // Install.
        let plan = preview(HookTarget::Claude, true)
            .expect("a BOM must not stop the preview");
        assert!(plan.diff.contains("coucou-hook"), "the diff must show what changes");
        let backup = write(HookTarget::Claude, true, &plan.fingerprint)
            .expect("install should succeed");

        // The backup holds the original bytes, BOM and all.
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);

        // Everything else survived, and so did the other tool's hook.
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["model"], "claude-opus-5");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["tui"]["x"], 1);
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
        assert!(status(HookTarget::Claude).installed);

        // A file that moved since the preview is refused, and left alone.
        let stale = preview(HookTarget::Claude, false).unwrap();
        std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
        let err = write(HookTarget::Claude, false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(untouched["model"], "someone-else-edited-this");

        // Content we cannot parse is refused before anything is written.
        std::fs::write(&path, b"{ broken").unwrap();
        assert!(preview(HookTarget::Claude, true).is_err());
        assert!(write(HookTarget::Claude, true, "whatever").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── GitHub Copilot ──────────────────────────────────────────────────────
    //
    // Copilot's format is not Claude Code's with a different name: flat entries,
    // `timeoutSec`, a numeric `version`, and a different answer syntax. These
    // tests pin the parts that would silently break an installed hook set.

    #[test]
    fn claude_hooks_keep_their_nested_shape() {
        let merged = merged(&json!({}), HookTarget::Claude);
        let hooks = merged["hooks"].as_object().unwrap();
        let entry = &hooks["PreToolUse"].as_array().unwrap()[0]["hooks"][0];
        assert_eq!(entry["timeout"], 10);
        assert!(entry["command"].as_str().unwrap().contains(MARKER));
        // Claude must never be tagged: `--agent` changes the wire format, and
        // the relay would answer with Copilot's bare object.
        assert!(!entry["command"].as_str().unwrap().contains("--agent"));
        assert!(merged.get("version").is_none());
    }

    #[test]
    fn copilot_hooks_are_flat_versioned_and_tagged() {
        let merged = merged(&json!({}), HookTarget::Copilot);
        assert_eq!(merged["version"], 1, "Copilot rejects a file without it");
        let hooks = merged["hooks"].as_object().unwrap();

        let entry = &hooks["permissionRequest"].as_array().unwrap()[0];
        // Flat: no nested "hooks" wrapper, and `timeoutSec` not `timeout`.
        assert_eq!(entry["timeoutSec"], 120, "a human is answering this one");
        assert!(entry.get("timeout").is_none());
        assert!(entry.get("hooks").is_none());
        assert_eq!(entry["type"], "command");
        // Both shell keys, so the same file works on macOS and Windows.
        assert!(entry["bash"].as_str().unwrap().contains("--agent copilot"));
        assert_eq!(entry["bash"], entry["powershell"]);

        // Every event we claim to handle must actually be written, and every
        // command tagged — an untagged entry would route to Claude Code's pill.
        for event in COPILOT_EVENTS {
            let entries = hooks[event.0].as_array().unwrap();
            assert_eq!(entries.len(), 1, "{event:?}");
            assert!(entries[0]["bash"].as_str().unwrap().contains("--agent copilot"));
        }
    }

    #[test]
    fn copilot_pretooluse_never_carries_a_decision() {
        // Copilot's command preToolUse hook is fail-closed: a crash or non-zero
        // exit denies the tool call. Approvals therefore ride permissionRequest,
        // which is fail-open, and preToolUse stays progress-only. If someone ever
        // adds a decision here, a Coucou bug would break the user's editor.
        let merged = merged(&json!({}), HookTarget::Copilot);
        let pre = &merged["hooks"]["preToolUse"].as_array().unwrap()[0];
        assert!(pre.get("permissionDecision").is_none());
        assert!(pre.get("permissionDecisionReason").is_none());
        assert!(merged["hooks"].get("permissionRequest").is_some());
    }

    #[test]
    fn copilot_install_is_idempotent() {
        // Reinstalling is a normal thing to do; entries must not stack up.
        // The command embeds the relay path, which is derived from HOME, so
        // this pins HOME too — otherwise a test that repoints it mid-run would
        // make the two merges disagree for reasons that are not about merging.
        let (_tmp, _home) = temp_home("copilot-idempotent");
        let once = merged(&json!({}), HookTarget::Copilot);
        let twice = merged(&once, HookTarget::Copilot);
        assert_eq!(once, twice);
        let c1 = merged(&json!({}), HookTarget::Claude);
        assert_eq!(c1, merged(&c1, HookTarget::Claude));
    }

    #[test]
    fn copilot_uninstall_keeps_foreign_hooks_and_the_version_key() {
        let existing = json!({
            "otherSetting": true,
            "hooks": {
                "preToolUse": [{"type": "command", "bash": "my-own-linter.sh"}],
                "sessionStart": [{"type": "command", "bash": "someone-elses.sh"}]
            }
        });
        let installed = merged(&existing, HookTarget::Copilot);
        let removed = without_ours(&installed, HookTarget::Copilot);

        assert_eq!(removed["otherSetting"], true);
        assert_eq!(removed["hooks"]["preToolUse"][0]["bash"], "my-own-linter.sh");
        assert_eq!(removed["hooks"]["sessionStart"][0]["bash"], "someone-elses.sh");
        // The schema key survives an uninstall: Copilot would reject the file.
        assert_eq!(removed["version"], 1);
    }

    #[test]
    fn an_empty_copilot_uninstall_leaves_no_empty_object() {
        let installed = merged(&json!({}), HookTarget::Copilot);
        let removed = without_ours(&installed, HookTarget::Copilot);
        assert!(removed.get("hooks").is_none(), "left an empty hooks object: {removed}");
    }

    #[test]
    fn the_two_targets_never_read_or_write_each_others_file() {
        let (tmp, _home) = temp_home("copilot");
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::fs::create_dir_all(tmp.join(".copilot/hooks")).unwrap();

        let claude = hook_path(HookTarget::Claude);
        let copilot = hook_path(HookTarget::Copilot);
        assert!(claude.starts_with(&tmp.join(".claude")));
        assert!(copilot.starts_with(&tmp.join(".copilot")));

        // A foreign hook in the Copilot file must survive a Claude Code install.
        std::fs::write(&copilot, br#"{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"linter.sh"}]}}"#).unwrap();
        write(HookTarget::Claude, true, &current_fingerprint(HookTarget::Claude)).unwrap();
        let untouched: Value = serde_json::from_slice(&std::fs::read(&copilot).unwrap()).unwrap();
        assert_eq!(untouched["hooks"]["preToolUse"][0]["bash"], "linter.sh");
        assert!(!status(HookTarget::Copilot).installed, "Copilot must not look configured");

        // And a full round trip on the Copilot side, backup included.
        let plan = preview(HookTarget::Copilot, true).unwrap();
        let backup = write(HookTarget::Copilot, true, &plan.fingerprint).unwrap();
        assert!(status(HookTarget::Copilot).installed);
        assert!(backup.contains("coucou.json.bak-"), "{backup:?}");

        let after: Value = serde_json::from_slice(&std::fs::read(&copilot).unwrap()).unwrap();
        assert_eq!(after["hooks"]["preToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(after["hooks"]["preToolUse"][0]["bash"], "linter.sh");

        // Uninstalling restores the user's file byte for byte.
        let plan = preview(HookTarget::Copilot, false).unwrap();
        write(HookTarget::Copilot, false, &plan.fingerprint).unwrap();
        assert!(!status(HookTarget::Copilot).installed);
        let restored: Value = serde_json::from_slice(&std::fs::read(&copilot).unwrap()).unwrap();
        assert_eq!(restored["hooks"]["preToolUse"][0]["bash"], "linter.sh");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
