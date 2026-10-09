import Foundation

/// Standalone mirror of `ClaudeService.normalizedChatBaseURL`.
///
/// The real function is a static method on a `@MainActor` class that pulls in the
/// whole app, so it cannot be compiled on its own. This copy exists only so the
/// rules are executable and stay in step with the Rust `normalize_base_url` — if
/// one side changes, the expectations here must change with it.
func normalizedChatBaseURL(_ raw: String) -> String? {
    var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    guard let range = trimmed.range(of: "://") else { return nil }
    let authority = String(trimmed[range.upperBound...])
    guard !authority.isEmpty, !authority.hasPrefix("/") else { return nil }

    for suffix in ["/chat/completions", "/completions", "/models", "/v1/chat/completions"] {
        if trimmed.hasSuffix(suffix) {
            trimmed = String(trimmed.dropLast(suffix.count))
            break
        }
    }
    while trimmed.hasSuffix("/") { trimmed.removeLast() }

    guard let url = URL(string: trimmed),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty,
          url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil
    else { return nil }
    return trimmed
}

@main
enum ChatBaseURLTests {
    static func main() {
        // Accepted: a versioned prefix is kept as typed.
        precondition(normalizedChatBaseURL("https://api.openai.com/v1") == "https://api.openai.com/v1")
        precondition(normalizedChatBaseURL("  http://localhost:11434/v1  ") == "http://localhost:11434/v1")
        precondition(normalizedChatBaseURL("https://openrouter.ai/api/v1/") == "https://openrouter.ai/api/v1")
        precondition(normalizedChatBaseURL("http://192.168.1.10:8080") == "http://192.168.1.10:8080")

        // Accepted: a pasted full endpoint is reduced to its base, so the request
        // does not end up at `…/chat/completions/chat/completions`.
        precondition(normalizedChatBaseURL("https://api.openai.com/v1/chat/completions") == "https://api.openai.com/v1")
        precondition(normalizedChatBaseURL("https://api.openai.com/v1/models") == "https://api.openai.com/v1")
        precondition(normalizedChatBaseURL("https://api.openai.com/v1/completions") == "https://api.openai.com/v1")

        // Rejected: anything that is not a plain web endpoint.
        precondition(normalizedChatBaseURL("") == nil)
        precondition(normalizedChatBaseURL("file:///etc/passwd") == nil)
        precondition(normalizedChatBaseURL("javascript:alert(1)") == nil)
        precondition(normalizedChatBaseURL("ftp://example.com") == nil)
        precondition(normalizedChatBaseURL("vscode://file/etc") == nil)
        precondition(normalizedChatBaseURL("https://user:pw@example.com/v1") == nil)
        precondition(normalizedChatBaseURL("https://example.com/v1?key=secret") == nil)
        precondition(normalizedChatBaseURL("not a url") == nil)
        // `URL(string:)` is lenient about slashes: this would otherwise resolve
        // to the host `v1` and send the conversation somewhere never typed.
        precondition(normalizedChatBaseURL("https:///v1") == nil)
        precondition(normalizedChatBaseURL("https://") == nil)
        precondition(normalizedChatBaseURL("api.openai.com/v1") == nil)

        print("Chat base URLs: 16 cases passed")
    }
}