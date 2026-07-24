import fs from "node:fs";
import path from "node:path";
import type { FrozenNativeMention } from "./features/publisher/native-mention.js";
import { createHash, randomUUID } from "node:crypto";
import { getDatabase, withImmediateTransaction } from "./sqlite.js";

export type PostDraftState =
  | "draft"
  | "editing"
  | "preview_ready"
  | "publish_prepared"
  | "publish_clicked"
  | "publishing"
  | "confirmed"
  | "failed"
  | "unknown_after_submit"
  | "archived";

export type PostPublishOperationState =
  | "prepared"
  | "publish_clicked"
  | "publishing"
  | "confirmed"
  | "failed_before_click"
  | "unknown_after_submit"
  | "rejected";

const allowedPublishTransitions: Record<
  PostPublishOperationState,
  ReadonlySet<PostPublishOperationState>
> = {
  prepared: new Set(["publish_clicked", "confirmed", "failed_before_click", "rejected"]),
  publish_clicked: new Set(["publishing", "confirmed", "unknown_after_submit", "failed_before_click"]),
  publishing: new Set(["confirmed", "unknown_after_submit", "failed_before_click"]),
  unknown_after_submit: new Set(["confirmed", "unknown_after_submit", "failed_before_click"]),
  confirmed: new Set(["confirmed"]),
  failed_before_click: new Set(["failed_before_click"]),
  rejected: new Set(["rejected"]),
};

export type PostDraftMedia = {
  mediaId: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  contentHash: string;
};

export type PostDraftMusic = {
  id: string;
  pageId?: string | null;
  idSource?: "page" | "derived";
  title: string;
  author: string | null;
  version: string | null;
  duration: string | null;
};

export type PostDraftRecord = {
  draftId: string;
  contentType: "carousel";
  actorAccount: string;
  state: PostDraftState;
  title: string;
  caption: string;
  hashtags?: string[];
  nativeMentions?: FrozenNativeMention[];
  media: PostDraftMedia[];
  selectedMusic: PostDraftMusic | null;
  coverIndex: number | null;
  desiredDigest: string;
  pageSyncedDigest: string | null;
  previewDigest: string | null;
  pageTargetId: string | null;
  pageUrl: string | null;
  publishedWorkId: string | null;
  publishedWorkUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

export type PostPublishOperationRecord = {
  operationId: string;
  draftId: string;
  idempotencyKey: string;
  snapshotDigest: string;
  snapshot: PostDraftSnapshot;
  state: PostPublishOperationState;
  createdAt: string;
  updatedAt: string;
  publishClickedAt: string | null;
  confirmedAt: string | null;
  resultingWorkId: string | null;
  resultingWorkUrl: string | null;
  clickCount: number;
  lastError: string | null;
};

export type PostDraftSnapshot = {
  draftId: string;
  contentType: "carousel";
  actorAccount: string;
  title: string;
  caption: string;
  media: Array<{
    mediaId: string;
    path: string;
    fileName: string;
    sizeBytes: number;
    contentHash: string;
    order: number;
  }>;
  selectedMusic: PostDraftMusic | null;
  coverIndex: number | null;
  pageTargetId: string;
  pageUrl: string;
  capturedAt: string;
};

type DraftRow = {
  draft_id: string;
  content_type: "carousel";
  actor_account: string;
  state: PostDraftState;
  title: string;
  caption: string;
  media_json: string;
  selected_music_json: string | null;
  cover_index: number | null;
  desired_digest: string;
  page_synced_digest: string | null;
  preview_digest: string | null;
  page_target_id: string | null;
  page_url: string | null;
  published_work_id: string | null;
  published_work_url: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  last_error: string | null;
};

type OperationRow = {
  operation_id: string;
  draft_id: string;
  idempotency_key: string;
  snapshot_digest: string;
  snapshot_json: string;
  state: PostPublishOperationState;
  created_at: string;
  updated_at: string;
  publish_clicked_at: string | null;
  confirmed_at: string | null;
  resulting_work_id: string | null;
  resulting_work_url: string | null;
  click_count: number;
  last_error: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function postDraftDigest(input: {
  contentType: "carousel";
  actorAccount: string;
  title: string;
  caption: string;
  media: PostDraftMedia[];
  selectedMusic: PostDraftMusic | null;
  coverIndex: number | null;
}): string {
  return createHash("sha256").update(stableJson({
    contentType: input.contentType,
    actorAccount: input.actorAccount,
    title: input.title,
    caption: input.caption,
    media: input.media.map(item => ({
      mediaId: item.mediaId,
      path: item.path,
      fileName: item.fileName,
      sizeBytes: item.sizeBytes,
      contentHash: item.contentHash,
    })),
    selectedMusic: input.selectedMusic,
    coverIndex: input.coverIndex,
  })).digest("hex");
}

export function postSnapshotDigest(snapshot: PostDraftSnapshot): string {
  const { capturedAt: _capturedAt, ...locked } = snapshot;
  return createHash("sha256").update(stableJson(locked)).digest("hex");
}

export function postPublishIdempotencyKey(draftId: string, digest: string): string {
  return createHash("sha256").update(`${draftId}\n${digest}`).digest("hex");
}

export function buildPostDraftMedia(filePath: string): PostDraftMedia {
  if (!path.isAbsolute(filePath)) throw new Error("IMAGE_PATH_NOT_ABSOLUTE");
  const resolved = path.resolve(filePath);
  const supported = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
  if (!supported.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`UNSUPPORTED_IMAGE_TYPE:${path.extname(resolved)}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`IMAGE_NOT_FILE:${resolved}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error(`IMAGE_TOO_LARGE:${resolved}`);
  const contentHash = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
  return {
    mediaId: randomUUID(),
    path: resolved,
    fileName: path.basename(resolved),
    sizeBytes: stat.size,
    contentHash,
  };
}

function parseDraft(row: DraftRow): PostDraftRecord {
  return {
    draftId: row.draft_id,
    contentType: row.content_type,
    actorAccount: row.actor_account,
    state: row.state,
    title: row.title,
    caption: row.caption,
    media: JSON.parse(row.media_json) as PostDraftMedia[],
    selectedMusic: row.selected_music_json
      ? JSON.parse(row.selected_music_json) as PostDraftMusic
      : null,
    coverIndex: row.cover_index,
    desiredDigest: row.desired_digest,
    pageSyncedDigest: row.page_synced_digest,
    previewDigest: row.preview_digest,
    pageTargetId: row.page_target_id,
    pageUrl: row.page_url,
    publishedWorkId: row.published_work_id,
    publishedWorkUrl: row.published_work_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
  };
}

function parseOperation(row: OperationRow): PostPublishOperationRecord {
  return {
    operationId: row.operation_id,
    draftId: row.draft_id,
    idempotencyKey: row.idempotency_key,
    snapshotDigest: row.snapshot_digest,
    snapshot: JSON.parse(row.snapshot_json) as PostDraftSnapshot,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishClickedAt: row.publish_clicked_at,
    confirmedAt: row.confirmed_at,
    resultingWorkId: row.resulting_work_id,
    resultingWorkUrl: row.resulting_work_url,
    clickCount: row.click_count,
    lastError: row.last_error,
  };
}

function draftInput(record: PostDraftRecord) {
  return {
    contentType: record.contentType,
    actorAccount: record.actorAccount,
    title: record.title,
    caption: record.caption,
    media: record.media,
    selectedMusic: record.selectedMusic,
    coverIndex: record.coverIndex,
  };
}

export class PostDraftStore {
  create(actorAccount = "Operator"): PostDraftRecord {
    const now = new Date().toISOString();
    const draftId = randomUUID();
    const base = {
      contentType: "carousel" as const,
      actorAccount,
      title: "",
      caption: "",
      media: [] as PostDraftMedia[],
      selectedMusic: null,
      coverIndex: null,
    };
    const digest = postDraftDigest(base);
    withImmediateTransaction(db => {
      db.prepare(`
        INSERT INTO post_drafts(
          draft_id, content_type, actor_account, state, title, caption,
          media_json, selected_music_json, cover_index, desired_digest,
          created_at, updated_at
        ) VALUES(?, 'carousel', ?, 'draft', '', '', '[]', NULL, NULL, ?, ?, ?)
      `).run(draftId, actorAccount, digest, now, now);
    });
    return this.require(draftId);
  }

  get(draftId: string): PostDraftRecord | null {
    const row = getDatabase().prepare(
      "SELECT * FROM post_drafts WHERE draft_id = ?",
    ).get(draftId) as DraftRow | undefined;
    return row ? parseDraft(row) : null;
  }

  require(draftId: string): PostDraftRecord {
    const record = this.get(draftId);
    if (!record) throw new Error(`POST_DRAFT_NOT_FOUND:${draftId}`);
    return record;
  }

  list(includeTerminal = false): PostDraftRecord[] {
    const rows = getDatabase().prepare(includeTerminal
      ? "SELECT * FROM post_drafts ORDER BY updated_at DESC"
      : "SELECT * FROM post_drafts WHERE state NOT IN ('confirmed', 'archived') ORDER BY updated_at DESC")
      .all() as unknown as DraftRow[];
    return rows.map(parseDraft);
  }

  updateContent(draftId: string, patch: Partial<Pick<
    PostDraftRecord,
    "title" | "caption" | "media" | "selectedMusic" | "coverIndex"
  >>): PostDraftRecord {
    return withImmediateTransaction(db => {
      const row = db.prepare("SELECT * FROM post_drafts WHERE draft_id = ?")
        .get(draftId) as DraftRow | undefined;
      if (!row) throw new Error(`POST_DRAFT_NOT_FOUND:${draftId}`);
      const current = parseDraft(row);
      if (["publish_clicked", "publishing", "confirmed", "unknown_after_submit", "archived"].includes(current.state)) {
        throw new Error(`POST_DRAFT_IMMUTABLE:${current.state}`);
      }
      const next: PostDraftRecord = { ...current, ...patch };
      if (next.media.length > 35) throw new Error("POST_DRAFT_MEDIA_LIMIT:35");
      if (next.coverIndex !== null
        && (next.coverIndex < 0 || next.coverIndex >= next.media.length)) {
        throw new Error("POST_DRAFT_COVER_OUT_OF_RANGE");
      }
      if (next.media.length === 0) next.coverIndex = null;
      const digest = postDraftDigest(draftInput(next));
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE post_drafts SET
          state='editing',
          title=?,
          caption=?,
          media_json=?,
          selected_music_json=?,
          cover_index=?,
          desired_digest=?,
          page_synced_digest=NULL,
          preview_digest=NULL,
          updated_at=?,
          last_verified_at=NULL,
          last_error=NULL
        WHERE draft_id=?
      `).run(
        next.title,
        next.caption,
        JSON.stringify(next.media),
        next.selectedMusic ? JSON.stringify(next.selectedMusic) : null,
        next.coverIndex,
        digest,
        now,
        draftId,
      );
      db.prepare(`
        UPDATE post_publish_operations
        SET state='rejected', updated_at=?, last_error='draft_changed_after_preview'
        WHERE draft_id=? AND state='prepared'
      `).run(now, draftId);
      return parseDraft(db.prepare("SELECT * FROM post_drafts WHERE draft_id = ?")
        .get(draftId) as DraftRow);
    });
  }

  markPageSynced(draftId: string, input: {
    pageTargetId: string;
    pageUrl: string;
  }): PostDraftRecord {
    return withImmediateTransaction(db => {
      const current = this.require(draftId);
      const now = new Date().toISOString();
      getDatabase().prepare(`
        UPDATE post_drafts SET
          state='preview_ready',
          page_synced_digest=desired_digest,
          page_target_id=?,
          page_url=?,
          updated_at=?,
          last_verified_at=?,
          last_error=NULL
        WHERE draft_id=?
      `).run(input.pageTargetId, input.pageUrl, now, now, draftId);
      return this.require(current.draftId);
    });
  }

  preparePublish(draftId: string, snapshot: PostDraftSnapshot): PostPublishOperationRecord {
    const digest = postSnapshotDigest(snapshot);
    const idempotencyKey = postPublishIdempotencyKey(draftId, digest);
    return withImmediateTransaction(db => {
      const draft = parseDraft(db.prepare("SELECT * FROM post_drafts WHERE draft_id = ?")
        .get(draftId) as DraftRow);
      if (draft.desiredDigest !== draft.pageSyncedDigest) {
        throw new Error("POST_DRAFT_NOT_PAGE_SYNCED");
      }
      if (draft.pageTargetId !== snapshot.pageTargetId || draft.pageUrl !== snapshot.pageUrl) {
        throw new Error("POST_DRAFT_PAGE_BINDING_MISMATCH");
      }
      const existing = db.prepare(
        "SELECT * FROM post_publish_operations WHERE idempotency_key = ?",
      ).get(idempotencyKey) as OperationRow | undefined;
      if (existing) {
        const operation = parseOperation(existing);
        if (operation.state === "confirmed") return operation;
        if (["publish_clicked", "publishing", "unknown_after_submit"].includes(operation.state)) {
          throw new Error(`POST_PUBLISH_OPERATION_UNRESOLVED:${operation.operationId}`);
        }
        if (operation.state === "prepared") return operation;
        throw new Error(
          `POST_PUBLISH_OPERATION_TERMINAL:${operation.operationId}:${operation.state}`,
        );
      }
      const operationId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO post_publish_operations(
          operation_id, draft_id, idempotency_key, snapshot_digest,
          snapshot_json, state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 'prepared', ?, ?)
      `).run(
        operationId,
        draftId,
        idempotencyKey,
        digest,
        JSON.stringify(snapshot),
        now,
        now,
      );
      db.prepare(`
        UPDATE post_drafts SET
          state='publish_prepared',
          preview_digest=?,
          updated_at=?,
          last_verified_at=?,
          last_error=NULL
        WHERE draft_id=?
      `).run(digest, now, now, draftId);
      return parseOperation(db.prepare(
        "SELECT * FROM post_publish_operations WHERE operation_id = ?",
      ).get(operationId) as OperationRow);
    });
  }

  getOperation(operationId: string): PostPublishOperationRecord | null {
    const row = getDatabase().prepare(
      "SELECT * FROM post_publish_operations WHERE operation_id = ?",
    ).get(operationId) as OperationRow | undefined;
    return row ? parseOperation(row) : null;
  }

  requireOperation(operationId: string): PostPublishOperationRecord {
    const operation = this.getOperation(operationId);
    if (!operation) throw new Error(`POST_PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
    return operation;
  }

  claimPublish(operationId: string): {
    transitioned: boolean;
    operation: PostPublishOperationRecord;
  } {
    return withImmediateTransaction(db => {
      const row = db.prepare(
        "SELECT * FROM post_publish_operations WHERE operation_id = ?",
      ).get(operationId) as OperationRow | undefined;
      if (!row) throw new Error(`POST_PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
      if (row.state !== "prepared") {
        return { transitioned: false, operation: parseOperation(row) };
      }
      const draft = db.prepare("SELECT * FROM post_drafts WHERE draft_id = ?")
        .get(row.draft_id) as DraftRow | undefined;
      if (!draft || draft.preview_digest !== row.snapshot_digest
        || draft.page_synced_digest !== draft.desired_digest) {
        throw new Error("POST_PUBLISH_SNAPSHOT_MISMATCH");
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE post_publish_operations SET
          state='publish_clicked',
          publish_clicked_at=?,
          updated_at=?,
          click_count=1,
          last_error=NULL
        WHERE operation_id=? AND state='prepared'
      `).run(now, now, operationId);
      db.prepare(`
        UPDATE post_drafts SET state='publish_clicked', updated_at=?
        WHERE draft_id=?
      `).run(now, row.draft_id);
      return {
        transitioned: true,
        operation: parseOperation(db.prepare(
          "SELECT * FROM post_publish_operations WHERE operation_id = ?",
        ).get(operationId) as OperationRow),
      };
    });
  }

  updateOperation(operationId: string, input: {
    state: PostPublishOperationState;
    resultingWorkId?: string | null;
    resultingWorkUrl?: string | null;
    lastError?: string | null;
  }): PostPublishOperationRecord {
    return withImmediateTransaction(db => {
      const row = db.prepare(
        "SELECT * FROM post_publish_operations WHERE operation_id = ?",
      ).get(operationId) as OperationRow | undefined;
      if (!row) throw new Error(`POST_PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
      const currentState = String(row.state) as PostPublishOperationState;
      if (input.state !== currentState
        && !allowedPublishTransitions[currentState].has(input.state)) {
        throw new Error(`POST_PUBLISH_TRANSITION_REJECTED:${currentState}->${input.state}`);
      }
      const now = new Date().toISOString();
      const confirmedAt = input.state === "confirmed" ? now : row.confirmed_at;
      const resultingWorkId = input.resultingWorkId ?? row.resulting_work_id;
      const resultingWorkUrl = input.resultingWorkUrl ?? row.resulting_work_url;
      if (input.state === "confirmed" && (!resultingWorkId || !resultingWorkUrl)) {
        throw new Error("POST_PUBLISH_CONFIRM_EVIDENCE_REQUIRED");
      }
      db.prepare(`
        UPDATE post_publish_operations SET
          state=?,
          updated_at=?,
          confirmed_at=?,
          resulting_work_id=?,
          resulting_work_url=?,
          last_error=?
        WHERE operation_id=?
      `).run(
        input.state,
        now,
        confirmedAt,
        resultingWorkId,
        resultingWorkUrl,
        input.lastError ?? null,
        operationId,
      );
      const draftState: PostDraftState = input.state === "confirmed"
        ? "confirmed"
        : input.state === "publishing"
          ? "publishing"
          : input.state === "unknown_after_submit"
            ? "unknown_after_submit"
            : input.state === "failed_before_click"
              ? "failed"
              : input.state === "publish_clicked"
                ? "publish_clicked"
                : "publish_prepared";
      db.prepare(`
        UPDATE post_drafts SET
          state=?,
          updated_at=?,
          published_work_id=COALESCE(?, published_work_id),
          published_work_url=COALESCE(?, published_work_url),
          last_verified_at=CASE WHEN ?='confirmed' THEN ? ELSE last_verified_at END,
          last_error=?
        WHERE draft_id=?
      `).run(
        draftState,
        now,
        input.resultingWorkId ?? null,
        input.resultingWorkUrl ?? null,
        input.state,
        now,
        input.lastError ?? null,
        row.draft_id,
      );
      return parseOperation(db.prepare(
        "SELECT * FROM post_publish_operations WHERE operation_id = ?",
      ).get(operationId) as OperationRow);
    });
  }

  listUnresolved(): PostPublishOperationRecord[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM post_publish_operations
      WHERE state IN ('publish_clicked', 'publishing', 'unknown_after_submit')
        AND operation_id NOT IN (
          SELECT legacy_operation_id FROM publish_legacy_migrations
        )
      ORDER BY updated_at ASC
    `).all() as unknown as OperationRow[];
    return rows.map(parseOperation);
  }

  listOperations(limit = 20): PostPublishOperationRecord[] {
    const rows = getDatabase().prepare(`
      SELECT * FROM post_publish_operations
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as unknown as OperationRow[];
    return rows.map(parseOperation);
  }
}
