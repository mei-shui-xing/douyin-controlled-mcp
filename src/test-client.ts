import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "douyin-readonly-self-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(
  process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp",
));

await client.connect(transport);
const tools = await client.listTools();
console.log(`TOOL_COUNT=${tools.tools.length}`);
console.log(`TOOLS=${tools.tools.map(tool => tool.name).join(",")}`);
const toolName = process.env.TEST_TOOL ?? "douyin_status";
const toolArguments = process.env.TEST_ARGS ? JSON.parse(process.env.TEST_ARGS) : {};
const status = await client.callTool({ name: toolName, arguments: toolArguments });
const printable = process.env.PRINT_IMAGES === "1"
  ? status
  : {
      ...status,
      content: Array.isArray(status.content)
        ? status.content.filter(item => item.type !== "image")
        : status.content,
    };
console.log(JSON.stringify(printable, null, 2));
await client.close();
