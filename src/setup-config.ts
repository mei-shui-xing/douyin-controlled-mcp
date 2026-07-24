import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { loadActionSettings, loadBoundUsers } from "./action-config.js";
import { loadSafeSocialActions } from "./social-config.js";

export type DetectedAccountCandidate = {
  displayName: string;
  uid: string;
  secUid: string;
  source: string;
  pageUrl?: string;
};

export type DetectedSetupAccount = {
  displayName: string;
  uid: string;
  secUid: string;
  evidenceSources: string[];
  pageCount: number;
};

export type SetupPreferences = {
  operatorAlias: string;
  publicComment: boolean;
  commentReply: boolean;
  publishVideo: boolean;
  publishArticle: boolean;
  maxWritesPerMinute: number;
  shareCooldownMinutes: number;
  minDelayMs: number;
  maxDelayMs: number;
};

const ACTION_SETTINGS_FILE = "douyin_action_settings.json";
const BOUND_USERS_FILE = "douyin_bound_users.json";
const SOCIAL_ACTIONS_FILE = "douyin_social_actions.json";
const SETUP_FILES = [ACTION_SETTINGS_FILE, BOUND_USERS_FILE, SOCIAL_ACTIONS_FILE] as const;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function validUid(value: string): boolean {
  return /^\d{5,30}$/.test(value);
}

function validSecUid(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function shortFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function maskStableId(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

export function resolveDetectedAccount(
  candidates: DetectedAccountCandidate[],
): DetectedSetupAccount {
  const normalized = candidates.flatMap(candidate => {
    const displayName = cleanText(candidate.displayName);
    const uid = cleanText(candidate.uid);
    const secUid = cleanText(candidate.secUid);
    if (!displayName || !validUid(uid) || !validSecUid(secUid) || uid === secUid) return [];
    return [{
      displayName,
      uid,
      secUid,
      source: cleanText(candidate.source) || "unknown",
      pageUrl: cleanText(candidate.pageUrl),
    }];
  });

  const identities = new Map<string, typeof normalized>();
  for (const candidate of normalized) {
    const key = `${candidate.uid}:${candidate.secUid}`;
    const existing = identities.get(key) ?? [];
    existing.push(candidate);
    identities.set(key, existing);
  }

  if (identities.size === 0) {
    throw new Error(
      "SETUP_ACCOUNT_NOT_DETECTED: No stable account identity containing display name, uid and sec_uid was found. Sign in and open your own profile or Creator Center, then retry.",
    );
  }
  if (identities.size > 1) {
    throw new Error(
      `SETUP_ACCOUNT_CONFLICT: Found ${identities.size} different account identities in allowed tabs. Keep only the account being configured open, then retry.`,
    );
  }

  const matches = [...identities.values()][0];
  const displayNames = [...new Set(matches.map(item => item.displayName))];
  if (displayNames.length !== 1) {
    throw new Error(
      "SETUP_ACCOUNT_NAME_CONFLICT: One stable identity has multiple display names. Refresh the account page and retry.",
    );
  }

  return {
    displayName: displayNames[0],
    uid: matches[0].uid,
    secUid: matches[0].secUid,
    evidenceSources: [...new Set(matches.map(item => item.source))].sort(),
    pageCount: new Set(matches.map(item => item.pageUrl).filter(Boolean)).size,
  };
}

function publicAccount(account: DetectedSetupAccount) {
  return {
    displayName: account.displayName,
    uidMasked: maskStableId(account.uid),
    secUidMasked: maskStableId(account.secUid),
    identityFingerprint: shortFingerprint(`${account.uid}:${account.secUid}`),
    evidenceSources: account.evidenceSources,
    pageCount: account.pageCount,
  };
}

function probeConfig(fileName: typeof SETUP_FILES[number], loader: () => unknown) {
  const filePath = path.join(CONFIG.privateConfigDir, fileName);
  if (!fs.existsSync(filePath)) {
    return { file: fileName, exists: false, valid: false, error: null };
  }
  try {
    loader();
    return { file: fileName, exists: true, valid: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      file: fileName,
      exists: true,
      valid: false,
      error: message.replaceAll(CONFIG.privateConfigDir, "<private-config>"),
    };
  }
}

export function getSetupStatus() {
  const files = [
    probeConfig(ACTION_SETTINGS_FILE, loadActionSettings),
    probeConfig(BOUND_USERS_FILE, loadBoundUsers),
    probeConfig(SOCIAL_ACTIONS_FILE, loadSafeSocialActions),
  ];
  const complete = files.every(file => file.valid);
  let operator: { alias: string; displayName: string } | null = null;
  if (files[0].valid) {
    const settings = loadActionSettings();
    operator = {
      alias: settings.operator.alias,
      displayName: settings.operator.displayName,
    };
  }
  return {
    setupRequired: !complete,
    complete,
    privateConfigLocation: "runtime/private-config",
    files,
    operator,
    nextAction: complete
      ? "Call douyin_validate_setup. To change accounts, the owner must first back up and move the existing private configuration."
      : "Sign in, call douyin_detect_current_account, ask the owner for an alias and permissions, then call douyin_configure_initial_setup.",
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function applyInitialSetup(
  account: DetectedSetupAccount,
  preferences: SetupPreferences,
) {
  const digest = shortFingerprint(JSON.stringify({
    account: { displayName: account.displayName, uid: account.uid, secUid: account.secUid },
    preferences,
  }));
  await fs.promises.mkdir(CONFIG.privateConfigDir, { recursive: true });
  const existing = SETUP_FILES.filter(fileName =>
    fs.existsSync(path.join(CONFIG.privateConfigDir, fileName)));
  if (existing.length > 0) {
    throw new Error(
      `SETUP_EXISTING_CONFIG_REFUSED: Existing private configuration will not be overwritten (${existing.join(", ")}). The owner must back it up and move it explicitly.`,
    );
  }

  const actionSettings = {
    operator: {
      alias: preferences.operatorAlias,
      display_name: account.displayName,
      uid: account.uid,
      sec_uid: account.secUid,
    },
    rate_limit: {
      max_writes_per_minute: preferences.maxWritesPerMinute,
      share_cooldown_minutes: preferences.shareCooldownMinutes,
      min_delay_ms: preferences.minDelayMs,
      max_delay_ms: preferences.maxDelayMs,
    },
    features: {
      public_comment: preferences.publicComment,
      comment_reply: preferences.commentReply,
      publish_video: preferences.publishVideo,
      publish_article: preferences.publishArticle,
    },
  };

  const created: string[] = [];
  try {
    for (const [fileName, value] of [
      [BOUND_USERS_FILE, {}],
      [SOCIAL_ACTIONS_FILE, {}],
      [ACTION_SETTINGS_FILE, actionSettings],
    ] as const) {
      const target = path.join(CONFIG.privateConfigDir, fileName);
      await writeJsonAtomically(target, value);
      created.push(target);
    }
    const status = getSetupStatus();
    if (!status.complete) {
      throw new Error("SETUP_VALIDATION_FAILED: Written configuration did not pass validation.");
    }
    return {
      applied: true,
      digest,
      account: publicAccount(account),
      preferences,
      status,
      restartRecommended: false,
    };
  } catch (error) {
    for (const target of created.reverse()) {
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export function validateSetup() {
  const status = getSetupStatus();
  if (!status.complete) {
    return {
      valid: false,
      status,
      boundUserCount: 0,
      safeSocialActionCount: 0,
      features: null,
    };
  }
  const settings = loadActionSettings();
  return {
    valid: true,
    status,
    boundUserCount: loadBoundUsers().size,
    safeSocialActionCount: loadSafeSocialActions().size,
    features: settings.features,
    rateLimit: settings.rateLimit,
  };
}

export function describeDetectedAccount(account: DetectedSetupAccount) {
  return publicAccount(account);
}
