import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import {
  getDatabase,
  getMetadata,
  setMetadata,
  sqliteWritableProbe,
  withImmediateTransaction,
} from "./sqlite.js";

export type CreatorReplyTransactionStatus =
  | "prepared"
  | "click_started"
  | "confirmed"
  | "rejected"
  | "expired"
  | "unknown_after_submit"
  | "failed_before_click";

export type CreatorReplyPlanRecord = {
  replyPlanId: string;
  transactionId: string;
  idempotencyKey: string;
  actorAccount: string;
  status: CreatorReplyTransactionStatus;
  workId: string;
  workTitle: string | null;
  targetCommentId: string;
  targetAuthor: string;
  targetText: string;
  targetTextHash: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  threadPath: string[];
  alreadyReplied: boolean;
  replyText: string;
  replyTextHash: string;
  snapshotId: string;
  targetSource?: "dataset" | "current_filtered" | "match_index";
  filterKeyword?: string | null;
  createdAt: string;
  expiresAt: string;
  clicked: boolean;
  clickedAt: string | null;
  confirmedAt: string | null;
  replyCommentId: string | null;
  verifiedInCreatorCenter: boolean;
  blockedReason: string | null;
  updatedAt: string;
};

type LegacyStoreFile = {
  plans?: Array<Partial<CreatorReplyPlanRecord> & {
    status?: string;
  }>;
};

type ReplyRow = Record<string, unknown>;

const allowedReplyTransitions: Record<
  CreatorReplyTransactionStatus,
  ReadonlySet<CreatorReplyTransactionStatus>
> = {
  prepared: new Set(["click_started", "confirmed", "rejected", "expired", "failed_before_click"]),
  click_started: new Set(["confirmed", "unknown_after_submit"]),
  unknown_after_submit: new Set(["confirmed", "unknown_after_submit"]),
  confirmed: new Set(["confirmed"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
  failed_before_click: new Set(["failed_before_click"]),
};

const legacyStoreFile = path.join(CONFIG.runtimeDir, "creator-reply-transactions.json");

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function creatorReplyIdempotencyKey(
  workId: string,
  targetCommentId: string,
  replyTextHash: string,
): string {
  return sha256(`${workId}:${targetCommentId}:${replyTextHash}`);
}

export function frozenCreatorTargetMatches(
  plan: Pick<CreatorReplyPlanRecord,
    "workId" | "targetCommentId" | "targetAuthor" | "targetText" | "targetTextHash"
    | "parentCommentId" | "rootCommentId" | "depth" | "threadPath">,
  current: {
    workId: string;
    commentId: string;
    author: string;
    text: string;
    parentCommentId: string | null;
    rootCommentId: string;
    depth: number;
    threadPath: string[];
  },
): boolean {
  return current.workId === plan.workId
    && current.commentId === plan.targetCommentId
    && current.author === plan.targetAuthor
    && current.text === plan.targetText
    && sha256(current.text) === plan.targetTextHash
    && current.parentCommentId === plan.parentCommentId
    && current.rootCommentId === plan.rootCommentId
    && current.depth === plan.depth
    && JSON.stringify(current.threadPath) === JSON.stringify(plan.threadPath);
}

function mapLegacyState(status: string | undefined, clicked: boolean): CreatorReplyTransactionStatus {
  if (status === "confirmed") return "confirmed";
  if (status === "pending_verification" || status === "unknown_after_submit") {
    return "unknown_after_submit";
  }
  if (status === "blocked") return "rejected";
  if (status === "prepared" && clicked) return "unknown_after_submit";
  return "prepared";
}

function rowToRecord(row: ReplyRow | undefined): CreatorReplyPlanRecord | null {
  if (!row) return null;
  const clickStartedAt = typeof row.click_started_at === "string" ? row.click_started_at : null;
  return {
    replyPlanId: String(row.reply_plan_id),
    transactionId: String(row.operation_id),
    idempotencyKey: String(row.idempotency_key),
    actorAccount: String(row.actor_account ?? "Operator"),
    status: String(row.state) as CreatorReplyTransactionStatus,
    workId: String(row.work_id),
    workTitle: typeof row.work_title === "string" ? row.work_title : null,
    targetCommentId: String(row.comment_id),
    targetAuthor: String(row.target_author),
    targetText: String(row.target_text),
    targetTextHash: String(row.target_text_hash),
    parentCommentId: typeof row.parent_comment_id === "string" ? row.parent_comment_id : null,
    rootCommentId: String(row.root_comment_id),
    depth: Number(row.depth),
    threadPath: JSON.parse(String(row.thread_path_json)) as string[],
    alreadyReplied: Number(row.already_replied) === 1,
    replyText: String(row.reply_text),
    replyTextHash: String(row.reply_text_hash),
    snapshotId: String(row.snapshot_id),
    targetSource: typeof row.target_source === "string"
      ? row.target_source as CreatorReplyPlanRecord["targetSource"]
      : undefined,
    filterKeyword: typeof row.filter_keyword === "string" ? row.filter_keyword : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
    clicked: Boolean(clickStartedAt),
    clickedAt: clickStartedAt,
    confirmedAt: typeof row.confirmed_at === "string" ? row.confirmed_at : null,
    replyCommentId: typeof row.reply_comment_id === "string" ? row.reply_comment_id : null,
    verifiedInCreatorCenter: Number(row.verified_in_creator_center) === 1,
    blockedReason: typeof row.last_error === "string" ? row.last_error : null,
  };
}

function insertRecord(record: CreatorReplyPlanRecord): void {
  getDatabase().prepare(`
    INSERT OR IGNORE INTO write_operations(
      operation_id, reply_plan_id, idempotency_key, work_id, work_title,
      actor_account,
      comment_id, target_author, target_text, target_text_hash,
      parent_comment_id, root_comment_id, depth, thread_path_json,
      already_replied, reply_text, reply_text_hash, snapshot_id,
      target_source, filter_keyword, state, created_at, updated_at,
      expires_at, click_started_at, confirmed_at, reply_comment_id,
      verified_in_creator_center, last_error
    ) VALUES(
      ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    record.transactionId,
    record.replyPlanId,
    record.idempotencyKey,
    record.workId,
    record.workTitle,
    record.actorAccount,
    record.targetCommentId,
    record.targetAuthor,
    record.targetText,
    record.targetTextHash,
    record.parentCommentId,
    record.rootCommentId,
    record.depth,
    JSON.stringify(record.threadPath),
    record.alreadyReplied ? 1 : 0,
    record.replyText,
    record.replyTextHash,
    record.snapshotId,
    record.targetSource ?? null,
    record.filterKeyword ?? null,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.expiresAt,
    record.clickedAt,
    record.confirmedAt,
    record.replyCommentId,
    record.verifiedInCreatorCenter ? 1 : 0,
    record.blockedReason,
  );
}

function migrateLegacyJson(): void {
  if (getMetadata("reply_operations_json_migrated") === "1") return;
  let imported = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyStoreFile, "utf8")) as LegacyStoreFile;
    withImmediateTransaction(() => {
      for (const legacy of parsed.plans ?? []) {
        if (!legacy.replyPlanId || !legacy.transactionId || !legacy.idempotencyKey
          || !legacy.workId || !legacy.targetCommentId || !legacy.targetAuthor
          || !legacy.targetText || !legacy.targetTextHash || !legacy.rootCommentId
          || !legacy.replyText || !legacy.replyTextHash || !legacy.snapshotId
          || !legacy.createdAt || !legacy.updatedAt || !legacy.expiresAt) continue;
        const clicked = legacy.clicked === true;
        const status = mapLegacyState(legacy.status, clicked);
        insertRecord({
          replyPlanId: legacy.replyPlanId,
          transactionId: legacy.transactionId,
          idempotencyKey: legacy.idempotencyKey,
          actorAccount: "Operator",
          status,
          workId: legacy.workId,
          workTitle: legacy.workTitle ?? null,
          targetCommentId: legacy.targetCommentId,
          targetAuthor: legacy.targetAuthor,
          targetText: legacy.targetText,
          targetTextHash: legacy.targetTextHash,
          parentCommentId: legacy.parentCommentId ?? null,
          rootCommentId: legacy.rootCommentId,
          depth: Number(legacy.depth ?? 0),
          threadPath: Array.isArray(legacy.threadPath)
            ? legacy.threadPath
            : [legacy.rootCommentId],
          alreadyReplied: legacy.alreadyReplied === true,
          replyText: legacy.replyText,
          replyTextHash: legacy.replyTextHash,
          snapshotId: legacy.snapshotId,
          targetSource: legacy.targetSource,
          filterKeyword: legacy.filterKeyword ?? null,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
          expiresAt: legacy.expiresAt,
          clicked,
          clickedAt: legacy.clickedAt ?? null,
          confirmedAt: status === "confirmed" ? legacy.updatedAt : null,
          replyCommentId: legacy.replyCommentId ?? null,
          verifiedInCreatorCenter: legacy.verifiedInCreatorCenter === true,
          blockedReason: legacy.blockedReason ?? null,
        });
        imported += 1;
      }
    });
  } catch {
    // A missing legacy JSON file is a valid fresh installation.
  }
  setMetadata("reply_operations_json_migrated", "1");
  setMetadata("reply_operations_json_imported_count", String(imported));
}

export class CreatorReplyStore {
  constructor() {
    getDatabase();
    migrateLegacyJson();
  }

  health(): { writable: boolean; error: string | null } {
    return sqliteWritableProbe();
  }

  create(input: Omit<CreatorReplyPlanRecord,
    "replyPlanId" | "transactionId" | "createdAt" | "updatedAt"
    | "status" | "clicked" | "clickedAt" | "confirmedAt" | "replyCommentId"
    | "verifiedInCreatorCenter" | "blockedReason">): CreatorReplyPlanRecord {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const plan: CreatorReplyPlanRecord = {
        ...input,
        replyPlanId: crypto.randomUUID(),
        transactionId: crypto.randomUUID(),
        status: "prepared",
        createdAt: now,
        updatedAt: now,
        clicked: false,
        clickedAt: null,
        confirmedAt: null,
        replyCommentId: null,
        verifiedInCreatorCenter: false,
        blockedReason: null,
      };
      db.prepare(`
        INSERT INTO write_operations(
          operation_id, reply_plan_id, idempotency_key, work_id, work_title,
          actor_account,
          comment_id, target_author, target_text, target_text_hash,
          parent_comment_id, root_comment_id, depth, thread_path_json,
          already_replied, reply_text, reply_text_hash, snapshot_id,
          target_source, filter_keyword, state, created_at, updated_at,
          expires_at, click_started_at, confirmed_at, reply_comment_id,
          verified_in_creator_center, last_error
        ) VALUES(
          ?, ?, ?, ?, ?,
          ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL,
          0, NULL
        )
      `).run(
        plan.transactionId,
        plan.replyPlanId,
        plan.idempotencyKey,
        plan.workId,
        plan.workTitle,
        plan.actorAccount,
        plan.targetCommentId,
        plan.targetAuthor,
        plan.targetText,
        plan.targetTextHash,
        plan.parentCommentId,
        plan.rootCommentId,
        plan.depth,
        JSON.stringify(plan.threadPath),
        plan.alreadyReplied ? 1 : 0,
        plan.replyText,
        plan.replyTextHash,
        plan.snapshotId,
        plan.targetSource ?? null,
        plan.filterKeyword ?? null,
        plan.status,
        plan.createdAt,
        plan.updatedAt,
        plan.expiresAt,
      );
      return plan;
    });
  }

  get(replyPlanId: string): CreatorReplyPlanRecord | null {
    return rowToRecord(getDatabase().prepare(
      `SELECT * FROM write_operations
       WHERE reply_plan_id=?
         AND scope='own_post'
         AND action_type='reply_to_comment'
         AND page_role='creator_center'`,
    ).get(replyPlanId) as ReplyRow | undefined);
  }

  getByTransactionId(transactionId: string): CreatorReplyPlanRecord | null {
    return rowToRecord(getDatabase().prepare(
      `SELECT * FROM write_operations
       WHERE operation_id=?
         AND scope='own_post'
         AND action_type='reply_to_comment'
         AND page_role='creator_center'`,
    ).get(transactionId) as ReplyRow | undefined);
  }

  getByIdempotencyKey(idempotencyKey: string): CreatorReplyPlanRecord | null {
    return rowToRecord(getDatabase().prepare(
      `SELECT * FROM write_operations
       WHERE idempotency_key=?
         AND scope='own_post'
         AND action_type='reply_to_comment'
         AND page_role='creator_center'`,
    ).get(idempotencyKey) as ReplyRow | undefined);
  }

  listRecoverable(): CreatorReplyPlanRecord[] {
    return (getDatabase().prepare(`
      SELECT * FROM write_operations
      WHERE state IN ('prepared', 'click_started', 'unknown_after_submit')
        AND scope='own_post' AND action_type='reply_to_comment'
        AND page_role='creator_center'
      ORDER BY created_at ASC
    `).all() as ReplyRow[])
      .map(row => rowToRecord(row))
      .filter((record): record is CreatorReplyPlanRecord => Boolean(record));
  }

  listUnresolvedAfterSubmit(): CreatorReplyPlanRecord[] {
    return (getDatabase().prepare(`
      SELECT * FROM write_operations
      WHERE state IN ('click_started', 'unknown_after_submit')
        AND scope='own_post' AND action_type='reply_to_comment'
        AND page_role='creator_center'
      ORDER BY created_at ASC
    `).all() as ReplyRow[])
      .map(row => rowToRecord(row))
      .filter((record): record is CreatorReplyPlanRecord => Boolean(record));
  }

  update(
    replyPlanId: string,
    patch: Partial<CreatorReplyPlanRecord>,
  ): CreatorReplyPlanRecord {
    return withImmediateTransaction(db => {
      const current = this.get(replyPlanId);
      if (!current) throw new Error("REPLY_PLAN_NOT_FOUND:replyPlanId 不存在。");
      const nextStatus = patch.status ?? current.status;
      if (nextStatus !== current.status
        && !allowedReplyTransitions[current.status].has(nextStatus)) {
        throw new Error(`CREATOR_REPLY_TRANSITION_REJECTED:${current.status}->${nextStatus}`);
      }
      const merged: CreatorReplyPlanRecord = {
        ...current,
        ...patch,
        replyPlanId: current.replyPlanId,
        transactionId: current.transactionId,
        updatedAt: new Date().toISOString(),
      };
      if (merged.status === "confirmed"
        && (!merged.confirmedAt
          || !merged.replyCommentId
          || !merged.verifiedInCreatorCenter)) {
        throw new Error("CREATOR_REPLY_CONFIRM_EVIDENCE_REQUIRED");
      }
      db.prepare(`
        UPDATE write_operations SET
          state=?, updated_at=?, expires_at=?, click_started_at=?,
          confirmed_at=?, reply_comment_id=?, resulting_comment_id=?,
          verified_in_creator_center=?,
          last_error=?, already_replied=?
        WHERE reply_plan_id=?
      `).run(
        merged.status,
        merged.updatedAt,
        merged.expiresAt,
        merged.clickedAt,
        merged.confirmedAt,
        merged.replyCommentId,
        merged.replyCommentId,
        merged.verifiedInCreatorCenter ? 1 : 0,
        merged.blockedReason,
        merged.alreadyReplied ? 1 : 0,
        replyPlanId,
      );
      return merged;
    });
  }

  markClickStartedIfPrepared(replyPlanId: string): {
    transitioned: boolean;
    record: CreatorReplyPlanRecord;
  } {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE write_operations
        SET state='click_started', click_started_at=?, updated_at=?, last_error=NULL
        WHERE reply_plan_id=? AND state='prepared' AND click_started_at IS NULL
      `).run(now, now, replyPlanId);
      const row = db.prepare(
        "SELECT * FROM write_operations WHERE reply_plan_id=?",
      ).get(replyPlanId) as ReplyRow | undefined;
      const record = rowToRecord(row);
      if (!record) throw new Error("REPLY_PLAN_NOT_FOUND:replyPlanId 不存在。");
      return { transitioned: Number(result.changes) === 1, record };
    });
  }
}
