import { randomUUID } from "node:crypto";
import { getDatabase, sqliteWritableProbe, withImmediateTransaction } from "./sqlite.js";
import { sha256 } from "./creator-reply-store.js";

export type SocialOperationState =
  | "prepared"
  | "click_started"
  | "confirmed"
  | "unknown_after_submit"
  | "failed_before_click"
  | "rejected";

export type SocialOperationRecord = {
  operationId: string;
  idempotencyKey: string;
  actionKind: "message" | "share" | "safe_social";
  actorAccount: string;
  boundAlias: string;
  targetUid: string;
  conversationId: string;
  targetContextHash: string;
  payloadHash: string;
  workId: string | null;
  actionKey: string | null;
  state: SocialOperationState;
  createdAt: string;
  updatedAt: string;
  clickStartedAt: string | null;
  confirmedAt: string | null;
  resultingMessageId: string | null;
  evidence: Record<string, unknown>;
  lastError: string | null;
};

type Row = Record<string, unknown>;

function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToRecord(row: Row | undefined): SocialOperationRecord | null {
  if (!row) return null;
  return {
    operationId: String(row.operation_id),
    idempotencyKey: String(row.idempotency_key),
    actionKind: String(row.action_kind) as SocialOperationRecord["actionKind"],
    actorAccount: String(row.actor_account),
    boundAlias: String(row.bound_alias),
    targetUid: String(row.target_uid),
    conversationId: String(row.conversation_id),
    targetContextHash: String(row.target_context_hash),
    payloadHash: String(row.payload_hash),
    workId: typeof row.work_id === "string" && row.work_id ? row.work_id : null,
    actionKey: typeof row.action_key === "string" && row.action_key ? row.action_key : null,
    state: String(row.state) as SocialOperationState,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clickStartedAt: typeof row.click_started_at === "string" ? row.click_started_at : null,
    confirmedAt: typeof row.confirmed_at === "string" ? row.confirmed_at : null,
    resultingMessageId: typeof row.resulting_message_id === "string"
      ? row.resulting_message_id
      : null,
    evidence: parseEvidence(row.evidence_json),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

const allowedTransitions: Record<SocialOperationState, ReadonlySet<SocialOperationState>> = {
  prepared: new Set(["click_started", "failed_before_click", "rejected"]),
  click_started: new Set(["confirmed", "unknown_after_submit"]),
  unknown_after_submit: new Set(["confirmed", "unknown_after_submit"]),
  confirmed: new Set(["confirmed"]),
  failed_before_click: new Set(["failed_before_click"]),
  rejected: new Set(["rejected"]),
};

export class SocialOperationStore {
  health(): { writable: boolean; error: string | null } {
    return sqliteWritableProbe();
  }

  prepare(input: {
    actionKind: SocialOperationRecord["actionKind"];
    actorAccount: string;
    boundAlias: string;
    targetUid: string;
    conversationId: string;
    targetContextHash: string;
    payloadHash: string;
    workId?: string | null;
    actionKey?: string | null;
    evidence?: Record<string, unknown>;
  }): SocialOperationRecord {
    const idempotencyKey = sha256([
      input.actionKind,
      input.actorAccount,
      input.boundAlias,
      input.targetUid,
      input.conversationId,
      input.targetContextHash,
      input.payloadHash,
      input.workId ?? "",
      input.actionKey ?? "",
    ].join(":"));
    return withImmediateTransaction(db => {
      const existing = rowToRecord(db.prepare(`
        SELECT * FROM social_operations WHERE idempotency_key=? LIMIT 1
      `).get(idempotencyKey) as Row | undefined);
      if (existing && ["prepared", "click_started", "confirmed", "unknown_after_submit"]
        .includes(existing.state)) {
        return existing;
      }
      const now = new Date().toISOString();
      const operationId = randomUUID();
      db.prepare(`
        INSERT INTO social_operations(
          operation_id, idempotency_key, action_kind, actor_account,
          bound_alias, target_uid, conversation_id, target_context_hash,
          payload_hash, work_id, action_key, state, created_at, updated_at,
          click_started_at, confirmed_at, resulting_message_id,
          evidence_json, last_error
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?,
          NULL, NULL, NULL, ?, NULL)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          operation_id=excluded.operation_id,
          state='prepared',
          created_at=excluded.created_at,
          updated_at=excluded.updated_at,
          click_started_at=NULL,
          confirmed_at=NULL,
          resulting_message_id=NULL,
          evidence_json=excluded.evidence_json,
          last_error=NULL
      `).run(
        operationId,
        idempotencyKey,
        input.actionKind,
        input.actorAccount,
        input.boundAlias,
        input.targetUid,
        input.conversationId,
        input.targetContextHash,
        input.payloadHash,
        input.workId ?? null,
        input.actionKey ?? null,
        now,
        now,
        JSON.stringify(input.evidence ?? {}),
      );
      return this.require(operationId);
    });
  }

  get(reference: string): SocialOperationRecord | null {
    return rowToRecord(getDatabase().prepare(`
      SELECT * FROM social_operations
      WHERE operation_id=? OR idempotency_key=? LIMIT 1
    `).get(reference, reference) as Row | undefined);
  }

  require(reference: string): SocialOperationRecord {
    const operation = this.get(reference);
    if (!operation) throw new Error(`SOCIAL_OPERATION_NOT_FOUND:${reference}`);
    return operation;
  }

  claim(reference: string): SocialOperationRecord {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const changed = db.prepare(`
        UPDATE social_operations
        SET state='click_started', click_started_at=?, updated_at=?, last_error=NULL
        WHERE operation_id=? AND state='prepared' AND click_started_at IS NULL
      `).run(now, now, reference);
      const operation = this.require(reference);
      if (Number(changed.changes) !== 1) {
        throw new Error(`SOCIAL_RETRY_BLOCKED:operation_id=${reference};state=${operation.state}`);
      }
      return operation;
    });
  }

  update(reference: string, input: {
    state: SocialOperationState;
    resultingMessageId?: string | null;
    evidence?: Record<string, unknown>;
    lastError?: string | null;
  }): SocialOperationRecord {
    return withImmediateTransaction(db => {
      const current = this.require(reference);
      if (input.state !== current.state
        && !allowedTransitions[current.state].has(input.state)) {
        throw new Error(`SOCIAL_TRANSITION_REJECTED:${current.state}->${input.state}`);
      }
      const now = new Date().toISOString();
      const resultingMessageId = input.resultingMessageId === undefined
        ? current.resultingMessageId
        : input.resultingMessageId;
      const confirmedAt = input.state === "confirmed" ? now : current.confirmedAt;
      if (input.state === "confirmed"
        && current.actionKind === "message"
        && !resultingMessageId) {
        throw new Error("SOCIAL_MESSAGE_CONFIRM_EVIDENCE_REQUIRED");
      }
      db.prepare(`
        UPDATE social_operations SET
          state=?, updated_at=?, confirmed_at=?, resulting_message_id=?,
          evidence_json=?, last_error=?
        WHERE operation_id=?
      `).run(
        input.state,
        now,
        confirmedAt,
        resultingMessageId,
        JSON.stringify(input.evidence ?? current.evidence),
        input.lastError === undefined ? current.lastError : input.lastError,
        current.operationId,
      );
      return this.require(current.operationId);
    });
  }

  listUnresolved(): SocialOperationRecord[] {
    return (getDatabase().prepare(`
      SELECT * FROM social_operations
      WHERE state IN ('click_started', 'unknown_after_submit')
      ORDER BY updated_at ASC
    `).all() as Row[])
      .map(rowToRecord)
      .filter((value): value is SocialOperationRecord => Boolean(value));
  }
}
