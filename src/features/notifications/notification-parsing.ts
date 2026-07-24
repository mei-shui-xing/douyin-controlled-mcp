import { createHash } from "node:crypto";

export const NOTIFICATION_PARSE_VERSION = "1.9.1";

export type NotificationFilter =
  | "all"
  | "mentions"
  | "comments"
  | "followers"
  | "likes"
  | "recommendations";

export type NotificationTargetKind =
  | "work_mention"
  | "comment"
  | "follower"
  | "like"
  | "recommendation"
  | "unknown";

export type NotificationAvailability = "available" | "unavailable" | "unknown";

export type NotificationActor = {
  uid: string | null;
  secUid: string | null;
  nickname: string | null;
};

export type NotificationWork = {
  workId: string | null;
  url: string | null;
  contentType: "video" | "note" | "article" | "unknown";
  description: string | null;
  availability: NotificationAvailability;
  author: NotificationActor;
};

export type NotificationComment = {
  commentId: string | null;
  text: string | null;
  parentCommentId: string | null;
  rootCommentId: string | null;
  availability: NotificationAvailability;
};

export type NotificationItem = {
  noticeId: string;
  noticeType: string;
  interactType: string;
  filterType: NotificationFilter;
  actor: NotificationActor;
  work: NotificationWork;
  comment: NotificationComment;
  displayContent: string | null;
  timeText: string | null;
  createdAt: string | null;
  unread: boolean | null;
  targetKind: NotificationTargetKind;
  openable: boolean;
  replyable: boolean;
  privacyFiltered: true;
  parseVersion: string;
};

export type FrozenNotificationReplyTarget = {
  noticeId: string;
  interactType: string;
  targetKind: "comment" | "work_mention";
  workId: string;
  commentId: string | null;
  actorUid: string | null;
  actorSecUid: string | null;
  snapshotHash: string;
};

export type ParsedNotificationCandidate = {
  item: NotificationItem | null;
  error: string | null;
};

type JsonRecord = Record<string, unknown>;

export type CanonicalNotificationCandidate = {
  [key: string]: unknown;
  notice_id: string;
  notice_type: string;
  create_time: string | number | null;
  noticeLogInfo: JsonRecord;
  aweme_id: string | null;
  schema_url: string | null;
  content: string | null;
  user: JsonRecord | null;
  comment: JsonRecord | null;
  aweme: JsonRecord | null;
  unread: unknown;
  time_text: string | null;
};

export type NotificationExtractionDiagnostics = {
  visibleNotificationRowCount: number;
  camelCaseNoticeIdCount: number;
  snakeCaseNoticeIdCount: number;
  panelOpen: boolean;
  emptyStateConfirmed: boolean;
  pageTargetId: string;
};

const stableId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d{8,24}$/.test(normalized) ? normalized : null;
};

const text = (value: unknown, max = 1_000): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\u200b/g, "").replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
};

const record = (value: unknown): JsonRecord | null => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null
);

function firstRecord(root: JsonRecord, keys: string[]): JsonRecord | null {
  for (const key of keys) {
    const value = record(root[key]);
    if (value) return value;
  }
  return null;
}

function firstText(root: JsonRecord | null, keys: string[], max = 1_000): string | null {
  if (!root) return null;
  for (const key of keys) {
    const value = text(root[key], max);
    if (value) return value;
  }
  return null;
}

function firstId(root: JsonRecord | null, keys: string[]): string | null {
  if (!root) return null;
  for (const key of keys) {
    const value = stableId(root[key]);
    if (value) return value;
  }
  return null;
}

function findRecordWithStableKey(
  value: unknown,
  key: string,
  maxDepth = 8,
): JsonRecord | null {
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): JsonRecord | null => {
    if (depth > maxDepth || !current || typeof current !== "object") return null;
    if (seen.has(current as object)) return null;
    seen.add(current as object);
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 100)) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const currentRecord = current as JsonRecord;
    if (stableId(currentRecord[key])) return currentRecord;
    for (const child of Object.values(currentRecord).slice(0, 100)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}

function findRecordWithNoticeId(value: unknown, maxDepth = 8): JsonRecord | null {
  return findRecordWithStableKey(value, "notice_id", maxDepth)
    ?? findRecordWithStableKey(value, "noticeId", maxDepth);
}

const primitive = (value: unknown): unknown => (
  ["string", "number", "boolean"].includes(typeof value) ? value : null
);

function pickPrimitiveFields(root: JsonRecord | null, keys: string[]): JsonRecord | null {
  if (!root) return null;
  const picked: JsonRecord = {};
  for (const key of keys) {
    const value = primitive(root[key]);
    if (value !== null) picked[key] = value;
  }
  return Object.keys(picked).length ? picked : null;
}

function canonicalActor(root: JsonRecord | null): JsonRecord | null {
  return pickPrimitiveFields(root, [
    "uid", "user_id", "sec_uid", "secUid", "nickname", "nick_name", "display_name",
  ]);
}

function canonicalComment(root: JsonRecord | null): JsonRecord | null {
  if (!root) return null;
  const picked = pickPrimitiveFields(root, [
    "cid", "comment_id", "text", "content", "comment_text", "aweme_id", "item_id",
    "reply_id", "parent_comment_id", "parent_id", "reply_to_reply_id", "root_comment_id",
    "root_id", "is_deleted", "is_delete", "deleted", "invalid", "is_invalid", "private",
    "availability", "status_text", "status_desc", "invalid_reason",
  ]) ?? {};
  const user = canonicalActor(firstRecord(root, ["user", "author"]));
  if (user) picked.user = user;
  return Object.keys(picked).length ? picked : null;
}

function canonicalWork(root: JsonRecord | null): JsonRecord | null {
  if (!root) return null;
  const picked = pickPrimitiveFields(root, [
    "aweme_id", "item_id", "desc", "description", "title", "content_type", "aweme_type",
    "type", "schema_url", "schemaUrl", "share_url", "is_deleted", "is_delete", "deleted",
    "invalid", "is_invalid", "private", "availability", "status_text", "status_desc",
    "invalid_reason",
  ]) ?? {};
  const author = canonicalActor(firstRecord(root, ["author", "user"]));
  if (author) picked.author = author;
  return Object.keys(picked).length ? picked : null;
}

/**
 * Converts both legacy fixtures and the real camelCase React props into one
 * privacy-filtered shape. Only explicit notification/business fields survive.
 */
export function canonicalizeNotificationCandidate(
  value: unknown,
): CanonicalNotificationCandidate | null {
  const root = findRecordWithNoticeId(value);
  if (!root) return null;
  const noticeId = stableId(root.notice_id) ?? stableId(root.noticeId);
  if (!noticeId) return null;
  const noticeInfo = firstRecord(root, ["noticeInfo", "notice_info"]);
  const commentSource = firstRecord(noticeInfo ?? {}, ["comment"])
    ?? firstRecord(root, ["comment", "comment_info", "commentInfo"]);
  const workSource = firstRecord(noticeInfo ?? {}, ["aweme", "item", "work"])
    ?? firstRecord(root, ["aweme", "item", "work", "aweme_info", "item_info"]);
  const userSource = firstRecord(noticeInfo ?? {}, ["from_user", "user", "actor"])
    ?? firstRecord(root, ["user", "actor", "from_user", "author", "notice_user"]);
  const logSource = firstRecord(root, ["noticeLogInfo", "notice_log_info", "log_info"]);
  const noticeTypeValue = root.notice_type ?? root.noticeType;
  const createTimeValue = root.create_time ?? root.createTime ?? root.created_at ?? root.timestamp;
  const schemaUrl = firstText(noticeInfo, ["schema_url", "schemaUrl"], 2_000)
    ?? firstText(root, ["schema_url", "schemaUrl"], 2_000)
    ?? firstText(workSource, ["schema_url", "schemaUrl", "share_url"], 2_000);
  return {
    notice_id: noticeId,
    notice_type: typeof noticeTypeValue === "number"
      ? String(noticeTypeValue)
      : text(noticeTypeValue, 40) ?? "unknown",
    create_time: typeof createTimeValue === "number" || typeof createTimeValue === "string"
      ? createTimeValue
      : null,
    noticeLogInfo: pickPrimitiveFields(logSource, ["interact_type", "interactType"]) ?? {},
    aweme_id: firstId(root, ["aweme_id", "awemeId", "item_id"])
      ?? firstId(commentSource, ["aweme_id", "item_id"])
      ?? firstId(workSource, ["aweme_id", "item_id"])
      ?? schemaWorkId(schemaUrl),
    schema_url: schemaUrl,
    content: firstText(noticeInfo, ["content"], 1_000)
      ?? firstText(root, ["display_content", "notice_content"], 1_000),
    user: canonicalActor(userSource),
    comment: canonicalComment(commentSource),
    aweme: canonicalWork(workSource),
    unread: root.unread ?? root.is_unread ?? root.read_status ?? null,
    time_text: firstText(root, ["time_text", "timeText", "create_time_text"], 120),
  };
}

export function notificationExtractionFailureCode(
  diagnostics: NotificationExtractionDiagnostics,
  extractedCount: number,
): string | null {
  if (extractedCount > 0) return null;
  if (diagnostics.visibleNotificationRowCount > 0) {
    return "NOTIFICATION_EXTRACTION_EMPTY_WITH_VISIBLE_ROWS";
  }
  if (diagnostics.camelCaseNoticeIdCount > 0 || diagnostics.snakeCaseNoticeIdCount > 0) {
    return "NOTIFICATION_REACT_SHAPE_UNSUPPORTED";
  }
  if (diagnostics.panelOpen && diagnostics.emptyStateConfirmed) return null;
  if (diagnostics.panelOpen) return "NOTIFICATION_EMPTY_STATE_UNCONFIRMED";
  return "NOTIFICATION_PANEL_NOT_OPEN";
}

function schemaWorkId(value: unknown): string | null {
  const raw = text(value, 2_000);
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    const url = new URL(decoded, "https://www.douyin.com");
    return stableId(url.searchParams.get("modal_id"))
      ?? stableId(url.searchParams.get("aweme_id"))
      ?? stableId(url.searchParams.get("item_id"))
      ?? stableId(url.pathname.match(/\/(?:video|note|article)\/(\d{8,24})/)?.[1]);
  } catch {
    return stableId(raw.match(/\/(?:video|note|article)\/(\d{8,24})/)?.[1]);
  }
}

function canonicalWorkUrl(workId: string | null, schemaUrl: string | null): string | null {
  if (!workId) return null;
  if (schemaUrl) {
    const match = schemaUrl.match(/https?:\/\/www\.douyin\.com\/(?:video|note|article)\/\d{8,24}/);
    if (match && schemaWorkId(match[0]) === workId) return match[0];
  }
  return `https://www.douyin.com/video/${workId}`;
}

function contentType(schemaUrl: string | null, workRecord: JsonRecord | null): NotificationWork["contentType"] {
  const hint = `${schemaUrl ?? ""} ${firstText(workRecord, ["content_type", "aweme_type", "type"], 80) ?? ""}`;
  if (/\/note\/|image|note|图文/i.test(hint)) return "note";
  if (/\/article\/|article|文章/i.test(hint)) return "article";
  if (/\/video\/|video|视频/i.test(hint)) return "video";
  return "unknown";
}

function unavailableFromStableFields(root: JsonRecord | null): boolean {
  if (!root) return false;
  const flags = ["is_deleted", "is_delete", "deleted", "invalid", "is_invalid", "private"];
  if (flags.some(key => root[key] === true || root[key] === 1 || root[key] === "1")) return true;
  const status = firstText(root, ["availability", "status_text", "status_desc", "invalid_reason"], 160);
  return Boolean(status && /已删除|无法查看|不可查看|私密|失效|不存在/.test(status));
}

function actorFrom(root: JsonRecord | null): NotificationActor {
  return {
    uid: firstId(root, ["uid", "user_id"]),
    secUid: firstText(root, ["sec_uid", "secUid"], 180),
    nickname: firstText(root, ["nickname", "nick_name", "display_name"], 160),
  };
}

function normalizedInteractType(root: JsonRecord): string {
  const log = firstRecord(root, ["noticeLogInfo", "notice_log_info", "log_info"]);
  return (firstText(log, ["interact_type", "interactType"], 80)
    ?? firstText(root, ["interact_type", "interactType"], 80)
    ?? "unknown").toLocaleLowerCase();
}

export function classifyNotification(input: {
  noticeType: string;
  interactType: string;
  hasWorkId: boolean;
  hasCommentId: boolean;
}): { filterType: NotificationFilter; targetKind: NotificationTargetKind } {
  const interact = input.interactType.toLocaleLowerCase();
  if (interact === "at" || interact === "mention" || input.noticeType === "45") {
    return input.hasCommentId
      ? { filterType: "mentions", targetKind: "comment" }
      : { filterType: "mentions", targetKind: input.hasWorkId ? "work_mention" : "unknown" };
  }
  if (interact === "comment" || input.noticeType === "31") {
    return { filterType: "comments", targetKind: input.hasCommentId ? "comment" : "unknown" };
  }
  if (/^(?:digg|like)(?:_|$)/.test(interact) || input.noticeType === "41") {
    return { filterType: "likes", targetKind: "like" };
  }
  if (/^(?:follow|follower)$/.test(interact)) return { filterType: "followers", targetKind: "follower" };
  if (/^(?:recommend|recommendation)$/.test(interact)) {
    return { filterType: "recommendations", targetKind: "recommendation" };
  }
  return { filterType: "all", targetKind: "unknown" };
}

function createdAt(root: JsonRecord): string | null {
  const value = root.create_time ?? root.created_at ?? root.timestamp;
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{10,13}$/.test(value)
    ? Number(value)
    : NaN;
  if (!Number.isFinite(numeric)) return null;
  const millis = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseNotificationCandidate(value: unknown): ParsedNotificationCandidate {
  const root = canonicalizeNotificationCandidate(value);
  if (!root) return { item: null, error: "NOTIFICATION_STABLE_NOTICE_ID_MISSING" };
  const noticeId = stableId(root.notice_id);
  if (!noticeId) return { item: null, error: "NOTIFICATION_STABLE_NOTICE_ID_MISSING" };
  const noticeType = root.notice_type;
  const interactType = normalizedInteractType(root);
  const commentRecord = firstRecord(root, ["comment", "comment_info", "commentInfo"]);
  const workRecord = firstRecord(root, ["aweme", "item", "work", "aweme_info", "item_info"]);
  const actorRecord = firstRecord(root, ["user", "actor", "from_user", "author", "notice_user"])
    ?? firstRecord(commentRecord ?? {}, ["user", "author"]);
  const workAuthorRecord = firstRecord(workRecord ?? {}, ["author", "user"]);
  const schemaUrl = firstText(root, ["schema_url", "schemaUrl"], 2_000)
    ?? firstText(workRecord, ["schema_url", "schemaUrl", "share_url"], 2_000);
  const workId = firstId(root, ["aweme_id", "item_id"])
    ?? firstId(workRecord, ["aweme_id", "item_id"])
    ?? schemaWorkId(schemaUrl);
  const commentId = firstId(commentRecord, ["cid", "comment_id"]);
  const workUnavailable = unavailableFromStableFields(workRecord) || unavailableFromStableFields(root);
  const commentUnavailable = unavailableFromStableFields(commentRecord);
  const classification = classifyNotification({
    noticeType,
    interactType,
    hasWorkId: Boolean(workId),
    hasCommentId: Boolean(commentId),
  });
  const availability: NotificationAvailability = workUnavailable
    ? "unavailable"
    : workId ? "available" : "unknown";
  const commentAvailability: NotificationAvailability = commentUnavailable
    ? "unavailable"
    : commentId ? "available" : "unknown";
  const openable = Boolean(workId)
    && availability !== "unavailable"
    && (classification.targetKind !== "comment" || Boolean(commentId && commentAvailability !== "unavailable"));
  const replyable = openable
    && (classification.targetKind === "comment" || classification.targetKind === "work_mention");
  const unreadValue = root.unread ?? root.is_unread ?? root.read_status;
  const unread = typeof unreadValue === "boolean" ? unreadValue
    : unreadValue === 1 || unreadValue === "1" ? true
      : unreadValue === 0 || unreadValue === "0" ? false : null;
  return {
    item: {
      noticeId,
      noticeType,
      interactType,
      filterType: classification.filterType,
      actor: actorFrom(actorRecord),
      work: {
        workId,
        url: canonicalWorkUrl(workId, schemaUrl),
        contentType: contentType(schemaUrl, workRecord),
        description: firstText(workRecord, ["desc", "description", "title"], 500)
          ?? firstText(root, ["aweme_desc", "work_desc"], 500),
        availability,
        author: actorFrom(workAuthorRecord),
      },
      comment: {
        commentId,
        text: firstText(commentRecord, ["text", "content", "comment_text"], 1_000),
        parentCommentId: firstId(commentRecord, ["reply_id", "parent_comment_id", "parent_id"]),
        rootCommentId: firstId(commentRecord, ["reply_to_reply_id", "root_comment_id", "root_id"])
          ?? commentId,
        availability: commentAvailability,
      },
      displayContent: root.content,
      timeText: firstText(root, ["time_text", "timeText", "create_time_text"], 120),
      createdAt: createdAt(root),
      unread,
      targetKind: classification.targetKind,
      openable,
      replyable,
      privacyFiltered: true,
      parseVersion: NOTIFICATION_PARSE_VERSION,
    },
    error: null,
  };
}

export function dedupeNotifications(items: NotificationItem[]): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const item of items) if (!byId.has(item.noticeId)) byId.set(item.noticeId, item);
  return [...byId.values()];
}

export function notificationSnapshotHash(item: NotificationItem): string {
  return createHash("sha256").update(JSON.stringify({
    noticeId: item.noticeId,
    noticeType: item.noticeType,
    interactType: item.interactType,
    actorUid: item.actor.uid,
    actorSecUid: item.actor.secUid,
    workId: item.work.workId,
    workAuthorUid: item.work.author.uid,
    workAuthorSecUid: item.work.author.secUid,
    commentId: item.comment.commentId,
    targetKind: item.targetKind,
    availability: item.work.availability,
  })).digest("hex");
}

export function freezeNotificationReplyTarget(
  item: NotificationItem,
): FrozenNotificationReplyTarget {
  if (!item.replyable || !item.openable) {
    throw new Error(`NOTIFICATION_NOT_REPLYABLE:${item.noticeId}`);
  }
  if (!item.work.workId) throw new Error("NOTIFICATION_WORK_ID_MISSING");
  if (item.targetKind !== "comment" && item.targetKind !== "work_mention") {
    throw new Error(`NOTIFICATION_TARGET_KIND_NOT_REPLYABLE:${item.targetKind}`);
  }
  if (item.targetKind === "comment" && !item.comment.commentId) {
    throw new Error("NOTIFICATION_COMMENT_ID_MISSING");
  }
  return {
    noticeId: item.noticeId,
    interactType: item.interactType,
    targetKind: item.targetKind,
    workId: item.work.workId,
    commentId: item.targetKind === "comment" ? item.comment.commentId : null,
    actorUid: item.actor.uid,
    actorSecUid: item.actor.secUid,
    snapshotHash: notificationSnapshotHash(item),
  };
}

export function compactNotification(item: NotificationItem): Record<string, unknown> {
  return {
    noticeId: item.noticeId,
    noticeType: item.noticeType,
    interactType: item.interactType,
    filterType: item.filterType,
    actor: {
      uid: item.actor.uid,
      secUid: item.actor.secUid,
      nickname: item.actor.nickname,
    },
    work: item.work.workId ? {
      workId: item.work.workId,
      contentType: item.work.contentType,
      description: item.work.description,
      availability: item.work.availability,
    } : null,
    comment: item.comment.commentId ? {
      commentId: item.comment.commentId,
      text: item.comment.text,
      parentCommentId: item.comment.parentCommentId,
      rootCommentId: item.comment.rootCommentId,
      availability: item.comment.availability,
    } : null,
    timeText: item.timeText,
    createdAt: item.createdAt,
    unread: item.unread,
    targetKind: item.targetKind,
    openable: item.openable,
    replyable: item.replyable,
    privacyFiltered: true,
  };
}
