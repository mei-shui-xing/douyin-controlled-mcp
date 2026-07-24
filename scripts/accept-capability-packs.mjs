import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp";
const expectedVersion = process.env.EXPECTED_VERSION ?? "1.6.0";
const expectedCoreTools = [
  "douyin_status",
  "douyin_healthcheck",
  "douyin_startup_self_check",
  "douyin_list_capability_packs",
  "douyin_load_capability_pack",
  "douyin_unload_capability_pack",
  "douyin_capability_pack_status",
  "douyin_invoke_capability",
  "douyin_call_capability_tool",
].sort();

async function connectClient(name) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  return client;
}

const gatewayClient = await connectClient("capability-gateway-acceptance");
let listChangedCount = 0;
gatewayClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
  listChangedCount += 1;
});

const initial = await gatewayClient.listTools();
assert.deepEqual(initial.tools.map(tool => tool.name).sort(), expectedCoreTools);

const health = await gatewayClient.callTool({
  name: "douyin_healthcheck",
  arguments: {},
});
assert.equal(health.isError, undefined);
assert.equal(health.structuredContent?.version, expectedVersion);

const notLoaded = await gatewayClient.callTool({
  name: "douyin_invoke_capability",
  arguments: {
    tool_name: "douyin_read_action_log",
    arguments: { limit: 1 },
  },
});
assert.equal(notLoaded.isError, true);
assert.match(
  notLoaded.content.map(item => item.type === "text" ? item.text : "").join("\n"),
  /capability_pack_not_loaded: maintenance/,
);

const gatewayCall = await gatewayClient.callTool({
  name: "douyin_call_capability_tool",
  arguments: {
    pack: "maintenance",
    tool: "douyin_read_action_log",
    arguments: { limit: 1 },
  },
});
assert.equal(gatewayCall.isError, undefined);
assert.equal(gatewayCall.structuredContent?.capabilityGateway, true);
assert.ok(listChangedCount >= 1);

const afterGateway = await gatewayClient.listTools();
assert.equal(
  afterGateway.tools.some(tool => tool.name === "douyin_read_action_log"),
  true,
);
assert.equal(
  afterGateway.tools.some(tool => tool.name === "douyin_publish_text"),
  false,
);
await gatewayClient.close();

const cachedClient = await connectClient("cached-manifest-acceptance");
const cachedInitial = await cachedClient.listTools();
assert.deepEqual(cachedInitial.tools.map(tool => tool.name).sort(), expectedCoreTools);
const cachedDirectCall = await cachedClient.callTool({
  name: "douyin_read_action_log",
  arguments: { limit: 1 },
});
assert.equal(cachedDirectCall.isError, undefined);
assert.equal(
  cachedDirectCall.structuredContent?.capabilityPackAutoLoaded,
  "maintenance",
);
assert.equal(
  cachedDirectCall.structuredContent?.compatibilityMode,
  "cached_manifest_direct_call",
);
const afterCachedDirectCall = await cachedClient.listTools();
assert.equal(
  afterCachedDirectCall.tools.some(tool => tool.name === "douyin_read_action_log"),
  true,
);
await cachedClient.close();

console.log(JSON.stringify({
  endpoint,
  version: health.structuredContent?.version,
  initialToolCount: initial.tools.length,
  initialTools: initial.tools.map(tool => tool.name),
  exactNotLoadedHint: true,
  fixedGateway: {
    tool: "douyin_call_capability_tool",
    loadedPack: "maintenance",
    listChangedCount,
    visibleToolCount: afterGateway.tools.length,
    publisherVisible: afterGateway.tools.some(tool => tool.name === "douyin_publish_text"),
  },
  cachedManifestCompatibility: {
    directTool: "douyin_read_action_log",
    autoLoadedPack: cachedDirectCall.structuredContent?.capabilityPackAutoLoaded,
    toolDisabledError: false,
    visibleToolCount: afterCachedDirectCall.tools.length,
  },
}, null, 2));
