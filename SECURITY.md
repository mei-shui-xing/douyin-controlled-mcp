# Security model (v1.10.0)

This MCP is read-mostly. Every Douyin account mutation is routed through a
dedicated, audited transaction. Generic browser primitives are not a fallback
for account writes.

## Network perimeter

- HTTP mode refuses all MCP and detailed health requests without the secret
  `MCP_ACCESS_TOKEN`.
- `GET /healthz` is intentionally minimal and unauthenticated. Detailed state
  is available only from authenticated `GET /healthz/details`.
- Browser origins are checked against `MCP_ALLOWED_ORIGINS`; wildcard CORS is
  not used. Unknown origins fail closed.
- Sessions have an inactivity TTL, a maximum count, and a per-client request
  rate limit.
- `DOUYIN_TEST_MODE=1` is rejected in HTTP mode.
- `scripts/start.ps1` creates a high-entropy local token and places it in the
  private connector URL. Treat that URL as a password: do not publish, share,
  screenshot, or commit it.
- The bundled `cloudflared.exe` is checked against its pinned SHA-256 before it
  is started. The quick tunnel is suitable for the owner's private connector,
  not a public multi-user product. A public release should add Cloudflare
  Access or an OAuth authorization server and rotate the existing token.

## Process and persistence boundary

- One process owns the SQLite ledger and dedicated browser profile at a time.
  A process lock refuses a second live MCP instance.
- SQLite uses WAL, `synchronous=FULL`, unique idempotency constraints, and
  `BEGIN IMMEDIATE` claims before write clicks.
- Rate-limit reservations are also recorded atomically in SQLite.
- Startup scripts verify recorded process identity before terminating a PID;
  a recycled PID belonging to another program is never stopped.
- Existing browser profiles and login state are preserved across upgrades.

## Capability packs and low-level controls

- A new connection sees only the fixed core tool set.
- Pack selection belongs to one MCP connection and is never inherited by a
  different client or connection.
- Hidden tools do not auto-load a pack when called directly.
- The read gateway can invoke only read-only tools. Writes use the separate
  explicit write gateway, require a loaded pack and
  `confirm_gateway_write=true`, then still pass the original tool's gates.
- Generic click accepts navigation and a small set of local non-account UI controls only.
- The separate `manual_control` pack may inspect an unfamiliar screenshot point and click one reversible interface control after frozen-page revalidation. It records URL, DOM, toast and mutating-network evidence.
- Visual targets classified as account-changing or ambiguous stop before click and require a dynamic transaction. Delete, publish, payment, logout and account-security targets always require a dedicated workflow.
- Element references are short-lived observation snapshots bound to the MCP
  connection, page target, URL and snapshot hash. Cross-session replay fails.

## Durable write transactions

Comments, replies, creator-comment deletion, publishing, bound-user messages,
shares and allowlisted social actions use persistent operation ledgers.

- Prepare persists the frozen actor, scope, target and payload before returning.
- A commit atomically moves to `click_started` (or the operation-specific
  equivalent) before the first submit-semantic click.
- A confirmed state requires authoritative evidence such as a stable comment,
  message or work ID, or a complete creator API readback.
- If a click may have produced an effect but confirmation is missing, the
  operation becomes `unknown_after_submit`. It is read-only forever and is
  never clicked again.
- `click_no_effect` is the only root-comment state eligible for a verified
  no-submit abort. Positive submit evidence always prevents abort.
- Any unresolved possibly-submitted operation closes the global write gate.
- Startup reconciliation can confirm exact creator replies, messages and
  shares by stable IDs/hashes; ambiguity stays unknown.

Creator comment deletion is limited to the configured operator's creator center. Prepare
freezes exactly one comment and commit requires `confirm_delete=true`. The
first delete-semantic click happens only after the durable claim. Confirmation
requires a complete creator API readback proving that comment ID is absent.

## Low-risk post actions

Likes, favorites and author follows use an explicit `work_id` target resolver
shared by own, bound-user and external posts. They do not use the browser's
current focus as the core target and do not borrow the comment/publish
prepare-commit transaction model.

- The actor account, post ID, author and autoplay lock are revalidated before
  the action.
- The action trigger is clicked at most once and is never retried when its
  outcome is uncertain.
- An immediate DOM class, color or toast is only optimistic evidence.
- `success=true` requires either a successful mutation response whose request
  contains the exact target work ID, or the requested state after reloading
  the same work.
- The structured result and action log retain request/response status,
  business code and reload persistence evidence.

## Social allowlist

Extra small social actions must be enabled in
`runtime/private-config/douyin_social_actions.json` with exact label, context, scope and an
independent `completed_context_contains` confirmation rule. An action without
that confirmation rule is unavailable and fails before click. Payment,
shopping, recharge, gifts, account settings, arbitrary contacts and arbitrary
social clicks remain outside this mechanism.

## Local files and privacy

- Upload and renderer inputs must be explicit absolute paths and pass file
  validation.
- The HTML carousel renderer is isolated from the signed-in Douyin browser and
  blocks external network access and scripts by default.
- Logs and database evidence store hashes and stable IDs where possible; they
  do not record cookies, access tokens, complete request headers or passwords.
- Transcription uses only the bundled local faster-whisper workflow; no
  external transcription-site account, credential or runtime integration is
  registered or allowed.
- Real-write acceptance tests require an explicitly controlled test comment or
  draft plus human confirmation. Automated fixtures do not send real Douyin
  comments, messages, deletions or posts.

### Authenticated compatibility gateway observations

Direct MCP observations remain owned by the originating session or connection. For authenticated compatibility gateways whose clients create a fresh short MCP session per call, the observation owner is derived from the access-token fingerprint. This permits a read-only `observe` followed by a later `probe` from the same authenticated plugin identity without making observations public. When no token fingerprint is available, ownership falls back to the current session or connection.
