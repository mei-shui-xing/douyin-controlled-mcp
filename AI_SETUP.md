# AI first-run setup contract

This file is for an AI client connected to this MCP. Keep the flow conversational and minimal. Do not invent a separate wizard or state machine.

## Required flow

1. Call `douyin_get_setup_status`.
2. If setup is required, ask the owner to sign in and open their own profile or Creator Center, then call `douyin_detect_current_account`.
3. Show the detected display name and masked identifiers. Ask the owner for:
   - one local operator alias;
   - permission to post public comments;
   - permission to reply to comments;
   - permission to publish videos;
   - permission to publish articles.
4. Recommend all four write permissions remain `false` for the first run. Only after the owner answers, call `douyin_configure_initial_setup` once with `confirm_apply=true`.
5. Call `douyin_validate_setup` and report whether configuration is valid and the current login matches.

## Hard rules

- Never ask the owner to paste cookies, access tokens, `uid`, or `sec_uid` into chat.
- Never guess an alias or permission answer.
- Never edit `config/*.example.json` as real configuration.
- Never overwrite an existing `runtime/private-config` file. The setup tool intentionally refuses.
- Never enable write permissions merely because the account was detected.
- If account detection reports zero or conflicting identities, stop and ask the owner to leave only the intended signed-in account open.
- Bound contacts and custom social actions are optional advanced configuration and are not part of initial setup.

The five user-visible stages are: **check → detect → ask → private write → validate**. “Ask” happens in the AI conversation; there is no extra MCP state or prepare token.

## Optional connection endpoint setup

This is separate from Douyin account binding. Do not make a public tunnel mandatory for first-run setup.

1. Ask whether the owner wants local-only access, the default temporary Cloudflare Quick Tunnel, or an optional stable Tailscale Funnel endpoint. Recommend local-only when the AI client runs on the same computer; otherwise recommend the temporary tunnel for the simplest Alpha setup.
2. For a stable endpoint, first verify that the bridge is healthy on `127.0.0.1:31337`, then discover `tailscale.exe` with `Get-Command`. Read `tailscale funnel --help` on that machine instead of assuming that flags from this document are current.
3. Verify that Tailscale is signed in and healthy without printing the account, Tailnet, hostname, or IP address into chat or logs intended for publication. If sign-in, Funnel enablement, or a policy approval is required, pause and let the owner complete it.
4. With current Tailscale versions, the intended operation is equivalent to `tailscale funnel --bg 31337`. Use the syntax reported by the installed CLI, then inspect `tailscale funnel status --json` locally to obtain the installation's actual HTTPS base URL.
5. Read the existing MCP access token from ignored runtime state without echoing it. Compose `<tailscale-base-url>/mcp?access_token=<url-encoded-token>`, verify both the protected health endpoint and MCP initialization, and only then present it as ready.
6. Store the resulting connector URL only in ignored `runtime/PUBLIC_MCP_URL.txt` (and optionally the local clipboard/connector page). Never write a real hostname, Tailnet name, IP address, or access token to tracked source, examples, screenshots, issue text, or release notes.
7. On later runs, verify the saved endpoint instead of assuming it still works. Do not silently switch connection modes, rotate a token, reset Funnel, or expose a new public endpoint without telling the owner.

The repository's launcher currently automates the temporary Cloudflare route. Stable Tailscale setup is intentionally AI-guided for the Alpha rather than hard-coded to one person's domain.

