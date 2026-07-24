import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp";
const client = new Client({
  name: "root-comment-clean-profile-acceptance",
  version: "1.0.0",
});
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

try {
  const loaded = await client.callTool({
    name: "douyin_load_capability_pack",
    arguments: {
      packs: ["adaptive_comment"],
      replace: true,
      include_schemas: false,
    },
  });
  assert.equal(loaded.isError, undefined);
  const inspected = await client.callTool({
    name: "douyin_diagnose_root_comment_submit",
    arguments: {
      action: "inspect",
      confirm_send: false,
      allow_browser_launch: true,
    },
  });
  assert.equal(inspected.isError, undefined);
  const result = inspected.structuredContent;
  assert.equal(result.profileDirectoryName, "operator_root_comment_clean");
  assert.equal(result.browserConnected, true);
  assert.equal(result.sent, false);
  assert.equal(
    [true, false].includes(result.accountVerified),
    true,
  );
  console.log(JSON.stringify({
    endpoint,
    profileId: result.profileId,
    profileDirectoryName: result.profileDirectoryName,
    browserConnected: result.browserConnected,
    browserLaunched: result.browserLaunched,
    accountVerified: result.accountVerified,
    manualQrLoginRequired: result.manualQrLoginRequired,
    classification: result.classification,
    sent: result.sent,
  }, null, 2));
} finally {
  await client.close();
}
