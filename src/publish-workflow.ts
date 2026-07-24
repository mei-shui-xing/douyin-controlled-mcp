import { createHash, randomUUID } from "node:crypto";

export const PUBLISH_STATES = [
  "draft",
  "preparing",
  "preview_ready",
  "needs_user_action",
  "publishing",
  "published",
  "blocked",
  "failed",
] as const;

export type PublishWorkflowStatus = typeof PUBLISH_STATES[number];

export const PUBLISH_ERROR_CODES = [
  "MISSING_COVER",
  "MISSING_TITLE",
  "MISSING_TEXT",
  "HASHTAG_NOT_CONFIRMED",
  "WRONG_PAGE",
  "WRONG_ACCOUNT",
  "PAGE_BINDING_LOST",
  "MUSIC_STATUS_UNKNOWN",
  "VISIBILITY_NOT_SET",
  "PUBLISH_TIME_NOT_SET",
  "PAGE_ERROR_PRESENT",
  "SNAPSHOT_REQUIRED",
  "SNAPSHOT_MISMATCH",
  "PUBLISH_EVIDENCE_INCOMPLETE",
  "DUPLICATE_PUBLISH",
  "VALIDATION_FAILED",
] as const;

export type PublishErrorCode = typeof PUBLISH_ERROR_CODES[number];

export type CoverSnapshot = {
  selected: boolean;
  source: string | null;
  thumbnailCount: number;
};

export type MusicSnapshot = {
  selected: boolean;
  id: string | null;
  title: string | null;
  author: string | null;
  version: string | null;
  duration: string | null;
  explicitNone: boolean;
};

export type PublishSnapshot = {
  title: string;
  text: string;
  textLength: number;
  paragraphCount: number;
  hashtags: string[];
  cover: CoverSnapshot;
  music: MusicSnapshot;
  visibility: string;
  publishTime: string;
  account: string;
  pageId: string;
  pageTargetId: string;
  pageUrl: string;
  errorPrompts: string[];
  preflightPassed: boolean;
  capturedAt: string;
};

export type PreflightResult = {
  passed: boolean;
  status: "preview_ready" | "needs_user_action" | "blocked";
  errorCode: PublishErrorCode | null;
  missing: PublishErrorCode[];
};

const transitions: Record<PublishWorkflowStatus, ReadonlySet<PublishWorkflowStatus>> = {
  draft: new Set(["preparing", "blocked", "failed"]),
  preparing: new Set(["preview_ready", "needs_user_action", "blocked", "failed"]),
  preview_ready: new Set(["publishing", "preparing", "needs_user_action", "blocked", "failed"]),
  needs_user_action: new Set(["preparing", "preview_ready", "blocked", "failed"]),
  publishing: new Set(["published", "needs_user_action", "blocked", "failed"]),
  published: new Set(),
  blocked: new Set(["preparing", "failed"]),
  failed: new Set(["preparing"]),
};

export function assertPublishTransition(from: PublishWorkflowStatus, to: PublishWorkflowStatus): void {
  if (!transitions[from].has(to)) {
    throw new Error(`INVALID_STATE_TRANSITION:${from}->${to}`);
  }
}

export function normalizeHashtag(value: string): string {
  const clean = value.replace(/^#+/, "").trim();
  return /^[\x00-\x7F]+$/.test(clean) ? clean.toLocaleLowerCase("en-US") : clean;
}

export function hashtagsEqual(left: string, right: string): boolean {
  return normalizeHashtag(left) === normalizeHashtag(right);
}

export function publisherTextEquivalent(left: string, right: string): boolean {
  const canonical = (value: string) => value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  return canonical(left) === canonical(right);
}

export function normalizeHashtags(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const display = value.replace(/^#+/, "").trim();
    if (!display) continue;
    if (!result.some(existing => hashtagsEqual(existing, display))) result.push(display);
  }
  return result;
}

export function evaluatePreflight(snapshot: PublishSnapshot, expected: {
  account: string;
  pageId: string;
  pageTargetId: string;
  title: string;
  text: string;
  hashtags: string[];
  coverRequired: boolean;
  musicRequired?: boolean;
}): PreflightResult {
  const missing: PublishErrorCode[] = [];
  if (!snapshot.title.trim()) missing.push("MISSING_TITLE");
  if (!snapshot.text.trim()) missing.push("MISSING_TEXT");
  if (snapshot.title.trim() !== expected.title.trim()
    || !publisherTextEquivalent(snapshot.text, expected.text)) {
    missing.push("VALIDATION_FAILED");
  }
  const actualTags = normalizeHashtags(snapshot.hashtags);
  const expectedTags = normalizeHashtags(expected.hashtags);
  if (actualTags.length !== expectedTags.length
    || expectedTags.some(tag => !actualTags.some(actual => hashtagsEqual(actual, tag)))) {
    missing.push("HASHTAG_NOT_CONFIRMED");
  }
  if (expected.coverRequired && !snapshot.cover.selected) missing.push("MISSING_COVER");
  if (expected.musicRequired === true
    && !snapshot.music.selected
    && !snapshot.music.explicitNone) {
    missing.push("MUSIC_STATUS_UNKNOWN");
  }
  if (!snapshot.visibility.trim()) missing.push("VISIBILITY_NOT_SET");
  if (!snapshot.publishTime.trim()) missing.push("PUBLISH_TIME_NOT_SET");
  if (snapshot.errorPrompts.length) missing.push("PAGE_ERROR_PRESENT");
  if (snapshot.account !== expected.account) missing.push("WRONG_ACCOUNT");
  if (snapshot.pageId !== expected.pageId
    || snapshot.pageTargetId !== expected.pageTargetId
    || !snapshot.pageUrl.includes("creator.douyin.com/creator-micro/content/")) {
    missing.push("WRONG_PAGE");
  }
  const unique = [...new Set(missing)];
  const blocked = unique.includes("WRONG_ACCOUNT") || unique.includes("WRONG_PAGE");
  return {
    passed: unique.length === 0,
    status: unique.length === 0 ? "preview_ready" : blocked ? "blocked" : "needs_user_action",
    errorCode: unique[0] ?? null,
    missing: unique,
  };
}

export function snapshotDigest(snapshot: PublishSnapshot): string {
  const locked = {
    title: snapshot.title,
    text: snapshot.text,
    hashtags: normalizeHashtags(snapshot.hashtags).map(normalizeHashtag).sort(),
    cover: snapshot.cover,
    music: snapshot.music,
    visibility: snapshot.visibility,
    publishTime: snapshot.publishTime,
    account: snapshot.account,
    pageId: snapshot.pageId,
    pageTargetId: snapshot.pageTargetId,
    pageUrl: snapshot.pageUrl,
  };
  return createHash("sha256").update(JSON.stringify(locked)).digest("hex");
}

type LockedSnapshot = {
  previewId: string;
  digest: string;
  snapshot: PublishSnapshot;
  published: boolean;
  submitAttempted: boolean;
  workId: string | null;
  workUrl: string | null;
  createdAt: string;
};

export class PublishSnapshotStore {
  private readonly records = new Map<string, LockedSnapshot>();

  lock(snapshot: PublishSnapshot): LockedSnapshot {
    const previewId = randomUUID();
    const record = {
      previewId,
      digest: snapshotDigest(snapshot),
      snapshot,
      published: false,
      submitAttempted: false,
      workId: null,
      workUrl: null,
      createdAt: new Date().toISOString(),
    };
    this.records.set(previewId, record);
    return record;
  }

  verify(previewId: string, current: PublishSnapshot): LockedSnapshot {
    const record = this.records.get(previewId);
    if (!record) throw new Error("SNAPSHOT_REQUIRED");
    if (record.published || record.submitAttempted) throw new Error("DUPLICATE_PUBLISH");
    if (record.digest !== snapshotDigest(current)) throw new Error("SNAPSHOT_MISMATCH");
    return record;
  }

  markPublished(previewId: string, evidence: { workId?: string; workUrl?: string } = {}): void {
    const record = this.records.get(previewId);
    if (!record) throw new Error("SNAPSHOT_REQUIRED");
    record.published = true;
    record.workId = evidence.workId ?? record.workId;
    record.workUrl = evidence.workUrl ?? record.workUrl;
  }

  markSubmitAttempted(previewId: string): void {
    const record = this.records.get(previewId);
    if (!record) throw new Error("SNAPSHOT_REQUIRED");
    if (record.submitAttempted || record.published) throw new Error("DUPLICATE_PUBLISH");
    record.submitAttempted = true;
  }

  read(previewId: string): LockedSnapshot | null {
    const record = this.records.get(previewId);
    return record ? {
      ...record,
      snapshot: {
        ...record.snapshot,
        hashtags: [...record.snapshot.hashtags],
        cover: { ...record.snapshot.cover },
        music: { ...record.snapshot.music },
        errorPrompts: [...record.snapshot.errorPrompts],
      },
    } : null;
  }
}

export const INCIDENT_REGRESSION = {
  fixtureName: "operator-first-article-missing-cover",
  contentType: "article",
  hashtags: ["ChatGPT", "AI日常", "人机恋", "AI陪伴"],
  expected: {
    preflightError: "MISSING_COVER" as const,
    published: false,
    neverTreatButtonClickAsSuccess: true,
  },
};
