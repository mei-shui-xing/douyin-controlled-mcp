import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

export type BoundUser = {
  alias: string;
  displayName: string;
  profileUrl: string;
  uid: string;
  secUid: string;
  allowShare: boolean;
  allowMessage: boolean;
  allowCreatorCenter: boolean;
};

export type OperatorAccount = {
  alias: string;
  displayName: string;
  uid: string;
  secUid: string;
};

export type ActionSettings = {
  operator: OperatorAccount;
  rateLimit: {
    maxWritesPerMinute: number;
    shareCooldownMinutes: number;
    minDelayMs: number;
    maxDelayMs: number;
  };
  features: {
    publicComment: boolean;
    commentReply: boolean;
    publishVideo: boolean;
    publishArticle: boolean;
  };
};

type RawBoundUser = {
  display_name?: unknown;
  profile_url?: unknown;
  uid?: unknown;
  sec_uid?: unknown;
  allow_share?: unknown;
  allow_message?: unknown;
  allow_creator_center?: unknown;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`动作配置无效：${field} 必须是非空字符串。`);
  }
  return value.trim();
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`动作配置无效：${field} 必须是 ${min}-${max} 的整数。`);
  }
  return Number(value);
}

function loadJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取动作配置 ${path.basename(file)}：${String(error)}`);
  }
}

function canonicalProfileUrl(secUid: string): string {
  return `https://www.douyin.com/user/${encodeURIComponent(secUid)}`;
}

const boundUsersFile = path.join(CONFIG.privateConfigDir, "douyin_bound_users.json");
const settingsFile = path.join(CONFIG.privateConfigDir, "douyin_action_settings.json");

export function loadBoundUsers(): Map<string, BoundUser> {
  const raw = loadJson(boundUsersFile);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("动作配置无效：douyin_bound_users.json 顶层必须是对象。");
  }
  const users = new Map<string, BoundUser>();
  for (const [rawAlias, value] of Object.entries(raw)) {
    const alias = rawAlias.trim().toLowerCase();
    const item = value as RawBoundUser;
    const secUid = requireString(item.sec_uid, `${alias}.sec_uid`);
    const profileUrl = requireString(item.profile_url, `${alias}.profile_url`);
    if (profileUrl !== canonicalProfileUrl(secUid)) {
      throw new Error(`动作配置无效：${alias}.profile_url 必须与 sec_uid 严格对应。`);
    }
    users.set(alias, {
      alias,
      displayName: requireString(item.display_name, `${alias}.display_name`),
      profileUrl,
      uid: requireString(item.uid, `${alias}.uid`),
      secUid,
      allowShare: item.allow_share === true,
      allowMessage: item.allow_message === true,
      allowCreatorCenter: item.allow_creator_center === true,
    });
  }
  return users;
}

export function getBoundUser(alias = "bound_user"): BoundUser {
  const normalized = alias.trim().toLowerCase();
  const users = loadBoundUsers();
  const user = users.get(normalized)
    ?? (normalized === "bound_user" && users.size === 1 ? [...users.values()][0] : undefined);
  if (!user) throw new Error(`未绑定别名“${alias}”。`);
  return user;
}

export function loadActionSettings(): ActionSettings {
  const raw = loadJson(settingsFile) as Record<string, any>;
  const operator = raw?.operator ?? {};
  const rate = raw?.rate_limit ?? {};
  const features = raw?.features ?? {};
  const minDelayMs = requireInteger(rate.min_delay_ms, "rate_limit.min_delay_ms", 250, 10_000);
  const maxDelayMs = requireInteger(rate.max_delay_ms, "rate_limit.max_delay_ms", minDelayMs, 15_000);
  return {
    operator: {
      alias: typeof operator.alias === "string" && operator.alias.trim()
        ? operator.alias.trim().toLowerCase()
        : "operator",
      displayName: requireString(operator.display_name, "operator.display_name"),
      uid: requireString(operator.uid, "operator.uid"),
      secUid: requireString(operator.sec_uid, "operator.sec_uid"),
    },
    rateLimit: {
      maxWritesPerMinute: requireInteger(rate.max_writes_per_minute, "rate_limit.max_writes_per_minute", 1, 30),
      shareCooldownMinutes: requireInteger(rate.share_cooldown_minutes, "rate_limit.share_cooldown_minutes", 1, 1_440),
      minDelayMs,
      maxDelayMs,
    },
    features: {
      publicComment: features.public_comment === true,
      commentReply: features.comment_reply === true,
      publishVideo: features.publish_video === true,
      publishArticle: features.publish_article === true,
    },
  };
}

export const RESERVED_DISABLED_MESSAGE = "该能力已预留，但当前配置未启用。";
