#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The normaliser itself lives on ClaudeService, which pulls in the whole app.
# tests/ChatBaseURLTests.swift carries a standalone copy of the rules so they are
# executable — keep it in step with openai_compat.rs in windows/src-tauri.
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coucou-chat-base-url.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc tests/ChatBaseURLTests.swift -o "$TEST_DIR/chat-base-url-tests"
"$TEST_DIR/chat-base-url-tests"