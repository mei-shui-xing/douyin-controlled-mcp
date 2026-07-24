import { createHash, randomUUID } from "node:crypto";
import { loadActionSettings } from "./action-config.js";
import { assertWriteReady } from "./write-gate.js";
import { withImmediateTransaction } from "./sqlite.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function enforceWritePolicy(actionType: string, workUrl?: string): Promise<void> {
  assertWriteReady();
  const settings = loadActionSettings();
  withImmediateTransaction(db => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const minuteAgo = new Date(now - 60_000).toISOString();
    db.prepare("DELETE FROM write_rate_reservations WHERE expires_at<=?").run(nowIso);
    const count = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM write_rate_reservations
      WHERE reserved_at>=?
    `).get(minuteAgo) as { count?: number | bigint }).count ?? 0);
    if (count >= settings.rateLimit.maxWritesPerMinute) {
      throw new Error(`动作限流：最近 1 分钟已有 ${count} 个原子写额度被占用，请稍后再试。`);
    }
    const workKeyHash = workUrl
      ? createHash("sha256").update(workUrl).digest("hex")
      : null;
    if (actionType === "share" && workKeyHash) {
      const cooldownStart = new Date(
        now - settings.rateLimit.shareCooldownMinutes * 60_000,
      ).toISOString();
      const duplicate = db.prepare(`
        SELECT reservation_id FROM write_rate_reservations
        WHERE action_type='share' AND work_key_hash=? AND reserved_at>=?
        LIMIT 1
      `).get(workKeyHash, cooldownStart);
      if (duplicate) {
        throw new Error(`分享冷却：该作品最近已有分享额度，请等待 ${settings.rateLimit.shareCooldownMinutes} 分钟。`);
      }
    }
    db.prepare(`
      INSERT INTO write_rate_reservations(
        reservation_id, action_type, work_key_hash, reserved_at, expires_at
      ) VALUES(?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      actionType,
      workKeyHash,
      nowIso,
      new Date(now + Math.max(60_000, settings.rateLimit.shareCooldownMinutes * 60_000))
        .toISOString(),
    );
  });
  const span = settings.rateLimit.maxDelayMs - settings.rateLimit.minDelayMs;
  await sleep(settings.rateLimit.minDelayMs + Math.floor(Math.random() * (span + 1)));
}
