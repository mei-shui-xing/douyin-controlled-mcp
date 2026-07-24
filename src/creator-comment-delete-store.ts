import { randomUUID } from "node:crypto";
import {
  getDatabase,
  sqliteWritableProbe,
  withImmediateTransaction,
} from "./sqlite.js";
import { sha256 } from "./creator-reply-store.js";

export type CreatorCommentDeleteState =
  | "prepared"
  | "delete_started"
  | "confirmed"
  | "unknown_after_submit"
  | "failed_before_click"
  | "rejected"
  | "expired";

export type CreatorCommentDeleteOperation = {
  operationId: string;
  operation_id: string;
  token: string;
  idempotencyKey: string;
  actorAccount: string;
  workId: string;
  commentId: string;
  targetAuthor: string;
  targetText: string;
  targetTextHash: string;
  parentCommentId: string | null;
  rootCommentId: string;
  state: CreatorCommentDeleteState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  deleteStartedAt: string | null;
  confirmedAt: string | null;
  lastError: string | null;
};

type Row = Record<string, unknown>;

const allowedDeleteTransitions: Record<
  CreatorCommentDeleteState,
  ReadonlySet<CreatorCommentDeleteState>
> = {
  prepared: new Set(["delete_started", "rejected", "expired", "failed_before_click"]),
  delete_started: new Set(["confirmed", "unknown_after_submit"]),
  unknown_after_submit: new Set(["confirmed", "unknown_after_submit"]),
  confirmed: new Set(["confirmed"]),
  failed_before_click: new Set(["failed_before_click"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
};

function rowToOperation(row: Row | undefined): CreatorCommentDeleteOperation | null {
  if (!row) return null;
  const operationId = String(row.operation_id);
  return {
    operationId,
    operation_id: operationId,
    token: String(row.token),
    idempotencyKey: String(row.idempotency_key),
    actorAccount: String(row.actor_account),
    workId: String(row.work_id),
    commentId: String(row.comment_id),
    targetAuthor: String(row.target_author),
    targetText: String(row.target_text),
    targetTextHash: String(row.target_text_hash),
    parentCommentId: typeof row.parent_comment_id === "string"
      && row.parent_comment_id
      ? row.parent_comment_id
      : null,
    rootCommentId: String(row.root_comment_id),
    state: String(row.state) as CreatorCommentDeleteState,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
    deleteStartedAt: typeof row.delete_started_at === "string"
      ? row.delete_started_at
      : null,
    confirmedAt: typeof row.confirmed_at === "string"
      ? row.confirmed_at
      : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

export function creatorCommentDeleteIdempotencyKey(input: {
  actorAccount: string;
  workId: string;
  commentId: string;
  targetTextHash: string;
}): string {
  return sha256([
    input.actorAccount,
    input.workId,
    input.commentId,
    input.targetTextHash,
    "delete_creator_comment",
  ].join(":"));
}

export class CreatorCommentDeleteStore {
  health(): { writable: boolean; error: string | null } {
    return sqliteWritableProbe();
  }

  create(input: {
    actorAccount: string;
    workId: string;
    commentId: string;
    targetAuthor: string;
    targetText: string;
    targetTextHash: string;
    parentCommentId: string | null;
    rootCommentId: string;
    expiresAt: string;
  }): CreatorCommentDeleteOperation {
    const idempotencyKey = creatorCommentDeleteIdempotencyKey(input);
    const existing = this.getByIdempotencyKey(idempotencyKey);
    if (existing && (
      existing.state === "confirmed"
      || existing.state === "delete_started"
      || existing.state === "unknown_after_submit"
      || (existing.state === "prepared"
        && Date.parse(existing.expiresAt) > Date.now())
    )) {
      return existing;
    }
    const now = new Date().toISOString();
    const operationId = randomUUID();
    const token = randomUUID();
    return withImmediateTransaction(db => {
      if (existing) {
        db.prepare(`
          UPDATE creator_comment_delete_operations
          SET operation_id=?, token=?, state='prepared', created_at=?,
              updated_at=?, expires_at=?, delete_started_at=NULL,
              confirmed_at=NULL, last_error=NULL
          WHERE idempotency_key=?
        `).run(operationId, token, now, now, input.expiresAt, idempotencyKey);
      } else {
        db.prepare(`
          INSERT INTO creator_comment_delete_operations(
            operation_id, token, idempotency_key, actor_account,
            work_id, comment_id, target_author, target_text,
            target_text_hash, parent_comment_id, root_comment_id,
            state, created_at, updated_at, expires_at,
            delete_started_at, confirmed_at, last_error
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared',
            ?, ?, ?, NULL, NULL, NULL)
        `).run(
          operationId,
          token,
          idempotencyKey,
          input.actorAccount,
          input.workId,
          input.commentId,
          input.targetAuthor,
          input.targetText,
          input.targetTextHash,
          input.parentCommentId,
          input.rootCommentId,
          now,
          now,
          input.expiresAt,
        );
      }
      return this.require(operationId);
    });
  }

  get(reference: string): CreatorCommentDeleteOperation | null {
    return rowToOperation(getDatabase().prepare(`
      SELECT * FROM creator_comment_delete_operations
      WHERE operation_id=? OR token=?
      LIMIT 1
    `).get(reference, reference) as Row | undefined);
  }

  getByIdempotencyKey(key: string): CreatorCommentDeleteOperation | null {
    return rowToOperation(getDatabase().prepare(`
      SELECT * FROM creator_comment_delete_operations
      WHERE idempotency_key=?
      LIMIT 1
    `).get(key) as Row | undefined);
  }

  require(reference: string): CreatorCommentDeleteOperation {
    const operation = this.get(reference);
    if (!operation) throw new Error(`DELETE_OPERATION_NOT_FOUND:${reference}`);
    return operation;
  }

  claimDeleteStarted(reference: string): CreatorCommentDeleteOperation {
    return withImmediateTransaction(db => {
      const operation = rowToOperation(db.prepare(`
        SELECT * FROM creator_comment_delete_operations
        WHERE operation_id=? OR token=?
        LIMIT 1
      `).get(reference, reference) as Row | undefined);
      if (!operation) throw new Error(`DELETE_OPERATION_NOT_FOUND:${reference}`);
      if (operation.state === "confirmed") return operation;
      if (operation.state === "delete_started"
        || operation.state === "unknown_after_submit") {
        throw new Error(
          `DELETE_RETRY_BLOCKED:operation_id=${operation.operationId};state=${operation.state}`,
        );
      }
      if (operation.state !== "prepared") {
        throw new Error(
          `DELETE_OPERATION_NOT_PREPARED:operation_id=${operation.operationId};state=${operation.state}`,
        );
      }
      const now = new Date().toISOString();
      if (Date.parse(operation.expiresAt) <= Date.now()) {
        db.prepare(`
          UPDATE creator_comment_delete_operations
          SET state='expired', updated_at=?, last_error='prepare_expired'
          WHERE operation_id=?
        `).run(now, operation.operationId);
        throw new Error(`DELETE_OPERATION_EXPIRED:${operation.operationId}`);
      }
      const changed = db.prepare(`
        UPDATE creator_comment_delete_operations
        SET state='delete_started', delete_started_at=?,
            updated_at=?, last_error=NULL
        WHERE operation_id=? AND state='prepared'
      `).run(now, now, operation.operationId);
      if (Number(changed.changes) !== 1) {
        throw new Error(`DELETE_CLAIM_CONFLICT:${operation.operationId}`);
      }
      return this.require(operation.operationId);
    });
  }

  update(
    reference: string,
    patch: {
      state: CreatorCommentDeleteState;
      confirmedAt?: string | null;
      lastError?: string | null;
    },
  ): CreatorCommentDeleteOperation {
    return withImmediateTransaction(db => {
      const operation = this.require(reference);
      if (patch.state !== operation.state
        && !allowedDeleteTransitions[operation.state].has(patch.state)) {
        throw new Error(
          `DELETE_OPERATION_TRANSITION_REJECTED:${operation.state}->${patch.state}`,
        );
      }
      const now = new Date().toISOString();
      const confirmedAt = patch.confirmedAt === undefined
        ? operation.confirmedAt
        : patch.confirmedAt;
      if (patch.state === "confirmed" && !confirmedAt) {
        throw new Error("DELETE_CONFIRM_EVIDENCE_REQUIRED");
      }
      db.prepare(`
        UPDATE creator_comment_delete_operations
        SET state=?, updated_at=?, confirmed_at=?, last_error=?
        WHERE operation_id=?
      `).run(
        patch.state,
        now,
        confirmedAt,
        patch.lastError === undefined ? operation.lastError : patch.lastError,
        operation.operationId,
      );
      return this.require(operation.operationId);
    });
  }

  listUnresolvedAfterSubmit(): CreatorCommentDeleteOperation[] {
    return (getDatabase().prepare(`
      SELECT * FROM creator_comment_delete_operations
      WHERE state IN ('delete_started', 'unknown_after_submit')
      ORDER BY updated_at ASC
    `).all() as Row[])
      .map(row => rowToOperation(row))
      .filter((value): value is CreatorCommentDeleteOperation => Boolean(value));
  }
}
