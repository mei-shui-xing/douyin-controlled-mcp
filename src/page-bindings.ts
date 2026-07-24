import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { loadActionSettings } from "./action-config.js";
import { getDatabase, getMetadata, setMetadata, withImmediateTransaction } from "./sqlite.js";
import type { PageRole } from "./state-store.js";

export type PageBinding = {
  role: PageRole;
  pageId: string;
  targetId: string;
  url: string;
  account: string | null;
  accountUid: string | null;
  accountSecUid: string | null;
  browserProfileId: string;
  pageTitle: string | null;
  verifiedAt: string;
  boundAt: string;
};

type LegacyPageBinding = Partial<PageBinding> & {
  role?: PageRole;
  pageId?: string;
  targetId?: string;
  url?: string;
};

const legacyBindingFile = path.join(CONFIG.runtimeDir, "page-bindings.json");
const browserProfilePath = path.resolve(CONFIG.runtimeDir, "browser-profile").toLocaleLowerCase();

export const browserProfileId = crypto.createHash("sha256")
  .update(browserProfilePath, "utf8")
  .digest("hex")
  .slice(0, 24);

function migrateLegacyBindings(): void {
  if (getMetadata("page_bindings_json_migrated") === "1") return;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyBindingFile, "utf8")) as {
      bindings?: LegacyPageBinding[];
    };
    withImmediateTransaction(db => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO page_bindings(
          role, page_id, target_id, url, account_display_name,
          account_uid, account_sec_uid, browser_profile_id,
          page_title, verified_at, bound_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const operator = loadActionSettings().operator;
      for (const binding of parsed.bindings ?? []) {
        if (!binding.role || !binding.pageId || !binding.targetId || !binding.url) continue;
        const verifiedAt = binding.verifiedAt
          ?? binding.boundAt
          ?? new Date(0).toISOString();
        const isOperator = binding.account === operator.displayName;
        insert.run(
          binding.role,
          binding.pageId,
          binding.targetId,
          binding.url,
          binding.account ?? null,
          binding.accountUid ?? (isOperator ? operator.uid : null),
          binding.accountSecUid ?? (isOperator ? operator.secUid : null),
          binding.browserProfileId ?? browserProfileId,
          binding.pageTitle ?? null,
          verifiedAt,
          binding.boundAt ?? verifiedAt,
        );
      }
    });
  } catch {
    // Fresh installations have no legacy binding file.
  }
  setMetadata("page_bindings_json_migrated", "1");
}

function rowToBinding(row: Record<string, unknown>): PageBinding {
  return {
    role: String(row.role) as PageRole,
    pageId: String(row.page_id),
    targetId: String(row.target_id),
    url: String(row.url),
    account: typeof row.account_display_name === "string" ? row.account_display_name : null,
    accountUid: typeof row.account_uid === "string" ? row.account_uid : null,
    accountSecUid: typeof row.account_sec_uid === "string" ? row.account_sec_uid : null,
    browserProfileId: String(row.browser_profile_id),
    pageTitle: typeof row.page_title === "string" ? row.page_title : null,
    verifiedAt: String(row.verified_at),
    boundAt: String(row.bound_at),
  };
}

export function loadPageBindings(): Map<PageRole, PageBinding> {
  migrateLegacyBindings();
  const rows = getDatabase().prepare(
    "SELECT * FROM page_bindings",
  ).all() as Array<Record<string, unknown>>;
  return new Map(rows.map(row => {
    const binding = rowToBinding(row);
    return [binding.role, binding];
  }));
}

export function savePageBinding(binding: Omit<PageBinding,
  "accountUid" | "accountSecUid" | "browserProfileId" | "pageTitle" | "verifiedAt"
> & Partial<Pick<PageBinding,
  "accountUid" | "accountSecUid" | "browserProfileId" | "pageTitle" | "verifiedAt"
>>): void {
  migrateLegacyBindings();
  const operator = loadActionSettings().operator;
  const isOperator = binding.account === operator.displayName;
  const verifiedAt = binding.verifiedAt ?? new Date().toISOString();
  withImmediateTransaction(db => {
    db.prepare(`
      INSERT INTO page_bindings(
        role, page_id, target_id, url, account_display_name,
        account_uid, account_sec_uid, browser_profile_id,
        page_title, verified_at, bound_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        page_id=excluded.page_id,
        target_id=excluded.target_id,
        url=excluded.url,
        account_display_name=excluded.account_display_name,
        account_uid=excluded.account_uid,
        account_sec_uid=excluded.account_sec_uid,
        browser_profile_id=excluded.browser_profile_id,
        page_title=excluded.page_title,
        verified_at=excluded.verified_at,
        bound_at=excluded.bound_at
    `).run(
      binding.role,
      binding.pageId,
      binding.targetId,
      binding.url,
      binding.account,
      binding.accountUid ?? (isOperator ? operator.uid : null),
      binding.accountSecUid ?? (isOperator ? operator.secUid : null),
      binding.browserProfileId ?? browserProfileId,
      binding.pageTitle ?? null,
      verifiedAt,
      binding.boundAt,
    );
  });
}

export function removePageBinding(role: PageRole): void {
  migrateLegacyBindings();
  withImmediateTransaction(db => {
    db.prepare("DELETE FROM page_bindings WHERE role=?").run(role);
  });
}
