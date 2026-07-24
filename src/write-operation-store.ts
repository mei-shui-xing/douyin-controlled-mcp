import { randomUUID } from "node:crypto";
import {
  getDatabase,
  sqliteWritableProbe,
  withImmediateTransaction,
} from "./sqlite.js";
import { sha256 } from "./creator-reply-store.js";
import type {
  TargetWriteAction,
  TargetWriteGate,
  TargetWriteScope,
} from "./target-write-gate.js";

export type WriteOperationState =
  | "prepared"
  | "click_started"
  | "click_attempted"
  | "click_no_effect"
  | "click_effect_confirmed"
  | "confirmed"
  | "rejected"
  | "expired"
  | "failed_before_click"
  | "unknown_after_submit"
  | "aborted_no_submit";

export type WriteOperationRecord = {
  token: string;
  operationId: string;
  operation_id: string;
  idempotencyKey: string;
  scope: TargetWriteScope;
  actionType: Extract<TargetWriteAction, "create_root_comment" | "reply_to_comment">;
  actorAccount: string;
  pageRole: TargetWriteGate["pageRole"];
  workId: string;
  workTitle: string | null;
  commentId: string | null;
  targetAuthor: string | null;
  targetText: string | null;
  targetTextHash: string | null;
  parentCommentId: string | null;
  rootCommentId: string | null;
  depth: number;
  threadPath: string[];
  writeText: string;
  writeTextHash: string;
  requestText: string;
  serverDisplayText: string | null;
  confirmationMethod:
    | "confirmed_by_server_id"
    | "confirmed_with_platform_normalization"
    | "archived_unresolved"
    | null;
  archivedAt: string | null;
  state: WriteOperationState;
  gateSnapshot: TargetWriteGate;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  clickStartedAt: string | null;
  clickAttemptedAt: string | null;
  clickEffectConfirmedAt: string | null;
  submitResponseSeenAt: string | null;
  composerClearedAt: string | null;
  clickAttemptCount: number;
  confirmedAt: string | null;
  resultingCommentId: string | null;
  lastError: string | null;
};

export type WriteExecutionAdapter =
  | "creator_center_reply"
  | "work_page_reply"
  | "work_page_root_comment";

export type AdaptiveCommentStep = {
  stepId: string;
  operationId: string;
  stepIndex: number;
  action: string;
  strategy: string | null;
  result: string;
  evidence: Record<string, unknown>;
  screenshotPath: string | null;
  diagnosticsPath: string | null;
  createdAt: string;
};

type Row = Record<string, unknown>;

const allowedWriteTransitions: Record<WriteOperationState, ReadonlySet<WriteOperationState>> = {
  prepared: new Set(["click_started", "click_attempted", "confirmed", "rejected", "expired", "failed_before_click"]),
  click_started: new Set(["confirmed", "unknown_after_submit"]),
  click_attempted: new Set(["click_no_effect", "click_effect_confirmed", "confirmed", "unknown_after_submit"]),
  click_no_effect: new Set(["click_attempted", "confirmed", "unknown_after_submit", "aborted_no_submit"]),
  click_effect_confirmed: new Set(["confirmed", "unknown_after_submit"]),
  unknown_after_submit: new Set(["confirmed", "unknown_after_submit"]),
  confirmed: new Set(["confirmed"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
  failed_before_click: new Set(["failed_before_click"]),
  aborted_no_submit: new Set(["aborted_no_submit"]),
};

function rowToRecord(row: Row | undefined): WriteOperationRecord | null {
  if (!row) return null;
  return {
    token: String(row.reply_plan_id),
    operationId: String(row.operation_id),
    operation_id: String(row.operation_id),
    idempotencyKey: String(row.idempotency_key),
    scope: String(row.scope) as TargetWriteScope,
    actionType: String(row.action_type) as WriteOperationRecord["actionType"],
    actorAccount: String(row.actor_account),
    pageRole: String(row.page_role) as TargetWriteGate["pageRole"],
    workId: String(row.work_id),
    workTitle: typeof row.work_title === "string" ? row.work_title : null,
    commentId: typeof row.comment_id === "string" && row.comment_id ? row.comment_id : null,
    targetAuthor: typeof row.target_author === "string" && row.target_author
      ? row.target_author
      : null,
    targetText: typeof row.target_text === "string" && row.target_text
      ? row.target_text
      : null,
    targetTextHash: typeof row.target_text_hash === "string" && row.target_text_hash
      ? row.target_text_hash
      : null,
    parentCommentId: typeof row.parent_comment_id === "string" ? row.parent_comment_id : null,
    rootCommentId: typeof row.root_comment_id === "string" && row.root_comment_id
      ? row.root_comment_id
      : null,
    depth: Number(row.depth ?? 0),
    threadPath: JSON.parse(String(row.thread_path_json ?? "[]")) as string[],
    writeText: String(row.reply_text),
    writeTextHash: String(row.reply_text_hash),
    requestText: typeof row.request_text === "string" && row.request_text
      ? row.request_text
      : String(row.reply_text),
    serverDisplayText: typeof row.server_display_text === "string"
      ? row.server_display_text
      : null,
    confirmationMethod: typeof row.confirmation_method === "string"
      ? row.confirmation_method as WriteOperationRecord["confirmationMethod"]
      : null,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    state: String(row.state) as WriteOperationState,
    gateSnapshot: JSON.parse(String(row.gate_snapshot_json || "{}")) as TargetWriteGate,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
    clickStartedAt: typeof row.click_started_at === "string" ? row.click_started_at : null,
    clickAttemptedAt: typeof row.click_attempted_at === "string"
      ? row.click_attempted_at
      : null,
    clickEffectConfirmedAt: typeof row.click_effect_confirmed_at === "string"
      ? row.click_effect_confirmed_at
      : null,
    submitResponseSeenAt: typeof row.submit_response_seen_at === "string"
      ? row.submit_response_seen_at
      : null,
    composerClearedAt: typeof row.composer_cleared_at === "string"
      ? row.composer_cleared_at
      : null,
    clickAttemptCount: Number(row.click_attempt_count ?? 0),
    confirmedAt: typeof row.confirmed_at === "string" ? row.confirmed_at : null,
    resultingCommentId: typeof row.resulting_comment_id === "string"
      ? row.resulting_comment_id
      : typeof row.reply_comment_id === "string"
        ? row.reply_comment_id
        : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

export function writeOperationIdempotencyKey(input: {
  actorAccount: string;
  workId: string;
  commentId?: string | null;
  writeTextHash: string;
}): string {
  return sha256([
    input.actorAccount,
    input.workId,
    input.commentId ?? "",
    input.writeTextHash,
  ].join(":"));
}

export function writeOperationTargetLockKey(input: Pick<
  WriteOperationRecord,
  "actorAccount" | "scope" | "actionType" | "workId" | "commentId"
  | "writeTextHash"
>): string {
  return [
    input.actorAccount,
    input.scope,
    input.actionType,
    input.workId,
    input.actionType === "create_root_comment"
      ? `root_text:${input.writeTextHash}`
      : input.commentId ?? "",
  ].join(":");
}

export function resolveWriteExecutionAdapter(
  operation: Pick<WriteOperationRecord, "scope" | "actionType" | "pageRole">,
): WriteExecutionAdapter {
  if (operation.actionType === "create_root_comment"
    && operation.pageRole === "root_comment_clean") {
    return "work_page_root_comment";
  }
  if (operation.actionType === "reply_to_comment"
    && operation.scope === "own_post"
    && operation.pageRole === "creator_center") {
    return "creator_center_reply";
  }
  if (operation.actionType === "reply_to_comment"
    && (
      (operation.scope === "own_post" && operation.pageRole === "operator_home")
      || (operation.scope === "bound_user_post" && operation.pageRole === "operator_home")
      || (operation.scope === "external_post" && operation.pageRole === "codex_test")
    )) {
    return "work_page_reply";
  }
  throw new Error(
    "ROUTE_INVARIANT_FAILED:"
    + `scope=${operation.scope},action_type=${operation.actionType},page_role=${operation.pageRole}`,
  );
}

export class WriteOperationStore {
  health(): { writable: boolean; error: string | null } {
    return sqliteWritableProbe();
  }

  create(input: {
    scope: TargetWriteScope;
    actionType: WriteOperationRecord["actionType"];
    actorAccount: string;
    pageRole: TargetWriteGate["pageRole"];
    workId: string;
    workTitle: string | null;
    commentId?: string | null;
    targetAuthor?: string | null;
    targetText?: string | null;
    targetTextHash?: string | null;
    parentCommentId?: string | null;
    rootCommentId?: string | null;
    depth?: number;
    threadPath?: string[];
    writeText: string;
    gateSnapshot: TargetWriteGate;
    expiresAt: string;
  }): WriteOperationRecord {
    const writeTextHash = sha256(input.writeText);
    const idempotencyKey = writeOperationIdempotencyKey({
      actorAccount: input.actorAccount,
      workId: input.workId,
      commentId: input.commentId,
      writeTextHash,
    });
    const existing = this.getByIdempotencyKey(idempotencyKey);
    const target = {
      actorAccount: input.actorAccount,
      scope: input.scope,
      actionType: input.actionType,
      workId: input.workId,
      commentId: input.commentId ?? null,
      writeTextHash,
    };
    this.assertNoActiveConflict(target, existing?.operationId);
    const existingPreparedExpired = existing?.state === "prepared"
      && Date.parse(existing.expiresAt) <= Date.now();
    const canReprepare = Boolean(existing && (
      existing.state === "aborted_no_submit"
      || existing.state === "click_no_effect"
      || existing.state === "expired"
      || existing.state === "failed_before_click"
      || existingPreparedExpired
    ));
    if (existing && !canReprepare) {
      return existing;
    }
    if (existing) {
      return withImmediateTransaction(db => {
        this.assertNoActiveConflict(target, existing.operationId);
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE write_operations SET
            scope=?, action_type=?, actor_account=?, page_role=?,
            work_id=?, work_title=?, comment_id=?, target_author=?,
            target_text=?, target_text_hash=?, parent_comment_id=?,
            root_comment_id=?, depth=?, thread_path_json=?, reply_text=?,
            reply_text_hash=?, request_text=?, server_display_text=NULL,
            confirmation_method=NULL, archived_at=NULL,
            snapshot_id=?, gate_snapshot_json=?,
            state='prepared', updated_at=?, expires_at=?,
            click_started_at=NULL, click_attempted_at=NULL,
            click_effect_confirmed_at=NULL, submit_response_seen_at=NULL,
            composer_cleared_at=NULL, confirmed_at=NULL,
            reply_comment_id=NULL, resulting_comment_id=NULL,
            last_error='reprepared_after_verified_no_submit'
          WHERE reply_plan_id=?
            AND (
              state IN (
                'aborted_no_submit',
                'click_no_effect',
                'expired',
                'failed_before_click'
              )
              OR (state='prepared' AND expires_at<=?)
            )
        `).run(
          input.scope,
          input.actionType,
          input.actorAccount,
          input.pageRole,
          input.workId,
          input.workTitle,
          input.commentId ?? "",
          input.targetAuthor ?? "",
          input.targetText ?? "",
          input.targetTextHash ?? "",
          input.parentCommentId ?? null,
          input.rootCommentId ?? "",
          input.depth ?? 0,
          JSON.stringify(input.threadPath ?? []),
          input.writeText,
          writeTextHash,
          input.writeText,
          sha256(JSON.stringify(input.gateSnapshot)).slice(0, 24),
          JSON.stringify(input.gateSnapshot),
          now,
          input.expiresAt,
          existing.token,
          now,
        );
        const reprepared = this.get(existing.token);
        if (!reprepared) {
          throw new Error("WRITE_OPERATION_REPREPARE_FAILED:无法重新准备已确认未发送的事务。");
        }
        return reprepared;
      });
    }
    return withImmediateTransaction(db => {
      this.assertNoActiveConflict(target);
      const now = new Date().toISOString();
      const token = randomUUID();
      const operationId = randomUUID();
      db.prepare(`
        INSERT INTO write_operations(
          operation_id, reply_plan_id, idempotency_key,
          scope, action_type, actor_account, page_role,
          work_id, work_title, comment_id, target_author, target_text,
          target_text_hash, parent_comment_id, root_comment_id, depth,
          thread_path_json, already_replied, reply_text, reply_text_hash,
          request_text,
          snapshot_id, target_source, filter_keyword, gate_snapshot_json,
          state, created_at, updated_at, expires_at, click_started_at,
          confirmed_at, reply_comment_id, resulting_comment_id,
          verified_in_creator_center, last_error
        ) VALUES(
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, 0, ?, ?, ?,
          ?, 'target_gate', NULL, ?,
          'prepared', ?, ?, ?, NULL,
          NULL, NULL, NULL,
          0, NULL
        )
      `).run(
        operationId,
        token,
        idempotencyKey,
        input.scope,
        input.actionType,
        input.actorAccount,
        input.pageRole,
        input.workId,
        input.workTitle,
        input.commentId ?? "",
        input.targetAuthor ?? "",
        input.targetText ?? "",
        input.targetTextHash ?? "",
        input.parentCommentId ?? null,
        input.rootCommentId ?? "",
        input.depth ?? 0,
        JSON.stringify(input.threadPath ?? []),
        input.writeText,
        writeTextHash,
        input.writeText,
        sha256(JSON.stringify(input.gateSnapshot)).slice(0, 24),
        JSON.stringify(input.gateSnapshot),
        now,
        now,
        input.expiresAt,
      );
      const created = this.get(token);
      if (!created) throw new Error("WRITE_OPERATION_CREATE_FAILED:事务持久化后无法回读。");
      return created;
    });
  }

  get(tokenOrOperationId: string): WriteOperationRecord | null {
    return rowToRecord(getDatabase().prepare(`
      SELECT * FROM write_operations
      WHERE reply_plan_id=? OR operation_id=?
    `).get(tokenOrOperationId, tokenOrOperationId) as Row | undefined);
  }

  getByIdempotencyKey(key: string): WriteOperationRecord | null {
    return rowToRecord(getDatabase().prepare(
      "SELECT * FROM write_operations WHERE idempotency_key=?",
    ).get(key) as Row | undefined);
  }

  listRecoverableGeneral(): WriteOperationRecord[] {
    return (getDatabase().prepare(`
      SELECT * FROM write_operations
      WHERE state IN (
        'prepared',
        'click_started',
        'click_attempted',
        'click_effect_confirmed',
        'unknown_after_submit'
      )
        AND archived_at IS NULL
        AND NOT (
          scope='own_post' AND action_type='reply_to_comment'
          AND page_role='creator_center'
        )
      ORDER BY created_at ASC
    `).all() as Row[])
      .map(rowToRecord)
      .filter((record): record is WriteOperationRecord => Boolean(record));
  }

  listUnresolvedGeneral(): WriteOperationRecord[] {
    return this.listRecoverableGeneral()
      .filter(record =>
        record.state === "click_started"
        || record.state === "click_attempted"
        || record.state === "click_effect_confirmed"
        || record.state === "unknown_after_submit");
  }

  findUnresolvedConflict(
    target: Pick<
      WriteOperationRecord,
      "actorAccount" | "scope" | "actionType" | "workId" | "commentId"
      | "writeTextHash"
    >,
    excludeOperationId?: string,
  ): WriteOperationRecord | null {
    const targetKey = writeOperationTargetLockKey(target);
    return this.listActiveTargetOperations().find(operation =>
      operation.operationId !== excludeOperationId
      && writeOperationTargetLockKey(operation) === targetKey) ?? null;
  }

  private listActiveTargetOperations(): WriteOperationRecord[] {
    return (getDatabase().prepare(`
      SELECT * FROM write_operations
      WHERE state IN (
        'prepared',
        'click_started',
        'click_attempted',
        'click_effect_confirmed',
        'unknown_after_submit'
      )
        AND archived_at IS NULL
      ORDER BY created_at ASC
    `).all() as Row[])
      .map(rowToRecord)
      .filter((record): record is WriteOperationRecord => Boolean(record));
  }

  private assertNoActiveConflict(
    target: Pick<
      WriteOperationRecord,
      "actorAccount" | "scope" | "actionType" | "workId" | "commentId"
      | "writeTextHash"
    >,
    excludeOperationId?: string,
  ): void {
    const conflict = this.findUnresolvedConflict(target, excludeOperationId);
    if (!conflict) return;
    throw new Error(
      `TARGET_WRITE_CONFLICT:operation_id=${conflict.operationId};`
      + `target_lock=${writeOperationTargetLockKey(conflict)};`
      + `state=${conflict.state}`,
    );
  }

  assertNoUnresolvedConflict(
    target: Pick<
      WriteOperationRecord,
      "actorAccount" | "scope" | "actionType" | "workId" | "commentId"
      | "writeTextHash"
    >,
    excludeOperationId?: string,
  ): void {
    const conflict = this.findUnresolvedConflict(target, excludeOperationId);
    if (!conflict) return;
    throw new Error(
      `TARGET_WRITE_CONFLICT:operation_id=${conflict.operationId};`
      + `target_lock=${writeOperationTargetLockKey(conflict)};`
      + `state=${conflict.state}`,
    );
  }

  update(
    token: string,
    patch: Partial<Pick<WriteOperationRecord,
      "state" | "expiresAt" | "clickStartedAt" | "clickAttemptedAt"
      | "clickEffectConfirmedAt" | "submitResponseSeenAt" | "composerClearedAt"
      | "clickAttemptCount" | "confirmedAt"
      | "resultingCommentId" | "lastError" | "serverDisplayText"
      | "confirmationMethod" | "archivedAt">>,
  ): WriteOperationRecord {
    return withImmediateTransaction(db => {
      const current = this.get(token);
      if (!current) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
      const nextState = patch.state ?? current.state;
      if (nextState !== current.state
        && !allowedWriteTransitions[current.state].has(nextState)) {
        throw new Error(
          `WRITE_OPERATION_TRANSITION_REJECTED:${current.state}->${nextState}`,
        );
      }
      const merged = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      if (merged.state === "confirmed"
        && (!merged.confirmedAt || !merged.resultingCommentId)) {
        throw new Error("WRITE_OPERATION_CONFIRM_EVIDENCE_REQUIRED");
      }
      if (merged.state === "aborted_no_submit"
        && (merged.clickEffectConfirmedAt
          || merged.submitResponseSeenAt
          || merged.composerClearedAt
          || merged.resultingCommentId)) {
        throw new Error("WRITE_OPERATION_ABORT_POSITIVE_EVIDENCE_PRESENT");
      }
      db.prepare(`
        UPDATE write_operations SET
          state=?, updated_at=?, expires_at=?, click_started_at=?,
          click_attempted_at=?, click_effect_confirmed_at=?,
          submit_response_seen_at=?, composer_cleared_at=?,
          click_attempt_count=?, confirmed_at=?, reply_comment_id=?,
          resulting_comment_id=?, server_display_text=?,
          confirmation_method=?, archived_at=?, last_error=?
        WHERE reply_plan_id=?
      `).run(
        merged.state,
        merged.updatedAt,
        merged.expiresAt,
        merged.clickStartedAt,
        merged.clickAttemptedAt,
        merged.clickEffectConfirmedAt,
        merged.submitResponseSeenAt,
        merged.composerClearedAt,
        merged.clickAttemptCount,
        merged.confirmedAt,
        merged.resultingCommentId,
        merged.resultingCommentId,
        merged.serverDisplayText,
        merged.confirmationMethod,
        merged.archivedAt,
        merged.lastError,
        current.token,
      );
      const updated = this.get(current.token);
      if (!updated) throw new Error("WRITE_OPERATION_UPDATE_FAILED:更新后无法回读。");
      return updated;
    });
  }

  markClickStartedIfPrepared(token: string): {
    transitioned: boolean;
    record: WriteOperationRecord;
  } {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE write_operations
        SET state='click_started', click_started_at=?, updated_at=?, last_error=NULL
        WHERE reply_plan_id=? AND state='prepared' AND click_started_at IS NULL
      `).run(now, now, token);
      const record = this.get(token);
      if (!record) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
      return { transitioned: Number(result.changes) === 1, record };
    });
  }

  markClickAttemptedIfPrepared(token: string): {
    transitioned: boolean;
    record: WriteOperationRecord;
  } {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE write_operations
        SET state='click_attempted', click_attempted_at=?, updated_at=?,
            click_attempt_count=click_attempt_count+1,
            click_started_at=NULL, click_effect_confirmed_at=NULL,
            submit_response_seen_at=NULL, composer_cleared_at=NULL,
            last_error=NULL
        WHERE reply_plan_id=? AND state='prepared'
          AND click_attempted_at IS NULL
          AND click_effect_confirmed_at IS NULL
      `).run(now, now, token);
      const record = this.get(token);
      if (!record) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
      return { transitioned: Number(result.changes) === 1, record };
    });
  }

  markClickEffectConfirmed(
    token: string,
    evidence: {
      submitResponseSeenAt?: string | null;
      composerClearedAt?: string | null;
    },
  ): WriteOperationRecord {
    const now = new Date().toISOString();
    return this.update(token, {
      state: "click_effect_confirmed",
      clickStartedAt: now,
      clickEffectConfirmedAt: now,
      submitResponseSeenAt: evidence.submitResponseSeenAt ?? null,
      composerClearedAt: evidence.composerClearedAt ?? null,
      lastError: null,
    });
  }

  markClickNoEffect(token: string, reason = "click_no_effect"): WriteOperationRecord {
    return this.update(token, {
      state: "click_no_effect",
      clickStartedAt: null,
      clickEffectConfirmedAt: null,
      submitResponseSeenAt: null,
      composerClearedAt: null,
      lastError: reason,
    });
  }

  beginAdaptiveAttempt(
    tokenOrOperationId: string,
    strategy: string,
    maxAttempts = 3,
  ): WriteOperationRecord {
    return withImmediateTransaction(db => {
      const current = this.get(tokenOrOperationId);
      if (!current) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
      if (current.actionType !== "create_root_comment") {
        throw new Error("ADAPTIVE_NOT_ALLOWED:仅支持主评论事务。");
      }
      if (current.state !== "click_no_effect") {
        throw new Error(`ADAPTIVE_NOT_READY:state=${current.state}`);
      }
      if (current.clickEffectConfirmedAt
        || current.submitResponseSeenAt
        || current.composerClearedAt
        || current.resultingCommentId) {
        throw new Error("ADAPTIVE_UNSAFE:已有可能提交的效果证据，只能只读回查。");
      }
      if (current.clickAttemptCount >= maxAttempts) {
        throw new Error(
          `ADAPTIVE_ATTEMPT_LIMIT:attempts=${current.clickAttemptCount},max=${maxAttempts}`,
        );
      }
      const now = new Date().toISOString();
      const transition = db.prepare(`
        UPDATE write_operations
        SET state='click_attempted', click_attempted_at=?, updated_at=?,
            click_attempt_count=click_attempt_count+1,
            last_error=?
        WHERE operation_id=? AND state='click_no_effect'
          AND click_effect_confirmed_at IS NULL
          AND submit_response_seen_at IS NULL
          AND composer_cleared_at IS NULL
          AND resulting_comment_id IS NULL
          AND click_attempt_count<?
      `).run(
        now,
        now,
        `adaptive_attempt_started:${strategy}`,
        current.operationId,
        maxAttempts,
      );
      if (Number(transition.changes) !== 1) {
        throw new Error("ADAPTIVE_TRANSITION_FAILED:事务状态已变化。");
      }
      const updated = this.get(current.operationId);
      if (!updated) throw new Error("WRITE_OPERATION_NOT_FOUND:更新后事务不存在。");
      return updated;
    });
  }

  appendAdaptiveStep(input: {
    operationId: string;
    action: string;
    strategy?: string | null;
    result: string;
    evidence?: Record<string, unknown>;
    screenshotPath?: string | null;
    diagnosticsPath?: string | null;
  }): AdaptiveCommentStep {
    return withImmediateTransaction(db => {
      const operation = this.get(input.operationId);
      if (!operation) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
      const next = db.prepare(`
        SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index
        FROM adaptive_comment_steps WHERE operation_id=?
      `).get(operation.operationId) as { next_index?: number | bigint };
      const stepIndex = Number(next.next_index ?? 1);
      const stepId = randomUUID();
      const createdAt = new Date().toISOString();
      const evidence = input.evidence ?? {};
      db.prepare(`
        INSERT INTO adaptive_comment_steps(
          step_id, operation_id, step_index, action, strategy, result,
          evidence_json, screenshot_path, diagnostics_path, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stepId,
        operation.operationId,
        stepIndex,
        input.action,
        input.strategy ?? null,
        input.result,
        JSON.stringify(evidence),
        input.screenshotPath ?? null,
        input.diagnosticsPath ?? null,
        createdAt,
      );
      return {
        stepId,
        operationId: operation.operationId,
        stepIndex,
        action: input.action,
        strategy: input.strategy ?? null,
        result: input.result,
        evidence,
        screenshotPath: input.screenshotPath ?? null,
        diagnosticsPath: input.diagnosticsPath ?? null,
        createdAt,
      };
    });
  }

  listAdaptiveSteps(operationId: string): AdaptiveCommentStep[] {
    return (getDatabase().prepare(`
      SELECT * FROM adaptive_comment_steps
      WHERE operation_id=? ORDER BY step_index ASC
    `).all(operationId) as Row[]).map(row => ({
      stepId: String(row.step_id),
      operationId: String(row.operation_id),
      stepIndex: Number(row.step_index),
      action: String(row.action),
      strategy: typeof row.strategy === "string" ? row.strategy : null,
      result: String(row.result),
      evidence: (() => {
        try {
          return JSON.parse(String(row.evidence_json ?? "{}")) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      screenshotPath: typeof row.screenshot_path === "string"
        ? row.screenshot_path
        : null,
      diagnosticsPath: typeof row.diagnostics_path === "string"
        ? row.diagnostics_path
        : null,
      createdAt: String(row.created_at),
    }));
  }

  abortNoSubmit(token: string, reason: string): WriteOperationRecord {
    const current = this.get(token);
    if (!current) throw new Error("WRITE_OPERATION_NOT_FOUND:事务不存在。");
    if (current.state !== "click_no_effect") {
      throw new Error(`ABORT_NOT_ALLOWED:state=${current.state}`);
    }
    if (current.clickEffectConfirmedAt
      || current.submitResponseSeenAt
      || current.composerClearedAt
      || current.resultingCommentId) {
      throw new Error("ABORT_UNSAFE:positive_submit_evidence_present");
    }
    return this.update(token, {
      state: "aborted_no_submit",
      clickStartedAt: null,
      clickAttemptedAt: current.clickAttemptedAt ?? current.clickStartedAt,
      clickEffectConfirmedAt: null,
      submitResponseSeenAt: null,
      composerClearedAt: null,
      resultingCommentId: null,
      lastError: reason,
    });
  }

  archiveUnresolved(tokenOrOperationId: string, reason: string): WriteOperationRecord {
    const current = this.get(tokenOrOperationId);
    if (!current) throw new Error("WRITE_OPERATION_NOT_FOUND");
    if (current.state !== "unknown_after_submit") {
      throw new Error("ARCHIVE_UNRESOLVED_NOT_ALLOWED:state=" + current.state);
    }
    if (current.archivedAt) return current;
    return this.update(current.token, {
      confirmationMethod: "archived_unresolved",
      archivedAt: new Date().toISOString(),
      lastError: "archived_unresolved:" + reason,
    });
  }
}
