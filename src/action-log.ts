import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import type { LowRiskVerification } from "./low-risk-post-action.js";

export type ActionLogEntry = {
  time: string;
  toolName: string;
  currentAccount: string;
  actionType: string;
  workUrl?: string;
  author?: string;
  beforeState?: string;
  afterState?: string;
  recipientAlias?: string;
  success: boolean;
  failureReason?: string;
  verification?: LowRiskVerification;
};

const actionLogFile = path.join(CONFIG.logsDir, "douyin_actions.jsonl");
fs.mkdirSync(CONFIG.logsDir, { recursive: true });

function clean(value: string | undefined, max = 500): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/([?&](?:token|code|ticket|auth|session)=)[^&\s]+/gi, "$1***")
    .slice(0, max);
}

export function appendActionLog(entry: Omit<ActionLogEntry, "time"> & { time?: string }): ActionLogEntry {
  const saved: ActionLogEntry = {
    time: entry.time ?? new Date().toISOString(),
    toolName: clean(entry.toolName, 80) ?? "unknown",
    currentAccount: clean(entry.currentAccount, 100) ?? "unknown",
    actionType: clean(entry.actionType, 80) ?? "unknown",
    workUrl: clean(entry.workUrl),
    author: clean(entry.author, 100),
    beforeState: clean(entry.beforeState, 100),
    afterState: clean(entry.afterState, 100),
    recipientAlias: clean(entry.recipientAlias, 80),
    success: entry.success,
    failureReason: clean(entry.failureReason),
    verification: entry.verification,
  };
  fs.appendFileSync(actionLogFile, `${JSON.stringify(saved)}\n`, "utf8");
  return saved;
}

export function readActionLog(limit = 30, actionType?: string): ActionLogEntry[] {
  if (!fs.existsSync(actionLogFile)) return [];
  return fs.readFileSync(actionLogFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as ActionLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ActionLogEntry => Boolean(entry))
    .filter(entry => !actionType || entry.actionType === actionType)
    .slice(-Math.max(1, Math.min(100, limit)))
    .reverse();
}

export function recentSuccessfulActions(sinceMs: number): ActionLogEntry[] {
  const since = Date.now() - sinceMs;
  return readActionLog(100)
    .filter(entry => entry.success && Date.parse(entry.time) >= since)
    .filter(entry => entry.actionType === "share"
      || entry.actionType === "message"
      || entry.beforeState !== entry.afterState);
}
