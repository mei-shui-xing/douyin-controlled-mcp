# Douyin Controlled MCP

An experimental, GPT-first (not GPT-only) MCP adapter for reading and carefully operating Douyin and Creator Center through structured IDs, DOM state, and verified browser state. Visual or Computer Use operation is a fallback when a structured route cannot safely identify the target.

This repository is an early `v0.1.0-alpha` candidate for a small tester group. Douyin UI and anti-abuse behavior can change without notice. Readback, confirmation gates, and stable IDs reduce risk but do not make automation risk-free.

## First run on Windows

Prerequisites: Windows 10/11, Node.js 20 or newer, Chrome or Edge, and a Douyin account that you can sign into yourself.

1. Run `START_HERE_SETUP.cmd`.
2. Run `START_BRIDGE.cmd` and connect the displayed MCP URL to your AI client.
3. Sign in to Douyin in the dedicated browser and open your own profile or Creator Center.
4. Tell the AI: **“请帮我完成抖音首次配置。”**
5. The AI checks configuration, detects the current account, asks you for a local alias and write permissions, creates ignored private configuration, and validates it.

You should not paste cookies, tokens, `uid`, or `sec_uid` into chat. See [AI_SETUP.md](AI_SETUP.md) for the exact machine-readable flow.

## Safety boundary

- Structured tools are preferred; screenshots and visual operation are fallback paths.
- Initial write permissions default to off. The AI must ask before enabling comments, replies, or publishing.
- Sending, publishing, deletion, account changes, payments, identity checks, and other sensitive actions require the owner to confirm or take over.
- Do not connect multiple AI clients to the same browser session for write work.
- Runtime configuration, browser profiles, tokens, cookies, logs, screenshots, SQLite state, and generated connector URLs are excluded from source and release packages.
- The old third-party EchoLens transcription route is retired. Optional transcription uses local `faster-whisper` only.

## Development verification

```powershell
npm ci
npm test
```

`npm test` runs TypeScript checking, build, deterministic fixtures, recovery/idempotency fixtures, HTTP security fixtures, and first-run configuration fixtures. Live Douyin behavior still requires owner-authorized manual acceptance because it depends on a logged-in account and the current site UI.

## Release and provenance

The application code is licensed under MIT; see [LICENSE](LICENSE). Dependency and optional-tool notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The owner-provided origin statement is recorded in [PROJECT_ORIGIN.md](PROJECT_ORIGIN.md).

Public release must use a fresh sanitized snapshot, not this private repository's historical Git objects. See [SECURITY.md](SECURITY.md) before packaging.

Known limitations and deferred architecture are tracked in [KNOWN_ISSUES.md](KNOWN_ISSUES.md) and [ROADMAP.md](ROADMAP.md).
