import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

type LockRecord = { pid: number; startedAt: string };

const lockFile = path.join(CONFIG.runtimeDir, "mcp-process.lock");
let owned = false;

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireProcessLock(): void {
  fs.mkdirSync(CONFIG.runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      const record: LockRecord = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(fd, JSON.stringify(record), "utf8");
      fs.closeSync(fd);
      owned = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LockRecord | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockRecord;
      } catch {
        // A malformed lock cannot prove that another server is active.
      }
      if (existing && processAlive(existing.pid)) {
        throw new Error(
          `MCP_PROCESS_LOCKED:pid=${existing.pid};started_at=${existing.startedAt}`,
        );
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
  throw new Error("MCP_PROCESS_LOCK_FAILED");
}

export function releaseProcessLock(): void {
  if (!owned) return;
  try {
    const existing = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockRecord;
    if (existing.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    // The process is already shutting down; stale locks are reclaimed at startup.
  }
  owned = false;
}
