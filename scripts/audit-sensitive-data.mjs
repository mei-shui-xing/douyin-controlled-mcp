import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const output = path.resolve(process.argv[2] ?? path.join(root, "SENSITIVE_DATA_INVENTORY.md"));
const skippedDirectories = new Set([".git", "node_modules", "dist"]);
const textExtensions = new Set([
  ".cmd", ".csv", ".env", ".html", ".js", ".json", ".jsonl", ".log", ".md",
  ".mjs", ".ps1", ".py", ".sql", ".ts", ".txt", ".yaml", ".yml",
]);
const findings = new Map();
const archiveRows = [];

function fingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function scopeFor(relative) {
  if (relative.startsWith("docs/archive/")) return "historical/excluded";
  const first = relative.split("/")[0];
  return ["runtime", "logs", "backups", "release"].includes(first) ? "ignored/private" : "tracked/source";
}

function record(category, value, relative, line) {
  if (!value || /^(null|true|false|YOUR_|EXACT_|GENERATE_)/i.test(value)) return;
  if (category === "access_token" && [
    "Get-OrCreateAccessToken",
    "process.env.MCP_ACCESS_TOKEN",
    "encodedToken",
    "$encodedToken",
  ].includes(value)) return;
  if (category === "cookie" && (/cookieHeader|cookies\.map|page\.context\(\)\.cookies/i.test(value)
    || value.startsWith(">"))) return;
  if (category === "account_alias" && ["operator", "bound_user", "example_friend"].includes(value)) return;
  if (["uid", "work_id", "comment_id", "message_id", "notice_id"].includes(category)
    && /(?:^|\/)(?:config\/test-fixtures|src\/.*fixtures|scripts\/accept-)/i.test(relative)
    && /^(?:1000000000[12]|7000000000000000001)$/.test(value)) return;
  if (/(_TEST_|fixture|placeholder|dummy|example)/i.test(value)
    && !category.startsWith("hardcoded_account_")) return;
  if (/_id$/.test(category) && /^(7000000000000000001|1000000000[12])$/.test(value)) return;
  const hash = fingerprint(value);
  const key = `${category}\0${hash}`;
  const current = findings.get(key) ?? { category, hash, length: value.length, locations: new Set(), scopes: new Set() };
  current.locations.add(`${relative}:${line}`);
  current.scopes.add(scopeFor(relative));
  findings.set(key, current);
}

function scanText(file, relative) {
  if (relative === "scripts/audit-sensitive-data.mjs") return;
  if (fs.statSync(file).size > 32 * 1024 * 1024) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  if (text.includes("\u0000")) return;
  let arrayContext = null;
  let arrayDepth = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const contextMatch = line.match(/"(?:viewed|known|pending|processed)?(work|message|comment|notice|notification)Ids?"\s*:\s*\[/i);
    if (contextMatch) {
      arrayContext = `${contextMatch[1].toLowerCase()}_id`;
      arrayDepth = 1;
    } else if (arrayContext) {
      arrayDepth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      if (arrayDepth <= 0) arrayContext = null;
    }

    const patterns = [
      ["access_token", /(?:access[_-]?token|MCP_ACCESS_TOKEN)\s*(?:=|:|\?)\s*["']?([A-Za-z0-9._~-]{16,})/gi],
      ["access_token", /[?&]access_token=([^&"'\s<]+)/gi],
      ["cookie", /(?:cookie|set-cookie)\s*(?:=|:)\s*["']?([^"'\r\n]{12,})/gi],
      ["sec_uid", /(MS4wLjABAAAA[A-Za-z0-9_-]{12,})/g],
      ["uid", /"(?:uid|user_id)"\s*:\s*"?([0-9]{8,22})"?/gi],
      ["work_id", /"(?:workId|work_id|aweme_id|item_id)"\s*:\s*"?([0-9]{8,22})"?/gi],
      ["comment_id", /"(?:commentId|comment_id|targetCommentId|parentCommentId|rootCommentId|replyCommentId)"\s*:\s*"?([0-9]{8,22})"?/gi],
      ["message_id", /"(?:messageId|message_id|serverId)"\s*:\s*"?([A-Za-z0-9_-]{8,})"?/gi],
      ["notice_id", /"(?:noticeId|notice_id|notificationId|notification_id)"\s*:\s*"?([A-Za-z0-9_-]{8,})"?/gi],
      ["account_alias", /"alias"\s*:\s*"([^"\r\n]+)"/gi],
      ["account_name", /"display_name"\s*:\s*"([^"\r\n]+)"/gi],
      ["hardcoded_account_alias", /\b(bingbing)\b/gi],
      ["hardcoded_account_name", /\b(Eiralin|Grayson)\b/g],
      ["local_path", /([A-Za-z]:\\Users\\[^\s"'<>]+)/g],
    ];
    for (const [category, regex] of patterns) {
      for (const match of line.matchAll(regex)) record(category, match[1], relative, lineNo);
    }
    if (arrayContext) {
      for (const match of line.matchAll(/"([0-9]{8,22})"/g)) record(arrayContext, match[1], relative, lineNo);
    }
    if (relative.endsWith("douyin_bound_users.json")) {
      const topLevelAlias = line.match(/^\s{2}"([^"\r\n]+)"\s*:\s*\{/);
      if (topLevelAlias) record("account_alias", topLevelAlias[1], relative, lineNo);
    }
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      if (/(^|\/)(browser-profile|grayson_root_comment_clean|chrome-user-data)$/i.test(relative)) {
        record("browser_profile_present", relative, relative, 0);
      }
      walk(file);
      continue;
    }
    if (entry.name.toLowerCase().endsWith(".zip")) {
      archiveRows.push({ relative, size: entry.size ?? fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
      continue;
    }
    if (textExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name.startsWith(".env")) scanText(file, relative);
  }
}

walk(root);
const sorted = [...findings.values()].sort((a, b) => a.category.localeCompare(b.category) || a.hash.localeCompare(b.hash));
const counts = new Map();
for (const item of sorted) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);

const lines = [
  "# Redacted sensitive-data inventory",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "Values are never printed. `sha12` is a one-way SHA-256 prefix used only to correlate duplicate occurrences. Items under ignored/private paths remain owner data and must never enter a package.",
  "",
  "## Counts by unique value",
  "",
  "| Category | Unique values |",
  "| --- | ---: |",
  ...[...counts.entries()].sort().map(([category, count]) => `| ${category} | ${count} |`),
  "",
  "## Redacted findings",
  "",
  "| Category | sha12 | Length | Scope | Locations |",
  "| --- | --- | ---: | --- | --- |",
  ...sorted.map(item => `| ${item.category} | \`${item.hash}\` | ${item.length} | ${[...item.scopes].join(", ")} | ${[...item.locations].join("<br>")} |`),
  "",
  "## Archive quarantine inventory",
  "",
  "| Archive | Bytes | SHA256 |",
  "| --- | ---: | --- |",
  ...archiveRows.sort((a, b) => a.relative.localeCompare(b.relative)).map(item => `| ${item.relative} | ${item.size} | \`${item.sha256}\` |`),
  "",
  "## Interpretation limits",
  "",
  "- Browser-profile cookie databases and other binary stores are flagged by presence, not decoded or copied.",
  "- IDs in source fixtures and historical documents may be synthetic; IDs under runtime/logs/private-config are treated as real unless the owner proves otherwise.",
  "- A clean candidate must contain no ignored/private locations and no non-placeholder account/token findings.",
];

fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ output, uniqueFindings: sorted.length, archives: archiveRows.length, counts: Object.fromEntries(counts) }));
