import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp";
const tool = process.env.MCP_TOOL;
if (!tool) throw new Error("MCP_TOOL is required.");
const argumentsValue = JSON.parse(process.env.MCP_ARGUMENTS ?? "{}");
const pack = process.env.MCP_PACK ?? null;

const client = new Client({
  name: "controlled-tool-invoker",
  version: "1.0.0",
});
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
try {
  if (pack) {
    await client.callTool({
      name: "douyin_load_capability_pack",
      arguments: {
        packs: [pack],
        replace: true,
        include_schemas: false,
      },
    });
  }
  const result = await client.callTool({
    name: tool,
    arguments: argumentsValue,
  });
  console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
