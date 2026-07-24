import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:31337/mcp");
const runLiveWrites = process.env.RUN_LIVE_LOW_RISK_WRITES === "1";
const localEndpoint = ["127.0.0.1", "localhost"].includes(endpoint.hostname);
const tokenFile = new URL("../runtime/MCP_ACCESS_TOKEN.txt", import.meta.url);
const accessToken = process.env.MCP_ACCESS_TOKEN
  ?? (localEndpoint && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
const removedToolFragments = [["echo", "lens"].join(""), ["dream", "log"].join("")];

const client = new Client({ name: "v1.10.0-low-risk-acceptance", version: "1.10.0" });
await client.connect(new StreamableHTTPClientTransport(endpoint, accessToken ? {
  requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
} : undefined));

const resultSummary = {
  endpoint: `${endpoint.origin}${endpoint.pathname}`,
  schemaVerified: false,
  liveWritesExecuted: false,
  restoredOriginalState: false,
  operations: [],
};

try {
  await client.callTool({
    name: "douyin_load_capability_pack_v1_10_0",
    arguments: { packs: ["public_social", "transcript"], replace: false, include_schemas: false },
  });
  const manifest = await client.listTools();
  const names = manifest.tools.map(tool => tool.name);
  for (const name of [
    "douyin_like_post",
    "douyin_favorite_post",
    "douyin_follow_post_author",
    "douyin_transcribe_link_local",
  ]) {
    assert.ok(names.includes(name), `${name} must be visible after loading its pack`);
  }
  assert.equal(
    names.some(name => removedToolFragments.some(fragment => name.toLowerCase().includes(fragment))),
    false,
    "removed third-party transcript tools must not be registered",
  );
  const likeSchema = manifest.tools.find(tool => tool.name === "douyin_like_post")?.inputSchema;
  assert.ok(likeSchema?.properties?.work_id);
  assert.deepEqual(likeSchema?.properties?.action?.enum, ["like", "unlike"]);
  assert.deepEqual(likeSchema?.properties?.scope?.enum, ["own_post", "bound_user_post", "external_post"]);
  const localSchema = manifest.tools.find(tool => tool.name === "douyin_transcribe_link_local")?.inputSchema;
  assert.ok(localSchema?.properties?.url);
  assert.ok(localSchema?.properties?.model?.enum?.includes("small"));
  resultSummary.schemaVerified = true;

  if (!runLiveWrites) {
    const readOnlyWorkId = process.env.READ_ONLY_LOW_RISK_WORK_ID?.trim();
    if (readOnlyWorkId) {
      assert.match(readOnlyWorkId, /^\d{16,20}$/);
      const dryRun = await client.callTool({
        name: "douyin_like_post",
        arguments: {
          work_id: readOnlyWorkId,
          action: "like",
          scope: process.env.READ_ONLY_LOW_RISK_SCOPE ?? "external_post",
          alias: process.env.READ_ONLY_LOW_RISK_ALIAS?.trim() || undefined,
          dry_run: true,
        },
      });
      assert.notEqual(dryRun.isError, true, dryRun.content?.map(item => item.text ?? "").join("\n"));
      assert.equal(dryRun.structuredContent?.changed, false);
      assert.equal(dryRun.structuredContent?.dryRun, true);
      assert.equal(dryRun.structuredContent?.verification?.level, "reload_confirmed");
      resultSummary.operations.push(dryRun.structuredContent);
    }
    console.log(JSON.stringify(resultSummary, null, 2));
  } else {
  const workId = process.env.LIVE_LOW_RISK_WORK_ID?.trim();
  assert.match(workId ?? "", /^\d{16,20}$/, "LIVE_LOW_RISK_WORK_ID is required for live acceptance");
  const scope = process.env.LIVE_LOW_RISK_SCOPE ?? "external_post";
  assert.ok(["own_post", "bound_user_post", "external_post"].includes(scope));
  const alias = process.env.LIVE_LOW_RISK_ALIAS?.trim() || undefined;
  if (scope === "bound_user_post") assert.ok(alias, "bound_user_post requires LIVE_LOW_RISK_ALIAS");

  await client.callTool({
    name: "browser_switch_allowed_tab",
    arguments: { page_id: process.env.LIVE_DECOY_PAGE_ID ?? "operator_home" },
  }).catch(() => null);

  const callLike = async (action, dryRun = false) => {
    const response = await client.callTool({
      name: "douyin_like_post",
      arguments: { work_id: workId, action, scope, alias, dry_run: dryRun },
    });
    assert.notEqual(response.isError, true, response.content?.map(item => item.text ?? "").join("\n"));
    resultSummary.operations.push(response.structuredContent);
    return response.structuredContent;
  };

  const before = await callLike("like", true);
  assert.equal(before.beforeLiked, false, "choose a work that is definitely not liked before running live acceptance");
  const liked = await callLike("like");
  assert.equal(liked.success, true);
  assert.equal(liked.changed, true);
  assert.ok(["server_confirmed", "reload_confirmed"].includes(liked.verification?.level));

  const idempotent = await callLike("like");
  assert.equal(idempotent.success, true);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.verification?.level, "reload_confirmed");

  const unliked = await callLike("unlike");
  assert.equal(unliked.success, true);
  assert.equal(unliked.changed, true);
  assert.ok(["server_confirmed", "reload_confirmed"].includes(unliked.verification?.level));

  const after = await callLike("unlike", true);
  assert.equal(after.afterLiked, false);
  assert.equal(after.verification?.persistedAfterReload, true);
  resultSummary.liveWritesExecuted = true;
  resultSummary.restoredOriginalState = true;
  console.log(JSON.stringify(resultSummary, null, 2));
  }
} finally {
  await client.close();
}
