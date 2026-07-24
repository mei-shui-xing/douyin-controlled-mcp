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

