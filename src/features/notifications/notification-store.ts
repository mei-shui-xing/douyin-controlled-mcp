import { createHash, randomUUID } from "node:crypto";
import { getDatabase, withImmediateTransaction } from "../../sqlite.js";
import type { NotificationFilter, NotificationItem } from "./notification-parsing.js";

type NotificationRow = Record<string, unknown>;

export type NotificationCheckpoint = {
  filter: NotificationFilter;
  acknowledgedCount: number;
  lastAcknowledgedAt: string | null;
};

export type NotificationCheckpointCandidate = {
  candidate: string;
  filter: NotificationFilter;
  noticeIds: string[];
  digest: string;
  createdAt: string;
  expiresAt: string;
};

const cleanSnapshot = (item: NotificationItem): NotificationItem => ({
  ...item,
  work: { ...item.work, url: item.work.url },
});

function parseSnapshot(row: NotificationRow): NotificationItem {
  return JSON.parse(String(row.snapshot_json)) as NotificationItem;
}

export class NotificationStore {
  upsert(items: NotificationItem[]): void {
    if (!items.length) return;
    withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO notification_records(
          notice_id,notice_type,interact_type,filter_type,actor_uid,actor_sec_uid,
          work_id,comment_id,observed_at,source_created_at,availability,parse_version,
          acknowledged_at,last_error,snapshot_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
        ON CONFLICT(notice_id) DO UPDATE SET
          notice_type=excluded.notice_type,
          interact_type=excluded.interact_type,
          filter_type=excluded.filter_type,
          actor_uid=excluded.actor_uid,
          actor_sec_uid=excluded.actor_sec_uid,
          work_id=excluded.work_id,
          comment_id=excluded.comment_id,
          observed_at=excluded.observed_at,
          source_created_at=excluded.source_created_at,
          availability=excluded.availability,
          parse_version=excluded.parse_version,
          last_error=NULL,
          snapshot_json=excluded.snapshot_json
      `);
      for (const item of items) {
        statement.run(
          item.noticeId,
          item.noticeType,
          item.interactType,
          item.filterType,
          item.actor.uid,
          item.actor.secUid,
          item.work.workId,
          item.comment.commentId,
          now,
          item.createdAt,
          item.work.availability,
          item.parseVersion,
          JSON.stringify(cleanSnapshot(item)),
        );
      }
    });
  }

  get(noticeId: string): NotificationItem | null {
    const row = getDatabase().prepare(
      "SELECT snapshot_json FROM notification_records WHERE notice_id=?",
    ).get(noticeId) as NotificationRow | undefined;
    return row ? parseSnapshot(row) : null;
  }

  checkpoint(filter: NotificationFilter): NotificationCheckpoint {
    const row = getDatabase().prepare(`
      SELECT COUNT(*) AS acknowledged_count, MAX(acknowledged_at) AS last_acknowledged_at
      FROM notification_records
      WHERE acknowledged_at IS NOT NULL AND (?='all' OR filter_type=?)
    `).get(filter, filter) as { acknowledged_count?: number | bigint; last_acknowledged_at?: string } | undefined;
    return {
      filter,
      acknowledgedCount: Number(row?.acknowledged_count ?? 0),
      lastAcknowledgedAt: row?.last_acknowledged_at ?? null,
    };
  }

  unacknowledged(items: NotificationItem[]): NotificationItem[] {
    if (!items.length) return [];
    const acknowledged = new Set<string>();
    const query = getDatabase().prepare(
      "SELECT acknowledged_at,last_error FROM notification_records WHERE notice_id=?",
    );
    return items.filter(item => {
      const row = query.get(item.noticeId) as { acknowledged_at?: string; last_error?: string } | undefined;
      if (row?.acknowledged_at) acknowledged.add(item.noticeId);
      return !acknowledged.has(item.noticeId) && !row?.last_error;
    });
  }

  createCandidate(filter: NotificationFilter, noticeIds: string[]): NotificationCheckpointCandidate {
    const unique = [...new Set(noticeIds)];
    const digest = createHash("sha256").update(JSON.stringify(unique)).digest("hex");
    const candidate = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    getDatabase().prepare(`
      INSERT INTO notification_checkpoint_candidates(
        candidate_id,filter_type,notice_ids_json,digest,created_at,expires_at,consumed_at
      ) VALUES(?,?,?,?,?,?,NULL)
    `).run(candidate, filter, JSON.stringify(unique), digest, createdAt, expiresAt);
    return { candidate, filter, noticeIds: unique, digest, createdAt, expiresAt };
  }

  acknowledge(input: {
    candidate?: string;
    noticeIds?: string[];
    confirm: boolean;
  }): { acknowledgedNoticeIds: string[]; alreadyAcknowledgedNoticeIds: string[]; localOnly: true } {
    if (!input.confirm) throw new Error("NOTIFICATION_CHECKPOINT_CONFIRMATION_REQUIRED");
    return withImmediateTransaction(db => {
      let noticeIds = [...new Set(input.noticeIds ?? [])];
      let candidateRow: NotificationRow | undefined;
      if (input.candidate) {
        candidateRow = db.prepare(`
          SELECT * FROM notification_checkpoint_candidates WHERE candidate_id=?
        `).get(input.candidate) as NotificationRow | undefined;
        if (!candidateRow) throw new Error("NOTIFICATION_CHECKPOINT_CANDIDATE_NOT_FOUND");
        if (!candidateRow.consumed_at && String(candidateRow.expires_at) < new Date().toISOString()) {
          throw new Error("NOTIFICATION_CHECKPOINT_CANDIDATE_EXPIRED");
        }
        noticeIds = [...new Set(JSON.parse(String(candidateRow.notice_ids_json)) as string[])];
      }
      if (!noticeIds.length) throw new Error("NOTIFICATION_CHECKPOINT_NOTICE_IDS_REQUIRED");
      const lookup = db.prepare(
        "SELECT acknowledged_at,last_error FROM notification_records WHERE notice_id=?",
      );
      const now = new Date().toISOString();
      const acknowledgedNoticeIds: string[] = [];
      const alreadyAcknowledgedNoticeIds: string[] = [];
      for (const noticeId of noticeIds) {
        const row = lookup.get(noticeId) as { acknowledged_at?: string; last_error?: string } | undefined;
        if (!row) throw new Error(`NOTIFICATION_NOT_PARSED:${noticeId}`);
        if (row.last_error) throw new Error(`NOTIFICATION_PARSE_FAILED:${noticeId}`);
        if (row.acknowledged_at) {
          alreadyAcknowledgedNoticeIds.push(noticeId);
          continue;
        }
        db.prepare("UPDATE notification_records SET acknowledged_at=? WHERE notice_id=?")
          .run(now, noticeId);
        acknowledgedNoticeIds.push(noticeId);
      }
      if (candidateRow && !candidateRow.consumed_at) {
        db.prepare("UPDATE notification_checkpoint_candidates SET consumed_at=? WHERE candidate_id=?")
          .run(now, input.candidate!);
      }
      return { acknowledgedNoticeIds, alreadyAcknowledgedNoticeIds, localOnly: true };
    });
  }

  audit(input: {
    noticeId: string;
    action: "open_target" | "prepare_reply";
    snapshotHash: string;
    operationId?: string | null;
    evidence?: Record<string, unknown>;
  }): void {
    getDatabase().prepare(`
      INSERT INTO notification_audit(
        audit_id,notice_id,action,snapshot_hash,operation_id,evidence_json,created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(
      randomUUID(),
      input.noticeId,
      input.action,
      input.snapshotHash,
      input.operationId ?? null,
      JSON.stringify(input.evidence ?? {}),
      new Date().toISOString(),
    );
  }
}
