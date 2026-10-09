// Custom OpenAI-compatible chat — a provider whose base URL, key and model the
// user supplies. Ollama, LM Studio, OpenRouter, Groq, vLLM, Azure and OpenAI
// itself all speak this shape, so one code path covers every one of them.
//
// As on the Anthropic side, this all happens in Rust: the key is read from the
// credential manager here and file bytes never cross the IPC boundary into the
// island.

use serde::Serialize;
use serde_json::{json, Value};

use crate::claude::{file_as_text, Chat, ChatContext, ChatReply, SYSTEM_PROMPT};
use crate::secrets;

/// Matches the Anthropic path so a long answer is not cut short on one provider
/// and allowed on the other.
const MAX_TOKENS: u32 = 4096;
/// Model discovery is a dropdown filler, not the conversation — it should fail
/// fast rather than hold the popover open.
const MODELS_TIMEOUT_SECS: u64 = 10;
const CHAT_TIMEOUT_SECS: u64 = 90;

/// Suffixes a user is likely to paste along with the base URL. Copied straight
/// from docs and config screens, so the endpoint gets trimmed back to its base.
const ENDPOINT_SUFFIXES: [&str; 4] = [
    "/chat/completions",
    "/completions",
    "/models",
    "/v1/chat/completions",
];

/// Never a chat model, whatever the endpoint calls it. Kept deliberately short:
/// an endpoint we know nothing about may name things anything, so the list only
/// drops families that cannot possibly answer a `chat/completions` call. Anything
/// wrongly filtered is still reachable by typing the model id by hand.
const NON_CHAT_MARKERS: [&str; 9] = [
    "embed", "whisper", "tts", "dall-e", "moderation", "audio", "rerank", "bge-", "e5-",
];

#[derive(Clone)]
pub struct CustomChatConfig {
    /// Already normalised — `normalize_base_url` ran before this was built, so
    /// the endpoints below are a plain string join.
    pub base_url: String,
    pub model: String,
    /// None for a local server that needs no auth — Ollama and LM Studio both
    /// answer without one, so an empty key is a valid configuration.
    pub api_key: Option<String>,
}

/// Deliberately hand-written rather than derived: `#[derive(Debug)]` would print
/// the key in full, and this struct reaches anything that logs a config.
impl std::fmt::Debug for CustomChatConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CustomChatConfig")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// What an endpoint says a model can do.
///
/// Every field is optional and every one is advisory: it describes the model, it
/// does not change what Coucou sends. A server that reports nothing here simply
/// yields `None`, and a classic OpenAI `/models` response never has the block at
/// all — so this is purely additive.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub tool_calling: Option<bool>,
    pub reasoning: Option<bool>,
    pub thinking: Option<bool>,
    pub vision: Option<bool>,
}

impl ModelCapabilities {
    /// True when at least one flag was reported — lets the UI hide the badges
    /// rather than showing four of them as "off".
    fn is_meaningful(&self) -> bool {
        self.tool_calling.is_some()
            || self.reasoning.is_some()
            || self.thinking.is_some()
            || self.vision.is_some()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModel {
    pub id: String,
    /// Always equal to `id`, on purpose. The id is what goes on the wire and
    /// what the user must type into the manual field, so a prettier label would
    /// put a gap between what is displayed and what actually works.
    pub label: String,
    /// Present only on endpoints that report limits. `None` on OpenAI and the
    /// other classic servers, which is what keeps that path visually unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// e.g. `["text", "image", "video"]`. Empty when the endpoint says nothing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
}

/// A config for listing models: the base URL and key, with no model.
///
/// Split from `config_for_chat` on purpose. Listing models is what you do *before*
/// you have a model, so requiring one here made « Load models » unusable — the
/// button could only ever work if you already knew an id and typed it. The model
/// is not part of a `/models` request anyway.
pub fn endpoint_from(base_url: &str) -> Result<CustomChatConfig, String> {
    Ok(CustomChatConfig {
        base_url: normalize_base_url(base_url)?,
        model: String::new(),
        api_key: secrets::get("custom-api-key"),
    })
}

/// Builds a config for one chat turn, or says which setting is wrong.
///
/// The model is required here and only here: sending without one would just 400.
/// Reading the key happens inside, so no caller has to remember to keep it out of
/// the front end.
pub fn config_for_chat(base_url: &str, model: &str) -> Result<CustomChatConfig, String> {
    let base_url = normalize_base_url(base_url)?;
    let model = model.trim();
    if model.is_empty() {
        return Err("No model set. Pick one in the list, or type the model id.".into());
    }
    Ok(CustomChatConfig {
        base_url,
        model: model.to_string(),
        api_key: secrets::get("custom-api-key"),
    })
}

/// Validates a user-typed base URL and reduces it to a bare `scheme://host[:port]/prefix`.
///
/// Handing this to `reqwest::Url::parse` alone is not enough: `file://` and
/// `javascript:` parse fine, and a URL carrying its own credentials or query
/// string would silently do something other than what the user typed.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("No base URL. Add one in Settings → Chat — custom endpoint.".into());
    }

    // Checked before parsing, because the URL parser is lenient about exactly the
    // case that matters here: for a special scheme it skips *any* number of
    // slashes, so `https:///v1` quietly becomes the host `v1`. Both the scheme
    // and host checks below would pass it and the request would go somewhere the
    // user never typed.
    let Some(scheme_end) = trimmed.find("://") else {
        return Err("A base URL must start with http:// or https://.".into());
    };
    let authority = &trimmed[scheme_end + 3..];
    if authority.is_empty() || authority.starts_with('/') {
        return Err("That base URL has no host — it looks like a missing domain.".into());
    }

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("That is not a valid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "A base URL must start with http:// or https:// — got {other:?}."
            ))
        }
    }

    if parsed.host_str().map_or(true, str::is_empty) {
        return Err("That base URL has no host.".into());
    }
    // `https://user:pw@host` is the shape of a mistake, not a feature — the key
    // belongs in the key field, where it goes to the credential manager.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Remove the username and password from the URL — use the API key field.".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("A base URL cannot carry a query string or a #fragment.".into());
    }

    let mut base = String::new();
    base.push_str(parsed.scheme());
    base.push_str("://");
    base.push_str(parsed.authority());
    // A pasted `…/v1/chat/completions` must not become `…/v1/chat/completions/chat/completions`.
    let mut path = parsed.path().trim_end_matches('/').to_string();
    for suffix in ENDPOINT_SUFFIXES {
        if let Some(base_path) = path.strip_suffix(suffix) {
            path = base_path.to_string();
            break;
        }
    }
    if !path.is_empty() {
        base.push_str(path.trim_end_matches('/'));
    }
    Ok(base)
}

/// One chat turn against the user's endpoint.
pub async fn send(
    chat: &Chat,
    cfg: &CustomChatConfig,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let history = chat.compat_snapshot();
    let body = json!({
        "model": cfg.model,
        "max_tokens": MAX_TOKENS,
        "messages": build_messages(&history, &query, context.as_ref()),
    });

    let response = match call(cfg, &body, CHAT_TIMEOUT_SECS).await {
        Ok(value) => value,
        Err(err) => {
            // Keep the history matching what the model actually saw.
            chat.compat_pop();
            return Err(err);
        }
    };

    let text = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        // The turn was accepted, so the question stays in the history and the
        // user can retry without retyping it.
        return Err("No response text from this endpoint.".into());
    }

    chat.compat_push("assistant", text.clone());
    Ok(ChatReply { text })
}

/// System prompt, then history, then the new turn — the one ordering every
/// OpenAI-compatible server agrees on.
fn build_messages(
    history: &[(String, String)],
    query: &str,
    context: Option<&ChatContext>,
) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    for (role, content) in history {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({
        "role": "user",
        "content": user_text(history.is_empty(), query, context),
    }));
    messages
}

/// File and window context rides along with the first message only, exactly like
/// `claude::send` and the macOS `chatOpenAICompatible`.
fn user_text(first_turn: bool, query: &str, context: Option<&ChatContext>) -> String {
    if !first_turn {
        return query.to_string();
    }
    match context {
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut prefix = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                prefix.push_str(&format!(", URL: {url}"));
            }
            format!("{prefix}\n\n{query}")
        }
        Some(ChatContext::File { name, path }) => match file_as_text(path) {
            // A PDF, an image, or anything too big to inline: name it and let the
            // model ask. Identical to what the Anthropic path does for these.
            Some(text) => format!("File contents:\n{text}\n\nFile: {name}\n\n{query}"),
            None => format!("File: {name}\n\n{query}"),
        },
        None => query.to_string(),
    }
}

/// The models this endpoint advertises, newest first when it says.
///
/// An endpoint with no `/models` route is not an error the user has to solve —
/// the picker falls back to typing the id — so the caller decides what an empty
/// list means, and only a transport or status failure is reported as an error.
pub async fn fetch_models(cfg: &CustomChatConfig) -> Result<Vec<ChatModel>, String> {
    let url = format!("{}/models", cfg.base_url);
    let response = get(&url, cfg.api_key.as_deref(), MODELS_TIMEOUT_SECS).await?;
    Ok(parse_models(&response))
}

/// Reads a `/models` body into picker entries.
///
/// Split out from `fetch_models` so the parsing can be tested against a captured
/// response without a network, and so both platforms' fixtures stay comparable.
pub fn parse_models(response: &Value) -> Vec<ChatModel> {
    // `{"data":[…]}` is the documented shape; a bare array shows up often enough
    // on self-hosted servers to be worth accepting.
    let Some(list) = response
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| response.as_array())
    else {
        return Vec::new();
    };

    let mut models: Vec<(u64, ChatModel)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in list {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        // Hoisted out of the per-marker scan: the same lowercased id was being
        // rebuilt once for every marker in the list.
        let lowered = id.to_lowercase();
        if NON_CHAT_MARKERS.iter().any(|m| lowered.contains(m)) {
            continue;
        }
        if seen.iter().any(|s| s == id) {
            continue;
        }
        seen.push(id.to_string());

        let created = item.get("created").and_then(Value::as_u64).unwrap_or(0);
        models.push((
            created,
            ChatModel {
                id: id.to_string(),
                label: id.to_string(),
                context_length: positive_u64(item.get("context_length")),
                max_output_tokens: positive_u64(item.get("max_output_tokens")),
                input_modalities: string_list(item.get("input_modalities")),
                capabilities: capabilities(item.get("capabilities")),
            },
        ));
    }

    // Servers that report no timestamp keep their own order, which is the order
    // the user sees; only sort when there is something to sort by.
    if models.iter().any(|(created, _)| *created > 0) {
        models.sort_by(|a, b| b.0.cmp(&a.0));
    }

    models.into_iter().map(|(_, model)| model).collect()
}

/// A number an endpoint reported, or None.
///
/// Zero is treated as absent: it is what a server sends for "unknown", and
/// rendering "0 ctx" would be worse than showing nothing.
fn positive_u64(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
}

/// A list of strings, ignoring anything that is not one.
///
/// Tolerates `null` and a bare string, both of which turn up on self-hosted
/// servers, because a malformed modality list must not lose the model entirely.
fn string_list(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The capability block, or None when absent or entirely empty.
fn capabilities(value: Option<&Value>) -> Option<ModelCapabilities> {
    let block = value?;
    let flag = |name: &str| -> Option<bool> {
        match block.get(name) {
            Some(Value::Bool(b)) => Some(*b),
            // Some servers send "yes"/1 instead of a boolean; anything that is
            // not a recognisable true is treated as unknown rather than false.
            Some(Value::String(s)) if s.eq_ignore_ascii_case("true") => Some(true),
            _ => None,
        }
    };
    let parsed = ModelCapabilities {
        tool_calling: flag("tool_calling"),
        reasoning: flag("reasoning"),
        thinking: flag("thinking"),
        vision: flag("vision"),
    };
    parsed.is_meaningful().then_some(parsed)
}

// ── Transport ─────────────────────────────────────────────────────────────────

/// A failure worth retrying with a different field name, as opposed to one the
/// server simply refused.
enum ApiError {
    /// Newer OpenAI models renamed `max_tokens` and 400 on the old name.
    NeedsMaxCompletionTokens,
    Other(String),
}

impl ApiError {
    fn into_message(self) -> String {
        match self {
            ApiError::NeedsMaxCompletionTokens => {
                "This endpoint rejected the token limit field. Check the model id.".into()
            }
            ApiError::Other(message) => message,
        }
    }
}

async fn call(
    cfg: &CustomChatConfig,
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let url = format!("{}/chat/completions", cfg.base_url);
    match post(&url, cfg.api_key.as_deref(), body, timeout_secs).await {
        Err(ApiError::NeedsMaxCompletionTokens) => {
            // Same request, renamed field. Costs one round trip and is the
            // difference between working and not against a current OpenAI model.
            let mut retry = body.clone();
            if let Some(object) = retry.as_object_mut() {
                if let Some(limit) = object.remove("max_tokens") {
                    object.insert("max_completion_tokens".into(), limit);
                }
            }
            post(&url, cfg.api_key.as_deref(), &retry, timeout_secs)
                .await
                .map_err(ApiError::into_message)
        }
        Err(err) => Err(err.into_message()),
        Ok(value) => Ok(value),
    }
}

async fn post(
    url: &str,
    api_key: Option<&str>,
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, ApiError> {
    let client = client(timeout_secs)?;
    let mut request = client.post(url);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .json(body)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("Network error: {e}")))?;

    read_json(response).await
}

async fn get(url: &str, api_key: Option<&str>, timeout_secs: u64) -> Result<Value, String> {
    let client = client(timeout_secs).map_err(ApiError::into_message)?;
    let mut request = client.get(url);
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    read_json(response).await.map_err(ApiError::into_message)
}

fn client(timeout_secs: u64) -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| ApiError::Other(e.to_string()))
}

async fn read_json(response: reqwest::Response) -> Result<Value, ApiError> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ApiError::Other(format!("Network error: {e}")))?;

    if !status.is_success() {
        // The provider's own message is what makes a bad key or a wrong model id
        // obvious, so it is preferred over anything we could word ourselves.
        if status == reqwest::StatusCode::BAD_REQUEST && text.contains("max_completion_tokens") {
            return Err(ApiError::NeedsMaxCompletionTokens);
        }
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(ApiError::Other(format!("Chat API {status}: {detail}")));
    }

    serde_json::from_str(&text)
        .map_err(|e| ApiError::Other(format!("Bad API response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn base_url_keeps_a_versioned_prefix() {
        assert_eq!(
            normalize_base_url("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_base_url("  http://localhost:11434/v1  ").unwrap(),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api/v1/").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("http://192.168.1.10:8080").unwrap(),
            "http://192.168.1.10:8080"
        );
    }

    #[test]
    fn base_url_strips_a_pasted_endpoint() {
        for pasted in [
            "https://api.openai.com/v1/chat/completions",
            "https://api.openai.com/v1/models",
            "https://api.openai.com/v1/completions",
        ] {
            assert_eq!(
                normalize_base_url(pasted).unwrap(),
                "https://api.openai.com/v1",
                "{pasted} should reduce to its base"
            );
        }
    }

    #[test]
    fn base_url_refuses_anything_that_is_not_a_plain_web_endpoint() {
        // `file://` and `javascript:` both parse as URLs; only the scheme check
        // keeps them away from a network call carrying the user's conversation.
        assert!(normalize_base_url("file:///etc/passwd").is_err());
        assert!(normalize_base_url("javascript:alert(1)").is_err());
        assert!(normalize_base_url("ftp://example.com").is_err());
        assert!(normalize_base_url("https://user:pw@example.com/v1").is_err());
        assert!(normalize_base_url("https://example.com/v1?key=secret").is_err());
        assert!(normalize_base_url("not a url").is_err());
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("https:///v1").is_err());
        assert!(normalize_base_url("https://").is_err());
        // No `://` at all — the check that catches a bare `api.openai.com/v1`.
        assert!(normalize_base_url("api.openai.com/v1").is_err());
    }

    #[test]
    fn messages_are_system_then_history_then_the_new_turn() {
        let history = vec![
            ("user".to_string(), "first".to_string()),
            ("assistant".to_string(), "second".to_string()),
        ];
        let messages = build_messages(&history, "third", None);
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], SYSTEM_PROMPT);
        assert_eq!(messages[1]["content"], "first");
        assert_eq!(messages[2]["content"], "second");
        assert_eq!(messages[3]["role"], "user");
        assert_eq!(messages[3]["content"], "third");
    }

    #[test]
    fn context_is_attached_to_the_first_turn_only() {
        let window = ChatContext::Window {
            app_name: "Safari".into(),
            title: "Docs".into(),
            url: Some("https://example.com".into()),
        };
        let first = user_text(true, "what is this?", Some(&window));
        assert!(first.contains("Safari"), "{first}");
        assert!(first.contains("https://example.com"), "{first}");
        assert!(first.ends_with("what is this?"), "{first}");

        let later = user_text(false, "and now?", Some(&window));
        assert_eq!(later, "and now?", "context must not repeat on later turns");
    }

    #[test]
    fn a_text_file_is_inlined_and_a_binary_one_is_only_named() {
        let tmp = std::env::temp_dir().join(format!("coucou-compat-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        let text_path = tmp.join("notes.txt");
        let mut file = std::fs::File::create(&text_path).unwrap();
        file.write_all(b"the quick brown fox").unwrap();
        drop(file);

        let inlined = user_text(
            true,
            "summarise",
            Some(&ChatContext::File { name: "notes.txt".into(), path: text_path.to_string_lossy().into() }),
        );
        assert!(inlined.contains("the quick brown fox"), "{inlined}");
        assert!(inlined.contains("File: notes.txt"), "{inlined}");

        let binary = tmp.join("pixel.png");
        std::fs::write(&binary, [0x89u8, 0x50, 0x4E, 0x47, 0x0D]).unwrap();
        let named = user_text(
            true,
            "what is it",
            Some(&ChatContext::File { name: "pixel.png".into(), path: binary.to_string_lossy().into() }),
        );
        assert!(named.contains("File: pixel.png"), "{named}");
        assert!(!named.contains("File contents:"), "binary bytes must never be inlined");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn base_url_agrees_with_the_swift_normaliser_case_for_case() {
        // `ClaudeService.normalizedChatBaseURL` on macOS implements these exact
        // rules, and tests/ChatBaseURLTests.swift asserts this same table against
        // a standalone copy of it. A settings string that works on one platform
        // and is rejected on the other would be a real bug, so the expectations
        // here and there must stay identical.
        let accepted: [(&str, &str); 7] = [
            ("https://api.openai.com/v1", "https://api.openai.com/v1"),
            ("  http://localhost:11434/v1  ", "http://localhost:11434/v1"),
            ("https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"),
            ("http://192.168.1.10:8080", "http://192.168.1.10:8080"),
            (
                "https://api.openai.com/v1/chat/completions",
                "https://api.openai.com/v1",
            ),
            ("https://api.openai.com/v1/models", "https://api.openai.com/v1"),
            (
                "https://api.openai.com/v1/completions",
                "https://api.openai.com/v1",
            ),
        ];
        for (input, expected) in accepted {
            assert_eq!(
                normalize_base_url(input).ok().as_deref(),
                Some(expected),
                "{input} should normalise to {expected}"
            );
        }

        let refused = [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com",
            "vscode://file/etc",
            "https://user:pw@example.com/v1",
            "https://example.com/v1?key=secret",
            "not a url",
            "https:///v1",
            "https://",
            "api.openai.com/v1",
        ];
        for input in refused {
            assert!(
                normalize_base_url(input).is_err(),
                "{input} must be refused"
            );
        }
    }

    #[test]
    fn the_key_is_never_printed_by_debug() {
        let cfg = CustomChatConfig {
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o-mini".into(),
            api_key: Some("sk-super-secret".into()),
        };
        let printed = format!("{cfg:?}");
        assert!(!printed.contains("sk-super-secret"), "{printed}");
        assert!(printed.contains("redacted"), "{printed}");
    }

    /// The exact body reported by the router in the bug report — `auto/*` models
    /// with the full metadata block. Trimmed to two entries; the fields are what
    /// matters, not the length of the list.
    const RICH_RESPONSE: &str = r#"{
      "object": "list",
      "data": [
        {
          "id": "auto/best-coding",
          "object": "model",
          "created": 1791049336,
          "owned_by": "combo",
          "permission": [],
          "root": "auto/best-coding",
          "parent": null,
          "context_length": 1000000,
          "max_input_tokens": 1000000,
          "max_output_tokens": 524288,
          "input_modalities": ["text", "image", "video"],
          "output_modalities": ["text"],
          "capabilities": {
            "tool_calling": true,
            "reasoning": true,
            "thinking": true,
            "temperature": true,
            "vision": true
          }
        },
        {
          "id": "auto/best-chat",
          "object": "model",
          "created": 1791049336,
          "owned_by": "combo",
          "context_length": 1000000,
          "input_modalities": ["text"],
          "capabilities": { "tool_calling": false }
        }
      ]
    }"#;

    #[test]
    fn a_rich_models_response_is_parsed_in_full() {
        let models = parse_models(&serde_json::from_str(RICH_RESPONSE).unwrap());
        assert_eq!(models.len(), 2, "both auto/* entries are kept");

        let coding = &models[0];
        assert_eq!(coding.id, "auto/best-coding");
        assert_eq!(coding.label, "auto/best-coding");
        assert_eq!(coding.context_length, Some(1_000_000));
        assert_eq!(coding.max_output_tokens, Some(524_288));
        assert_eq!(coding.input_modalities, ["text", "image", "video"]);

        let caps = coding.capabilities.as_ref().expect("capabilities parsed");
        assert_eq!(caps.tool_calling, Some(true));
        assert_eq!(caps.reasoning, Some(true));
        assert_eq!(caps.thinking, Some(true));
        assert_eq!(caps.vision, Some(true));

        // Absent flags stay absent rather than becoming `false`.
        let chat = &models[1];
        let caps = chat.capabilities.as_ref().expect("partial block kept");
        assert_eq!(caps.tool_calling, Some(false));
        assert_eq!(caps.vision, None, "an unreported flag is unknown, not false");
        assert_eq!(chat.max_output_tokens, None);
        assert_eq!(chat.input_modalities, ["text"]);
    }

    #[test]
    fn a_classic_openai_response_is_unchanged_and_carries_no_metadata() {
        // The traditional shape must keep working and must not gain empty fields:
        // this is what "keep both" has to mean.
        let classic = r#"{
          "object": "list",
          "data": [
            { "id": "gpt-4o", "object": "model", "created": 1715367049, "owned_by": "openai" },
            { "id": "gpt-4o-mini", "object": "model", "created": 1715367049, "owned_by": "openai" }
          ]
        }"#;
        let models = parse_models(&serde_json::from_str(classic).unwrap());
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-4o");
        assert_eq!(models[0].context_length, None);
        assert_eq!(models[0].max_output_tokens, None);
        assert!(models[0].input_modalities.is_empty());
        assert!(models[0].capabilities.is_none());

        // Serialised back, it is byte-identical to what the picker got before —
        // optional fields are skipped rather than sent as null.
        let json = serde_json::to_string(&models[0]).unwrap();
        assert_eq!(json, r#"{"id":"gpt-4o","label":"gpt-4o"}"#);
    }

    #[test]
    fn a_bare_array_and_junk_entries_are_both_tolerated() {
        // Some self-hosted servers answer with a top-level array.
        let bare = r#"[{"id":"llama3","created":1},{"id":"llama3","created":1}]"#;
        let models = parse_models(&serde_json::from_str(bare).unwrap());
        assert_eq!(models.len(), 1, "duplicates are collapsed");
        assert_eq!(models[0].id, "llama3");

        // A malformed entry must lose only itself, never the whole list.
        let mixed = r#"{"data":[
            {"id":"good-model","created":2},
            {"object":"model"},
            {"id":"   "},
            {"id":"text-embedding-3-large"},
            {"id":"another-good","context_length":"not a number","input_modalities":null}
        ]}"#;
        let models = parse_models(&serde_json::from_str(mixed).unwrap());
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        // Newest first. `another-good` reports no timestamp at all, so it sorts
        // last rather than pretending to be the oldest.
        assert_eq!(ids, ["good-model", "another-good"]);
        assert_eq!(models[1].context_length, None, "a bad type is unknown");
        assert!(models[1].input_modalities.is_empty());

        // Nothing usable at all is an empty list, never a panic.
        assert!(parse_models(&serde_json::json!({"error": "nope"})).is_empty());
        assert!(parse_models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_chat_turn_still_refuses_an_empty_model_but_listing_models_does_not() {
        // The bug this split fixed: « Load models » is what you press *before* you
        // have a model, so demanding one there made the button unusable.
        let cfg = endpoint_from("https://api.openai.com/v1").unwrap();
        assert!(cfg.model.is_empty(), "discovery must not require a model");

        let Err(err) = config_for_chat("https://api.openai.com/v1", "   ") else {
            panic!("a blank model must be refused before any chat request");
        };
        assert!(err.contains("model"), "{err}");

        let Err(err) = config_for_chat("", "gpt-4o") else {
            panic!("a blank base URL must be refused before any chat request");
        };
        assert!(err.contains("base URL"), "{err}");

        // Both still refuse a bad URL, so neither makes a request with it.
        assert!(endpoint_from("file:///etc/passwd").is_err());
    }
}