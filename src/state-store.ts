import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { getDatabase, getMetadata, setMetadata, withImmediateTransaction } from "./sqlite.js";

export type PageRole =
  | "operator_home"
  | "bound_messages"
  | "codex_test"
  | "publisher"
  | "creator_center"
  | "notifications"
  | "notification_target";

export type SavedPageState = {
  pageId: string;
  targetId?: string;
  role: PageRole;
  url: string;
  workId: string | null;
  scrollX: number;
  scrollY: number;
  savedAt: string;
};

type PersistentUsageState = {
  version: 2;
  messageIdentityVersion: string | null;
  viewedMessageIds: string[];
  knownMessageIds: string[];
  viewedWorkIds: string[];
  viewedProfileWorkIds: string[];
  knownOwnCommentIds: string[];
  knownCreatorCommentIds: string[];
  lastPageStates: SavedPageState[];
  updatedAt: string;
};

const stateFile = path.join(CONFIG.runtimeDir, "douyin-usage-state.json");

const emptyState = (): PersistentUsageState => ({
  version: 2,
  messageIdentityVersion: null,
  viewedMessageIds: [],
  knownMessageIds: [],
  viewedWorkIds: [],
  viewedProfileWorkIds: [],
  knownOwnCommentIds: [],
  knownCreatorCommentIds: [],
  lastPageStates: [],
  updatedAt: new Date(0).toISOString(),
});

export type MessageIdentityMergeResult = {
  identityVersion: string;
  knownMessageIds: string[];
  viewedMessageIds: string[];
  freshMessageIds: string[];
  baselineCreated: boolean;
};

export function mergeMessageIdentityState(input: {
  knownMessageIds: string[];
  viewedMessageIds: string[];
  currentIdentityVersion: string | null;
  nextIdentityVersion: string;
  incomingMessageIds: string[];
}): MessageIdentityMergeResult {
  const incoming = [...new Set(input.incomingMessageIds.filter(Boolean))];
  if (input.currentIdentityVersion !== input.nextIdentityVersion) {
    return {
      identityVersion: input.nextIdentityVersion,
      knownMessageIds: incoming,
      viewedMessageIds: [],
      freshMessageIds: [],
      baselineCreated: true,
    };
  }
  const known = new Set(input.knownMessageIds);
  const freshMessageIds = incoming.filter(messageId => !known.has(messageId));
  return {
    identityVersion: input.nextIdentityVersion,
    knownMessageIds: [...new Set([...input.knownMessageIds, ...incoming])],
    viewedMessageIds: [...new Set(input.viewedMessageIds.filter(Boolean))],
    freshMessageIds,
    baselineCreated: false,
  };
}

export class PersistentStateStore {
  private loaded = false;
  private state = emptyState();

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(stateFile, "utf8")) as Partial<PersistentUsageState>;
      this.state = {
        version: 2,
        messageIdentityVersion: typeof parsed.messageIdentityVersion === "string"
          ? parsed.messageIdentityVersion
          : null,
        viewedMessageIds: Array.isArray(parsed.viewedMessageIds) ? parsed.viewedMessageIds.filter(Boolean) : [],
        knownMessageIds: Array.isArray(parsed.knownMessageIds) ? parsed.knownMessageIds.filter(Boolean) : [],
        viewedWorkIds: Array.isArray(parsed.viewedWorkIds) ? parsed.viewedWorkIds.filter(Boolean) : [],
        viewedProfileWorkIds: Array.isArray(parsed.viewedProfileWorkIds) ? parsed.viewedProfileWorkIds.filter(Boolean) : [],
        knownOwnCommentIds: Array.isArray(parsed.knownOwnCommentIds) ? parsed.knownOwnCommentIds.filter(Boolean) : [],
        knownCreatorCommentIds: Array.isArray(parsed.knownCreatorCommentIds)
          ? parsed.knownCreatorCommentIds.filter(Boolean)
          : [],
        lastPageStates: Array.isArray(parsed.lastPageStates) ? parsed.lastPageStates : [],
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch {
      this.state = emptyState();
    }
    if (getMetadata("known_creator_comments_json_migrated") !== "1") {
      const now = new Date().toISOString();
      withImmediateTransaction(db => {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO seen_comments(
            comment_id, work_id, first_seen_at, last_seen_at,
            has_replied, own_reply_comment_id
          ) VALUES(?, 'legacy_unknown', ?, ?, 0, NULL)
        `);
        for (const commentId of this.state.knownCreatorCommentIds) {
          if (/^\d{8,}$/.test(commentId)) insert.run(commentId, now, now);
        }
      });
      setMetadata("known_creator_comments_json_migrated", "1");
    }
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await fs.mkdir(CONFIG.runtimeDir, { recursive: true });
    const temporary = `${stateFile}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await fs.rename(temporary, stateFile);
  }

  async viewedMessageIds(): Promise<Set<string>> {
    await this.ensureLoaded();
    return new Set(this.state.viewedMessageIds);
  }

  async messageIdentityCheckpoint(identityVersion: string): Promise<{
    baselineRequired: boolean;
    knownMessageIds: Set<string>;
  }> {
    await this.ensureLoaded();
    return {
      baselineRequired: this.state.messageIdentityVersion !== identityVersion,
      knownMessageIds: this.state.messageIdentityVersion === identityVersion
        ? new Set(this.state.knownMessageIds)
        : new Set<string>(),
    };
  }

  async consumeNewMessageIds(
    messageIds: string[],
    identityVersion = "legacy_v1",
  ): Promise<Set<string>> {
    await this.ensureLoaded();
    const merged = mergeMessageIdentityState({
      knownMessageIds: this.state.knownMessageIds,
      viewedMessageIds: this.state.viewedMessageIds,
      currentIdentityVersion: this.state.messageIdentityVersion,
      nextIdentityVersion: identityVersion,
      incomingMessageIds: messageIds,
    });
    this.state.messageIdentityVersion = merged.identityVersion;
    this.state.knownMessageIds = merged.knownMessageIds;
    this.state.viewedMessageIds = merged.viewedMessageIds;
    await this.persist();
    return new Set(merged.freshMessageIds);
  }

  async viewedWorkIds(): Promise<Set<string>> {
    await this.ensureLoaded();
    return new Set(this.state.viewedWorkIds);
  }

  async viewedProfileWorkIds(): Promise<Set<string>> {
    await this.ensureLoaded();
    return new Set(this.state.viewedProfileWorkIds);
  }

  async markMessageAndWorkViewed(messageId: string, workId: string): Promise<void> {
    await this.ensureLoaded();
    this.state.viewedMessageIds = Array.from(new Set([...this.state.viewedMessageIds, messageId]));
    this.state.viewedWorkIds = Array.from(new Set([...this.state.viewedWorkIds, workId]));
    await this.persist();
  }

  async markProfileWorkViewed(workId: string): Promise<void> {
    await this.ensureLoaded();
    this.state.viewedProfileWorkIds = Array.from(new Set([...this.state.viewedProfileWorkIds, workId]));
    this.state.viewedWorkIds = Array.from(new Set([...this.state.viewedWorkIds, workId]));
    await this.persist();
  }

  async markWorkViewed(workId: string): Promise<void> {
    await this.ensureLoaded();
    this.state.viewedWorkIds = Array.from(new Set([...this.state.viewedWorkIds, workId]));
    await this.persist();
  }

  async consumeNewOwnCommentIds(commentIds: string[]): Promise<Set<string>> {
    await this.ensureLoaded();
    const known = new Set(this.state.knownOwnCommentIds);
    const fresh = new Set(commentIds.filter(commentId => !known.has(commentId)));
    this.state.knownOwnCommentIds = Array.from(new Set([...this.state.knownOwnCommentIds, ...commentIds]));
    await this.persist();
    return fresh;
  }

  async consumeNewCreatorCommentIds(items: Array<string | {
    commentId: string;
    workId: string;
    hasReplied?: boolean;
    ownReplyCommentId?: string | null;
  }>): Promise<Set<string>> {
    await this.ensureLoaded();
    const normalized = items.map(item => typeof item === "string"
      ? {
          commentId: item,
          workId: "legacy_unknown",
          hasReplied: false,
          ownReplyCommentId: null,
        }
      : {
          commentId: item.commentId,
          workId: item.workId,
          hasReplied: item.hasReplied === true,
          ownReplyCommentId: item.ownReplyCommentId ?? null,
        });
    return withImmediateTransaction(db => {
      const fresh = new Set<string>();
      const exists = db.prepare("SELECT 1 FROM seen_comments WHERE comment_id=?");
      const upsert = db.prepare(`
        INSERT INTO seen_comments(
          comment_id, work_id, first_seen_at, last_seen_at,
          has_replied, own_reply_comment_id
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET
          work_id=excluded.work_id,
          last_seen_at=excluded.last_seen_at,
          has_replied=excluded.has_replied,
          own_reply_comment_id=COALESCE(
            excluded.own_reply_comment_id,
            seen_comments.own_reply_comment_id
          )
      `);
      const now = new Date().toISOString();
      for (const item of normalized) {
        if (!exists.get(item.commentId)) fresh.add(item.commentId);
        upsert.run(
          item.commentId,
          item.workId,
          now,
          now,
          item.hasReplied ? 1 : 0,
          item.ownReplyCommentId,
        );
      }
      return fresh;
    });
  }

  async knownCreatorCommentIds(): Promise<Set<string>> {
    await this.ensureLoaded();
    const rows = getDatabase().prepare(
      "SELECT comment_id FROM seen_comments",
    ).all() as Array<{ comment_id: string }>;
    return new Set(rows.map(row => row.comment_id));
  }

  async markCreatorCommentIds(items: Array<string | {
    commentId: string;
    workId: string;
    hasReplied?: boolean;
    ownReplyCommentId?: string | null;
  }>): Promise<void> {
    await this.ensureLoaded();
    await this.consumeNewCreatorCommentIds(items);
  }

  async savePageStates(states: SavedPageState[]): Promise<void> {
    await this.ensureLoaded();
    this.state.lastPageStates = states;
    await this.persist();
  }
}
