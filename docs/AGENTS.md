# Coucou — third-party agent integration

Any tool that can write to a Unix domain socket (macOS, Linux) or a named pipe (Windows) can send events to Coucou and have its own pill next to Claude Code.

## The `coucou_agent` field

Add the optional field `coucou_agent` to any hook JSON payload. Coucou will create a pill labelled with the agent name and route all events to it.

**Validation:** the name must match `^[a-z0-9-]{1,24}$` (lowercase letters, digits and hyphens, 1–24 characters). An absent or invalid name routes the event to the Claude Code pill instead.

## Hook command (macOS)

Configure your tool to call the Coucou relay with `--agent <your-name>` after the hook executable:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "/path/to/nb-hook --agent my-tool" }
    ]
  }
}
```

The shell wrapper passes `"$@"` to the Python relay, which extracts the agent name and injects it into the payload before forwarding to Coucou.

## Hook command (Windows)

Same pattern with the Windows relay:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "C:\\path\\to\\coucou-hook.exe --agent my-tool" }
    ]
  }
}
```

## Hook command (Linux)

Same pattern with the Linux relay. Coucou copies the relay to `~/.local/share/coucou/bin/coucou-hook` at startup.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "/path/to/coucou-hook --agent my-tool" }
    ]
  }
}
```

## Payload format

The relay adds `coucou_agent` to the JSON it forwards. You can also add it yourself if you talk to the socket directly:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session-1",
  "coucou_agent": "my-tool",
  "prompt": "Running task…"
}
```

Send newline-terminated JSON to the socket:
- **macOS (GitHub build):** `~/Library/Application Support/NotchBuddy/nb.sock`
- **macOS (App Store build):** `~/Library/Containers/fr.louisraille.Coucou/Data/nb.sock`
- **Windows:** `\\.\pipe\coucou-<user-SID>`
- **Linux:** `$XDG_RUNTIME_DIR/coucou.sock` (usually `/run/user/<uid>/coucou.sock`). Only your own user account can connect.

## Supported events

All standard Claude Code hook events are supported. `PermissionRequest` gets an
approval card for **declared agents** — Claude Code, Cursor, Codex and GitHub
Copilot. For any *other* third-party agent the request is answered immediately
with no decision, so the relay writes nothing and the agent re-asks in its
terminal. That is deliberate: the card can only be answered by a human looking at
the notch, and offering one for an agent Coucou knows nothing about would look
like a Claude Code request.

The pill lifecycle:

| Event | Effect |
|---|---|
| `SessionStart` | Creates the pill (if absent), sets state to idle |
| `UserPromptSubmit` | State → thinking; prompt shown in ticker |
| `PreToolUse` | State → working; tool label shown in ticker |
| `PostToolUse` / `PostToolUseFailure` | State → working |
| `Notification` | Rate-limit or question state if applicable |
| `Stop` | State → finished for 5 s; active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `StopFailure` | State → error |
| `SessionEnd` | Active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `SubagentStart` / `SubagentStop` | Step added to ticker |

## Declared pills

A **declared pill** is a catalog entry (`PillCatalog.swift`) that has been enabled in **Settings → Active pills**. When a session ends for a declared pill, the pill stays visible and resets to idle instead of disappearing.

A catalog pill that is not checked in Settings behaves like any other agent: it gets an automatic pill when a session starts, and that pill is removed when the session ends.

### GitHub Copilot

Coucou supports GitHub Copilot out of the box via **Settings → GitHub Copilot →
Install hooks**. The installer writes one file, `~/.copilot/hooks/coucou.json`
(or `$COPILOT_HOME/hooks/`), which covers three surfaces at once:

| Surface | Why the same file works |
|---|---|
| Copilot CLI | `~/.copilot/hooks/*.json` is its native user-level hook directory |
| VS Code — Local harness | Discovers `~/.copilot/hooks/*.json`; its parser accepts the Copilot format (numeric `version`, camelCase events) and maps it to the local schema |
| VS Code — Copilot target | Runs the same Copilot SDK as the CLI |

The installer is user-level only. Coucou never writes `.github/hooks/*.json`: those
are committed to the repository and would run for every contributor, and under
Copilot cloud agent — in a sandbox where the Coucou app does not exist.

| Copilot event | Coucou event |
|---|---|
| `sessionStart` | `SessionStart` |
| `userPromptSubmitted` | `UserPromptSubmit` |
| `preToolUse` | `PreToolUse` |
| `postToolUse` | `PostToolUse` |
| `postToolUseFailure` | `PostToolUseFailure` |
| `permissionRequest` | `PermissionRequest` |
| `agentStop` | `Stop` |
| `subagentStart` / `subagentStop` | `SubagentStart` / `SubagentStop` |
| `sessionEnd` | `SessionEnd` |
| `notification` | `Notification` |

There is no `StopFailure` equivalent; a failed turn surfaces through
`errorOccurred`, and the island already marks the failing tool via
`postToolUseFailure`.

The relay is invoked with `--agent copilot`, which routes events to the
`agent_copilot` pill and switches the answer syntax (below).

### ⚠ Approvals use `permissionRequest`, never `preToolUse`

Copilot's `preToolUse` command hook is **fail-closed**: a crash or a non-zero exit
*denies* the tool call, even when stdout says `permissionDecision: "allow"`. A bug
in Coucou would therefore break the user's editor. `permissionRequest` is
fail-open on a crash, so a Coucou that is closed, paused or slow degrades to
"Copilot asks in its own terminal" — which is the behaviour `CLAUDE.md` requires.

Coucou therefore installs `preToolUse` for progress only and never emits a
decision from it.

### The answer syntax differs per harness

Both relays accept the same `--agent` tag and write whichever shape the caller
understands:

| Agent | `stdout` on a decision |
|---|---|
| Claude Code, Gemini, Antigravity, Codex | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` |
| GitHub Copilot | `{"behavior":"allow"}` |

Copilot reads `stdout` as the decision object itself, so an envelope would parse
as a decision with no `behavior` and be ignored. Anything unrecognised prints
nothing on both paths — silence is the safe answer, because it falls through to
the agent's own prompt.

Copilot has no equivalent of Claude Code's `updatedPermissions`, so the island
hides **Always** for a Copilot request.

The GitHub build exposes Gemini CLI (`agent_gemini`) and Antigravity (`agent_antigravity`) in Settings → Active pills. Cursor (`agent_cursor`) and Codex (`agent_codex`, GitHub build only) are there too — their pills can be declared and set as the main pill; session support is coming in a future version.

## Real-world examples

### Gemini CLI (macOS)

Coucou supports Gemini CLI out of the box via **Settings → Gemini CLI → Install hooks**.
The installer writes to `~/.gemini/settings.json` and uses `--agent gemini` so
Gemini sessions get their own pill. The relay translates Gemini event names to canonical
Coucou events automatically.

| Gemini CLI event | Canonical event |
|---|---|
| `BeforeTool` | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `BeforeAgent` | `UserPromptSubmit` |
| `AfterAgent` | `Stop` |

`AfterModel` is not installed — it fires on every response chunk and would flood the island.

### Antigravity — `agy` (macOS)

Coucou supports Antigravity out of the box via **Settings → Antigravity → Install hooks**.
The installer writes to `~/.gemini/config/hooks.json` (timeouts in seconds) and uses
`--agent antigravity`. The relay translates `toolCall.name` / `conversationId` to the
island's `tool_name` / `session_id`.

| Antigravity event | Canonical event |
|---|---|
| `PreInvocation` | `UserPromptSubmit` |
| `PreToolUse` | `PreToolUse` |
| `PostToolUse` | `PostToolUse` |
| `PostInvocation` | `PostToolUse` |
| `Stop` | `Stop` |

### Any other tool

Follow the generic pattern: call `nb-hook --agent <your-name> <EventName>` (macOS),
`coucou-hook.exe --agent <your-name> <EventName>` (Windows)
or `~/.local/share/coucou/bin/coucou-hook --agent <your-name> <EventName>` (Linux)
and let the relay forward the event.

## Quick test (Linux)

With Coucou running:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","coucou_agent":"demo"}' \
  | ~/.local/share/coucou/bin/coucou-hook --agent demo
```

A "demo" pill should appear in the island.

## Quick test (macOS)

With Coucou running:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","coucou_agent":"demo"}' \
  | /bin/sh ~/Library/Application\ Support/NotchBuddy/nb-hook --agent demo
```

A "demo" pill should appear in the island.
