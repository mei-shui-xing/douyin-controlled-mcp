# Known Alpha issues

## Dependency audit

After the non-breaking lockfile update, `npm audit` reports two moderate findings representing one transitive issue:

- `@modelcontextprotocol/sdk` 1.29.0 depends on `@hono/node-server` 1.19.15, while GHSA-frvp-7c67-39w9 marks `@hono/node-server <2.0.5` as vulnerable to an encoded-backslash path traversal in its Windows `serve-static` adapter.
- This project does not import `@hono/node-server` and does not use its static-file adapter; HTTP transport is hosted by Express. The vulnerable package is installed transitively, so the finding is retained and not hidden.
- npm currently proposes downgrading the direct MCP SDK to 1.24.3 as the automatic fix. That is not a safe unreviewed upgrade path for this codebase, so it is deferred pending an MCP SDK release or a tested dependency override.

The previously reported high-severity `fast-uri <=3.1.3` issue is resolved in the lockfile by 3.1.4.

## Product limitations

- Live behavior depends on the current Douyin and Creator Center DOM and can break after site updates. Fixtures do not replace owner-authorized live acceptance.
- First-run account detection requires the site to expose display name, numeric `uid`, and `sec_uid` together. Creator Center is the recommended detection page. Detection fails closed on absent or conflicting identity evidence.
- The Alpha setup flow configures the operator only. Bound contacts and custom safe social actions remain advanced manual configuration using the example schemas.
- A single browser profile should have only one AI/client performing write operations at a time.
- The generic role names in this sanitized Alpha are intended for fresh installations. Private pre-Alpha runtime page bindings are not bundled and should be rebound rather than copied into a public installation.

