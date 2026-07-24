import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(
  process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp",
);
const draftId =
  process.env.DRAFT_ID ?? "0113ed03-46df-49ce-8228-df179d0abc78";

async function withClient(name, operation) {
  const client = new Client({ name, version: "1.8.2" });
  const transport = new StreamableHTTPClientTransport(endpoint);
  await client.connect(transport);
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

const sameConnection = await withClient(
  "capability-runtime-same-connection",
  async client => {
    const initial = await client.listTools();
    assert.equal(initial.tools.length, 10);

    const loaded = await client.callTool({
      name: "douyin_load_capability_pack",
      arguments: {
        packs: ["publisher"],
        replace: true,
        include_schemas: false,
      },
    });
    assert.equal(loaded.isError, undefined);
    assert.equal(loaded.structuredContent?.selectedPacks?.includes("publisher"), true);

    const status = await client.callTool({
      name: "douyin_capability_pack_status",
      arguments: {},
    });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent?.selectedPacks?.includes("publisher"), true);
    assert.equal(status.structuredContent?.stateScope, "connection_session");

    const draft = await client.callTool({
      name: "douyin_invoke_capability",
      arguments: {
        tool_name: "douyin_get_post_draft",
        arguments: { draft_id: draftId },
      },
    });
    assert.equal(draft.isError, undefined);
    assert.equal(draft.structuredContent?.draftId, draftId);

    return { initial, loaded, status, draft };
  },
);

const freshConnection = await withClient(
  "capability-runtime-fresh-connection",
  async client => {
    const status = await client.callTool({
      name: "douyin_capability_pack_status",
      arguments: {},
    });
    assert.equal(status.isError, undefined);
    assert.deepEqual(status.structuredContent?.selectedPacks, []);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    return { status, tools };
  },
);

const gateway = await withClient(
  "capability-runtime-read-gateway",
  async client => {
    const result = await client.callTool({
      name: "douyin_call_capability_tool",
      arguments: {
        pack: "publisher",
        tool: "douyin_get_post_draft",
        arguments: { draft_id: draftId },
        auto_load: true,
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.capabilityGateway, true);
    assert.equal(result.structuredContent?.draftId, draftId);
    return result;
  },
);

console.log(JSON.stringify({
  status: "PASS",
  endpoint: `${endpoint.origin}${endpoint.pathname}`,
  coreToolCount: sameConnection.initial.tools.length,
  sameConnectionSelectedPacks:
    sameConnection.status.structuredContent?.selectedPacks,
  freshConnectionSelectedPacks:
    freshConnection.status.structuredContent?.selectedPacks,
  stateScope: sameConnection.status.structuredContent?.stateScope,
  stateRevision: sameConnection.status.structuredContent?.stateRevision,
  registryRevision: sameConnection.status.structuredContent?.registryRevision,
  gateway: gateway.structuredContent?.capabilityGateway,
  draftId,
}, null, 2));
