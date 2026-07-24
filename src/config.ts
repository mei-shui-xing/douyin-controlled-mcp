import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(thisFile), "..");
const privateConfigDir = path.resolve(
  process.env.DOUYIN_PRIVATE_CONFIG_DIR ?? path.join(projectRoot, "runtime", "private-config"),
);

const extraAllowedHosts = (process.env.DOUYIN_EXTRA_ALLOWED_HOSTS ?? "")
  .split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

export const CONFIG = {
  name: "douyin-controlled-browser",
  version: "0.1.0-alpha.0",
  cdpUrl: process.env.DOUYIN_CDP_URL ?? "http://127.0.0.1:9222",
  rootCommentCdpUrl:
    process.env.DOUYIN_ROOT_COMMENT_CDP_URL ?? "http://127.0.0.1:9223",
  httpPort: Number(process.env.MCP_PORT ?? 31337),
  httpHost: process.env.MCP_HOST ?? "127.0.0.1",
  accessToken: (process.env.MCP_ACCESS_TOKEN ?? "").trim(),
  allowedOrigins: new Set((process.env.MCP_ALLOWED_ORIGINS
    ?? "https://chatgpt.com,https://chat.openai.com,https://platform.openai.com")
    .split(",")
    .map(origin => origin.trim().toLowerCase().replace(/\/$/, ""))
    .filter(Boolean)),
  sessionTtlMs: Math.min(
    24 * 60 * 60_000,
    Math.max(5 * 60_000, Number(process.env.MCP_SESSION_TTL_MS ?? 30 * 60_000)),
  ),
  sessionIdleEvictionMs: Math.min(
    10 * 60_000,
    Math.max(5_000, Number(process.env.MCP_SESSION_IDLE_EVICTION_MS ?? 15_000)),
  ),
  maxSessions: Math.min(64, Math.max(1, Number(process.env.MCP_MAX_SESSIONS ?? 48))),
  maxRequestsPerMinute: Math.min(
    600,
    Math.max(20, Number(process.env.MCP_MAX_REQUESTS_PER_MINUTE ?? 180)),
  ),
  projectRoot,
  privateConfigDir,
  runtimeDir: path.join(projectRoot, "runtime"),
  logsDir: path.join(projectRoot, "logs"),
  transcriptDir: path.join(projectRoot, "runtime", "transcripts"),
  transcriptPythonFile: path.join(projectRoot, "runtime", "TRANSCRIPT_PYTHON.txt"),
  transcriptModel: process.env.FW_MODEL_SIZE ?? "small",
  screenshotQuality: Math.min(90, Math.max(40, Number(process.env.SCREENSHOT_QUALITY ?? 68))),
  maxElements: Math.min(140, Math.max(20, Number(process.env.MAX_ELEMENTS ?? 100))),
  actionDelayMs: Math.min(4000, Math.max(250, Number(process.env.ACTION_DELAY_MS ?? 900))),
  allowedHosts: new Set([
    "douyin.com",
    "www.douyin.com",
    "creator.douyin.com",
    ...extraAllowedHosts,
  ]),
};
