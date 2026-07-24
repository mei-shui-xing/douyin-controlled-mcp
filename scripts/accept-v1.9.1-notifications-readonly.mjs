import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp");
const runLiveReads = process.env.RUN_LIVE_NOTIFICATION_READS === "1";
const runPrepare = process.env.RUN_NOTIFICATION_REPLY_PREPARE === "1";
const expectedCommentNoticeId = "7665983569164452879";
const expectedMentionNoticeId = "7665220941693584424";
const expectedWorkId = "7664665666477133107";
const expectedCommentId = "7665983526496879397";
const schemaTools = [
  "douyin_load_capability_pack",
  "douyin_unload_capability_pack",
  "douyin_call_capability_tool",
  "douyin_call_write_capability_tool",
  "douyin_load_capability_pack_v1_9_1",
  "douyin_unload_capability_pack_v1_9_1",
  "douyin_call_capability_tool_v1_9_1",
  "douyin_call_write_capability_tool_v1_9_1",
];
const localEndpoint = ["127.0.0.1", "localhost"].includes(endpoint.hostname);
const accessToken = process.env.MCP_ACCESS_TOKEN
  ?? (localEndpoint && fs.existsSync(new URL("../runtime/MCP_ACCESS_TOKEN.txt", import.meta.url))
    ? fs.readFileSync(new URL("../runtime/MCP_ACCESS_TOKEN.txt", import.meta.url), "utf8").trim()
    : "");

const client = new Client({ name: "v1.9.1-notifications-readonly-acceptance", version: "1.9.1" });
await client.connect(new StreamableHTTPClientTransport(endpoint, accessToken ? {
  requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
} : undefined));
try {
  const manifest = await client.listTools();
  for (const toolName of schemaTools) {
    const schema = manifest.tools.find(tool => tool.name === toolName)?.inputSchema;
    assert.ok(schema, `${toolName} must be visible in the public MCP schema`);
    const properties = schema.properties ?? {};
    const packEnum = properties.packs?.items?.enum ?? properties.pack?.enum ?? [];
    assert.ok(packEnum.includes("notifications"), `${toolName} must enumerate notifications`);
  }

  const load = await client.callTool({
    name: "douyin_load_capability_pack_v1_9_1",
    arguments: { packs: ["notifications"], replace: false, include_schemas: false },
  });
  assert.notEqual(load.isError, true);
  assert.ok(load.structuredContent?.activePacks?.includes("notifications"));

  let live = null;
  if (runLiveReads) {
    const all = await client.callTool({
      name: "douyin_list_notifications",
      arguments: { filter: "all", limit: 100, response_mode: "full", include_unavailable: true },
    });
    assert.notEqual(all.isError, true);
    assert.ok(Number(all.structuredContent?.count ?? 0) > 0);

    const mentions = await client.callTool({
      name: "douyin_list_notifications",
      arguments: { filter: "mentions", limit: 100, response_mode: "full", include_unavailable: true },
    });
    assert.notEqual(mentions.isError, true);
    assert.ok((mentions.structuredContent?.items ?? []).some(item => item.noticeId === expectedMentionNoticeId));

    const comment = await client.callTool({
      name: "douyin_get_notification",
      arguments: { notice_id: expectedCommentNoticeId },
    });
    assert.notEqual(comment.isError, true);
    assert.equal(comment.structuredContent?.item?.work?.workId, expectedWorkId);
    assert.equal(comment.structuredContent?.item?.comment?.commentId, expectedCommentId);

    const mention = await client.callTool({
      name: "douyin_get_notification",
      arguments: { notice_id: expectedMentionNoticeId },
    });
    assert.notEqual(mention.isError, true);

    const opened = await client.callTool({
      name: "douyin_open_notification_target",
      arguments: { notice_id: expectedCommentNoticeId },
    });
    assert.notEqual(opened.isError, true);
    assert.equal(opened.structuredContent?.workVerified, true);
    assert.equal(opened.structuredContent?.workId, expectedWorkId);
    assert.equal(opened.structuredContent?.commentId, expectedCommentId);

    let prepared = null;
    if (runPrepare) {
      prepared = await client.callTool({
        name: "douyin_prepare_reply_from_notification",
        arguments: {
          notice_id: expectedCommentNoticeId,
          text: process.env.NOTIFICATION_REPLY_PREPARE_TEXT ?? "v1.9.1 read-only acceptance prepare; do not commit",
        },
      });
      assert.notEqual(prepared.isError, true);
      assert.equal(prepared.structuredContent?.sent, false);
      assert.equal(prepared.structuredContent?.confirmationRequired, true);
      assert.ok(prepared.structuredContent?.operationId);
    }
    live = {
      allCount: all.structuredContent?.count,
      mentionCount: mentions.structuredContent?.count,
      commentNoticeId: comment.structuredContent?.item?.noticeId,
      workId: comment.structuredContent?.item?.work?.workId,
      commentId: comment.structuredContent?.item?.comment?.commentId,
      mentionNoticeId: mention.structuredContent?.item?.noticeId,
      targetVerified: opened.structuredContent?.workVerified === true,
      targetPageOwnership: opened.structuredContent?.pageOwnership ?? null,
      replyPrepared: prepared ? prepared.structuredContent?.confirmationRequired === true : false,
    };
  }

  console.log(JSON.stringify({
    endpoint: `${endpoint.origin}${endpoint.pathname}`,
    schemaToolsVerified: schemaTools,
    notificationsLoaded: true,
    liveReadsExecuted: runLiveReads,
    live,
    prohibitedWritesExecuted: false,
  }, null, 2));
} finally {
  await client.close();
}
