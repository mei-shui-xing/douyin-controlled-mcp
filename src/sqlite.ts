import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config.js";

export const sqliteFile = process.env.DOUYIN_STATE_DB
  ? path.resolve(process.env.DOUYIN_STATE_DB)
  : path.join(CONFIG.runtimeDir, "douyin-state.sqlite3");

let database: DatabaseSync | null = null;
let initializationError: Error | null = null;

function migrateWriteOperationSubmitEvidence(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(write_operations)").all() as Array<{
    name?: string;
  }>;
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='write_operations'",
  ).get() as { sql?: string } | undefined;
  if (columns.some(column => column.name === "click_attempted_at")
    && tableSql?.sql?.includes("aborted_no_submit")) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TABLE IF EXISTS write_operations_v133;
      CREATE TABLE write_operations_v133 (
        operation_id TEXT PRIMARY KEY,
        reply_plan_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'own_post' CHECK (scope IN ('own_post', 'bound_user_post', 'external_post')),
        action_type TEXT NOT NULL DEFAULT 'reply_to_comment' CHECK (action_type IN (
          'create_root_comment',
          'reply_to_comment'
        )),
        actor_account TEXT NOT NULL DEFAULT 'Operator',
        page_role TEXT NOT NULL DEFAULT 'creator_center',
        work_id TEXT NOT NULL,
        work_title TEXT,
        comment_id TEXT NOT NULL DEFAULT '',
        target_author TEXT NOT NULL DEFAULT '',
        target_text TEXT NOT NULL DEFAULT '',
        target_text_hash TEXT NOT NULL DEFAULT '',
        parent_comment_id TEXT,
        root_comment_id TEXT NOT NULL DEFAULT '',
        depth INTEGER NOT NULL DEFAULT 0,
        thread_path_json TEXT NOT NULL DEFAULT '[]',
        already_replied INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT NOT NULL,
        reply_text_hash TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        target_source TEXT,
        filter_keyword TEXT,
        gate_snapshot_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL CHECK (state IN (
          'prepared',
          'click_started',
          'click_attempted',
          'click_no_effect',
          'click_effect_confirmed',
          'confirmed',
          'rejected',
          'expired',
          'unknown_after_submit',
          'failed_before_click',
          'aborted_no_submit'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        click_started_at TEXT,
        click_attempted_at TEXT,
        click_effect_confirmed_at TEXT,
        submit_response_seen_at TEXT,
        composer_cleared_at TEXT,
        click_attempt_count INTEGER NOT NULL DEFAULT 0,
        confirmed_at TEXT,
        reply_comment_id TEXT,
        resulting_comment_id TEXT,
        verified_in_creator_center INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      INSERT INTO write_operations_v133(
        operation_id, reply_plan_id, idempotency_key,
        scope, action_type, actor_account, page_role,
        work_id, work_title, comment_id, target_author, target_text,
        target_text_hash, parent_comment_id, root_comment_id, depth,
        thread_path_json, already_replied, reply_text, reply_text_hash,
        snapshot_id, target_source, filter_keyword, gate_snapshot_json,
        state, created_at, updated_at, expires_at, click_started_at,
        click_attempted_at, click_effect_confirmed_at, submit_response_seen_at,
        composer_cleared_at, click_attempt_count, confirmed_at,
        reply_comment_id, resulting_comment_id, verified_in_creator_center,
        last_error
      )
      SELECT
        operation_id, reply_plan_id, idempotency_key,
        scope, action_type, actor_account, page_role,
        work_id, work_title, comment_id, target_author, target_text,
        target_text_hash, parent_comment_id, root_comment_id, depth,
        thread_path_json, already_replied, reply_text, reply_text_hash,
        snapshot_id, target_source, filter_keyword, gate_snapshot_json,
        state, created_at, updated_at, expires_at, click_started_at,
        NULL, click_started_at, NULL,
        NULL, CASE WHEN click_started_at IS NULL THEN 0 ELSE 1 END, confirmed_at,
        reply_comment_id, resulting_comment_id, verified_in_creator_center,
        last_error
      FROM write_operations;
      DROP TABLE write_operations;
      ALTER TABLE write_operations_v133 RENAME TO write_operations;
      CREATE INDEX write_operations_state_idx
        ON write_operations(state, updated_at);
      CREATE INDEX write_operations_target_idx
        ON write_operations(scope, work_id, comment_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureAdaptiveCommentSteps(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_comment_steps (
      step_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      action TEXT NOT NULL,
      strategy TEXT,
      result TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      screenshot_path TEXT,
      diagnostics_path TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(operation_id, step_index),
      FOREIGN KEY(operation_id) REFERENCES write_operations(operation_id)
    );
    CREATE INDEX IF NOT EXISTS adaptive_comment_steps_operation_idx
      ON adaptive_comment_steps(operation_id, step_index);
  `);
}

function ensurePostPublishingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_drafts (
      draft_id TEXT PRIMARY KEY,
      content_type TEXT NOT NULL CHECK (content_type IN ('carousel')),
      actor_account TEXT NOT NULL DEFAULT 'Operator',
      state TEXT NOT NULL CHECK (state IN (
        'draft',
        'editing',
        'preview_ready',
        'publish_prepared',
        'publish_clicked',
        'publishing',
        'confirmed',
        'failed',
        'unknown_after_submit',
        'archived'
      )),
      title TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      selected_music_json TEXT,
      cover_index INTEGER,
      desired_digest TEXT NOT NULL,
      page_synced_digest TEXT,
      preview_digest TEXT,
      page_target_id TEXT,
      page_url TEXT,
      published_work_id TEXT,
      published_work_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_verified_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS post_drafts_state_idx
      ON post_drafts(state, updated_at);

    CREATE TABLE IF NOT EXISTS post_publish_operations (
      operation_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      snapshot_digest TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'prepared',
        'publish_clicked',
        'publishing',
        'confirmed',
        'failed_before_click',
        'unknown_after_submit',
        'rejected'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      publish_clicked_at TEXT,
      confirmed_at TEXT,
      resulting_work_id TEXT,
      resulting_work_url TEXT,
      click_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      FOREIGN KEY(draft_id) REFERENCES post_drafts(draft_id)
    );
    CREATE INDEX IF NOT EXISTS post_publish_operations_state_idx
      ON post_publish_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS post_publish_operations_draft_idx
      ON post_publish_operations(draft_id, created_at);
  `);
}

function ensurePublisherV2Tables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_drafts_v2 (
      draft_id TEXT PRIMARY KEY,
      actor_account TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('text', 'carousel', 'article', 'video')),
      semantic_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      intent_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'draft', 'syncing', 'prepared', 'validation_failed', 'blocked_before_click',
        'submitted_unverified', 'published', 'confirmed_unsent', 'aborted'
      )),
      page_target_id TEXT,
      page_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      published_work_id TEXT,
      published_work_url TEXT
    );
    CREATE INDEX IF NOT EXISTS publish_drafts_v2_semantic_idx
      ON publish_drafts_v2(actor_account, semantic_hash, updated_at);

    CREATE TABLE IF NOT EXISTS publish_operations_v2 (
      operation_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      actor_account TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('text', 'carousel', 'article', 'video')),
      semantic_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (
        'prepared', 'validation_failed', 'blocked_before_click', 'click_intent_recorded',
        'submitted_unverified', 'published', 'unknown_after_submit',
        'confirmed_unsent', 'aborted'
      )),
      click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count IN (0, 1)),
      clicked_at TEXT,
      request_evidence_json TEXT,
      response_evidence_json TEXT,
      resulting_work_id TEXT,
      resulting_work_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      FOREIGN KEY(draft_id) REFERENCES publish_drafts_v2(draft_id)
    );
    CREATE INDEX IF NOT EXISTS publish_operations_v2_scope_idx
      ON publish_operations_v2(actor_account, semantic_hash, state, updated_at);

    CREATE TABLE IF NOT EXISTS publish_evidence_v2 (
      evidence_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(operation_id) REFERENCES publish_operations_v2(operation_id)
    );
    CREATE INDEX IF NOT EXISTS publish_evidence_v2_operation_idx
      ON publish_evidence_v2(operation_id, created_at);

    CREATE TABLE IF NOT EXISTS publish_legacy_migrations (
      legacy_operation_id TEXT PRIMARY KEY,
      legacy_draft_id TEXT NOT NULL,
      v2_operation_id TEXT NOT NULL,
      v2_draft_id TEXT NOT NULL,
      migration_state TEXT NOT NULL CHECK (migration_state IN ('prepared', 'published', 'superseded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(legacy_operation_id) REFERENCES post_publish_operations(operation_id),
      FOREIGN KEY(legacy_draft_id) REFERENCES post_drafts(draft_id),
      FOREIGN KEY(v2_operation_id) REFERENCES publish_operations_v2(operation_id),
      FOREIGN KEY(v2_draft_id) REFERENCES publish_drafts_v2(draft_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS publish_legacy_migrations_v2_operation_idx
      ON publish_legacy_migrations(v2_operation_id);
    CREATE INDEX IF NOT EXISTS publish_legacy_migrations_state_idx
      ON publish_legacy_migrations(migration_state, updated_at);
  `);
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{
    name?: string;
  }>).map(column => String(column.name ?? "")));
}

function createV186Backup(db: DatabaseSync): string | null {
  const populated = Number((db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM write_operations)
      + (SELECT COUNT(*) FROM publish_operations_v2) AS total
  `).get() as { total?: number | bigint } | undefined)?.total ?? 0) > 0;
  if (!populated) return null;
  const runtimeRoot = path.resolve(CONFIG.runtimeDir);
  const databasePath = path.resolve(sqliteFile);
  const backupDir = databasePath.startsWith(runtimeRoot + path.sep)
    ? path.join(CONFIG.projectRoot, "backups")
    : path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `pre-v1.8.6-sqlite-${timestamp}.sqlite3`);
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return backupPath;
}

function createV190Backup(db: DatabaseSync): string | null {
  const populated = Number((db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM write_operations)
      + (SELECT COUNT(*) FROM publish_operations_v2)
      + (SELECT COUNT(*) FROM page_bindings) AS total
  `).get() as { total?: number | bigint } | undefined)?.total ?? 0) > 0;
  if (!populated) return null;
  const runtimeRoot = path.resolve(CONFIG.runtimeDir);
  const databasePath = path.resolve(sqliteFile);
  const backupDir = databasePath.startsWith(runtimeRoot + path.sep)
    ? path.join(CONFIG.projectRoot, "backups")
    : path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `pre-v1.9.0-sqlite-${timestamp}.sqlite3`);
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}

function migrateV186RecoveryState(db: DatabaseSync): void {
  const writeColumns = tableColumns(db, "write_operations");
  const operationSql = String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='publish_operations_v2'",
  ).get() as { sql?: string } | undefined)?.sql ?? "");
  const draftSql = String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='publish_drafts_v2'",
  ).get() as { sql?: string } | undefined)?.sql ?? "");
  const commentMigrationNeeded = !writeColumns.has("request_text")
    || !writeColumns.has("server_display_text")
    || !writeColumns.has("confirmation_method")
    || !writeColumns.has("archived_at");
  const publisherMigrationNeeded = !operationSql.includes("deleted_or_unavailable")
    || !draftSql.includes("deleted_or_unavailable");
  if (!commentMigrationNeeded && !publisherMigrationNeeded) return;

  const backupPath = createV186Backup(db);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!writeColumns.has("request_text")) {
      db.exec("ALTER TABLE write_operations ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
      db.exec("UPDATE write_operations SET request_text=reply_text WHERE request_text=''");
    }
    if (!writeColumns.has("server_display_text")) {
      db.exec("ALTER TABLE write_operations ADD COLUMN server_display_text TEXT");
    }
    if (!writeColumns.has("confirmation_method")) {
      db.exec("ALTER TABLE write_operations ADD COLUMN confirmation_method TEXT");
    }
    if (!writeColumns.has("archived_at")) {
      db.exec("ALTER TABLE write_operations ADD COLUMN archived_at TEXT");
    }

    if (publisherMigrationNeeded) {
      db.exec(`
        DROP TABLE IF EXISTS publish_operations_v186;
        DROP TABLE IF EXISTS publish_drafts_v186;
        CREATE TABLE publish_drafts_v186 (
          draft_id TEXT PRIMARY KEY,
          actor_account TEXT NOT NULL,
          content_type TEXT NOT NULL CHECK (content_type IN ('text', 'carousel', 'article', 'video')),
          semantic_hash TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          intent_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'draft', 'syncing', 'prepared', 'validation_failed', 'blocked_before_click',
            'submitted_unverified', 'published', 'deleted_or_unavailable',
            'confirmed_unsent', 'aborted'
          )),
          page_target_id TEXT,
          page_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          published_work_id TEXT,
          published_work_url TEXT
        );
        INSERT INTO publish_drafts_v186 SELECT * FROM publish_drafts_v2;

        CREATE TABLE publish_operations_v186 (
          operation_id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          actor_account TEXT NOT NULL,
          content_type TEXT NOT NULL CHECK (content_type IN ('text', 'carousel', 'article', 'video')),
          semantic_hash TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN (
            'prepared', 'validation_failed', 'blocked_before_click', 'click_intent_recorded',
            'submitted_unverified', 'published', 'deleted_or_unavailable',
            'unknown_after_submit', 'confirmed_unsent', 'aborted'
          )),
          click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count IN (0, 1)),
          clicked_at TEXT,
          request_evidence_json TEXT,
          response_evidence_json TEXT,
          resulting_work_id TEXT,
          resulting_work_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          FOREIGN KEY(draft_id) REFERENCES publish_drafts_v186(draft_id)
        );
        INSERT INTO publish_operations_v186 SELECT * FROM publish_operations_v2;

        DROP TABLE publish_operations_v2;
        DROP TABLE publish_drafts_v2;
        ALTER TABLE publish_drafts_v186 RENAME TO publish_drafts_v2;
        ALTER TABLE publish_operations_v186 RENAME TO publish_operations_v2;
        CREATE INDEX publish_drafts_v2_semantic_idx
          ON publish_drafts_v2(actor_account, semantic_hash, updated_at);
        CREATE INDEX publish_operations_v2_scope_idx
          ON publish_operations_v2(actor_account, semantic_hash, state, updated_at);
      `);
    }
    db.prepare(`
      INSERT INTO runtime_metadata(key,value,updated_at) VALUES('migration_v1.8.6',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(JSON.stringify({ backupPath, completed: true }), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error("SQLITE_V186_FOREIGN_KEY_CHECK_FAILED");
}

function migrateV190NotificationsAndMentions(db: DatabaseSync): void {
  const draftColumns = tableColumns(db, "publish_drafts_v2");
  const hasTable = (name: string): boolean => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name));
  const migrationNeeded = !hasTable("notification_records")
    || !hasTable("notification_checkpoint_candidates")
    || !hasTable("notification_audit")
    || !draftColumns.has("page_sync_digest")
    || !draftColumns.has("preview_digest");
  if (!migrationNeeded) return;

  const backupPath = createV190Backup(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!draftColumns.has("page_sync_digest")) {
      db.exec("ALTER TABLE publish_drafts_v2 ADD COLUMN page_sync_digest TEXT");
    }
    if (!draftColumns.has("preview_digest")) {
      db.exec("ALTER TABLE publish_drafts_v2 ADD COLUMN preview_digest TEXT");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_records (
        notice_id TEXT PRIMARY KEY,
        notice_type TEXT NOT NULL,
        interact_type TEXT NOT NULL,
        filter_type TEXT NOT NULL CHECK (filter_type IN (
          'all','mentions','comments','followers','likes','recommendations'
        )),
        actor_uid TEXT,
        actor_sec_uid TEXT,
        work_id TEXT,
        comment_id TEXT,
        observed_at TEXT NOT NULL,
        source_created_at TEXT,
        availability TEXT NOT NULL CHECK (availability IN ('available','unavailable','unknown')),
        parse_version TEXT NOT NULL,
        acknowledged_at TEXT,
        last_error TEXT,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notification_records_filter_idx
        ON notification_records(filter_type, acknowledged_at, observed_at);
      CREATE INDEX IF NOT EXISTS notification_records_target_idx
        ON notification_records(work_id, comment_id);

      CREATE TABLE IF NOT EXISTS notification_checkpoint_candidates (
        candidate_id TEXT PRIMARY KEY,
        filter_type TEXT NOT NULL CHECK (filter_type IN (
          'all','mentions','comments','followers','likes','recommendations'
        )),
        notice_ids_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_checkpoint_candidates_time_idx
        ON notification_checkpoint_candidates(expires_at, consumed_at);

      CREATE TABLE IF NOT EXISTS notification_audit (
        audit_id TEXT PRIMARY KEY,
        notice_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('open_target','prepare_reply')),
        snapshot_hash TEXT NOT NULL,
        operation_id TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(notice_id) REFERENCES notification_records(notice_id)
      );
      CREATE INDEX IF NOT EXISTS notification_audit_notice_idx
        ON notification_audit(notice_id, created_at);
    `);
    db.prepare(`
      INSERT INTO runtime_metadata(key,value,updated_at) VALUES('migration_v1.9.0',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(JSON.stringify({ backupPath, completed: true }), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error("SQLITE_V190_FOREIGN_KEY_CHECK_FAILED");
}

function initialize(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_operations (
      operation_id TEXT PRIMARY KEY,
      reply_plan_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      work_id TEXT NOT NULL,
      work_title TEXT,
      comment_id TEXT NOT NULL,
      target_author TEXT NOT NULL,
      target_text TEXT NOT NULL,
      target_text_hash TEXT NOT NULL,
      parent_comment_id TEXT,
      root_comment_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      thread_path_json TEXT NOT NULL,
      already_replied INTEGER NOT NULL DEFAULT 0,
      reply_text TEXT NOT NULL,
      reply_text_hash TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      target_source TEXT,
      filter_keyword TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'prepared',
        'click_started',
        'confirmed',
        'rejected',
        'expired',
        'unknown_after_submit',
        'failed_before_click'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      click_started_at TEXT,
      confirmed_at TEXT,
      reply_comment_id TEXT,
      verified_in_creator_center INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS reply_operations_state_idx
      ON reply_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS reply_operations_target_idx
      ON reply_operations(work_id, comment_id);

    CREATE TABLE IF NOT EXISTS write_operations (
      operation_id TEXT PRIMARY KEY,
      reply_plan_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'own_post' CHECK (scope IN ('own_post', 'bound_user_post', 'external_post')),
      action_type TEXT NOT NULL DEFAULT 'reply_to_comment' CHECK (action_type IN (
        'create_root_comment',
        'reply_to_comment'
      )),
      actor_account TEXT NOT NULL DEFAULT 'Operator',
      page_role TEXT NOT NULL DEFAULT 'creator_center',
      work_id TEXT NOT NULL,
      work_title TEXT,
      comment_id TEXT NOT NULL DEFAULT '',
      target_author TEXT NOT NULL DEFAULT '',
      target_text TEXT NOT NULL DEFAULT '',
      target_text_hash TEXT NOT NULL DEFAULT '',
      parent_comment_id TEXT,
      root_comment_id TEXT NOT NULL DEFAULT '',
      depth INTEGER NOT NULL DEFAULT 0,
      thread_path_json TEXT NOT NULL DEFAULT '[]',
      already_replied INTEGER NOT NULL DEFAULT 0,
      reply_text TEXT NOT NULL,
      reply_text_hash TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      target_source TEXT,
      filter_keyword TEXT,
      gate_snapshot_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL CHECK (state IN (
        'prepared',
        'click_started',
        'click_attempted',
        'click_no_effect',
        'click_effect_confirmed',
        'confirmed',
        'rejected',
        'expired',
        'unknown_after_submit',
        'failed_before_click',
        'aborted_no_submit'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      click_started_at TEXT,
      click_attempted_at TEXT,
      click_effect_confirmed_at TEXT,
      submit_response_seen_at TEXT,
      composer_cleared_at TEXT,
      click_attempt_count INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      reply_comment_id TEXT,
      resulting_comment_id TEXT,
      verified_in_creator_center INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS write_operations_state_idx
      ON write_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS write_operations_target_idx
      ON write_operations(scope, work_id, comment_id);

    INSERT OR IGNORE INTO write_operations(
      operation_id, reply_plan_id, idempotency_key,
      scope, action_type, actor_account, page_role,
      work_id, work_title, comment_id, target_author, target_text,
      target_text_hash, parent_comment_id, root_comment_id, depth,
      thread_path_json, already_replied, reply_text, reply_text_hash,
      snapshot_id, target_source, filter_keyword, gate_snapshot_json,
      state, created_at, updated_at, expires_at, click_started_at,
      confirmed_at, reply_comment_id, resulting_comment_id,
      verified_in_creator_center, last_error
    )
    SELECT
      operation_id, reply_plan_id, idempotency_key,
      'own_post', 'reply_to_comment', 'Operator', 'creator_center',
      work_id, work_title, comment_id, target_author, target_text,
      target_text_hash, parent_comment_id, root_comment_id, depth,
      thread_path_json, already_replied, reply_text, reply_text_hash,
      snapshot_id, target_source, filter_keyword, '{}',
      state, created_at, updated_at, expires_at, click_started_at,
      confirmed_at, reply_comment_id, reply_comment_id,
      verified_in_creator_center, last_error
    FROM reply_operations;

    CREATE TABLE IF NOT EXISTS seen_comments (
      comment_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      has_replied INTEGER NOT NULL DEFAULT 0,
      own_reply_comment_id TEXT
    );
    CREATE INDEX IF NOT EXISTS seen_comments_work_idx
      ON seen_comments(work_id, last_seen_at);

    CREATE TABLE IF NOT EXISTS creator_comment_delete_operations (
      operation_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      actor_account TEXT NOT NULL,
      work_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      target_author TEXT NOT NULL,
      target_text TEXT NOT NULL,
      target_text_hash TEXT NOT NULL,
      parent_comment_id TEXT,
      root_comment_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'prepared',
        'delete_started',
        'confirmed',
        'unknown_after_submit',
        'failed_before_click',
        'rejected',
        'expired'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      delete_started_at TEXT,
      confirmed_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS creator_comment_delete_state_idx
      ON creator_comment_delete_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS creator_comment_delete_target_idx
      ON creator_comment_delete_operations(work_id, comment_id);

    CREATE TABLE IF NOT EXISTS social_operations (
      operation_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      action_kind TEXT NOT NULL CHECK (action_kind IN ('message', 'share', 'safe_social')),
      actor_account TEXT NOT NULL,
      bound_alias TEXT NOT NULL,
      target_uid TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      target_context_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      work_id TEXT,
      action_key TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'prepared',
        'click_started',
        'confirmed',
        'unknown_after_submit',
        'failed_before_click',
        'rejected'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      click_started_at TEXT,
      confirmed_at TEXT,
      resulting_message_id TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS social_operations_state_idx
      ON social_operations(state, updated_at);
    CREATE INDEX IF NOT EXISTS social_operations_target_idx
      ON social_operations(bound_alias, action_kind, target_context_hash);

    CREATE TABLE IF NOT EXISTS write_rate_reservations (
      reservation_id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      work_key_hash TEXT,
      reserved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS write_rate_reservations_time_idx
      ON write_rate_reservations(reserved_at, expires_at);

    CREATE TABLE IF NOT EXISTS page_bindings (
      role TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      url TEXT NOT NULL,
      account_display_name TEXT,
      account_uid TEXT,
      account_sec_uid TEXT,
      browser_profile_id TEXT NOT NULL,
      page_title TEXT,
      verified_at TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migrateWriteOperationSubmitEvidence(db);
  ensureAdaptiveCommentSteps(db);
  ensurePostPublishingTables(db);
  ensurePublisherV2Tables(db);
  migrateV186RecoveryState(db);
  migrateV190NotificationsAndMentions(db);
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  if (initializationError) throw initializationError;
  try {
    fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
    database = new DatabaseSync(sqliteFile);
    initialize(database);
    return database;
  } catch (error) {
    initializationError = error instanceof Error ? error : new Error(String(error));
    throw initializationError;
  }
}

export function withImmediateTransaction<T>(operation: (db: DatabaseSync) => T): T {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export function sqliteWritableProbe(): { writable: boolean; error: string | null } {
  try {
    withImmediateTransaction(db => {
      db.prepare(`
        INSERT INTO runtime_metadata(key, value, updated_at)
        VALUES('last_write_probe', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value=excluded.value,
          updated_at=excluded.updated_at
      `).run(randomUUID(), new Date().toISOString());
    });
    return { writable: true, error: null };
  } catch (error) {
    return { writable: false, error: String(error) };
  }
}

export function setMetadata(key: string, value: string): void {
  withImmediateTransaction(db => {
    db.prepare(`
      INSERT INTO runtime_metadata(key, value, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `).run(key, value, new Date().toISOString());
  });
}

export function getMetadata(key: string): string | null {
  const row = getDatabase().prepare(
    "SELECT value FROM runtime_metadata WHERE key=?",
  ).get(key) as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

export function closeDatabase(): void {
  database?.close();
  database = null;
  initializationError = null;
}
