import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp";
const client = new Client({ name: "douyin-latency-benchmark", version: "0.7.1" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

async function timed(name, operation) {
  const startedAt = performance.now();
  const result = await operation();
  return {
    name,
    elapsedMs: Math.round(performance.now() - startedAt),
    result,
  };
}

const connected = await timed("connect", () => client.connect(transport));
const listed = await timed("listTools", () => client.listTools());
const measurements = [connected, {
  name: listed.name,
  elapsedMs: listed.elapsedMs,
  toolCount: listed.result.tools.length,
}];

for (let index = 1; index <= 3; index += 1) {
  const measured = await timed(`observeFast-${index}`, () => client.callTool({
    name: "douyin_observe_fast",
    arguments: {},
  }));
  const structured = measured.result.structuredContent ?? {};
  measurements.push({
    name: measured.name,
    elapsedMs: measured.elapsedMs,
    browserElapsedMs: structured.elapsedMs ?? null,
    screenshotIncluded: structured.screenshotIncluded ?? null,
  });
}

console.log(JSON.stringify({ endpoint, measurements }, null, 2));
await client.close();
