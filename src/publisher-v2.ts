import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getDatabase, withImmediateTransaction } from "./sqlite.js";
import {
  buildPostDraftMedia,
  type PostDraftMedia,
  type PostDraftMusic,
  type PostDraftRecord,
} from "./post-draft-store.js";
import {
  nativeMentionsMatch,
  projectCaptionWithMentions,
  resolveNativeMentions,
  type FrozenNativeMention,
  type NativeMentionInspection,
  type PublishMentionInput,
} from "./features/publisher/native-mention.js";

export type PublishContentType = "text" | "carousel" | "article" | "video";
export type PublishAction = "prepare" | "publish";
export type PublishVisibility = "public" | "friends" | "private";

export function publishRouteForContentType(contentType: PublishContentType): {
  contentType: PublishContentType;
  adapter: "carousel" | "unsupported";
  directUrl: string | null;
} {
  if (contentType === "carousel") {
    return {
      contentType,
      adapter: "carousel",
      directUrl: "https://creator.douyin.com/creator-micro/content/upload",
    };
  }
  return { contentType, adapter: "unsupported", directUrl: null };
}
export type PublishV2OperationState =
  | "prepared"
  | "validation_failed"
  | "blocked_before_click"
  | "click_intent_recorded"
  | "submitted_unverified"
  | "published"
  | "deleted_or_unavailable"
  | "unknown_after_submit"
  | "confirmed_unsent"
  | "aborted";

export type PublishContentIntent = {
  contentType: PublishContentType;
  title: string;
  caption: string;
  images: PostDraftMedia[];
  hashtags: string[];
  music: PostDraftMusic | null;
  visibility: PublishVisibility;
  scheduledAt: string | null;
  mentions: FrozenNativeMention[];
};

export type PublishV2DraftRecord = {
  draftId: string;
  actorAccount: string;
  semanticHash: string;
  revision: number;
  intent: PublishContentIntent;
  state: string;
  pageTargetId: string | null;
  pageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  publishedWorkId: string | null;
  publishedWorkUrl: string | null;
  pageSyncDigest: string | null;
  previewDigest: string | null;
};

export type LegacyPublishMigrationState = "prepared" | "published" | "superseded";

export type LegacyPublishMigrationRecord = {
  legacyOperationId: string;
  legacyDraftId: string;
  v2OperationId: string;
  v2DraftId: string;
  migrationState: LegacyPublishMigrationState;
  createdAt: string;
  updatedAt: string;
};

export type PublishV2OperationRecord = {
  operationId: string;
  draftId: string;
  actorAccount: string;
  contentType: PublishContentType;
  semanticHash: string;
  idempotencyKey: string;
  state: PublishV2OperationState;
  clickCount: number;
  clickedAt: string | null;
  requestEvidence: Record<string, unknown> | null;
  responseEvidence: Record<string, unknown> | null;
  resultingWorkId: string | null;
  resultingWorkUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

type DraftRow = {
  draft_id: string; actor_account: string; semantic_hash: string; revision: number;
  intent_json: string; state: string; page_target_id: string | null; page_url: string | null;
  created_at: string; updated_at: string; last_error: string | null;
  published_work_id: string | null; published_work_url: string | null;
  page_sync_digest: string | null; preview_digest: string | null;
};
type OperationRow = {
  operation_id: string; draft_id: string; actor_account: string; content_type: PublishContentType;
  semantic_hash: string; idempotency_key: string; state: PublishV2OperationState;
  click_count: number; clicked_at: string | null; request_evidence_json: string | null;
  response_evidence_json: string | null; resulting_work_id: string | null;
  resulting_work_url: string | null; created_at: string; updated_at: string; last_error: string | null;
};
type LegacyMigrationRow = {
  legacy_operation_id: string; legacy_draft_id: string; v2_operation_id: string;
  v2_draft_id: string; migration_state: LegacyPublishMigrationState;
  created_at: string; updated_at: string;
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

export function normalizePublishText(value: string): string {
  return value.replace(/\u200b/g, "").replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeHashtags(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const tag = normalizePublishText(value).replace(/^#+/, "").replace(/\s+/g, "");
    if (!tag || seen.has(tag.toLocaleLowerCase())) continue;
    seen.add(tag.toLocaleLowerCase());
    result.push(tag);
  }
  return result;
}

export function publishSemanticHash(intent: PublishContentIntent): string {
  return createHash("sha256").update(stableJson({
    contentType: intent.contentType,
    title: normalizePublishText(intent.title),
    caption: normalizePublishText(intent.caption),
    hashtags: normalizeHashtags(intent.hashtags),
    images: intent.images.map((item, order) => ({ contentHash: item.contentHash, order })),
    music: intent.music ? {
      id: intent.music.id,
      title: intent.music.title,
      author: intent.music.author,
      duration: intent.music.duration,
    } : null,
    visibility: intent.visibility,
    scheduledAt: intent.scheduledAt,
    mentions: (intent.mentions ?? []).map(item => ({
      alias: item.alias,
      displayName: item.displayName,
      uid: item.uid,
      secUid: item.secUid,
      placement: item.placement,
    })),
  })).digest("hex");
}

export function canonicalCarouselCaptionBody(value: string): string {
  return normalizePublishText(value)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function projectedCarouselCaption(
  intent: Pick<PublishContentIntent, "caption" | "hashtags" | "mentions">,
): string {
  const caption = projectCaptionWithMentions(
    canonicalCarouselCaptionBody(intent.caption),
    intent.mentions ?? [],
  );
  const tags = normalizeHashtags(intent.hashtags).map(tag => `#${tag}`).join(" ");
  return [caption, tags].filter(Boolean).join(" ");
}

export type PublishedWorkAvailability = "available" | "deleted_or_unavailable" | "inconclusive";

export function classifyPublishedWorkAvailability(input: {
  expectedWorkId: string;
  responseStatus?: number | null;
  finalUrl?: string | null;
  bodyText?: string | null;
  observedWorkId?: string | null;
  hasWorkDetailEvidence?: boolean;
}): PublishedWorkAvailability {
  if (input.responseStatus === 404 || input.responseStatus === 410) return "deleted_or_unavailable";
  const body = normalizePublishText(input.bodyText ?? "");
  if (/(?:作品|视频|图文|内容).{0,8}(?:已删除|不存在|无法查看|已失效|不可见)|作者已删除|你要观看的.{0,6}不存在|内容暂时无法查看|当前作品无法访问|私密作品/.test(body)) {
    return "deleted_or_unavailable";
  }
  if (input.observedWorkId === input.expectedWorkId && input.hasWorkDetailEvidence) return "available";
  return "inconclusive";
}

export function carouselSemanticMatches(input: {
  intent: PublishContentIntent;
  title: string;
  caption: string;
  hashtags?: string[];
  plainHashtags?: string[];
  imageCount: number;
  imageOrder: string[];
  music: PostDraftMusic | null;
  mentionInspection?: NativeMentionInspection;
}): boolean {
  const expectedOrder = input.intent.images.map(item => item.fileName);
  const orderMatches = input.imageOrder.length === expectedOrder.length
    && input.imageOrder.every((item, index) => item === expectedOrder[index]);
  const musicMatches = input.intent.music
    ? Boolean(input.music && input.music.id === input.intent.music.id)
    : input.music === null;
  const normalizedActual = canonicalCarouselCaptionBody(input.caption);
  const normalizedExpected = projectedCarouselCaption(input.intent);
  const expectedHashtags = normalizeHashtags(input.intent.hashtags);
  const actualHashtags = normalizeHashtags(input.hashtags ?? []);
  const hashtagsMatch = actualHashtags.length === expectedHashtags.length
    && actualHashtags.every((item, index) => item === expectedHashtags[index]);
  const mentionsMatch = nativeMentionsMatch(
    input.intent.mentions ?? [],
    input.mentionInspection ?? {
      nativeMentions: [],
      plainTextMentions: [],
      unresolvedMentions: [],
    },
  );
  return normalizePublishText(input.title) === normalizePublishText(input.intent.title)
    && normalizedActual === normalizedExpected
    && hashtagsMatch
    && (input.plainHashtags?.length ?? 0) === 0
    && input.imageCount === input.intent.images.length
    && orderMatches
    && musicMatches
    && mentionsMatch;
}

export async function buildPublishIntent(input: {
  contentType: PublishContentType;
  title?: string;
  caption?: string;
  imagePaths?: string[];
  hashtags?: string[];
  music?: PostDraftMusic | null;
  visibility?: PublishVisibility;
  scheduledAt?: string | null;
  mentions?: PublishMentionInput[];
}): Promise<PublishContentIntent> {
  const imagePaths = input.imagePaths ?? [];
  const images = await Promise.all(imagePaths.map(buildPostDraftMedia));
  return {
    contentType: input.contentType,
    title: normalizePublishText(input.title ?? ""),
    caption: normalizePublishText(input.caption ?? ""),
    images,
    hashtags: normalizeHashtags(input.hashtags ?? []),
    music: input.music ?? null,
    visibility: input.visibility ?? "public",
    scheduledAt: input.scheduledAt ?? null,
    mentions: resolveNativeMentions(input.mentions ?? []),
  };
}

function parseDraft(row: DraftRow): PublishV2DraftRecord {
  const parsedIntent = JSON.parse(row.intent_json) as PublishContentIntent;
  parsedIntent.mentions ??= [];
  return {
    draftId: row.draft_id, actorAccount: row.actor_account, semanticHash: row.semantic_hash,
    revision: row.revision, intent: parsedIntent,
    state: row.state, pageTargetId: row.page_target_id, pageUrl: row.page_url,
    createdAt: row.created_at, updatedAt: row.updated_at, lastError: row.last_error,
    publishedWorkId: row.published_work_id, publishedWorkUrl: row.published_work_url,
    pageSyncDigest: row.page_sync_digest ?? null,
    previewDigest: row.preview_digest ?? null,
  };
}

function parseOperation(row: OperationRow): PublishV2OperationRecord {
  return {
    operationId: row.operation_id, draftId: row.draft_id, actorAccount: row.actor_account,
    contentType: row.content_type, semanticHash: row.semantic_hash, idempotencyKey: row.idempotency_key,
    state: row.state, clickCount: row.click_count, clickedAt: row.clicked_at,
    requestEvidence: row.request_evidence_json ? JSON.parse(row.request_evidence_json) : null,
    responseEvidence: row.response_evidence_json ? JSON.parse(row.response_evidence_json) : null,
    resultingWorkId: row.resulting_work_id, resultingWorkUrl: row.resulting_work_url,
    createdAt: row.created_at, updatedAt: row.updated_at, lastError: row.last_error,
  };
}

function parseLegacyMigration(row: LegacyMigrationRow): LegacyPublishMigrationRecord {
  return {
    legacyOperationId: row.legacy_operation_id,
    legacyDraftId: row.legacy_draft_id,
    v2OperationId: row.v2_operation_id,
    v2DraftId: row.v2_draft_id,
    migrationState: row.migration_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const allowedTransitions: Record<PublishV2OperationState, ReadonlySet<PublishV2OperationState>> = {
  prepared: new Set(["validation_failed", "blocked_before_click", "click_intent_recorded", "aborted"]),
  validation_failed: new Set(["prepared", "blocked_before_click", "aborted"]),
  blocked_before_click: new Set(["prepared", "aborted"]),
  click_intent_recorded: new Set(["submitted_unverified", "unknown_after_submit", "published"]),
  submitted_unverified: new Set(["published", "unknown_after_submit", "confirmed_unsent"]),
  unknown_after_submit: new Set(["published", "confirmed_unsent"]),
  confirmed_unsent: new Set(["prepared", "aborted"]),
  published: new Set(["published", "deleted_or_unavailable"]),
  deleted_or_unavailable: new Set(["deleted_or_unavailable"]),
  aborted: new Set(["aborted"]),
};

export class PublisherV2Store {
  getLegacyMigration(legacyOperationId: string): LegacyPublishMigrationRecord | null {
    const row = getDatabase().prepare(
      "SELECT * FROM publish_legacy_migrations WHERE legacy_operation_id=?",
    ).get(legacyOperationId) as LegacyMigrationRow | undefined;
    return row ? parseLegacyMigration(row) : null;
  }

  getLegacyMigrationByV2Operation(v2OperationId: string): LegacyPublishMigrationRecord | null {
    const row = getDatabase().prepare(
      "SELECT * FROM publish_legacy_migrations WHERE v2_operation_id=?",
    ).get(v2OperationId) as LegacyMigrationRow | undefined;
    return row ? parseLegacyMigration(row) : null;
  }

  registerLegacyMigration(input: {
    legacyOperationId: string;
    legacyDraftId: string;
    v2OperationId: string;
    v2DraftId: string;
    migrationState: LegacyPublishMigrationState;
  }): LegacyPublishMigrationRecord {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO publish_legacy_migrations(
        legacy_operation_id,legacy_draft_id,v2_operation_id,v2_draft_id,migration_state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(legacy_operation_id) DO UPDATE SET
        v2_operation_id=excluded.v2_operation_id,
        v2_draft_id=excluded.v2_draft_id,
        migration_state=excluded.migration_state,
        updated_at=excluded.updated_at`).run(
        input.legacyOperationId,
        input.legacyDraftId,
        input.v2OperationId,
        input.v2DraftId,
        input.migrationState,
        now,
        now,
      );
      return parseLegacyMigration(db.prepare(
        "SELECT * FROM publish_legacy_migrations WHERE legacy_operation_id=?",
      ).get(input.legacyOperationId) as LegacyMigrationRow);
    });
  }

  markLegacyMigrationState(
    legacyOperationId: string,
    migrationState: LegacyPublishMigrationState,
  ): LegacyPublishMigrationRecord {
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      const result = db.prepare(`UPDATE publish_legacy_migrations
        SET migration_state=?,updated_at=? WHERE legacy_operation_id=?`)
        .run(migrationState, now, legacyOperationId);
      if (Number(result.changes) !== 1) {
        throw new Error(`LEGACY_PUBLISH_MIGRATION_NOT_FOUND:${legacyOperationId}`);
      }
      return parseLegacyMigration(db.prepare(
        "SELECT * FROM publish_legacy_migrations WHERE legacy_operation_id=?",
      ).get(legacyOperationId) as LegacyMigrationRow);
    });
  }

  prepare(actorAccount: string, intent: PublishContentIntent): {
    draft: PublishV2DraftRecord; operation: PublishV2OperationRecord; existing: boolean;
  } {
    const semanticHash = publishSemanticHash(intent);
    return withImmediateTransaction(db => {
      const latest = db.prepare(`SELECT * FROM publish_operations_v2
        WHERE actor_account=? AND semantic_hash=? ORDER BY updated_at DESC, created_at DESC LIMIT 1`)
        .get(actorAccount, semanticHash) as OperationRow | undefined;
      if (latest && latest.state !== "deleted_or_unavailable") {
        const operation = parseOperation(latest);
        const draft = parseDraft(db.prepare("SELECT * FROM publish_drafts_v2 WHERE draft_id=?")
          .get(operation.draftId) as DraftRow);
        return { draft, operation, existing: true };
      }
      const previousRevision = latest
        ? Number((db.prepare("SELECT revision FROM publish_drafts_v2 WHERE draft_id=?")
            .get(latest.draft_id) as { revision?: number } | undefined)?.revision ?? 1)
        : 0;
      const revision = previousRevision + 1;
      const idempotencyKey = createHash("sha256")
        .update(stableJson({ actorAccount, semanticHash, revision }))
        .digest("hex");
      const now = new Date().toISOString();
      const draftId = randomUUID();
      const operationId = randomUUID();
      db.prepare(`INSERT INTO publish_drafts_v2(
        draft_id, actor_account, content_type, semantic_hash, revision, intent_json, state, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,'draft',?,?)`).run(
        draftId, actorAccount, intent.contentType, semanticHash, revision, JSON.stringify(intent), now, now,
      );
      db.prepare(`INSERT INTO publish_operations_v2(
        operation_id,draft_id,actor_account,content_type,semantic_hash,idempotency_key,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'prepared',?,?)`).run(
        operationId, draftId, actorAccount, intent.contentType, semanticHash, idempotencyKey, now, now,
      );
      return {
        draft: parseDraft(db.prepare("SELECT * FROM publish_drafts_v2 WHERE draft_id=?").get(draftId) as DraftRow),
        operation: parseOperation(db.prepare("SELECT * FROM publish_operations_v2 WHERE operation_id=?")
          .get(operationId) as OperationRow),
        existing: false,
      };
    });
  }

  getOperation(operationId: string): PublishV2OperationRecord | null {
    const row = getDatabase().prepare("SELECT * FROM publish_operations_v2 WHERE operation_id=?")
      .get(operationId) as OperationRow | undefined;
    return row ? parseOperation(row) : null;
  }

  requireOperation(operationId: string): PublishV2OperationRecord {
    const record = this.getOperation(operationId);
    if (!record) throw new Error(`PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
    return record;
  }

  requireDraft(draftId: string): PublishV2DraftRecord {
    const row = getDatabase().prepare("SELECT * FROM publish_drafts_v2 WHERE draft_id=?")
      .get(draftId) as DraftRow | undefined;
    if (!row) throw new Error(`PUBLISH_DRAFT_NOT_FOUND:${draftId}`);
    return parseDraft(row);
  }

  list(limit = 20): PublishV2OperationRecord[] {
    const rows = getDatabase().prepare(
      "SELECT * FROM publish_operations_v2 ORDER BY updated_at DESC LIMIT ?",
    ).all(Math.max(1, Math.min(100, limit))) as unknown as OperationRow[];
    return rows.map(parseOperation);
  }

  listUnresolved(): PublishV2OperationRecord[] {
    const rows = getDatabase().prepare(`SELECT * FROM publish_operations_v2
      WHERE state IN ('click_intent_recorded','submitted_unverified','unknown_after_submit')
      ORDER BY updated_at ASC`).all() as unknown as OperationRow[];
    return rows.map(parseOperation);
  }

  markPrepared(operationId: string, input: {
    pageTargetId: string;
    pageUrl: string;
    pageSyncDigest: string;
    previewDigest: string;
  }): PublishV2OperationRecord {
    const current = this.requireOperation(operationId);
    if (["validation_failed", "blocked_before_click", "confirmed_unsent"].includes(current.state)) {
      this.transition(operationId, "prepared", { lastError: null });
    } else if (current.state !== "prepared") {
      return current;
    }
    return withImmediateTransaction(db => {
      const now = new Date().toISOString();
      db.prepare(`UPDATE publish_drafts_v2 SET state='prepared',page_target_id=?,page_url=?,
        page_sync_digest=?,preview_digest=?,updated_at=?,last_error=NULL
        WHERE draft_id=?`).run(
        input.pageTargetId,
        input.pageUrl,
        input.pageSyncDigest,
        input.previewDigest,
        now,
        current.draftId,
      );
      return this.requireOperation(operationId);
    });
  }

  transition(operationId: string, state: PublishV2OperationState, input: {
    lastError?: string | null;
    requestEvidence?: Record<string, unknown> | null;
    responseEvidence?: Record<string, unknown> | null;
    workId?: string | null;
    workUrl?: string | null;
  } = {}): PublishV2OperationRecord {
    return withImmediateTransaction(db => {
      const row = db.prepare("SELECT * FROM publish_operations_v2 WHERE operation_id=?")
        .get(operationId) as OperationRow | undefined;
      if (!row) throw new Error(`PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
      if (state !== row.state && !allowedTransitions[row.state].has(state)) {
        throw new Error(`PUBLISH_TRANSITION_REJECTED:${row.state}->${state}`);
      }
      const now = new Date().toISOString();
      if (state === "click_intent_recorded" && row.state === "click_intent_recorded") {
        throw new Error("PUBLISH_CLICK_ALREADY_RECORDED");
      }
      const click = state === "click_intent_recorded";
      const resetConfirmedUnsent = state === "prepared" && row.state === "confirmed_unsent";
      if (click && row.click_count !== 0) throw new Error("PUBLISH_CLICK_ALREADY_RECORDED");
      if (state === "published" && (!input.workId && !row.resulting_work_id)) {
        throw new Error("PUBLISH_CONFIRM_EVIDENCE_REQUIRED");
      }
      db.prepare(`UPDATE publish_operations_v2 SET state=?,updated_at=?,
        click_count=CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE click_count END,
        clicked_at=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE clicked_at END,
        request_evidence_json=COALESCE(?,request_evidence_json),
        response_evidence_json=COALESCE(?,response_evidence_json),
        resulting_work_id=COALESCE(?,resulting_work_id),resulting_work_url=COALESCE(?,resulting_work_url),
        last_error=? WHERE operation_id=?`).run(
        state, now, click ? 1 : 0, resetConfirmedUnsent ? 1 : 0,
        click ? 1 : 0, now, resetConfirmedUnsent ? 1 : 0,
        input.requestEvidence ? JSON.stringify(input.requestEvidence) : null,
        input.responseEvidence ? JSON.stringify(input.responseEvidence) : null,
        input.workId ?? null, input.workUrl ?? null, input.lastError ?? null, operationId,
      );
      const draftState = state === "published" ? "published"
        : state === "deleted_or_unavailable" ? "deleted_or_unavailable"
        : state === "confirmed_unsent" ? "confirmed_unsent"
          : state === "aborted" ? "aborted"
            : state === "validation_failed" ? "validation_failed"
              : state === "blocked_before_click" ? "blocked_before_click"
                : state === "submitted_unverified" || state === "unknown_after_submit"
                  ? "submitted_unverified" : "prepared";
      db.prepare(`UPDATE publish_drafts_v2 SET state=?,updated_at=?,last_error=?,
        published_work_id=COALESCE(?,published_work_id),published_work_url=COALESCE(?,published_work_url)
        WHERE draft_id=?`).run(
        draftState, now, input.lastError ?? null, input.workId ?? null, input.workUrl ?? null, row.draft_id,
      );
      return parseOperation(db.prepare("SELECT * FROM publish_operations_v2 WHERE operation_id=?")
        .get(operationId) as OperationRow);
    });
  }

  addEvidence(operationId: string, kind: string, evidence: Record<string, unknown>): void {
    getDatabase().prepare(`INSERT INTO publish_evidence_v2(evidence_id,operation_id,kind,evidence_json,created_at)
      VALUES(?,?,?,?,?)`).run(randomUUID(), operationId, kind, JSON.stringify(evidence), new Date().toISOString());
  }
}

export function asCarouselDraft(draft: PublishV2DraftRecord): PostDraftRecord {
  if (draft.intent.contentType !== "carousel") throw new Error("CONTENT_TYPE_NOT_SUPPORTED");
  return {
    draftId: draft.draftId,
    contentType: "carousel",
    actorAccount: draft.actorAccount,
    state: "editing",
    title: draft.intent.title,
    caption: canonicalCarouselCaptionBody(draft.intent.caption),
    hashtags: normalizeHashtags(draft.intent.hashtags),
    nativeMentions: draft.intent.mentions ?? [],
    media: draft.intent.images,
    selectedMusic: draft.intent.music,
    coverIndex: draft.intent.images.length ? 0 : null,
    desiredDigest: draft.semanticHash,
    pageSyncedDigest: null,
    previewDigest: null,
    pageTargetId: draft.pageTargetId,
    pageUrl: draft.pageUrl,
    publishedWorkId: draft.publishedWorkId,
    publishedWorkUrl: draft.publishedWorkUrl,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    lastVerifiedAt: null,
    lastError: draft.lastError,
  };
}

export function publishIntentSummary(intent: PublishContentIntent) {
  return {
    content_type: intent.contentType,
    title: intent.title,
    caption: intent.caption,
    hashtags: intent.hashtags,
    image_count: intent.images.length,
    image_names: intent.images.map(item => path.basename(item.path)),
    music: intent.music,
    visibility: intent.visibility,
    scheduled_at: intent.scheduledAt,
    mentions: (intent.mentions ?? []).map(item => ({
      alias: item.alias,
      display_name: item.displayName,
      uid: item.uid,
      sec_uid: item.secUid,
      placement: item.placement,
    })),
  };
}
