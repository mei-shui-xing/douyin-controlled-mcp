import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

fs.mkdirSync(CONFIG.logsDir, { recursive: true });

const logFile = path.join(CONFIG.logsDir, "bridge.log");

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
      .replace(/([?&](?:token|code|ticket|auth|session)=)[^&\s]+/gi, "$1***");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export function log(event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...redact(details) as Record<string, unknown>,
  });
  fs.appendFileSync(logFile, `${entry}\n`, "utf8");
  console.error(`[douyin-readonly] ${event}`);
}
