import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp";
const operationId = process.env.ADAPTIVE_OPERATION_ID ?? null;

const client = new Client({
  name: "adaptive-comment-readonly-acceptance",
  version: "1.0.0",
});
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

try {
  const catalog = await client.callTool({
    name: "douyin_list_capability_packs",
    arguments: {},
  });
  const packs = catalog.structuredContent?.packs ?? [];
  assert.equal(packs.some(pack => pack.name === "adaptive_comment"), true);

  const loaded = await client.callTool({
    name: "douyin_load_capability_pack",
    arguments: {
      packs: ["adaptive_comment"],
      replace: true,
      include_schemas: false,
    },
  });
  assert.deepEqual(
    loaded.structuredContent?.activePacks,
    ["adaptive_comment", "public_social", "browse"],
  );

  const listed = await client.listTools();
  const adaptiveTools = listed.tools
    .map(tool => tool.name)
    .filter(name => name.startsWith("douyin_adaptive_"));
  assert.equal(adaptiveTools.length, 8);
  assert.equal(
    listed.tools.some(tool => tool.name === "douyin_preview_comment_on_post"),
    true,
  );
  assert.equal(
    listed.tools.some(tool => tool.name === "douyin_diagnose_root_comment_submit"),
    true,
  );
  assert.equal(
    listed.tools.some(tool => tool.name === "douyin_readback_exact_root_comment"),
    true,
  );

  let result = null;
  if (operationId) {
    const inspected = await client.callTool({
      name: "douyin_adaptive_inspect_comment_composer",
      arguments: { operation_id: operationId },
    });
    assert.equal(inspected.isError, undefined);
    result = inspected.structuredContent;
    assert.equal(result.operationId, operationId);
    assert.equal(result.sent, false);
  }

  console.log(JSON.stringify({
    endpoint,
    packCount: packs.length,
    activePacks: loaded.structuredContent?.activePacks,
    adaptiveToolCount: adaptiveTools.length + 3,
    operationId: result?.operationId ?? null,
    state: result?.state ?? null,
    workId: result?.workId ?? null,
    scope: result?.scope ?? null,
    composerTextMatched: result?.composerTextMatched ?? null,
    candidateBelongsToFrozenEditor:
      result?.submitCandidate?.belongsToFrozenEditor ?? null,
    candidateDisabled: result?.submitCandidate?.disabled ?? null,
    candidateObscured: result?.submitCandidate?.obscured ?? null,
    clickAttemptCount: result?.clickAttemptCount ?? null,
    maxSubmitAttempts: result?.maxSubmitAttempts ?? null,
    adaptiveReady: result?.adaptiveReady ?? null,
    sent: result?.sent ?? false,
    auditStepIndex: result?.auditStep?.stepIndex ?? null,
  }, null, 2));
} finally {
  await client.close();
}
