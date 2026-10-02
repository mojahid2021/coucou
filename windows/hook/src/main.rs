//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let Some(event) = read_event() else { std::process::exit(0) };

    let waits_for_answer = event.is_permission;
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let payload = event.payload.clone();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision, event.target) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: the agent asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// Which harness is asking, and therefore which answer syntax it expects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    /// Claude Code, Gemini, Antigravity, Codex — anything that wants Claude's
    /// `hookSpecificOutput` envelope. The default, so an unrecognised `--agent`
    /// behaves exactly as it did before.
    Claude,
    /// GitHub Copilot (CLI, VS Code Local harness, VS Code Copilot target).
    Copilot,
}

impl Target {
    /// Only an exact match counts. A typo must not silently change the wire
    /// format of an existing agent's approvals.
    fn from_agent(agent: &str) -> Target {
        if agent == "copilot" { Target::Copilot } else { Target::Claude }
    }

    /// Copilot spells every event in camelCase and uses `agentStop` where Claude
    /// Code says `Stop`. Rewriting them to the canonical names is what lets one
    /// island state machine serve every harness.
    ///
    /// `permissionRequest` matters most: left untranslated it never matches the
    /// island's `PermissionRequest` arm, so approvals would silently never fire
    /// and the user would wait for a card that cannot appear.
    fn canonical_event(self, raw: &str) -> String {
        if self != Target::Copilot {
            return raw.to_string();
        }
        match raw {
            "permissionRequest" => "PermissionRequest",
            "agentStop" => "Stop",
            "sessionStart" => "SessionStart",
            "sessionEnd" => "SessionEnd",
            "userPromptSubmitted" => "UserPromptSubmit",
            "preToolUse" => "PreToolUse",
            "postToolUse" => "PostToolUse",
            "postToolUseFailure" => "PostToolUseFailure",
            "subagentStart" => "SubagentStart",
            "subagentStop" => "SubagentStop",
            "notification" => "Notification",
            "errorOccurred" => "StopFailure",
            "preCompact" => "PreCompact",
            other => other,
        }
        .to_string()
    }
}

/// Rewrites Copilot's camelCase payload keys into the snake_case names the
/// island reads. A no-op for every other agent, and never clobbers a key that
/// is already in the canonical form.
fn normalize_copilot_fields(map: &mut serde_json::Map<String, serde_json::Value>, target: Target) {
    if target != Target::Copilot {
        return;
    }
    const RENAMES: &[(&str, &str)] = &[
        ("tool_name", "toolName"),
        ("tool_input", "toolArgs"),
        ("session_id", "sessionId"),
    ];
    for (to, from) in RENAMES {
        if !map.contains_key(*to) {
            if let Some(v) = map.remove(*from) {
                map.insert((*to).to_string(), v);
            }
        }
    }
}

/// What `read_event` hands to `main`: the line to forward, who is listening,
/// and whether this event waits for a human.
struct Incoming {
    payload: String,
    target: Target,
    is_permission: bool,
}

/// The documented permission output for the harness that asked. Anything we do
/// not recognise prints nothing at all rather than guessing — silence is the safe
/// answer, and for Copilot silence is exactly right: no decision falls through to
/// its own terminal prompt.
///
/// Claude Code: https://code.claude.com/docs/en/hooks
/// Copilot:     https://docs.github.com/en/copilot/reference/hooks-reference
fn decision_json(decision: &str, target: Target) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not the agent's.
        "allow" | "always" => r#"{"behavior":"allow"}"#,
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#,
        _ => return None,
    };
    Some(match target {
        // Copilot answers `permissionRequest` with the bare object on stdout.
        // Nothing else — no hookEventName, no envelope.
        Target::Copilot => behavior.to_string(),
        Target::Claude => format!(
            r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
        ),
    })
}

/// Reads stdin and returns the payload to forward, the event name, and which
/// harness is listening.
fn read_event() -> Option<Incoming> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let mut map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    // Resolved before `agent` is moved into the payload below.
    let target = Target::from_agent(&agent);
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    // Copilot's own event names are translated to the canonical ones the island
    // switches on, so one state machine serves every harness.
    let event = target.canonical_event(&event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    // Copilot's native payload is camelCase (`toolName`, `toolArgs`, `sessionId`)
    // while the island reads Claude Code's snake_case. Copilot only emits the
    // snake_case form in its VS Code-compatible PascalCase mode, so without this
    // a CLI session would show a bare "Tool" in the ticker and an approval card
    // with no command on it — the two things the card exists to tell you.
    // Never overwrites a value that is already there.
    normalize_copilot_fields(&mut map, target);

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some(Incoming {
        is_permission: event == "PermissionRequest",
        payload: line,
        target,
    })
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", Target::Claude).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", Target::Claude).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", Target::Claude).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn copilot_gets_the_bare_object_it_expects() {
        // Copilot's permissionRequest reads stdout as the decision itself — an
        // envelope here would be parsed as a decision with no `behavior`, and
        // silently fall through to its own prompt.
        assert_eq!(decision_json("allow", Target::Copilot).unwrap(), r#"{"behavior":"allow"}"#);
        assert_eq!(
            decision_json("deny", Target::Copilot).unwrap(),
            r#"{"behavior":"deny","message":"Denied from Coucou"}"#
        );
        assert_eq!(decision_json("always", Target::Copilot).unwrap(), r#"{"behavior":"allow"}"#);
    }

    #[test]
    fn only_copilot_selects_the_copilot_wire_format() {
        // A near-miss must not change how an existing agent's approvals are
        // written — that would break the very tools this relay was written for.
        for agent in ["Claude", "co-pilot", "copilot-cli", "COPILOT", "copilot ", ""] {
            assert_eq!(Target::from_agent(agent), Target::Claude, "{agent:?}");
        }
        assert_eq!(Target::from_agent("copilot"), Target::Copilot);
        // Everything except the exact match keeps Claude's bytes.
        assert!(decision_json("allow", Target::Claude).unwrap().contains("hookSpecificOutput"));
    }

    #[test]
    fn copilots_event_names_become_the_canonical_ones() {
        // The island switches on Claude Code's spelling. Left untranslated,
        // Copilot's `permissionRequest` matches no arm: no card is ever shown,
        // the relay waits 110 s for an answer that cannot come, and the user
        // watches Copilot sit idle. This is the regression that test guards.
        assert_eq!(Target::Copilot.canonical_event("permissionRequest"), "PermissionRequest");
        assert_eq!(Target::Copilot.canonical_event("agentStop"), "Stop");
        assert_eq!(Target::Copilot.canonical_event("sessionStart"), "SessionStart");
        assert_eq!(Target::Copilot.canonical_event("userPromptSubmitted"), "UserPromptSubmit");
        assert_eq!(Target::Copilot.canonical_event("preToolUse"), "PreToolUse");
        assert_eq!(Target::Copilot.canonical_event("postToolUse"), "PostToolUse");
        assert_eq!(Target::Copilot.canonical_event("errorOccurred"), "StopFailure");

        // Claude Code's names pass through untouched.
        assert_eq!(Target::Claude.canonical_event("permissionRequest"), "permissionRequest");
        assert_eq!(Target::Claude.canonical_event("PermissionRequest"), "PermissionRequest");
        assert_eq!(Target::Claude.canonical_event("agentStop"), "agentStop");

        // Anything unknown is left alone rather than guessed at.
        assert_eq!(Target::Copilot.canonical_event("somethingNew"), "somethingNew");
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", Target::Claude).is_none());
        assert!(decision_json("maybe", Target::Claude).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, Target::Claude).is_none());
        // Same silence for Copilot: no decision must fall through to its prompt.
        assert!(decision_json("", Target::Copilot).is_none());
        assert!(decision_json("maybe", Target::Copilot).is_none());
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, Target::Copilot).is_none());
        // Neither target may emit a half-written object.
        for d in ["", " ", "allow", "always", "deny", "\n", "{", "null"] {
            if let Some(out) = decision_json(d, Target::Copilot) {
                assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok(), "{d:?}");
            }
        }
    }

    /// Copilot's native payload is camelCase; the island only reads snake_case.
    /// This is the field that makes the ticker and the approval card useful.
    #[test]
    fn copilots_camel_case_fields_are_translated() {
        let mut map = serde_json::json!({
            "toolName": "bash", "toolArgs": {"command": "ls"}, "sessionId": "c1"
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_copilot_fields(&mut map, Target::Copilot);
        let out = serde_json::Value::Object(map);

        assert_eq!(out["tool_name"], "bash");
        assert_eq!(out["tool_input"]["command"], "ls");
        assert_eq!(out["session_id"], "c1");
        // The camelCase originals are gone, so nothing downstream sees two names.
        assert!(out.get("toolName").is_none());
        assert!(out.get("sessionId").is_none());
    }

    #[test]
    fn translation_never_overwrites_a_value_that_is_already_there() {
        // Copilot's VS Code-compatible mode sends snake_case already. Reading it
        // must not depend on which of the two forms arrived.
        let mut map = serde_json::json!({
            "tool_name": "edit", "toolName": "bash", "session_id": "s1", "sessionId": "s2"
        })
        .as_object()
        .unwrap()
        .clone();
        normalize_copilot_fields(&mut map, Target::Copilot);
        let out = serde_json::Value::Object(map);
        assert_eq!(out["tool_name"], "edit");
        assert_eq!(out["session_id"], "s1");
    }

    #[test]
    fn no_other_agent_has_its_fields_renamed() {
        let mut map = serde_json::json!({"toolName": "bash"})
            .as_object()
            .unwrap()
            .clone();
        normalize_copilot_fields(&mut map, Target::Claude);
        // Untouched: Claude Code, Gemini, Antigravity and Codex all speak
        // snake_case and their payload must pass through byte for byte.
        assert!(map.contains_key("toolName"));
        assert!(!map.contains_key("tool_name"));
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
