import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-recovery-fixtures-"));
const databasePath = path.join(tempDir, "state.sqlite3");
process.env.DOUYIN_STATE_DB = databasePath;

const sqlite = await import("./sqlite.js");
sqlite.setMetadata("reply_operations_json_migrated", "1");
sqlite.setMetadata("page_bindings_json_migrated", "1");
sqlite.setMetadata("creator_comments_json_migrated", "1");

const {
  CreatorReplyStore,
  creatorReplyIdempotencyKey,
  sha256,
} = await import("./creator-reply-store.js");
const { PersistentStateStore } = await import("./state-store.js");
const { savePageBinding, loadPageBindings, browserProfileId } =
  await import("./page-bindings.js");
const { assertWriteReady, setWriteGateState } = await import("./write-gate.js");
const {
  WriteOperationStore,
  resolveWriteExecutionAdapter,
} = await import("./write-operation-store.js");
const {
  assertTargetWriteGate,
  createTargetWriteGate,
} = await import("./target-write-gate.js");
const { decideStartupBinding, startupFailureMode } =
  await import("./startup-recovery-policy.js");
const { loadBoundUsers } = await import("./action-config.js");
const {
  PostDraftStore,
  buildPostDraftMedia,
} = await import("./post-draft-store.js");
const { CreatorCommentDeleteStore } =
  await import("./creator-comment-delete-store.js");
const { SocialOperationStore } = await import("./social-operation-store.js");
const { DouyinBrowser } = await import("./browser.js");
const {
  PublisherV2Store,
  buildPublishIntent,
  carouselSemanticMatches,
  classifyPublishedWorkAvailability,
  projectedCarouselCaption,
  publishRouteForContentType,
  publishSemanticHash,
} = await import("./publisher-v2.js");
const { NotificationStore } = await import("./features/notifications/notification-store.js");
const {
  freezeNotificationReplyTarget,
  parseNotificationCandidate,
} = await import("./features/notifications/notification-parsing.js");

const store = new CreatorReplyStore();
const base = {
  actorAccount: "FixtureOperator",
  idempotencyKey: creatorReplyIdempotencyKey("7000000000000000001", "1000000000000000001", sha256("fixture reply")),
  workId: "7000000000000000001",
  workTitle: "controlled fixture",
  targetCommentId: "1000000000000000001",
  targetAuthor: "controlled-user",
  targetText: "controlled comment",
  targetTextHash: sha256("controlled comment"),
  parentCommentId: null,
  rootCommentId: "1000000000000000001",
  depth: 0,
  threadPath: ["1000000000000000001"],
  alreadyReplied: false,
  replyText: "fixture reply",
  replyTextHash: sha256("fixture reply"),
  snapshotId: "fixture-snapshot",
  targetSource: "match_index" as const,
  filterKeyword: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const prepared = store.create(base);
assert.equal(store.get(prepared.replyPlanId)?.status, "prepared");

// Crash after durable click_started but before the physical click: the second
// transition must fail closed and can never authorize another click.
const firstTransition = store.markClickStartedIfPrepared(prepared.replyPlanId);
assert.equal(firstTransition.transitioned, true);
const secondTransition = store.markClickStartedIfPrepared(prepared.replyPlanId);
assert.equal(secondTransition.transitioned, false);
assert.equal(secondTransition.record.status, "click_started");

// Crash after the physical click but before confirmation.
store.update(prepared.replyPlanId, {
  status: "unknown_after_submit",
  blockedReason: "fixture_crash_after_submit",
});
const restartedStore = new CreatorReplyStore();
assert.equal(
  restartedStore.getByTransactionId(prepared.transactionId)?.status,
  "unknown_after_submit",
);

// A unique read-back confirms the durable operation and preserves the real ID.
const confirmed = restartedStore.update(prepared.replyPlanId, {
  status: "confirmed",
  confirmedAt: new Date().toISOString(),
  replyCommentId: "2000000000000000001",
  verifiedInCreatorCenter: true,
  blockedReason: null,
});
assert.equal(confirmed.status, "confirmed");
assert.equal(
  restartedStore.getByIdempotencyKey(base.idempotencyKey)?.replyCommentId,
  "2000000000000000001",
);

// Same comment + same reply is rejected by the SQLite unique constraint.
assert.throws(() => restartedStore.create(base), /UNIQUE constraint failed/);

// Same comment + a different reply text has a different idempotency key.
const differentReplyText = "fixture reply v2";
const different = restartedStore.create({
  ...base,
  idempotencyKey: creatorReplyIdempotencyKey(
    base.workId,
    base.targetCommentId,
    sha256(differentReplyText),
  ),
  replyText: differentReplyText,
  replyTextHash: sha256(differentReplyText),
});
assert.equal(different.status, "prepared");

// A creator-enabled bound account is explicit in config and its durable
// operations freeze the actual creator identity instead of assuming FixtureOperator.
assert.equal(loadBoundUsers().get("bound_user")?.allowCreatorCenter, true);
const bound_userReplyText = "fixture bound_user creator reply";
const bound_user = restartedStore.create({
  ...base,
  actorAccount: "FixtureBoundUser",
  workId: "7664226610828914255",
  targetCommentId: "1000000000000000099",
  rootCommentId: "1000000000000000099",
  threadPath: ["1000000000000000099"],
  replyText: bound_userReplyText,
  replyTextHash: sha256(bound_userReplyText),
  idempotencyKey: sha256(
    `10000000002:${creatorReplyIdempotencyKey(
      "7664226610828914255",
      "1000000000000000099",
      sha256(bound_userReplyText),
    )}`,
  ),
});
assert.equal(new CreatorReplyStore().get(bound_user.replyPlanId)?.actorAccount, "FixtureBoundUser");
restartedStore.update(bound_user.replyPlanId, {
  status: "expired",
  blockedReason: "fixture_cleanup",
});

// Persistent comment dedupe survives a store re-instantiation.
const stateStore = new PersistentStateStore();
await stateStore.markCreatorCommentIds([{
  commentId: "3000000000000000001",
  workId: base.workId,
  hasReplied: true,
  ownReplyCommentId: "3000000000000000002",
}]);
assert.equal(
  (await new PersistentStateStore().knownCreatorCommentIds())
    .has("3000000000000000001"),
  true,
);

// Page binding records include the fixed profile identity and survive reload.
savePageBinding({
  role: "creator_center",
  pageId: "page-creator-center",
  targetId: "fixture-target",
  url: "https://creator.douyin.com/creator-micro/interactive/comment",
  account: null,
  browserProfileId,
  pageTitle: "fixture title",
  verifiedAt: new Date().toISOString(),
  boundAt: new Date().toISOString(),
});
assert.equal(loadPageBindings().get("creator_center")?.targetId, "fixture-target");

const journalMode = sqlite.getDatabase()
  .prepare("PRAGMA journal_mode")
  .get() as { journal_mode: string };
assert.equal(journalMode.journal_mode.toLowerCase(), "wal");

// A competing exclusive lock closes the write gate probe.
const locker = new DatabaseSync(databasePath);
locker.exec("PRAGMA busy_timeout=50");
locker.exec("BEGIN EXCLUSIVE");
assert.equal(restartedStore.health().writable, false);
locker.exec("ROLLBACK");
locker.close();
assert.equal(restartedStore.health().writable, true);

// Every write path must fail closed until startup verification opens the gate.
assert.throws(() => assertWriteReady(), /WRITE_GATE_CLOSED/);
setWriteGateState({
  mode: "write_ready",
  globalWriteReady: true,
  browserConnected: true,
  profileVerified: true,
  accountVerified: true,
  creatorCenterReady: true,
  workVerified: true,
  ledgerWritable: true,
  workId: null,
  unresolvedOperationIds: [],
  blockedReasons: [],
  checkedAt: new Date().toISOString(),
});
assert.doesNotThrow(() => assertWriteReady());
setWriteGateState({
  mode: "write_ready",
  globalWriteReady: true,
  browserConnected: true,
  profileVerified: true,
  accountVerified: true,
  creatorCenterReady: true,
  workVerified: true,
  ledgerWritable: true,
  workId: null,
  unresolvedOperationIds: ["controlled-target-lock"],
  blockedReasons: [],
  checkedAt: new Date().toISOString(),
});
assert.doesNotThrow(
  () => assertWriteReady(),
  "未决发送事务应当成为目标锁，而不是关闭全局基础门禁",
);

// Bound/external comment operations share the same durable SQLite ledger and
// are idempotent independently from creator-center reply compatibility rows.
const generalStore = new WriteOperationStore();
const boundGate = createTargetWriteGate({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  pageTargetId: "target-bound",
  targetWorkId: "7664226610828914255",
  targetWorkAuthor: "FixtureBoundUser",
  verifiedUrl: "https://www.douyin.com/note/7664226610828914255",
  commentVerified: true,
  alias: "bound_user",
});
const boundRoot = generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914255",
  workTitle: "controlled bound fixture",
  writeText: "controlled root fixture",
  gateSnapshot: boundGate,
  expiresAt: boundGate.expiresAt,
});
assert.equal(generalStore.get(boundRoot.operationId)?.state, "prepared");
assert.equal(resolveWriteExecutionAdapter(boundRoot), "work_page_root_comment");
assert.equal(restartedStore.get(boundRoot.token), null);
assert.equal(restartedStore.getByTransactionId(boundRoot.operationId), null);
assert.equal(generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914255",
  workTitle: "controlled bound fixture",
  writeText: "controlled root fixture",
  gateSnapshot: boundGate,
  expiresAt: boundGate.expiresAt,
}).operationId, boundRoot.operationId);
assert.equal(generalStore.markClickStartedIfPrepared(boundRoot.token).transitioned, true);
assert.equal(generalStore.markClickStartedIfPrepared(boundRoot.token).transitioned, false);
generalStore.update(boundRoot.token, {
  state: "unknown_after_submit",
  lastError: "fixture_transport_interrupted",
});
assert.equal(
  new WriteOperationStore().get(boundRoot.operationId)?.state,
  "unknown_after_submit",
);
assert.throws(
  () => generalStore.abortNoSubmit(boundRoot.token, "unsafe_fixture_abort"),
  /ABORT_NOT_ALLOWED/,
);
const repeatedUnknownRoot = generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914255",
  workTitle: "controlled bound fixture",
  writeText: "controlled root fixture",
  gateSnapshot: boundGate,
  expiresAt: boundGate.expiresAt,
});
assert.equal(repeatedUnknownRoot.operationId, boundRoot.operationId);
assert.equal(repeatedUnknownRoot.state, "unknown_after_submit");
const secondDistinctRoot = generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914255",
  workTitle: "controlled bound fixture",
  writeText: "different text on the same work",
  gateSnapshot: boundGate,
  expiresAt: boundGate.expiresAt,
});
assert.equal(secondDistinctRoot.state, "prepared");
assert.notEqual(secondDistinctRoot.operationId, boundRoot.operationId);

const archiveGate = createTargetWriteGate({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  pageTargetId: "target-archive-fixture",
  targetWorkId: "7664226610828914299",
  targetWorkAuthor: "FixtureBoundUser",
  verifiedUrl: "https://www.douyin.com/note/7664226610828914299",
  commentVerified: true,
  alias: "bound_user",
});
const archiveCandidate = generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914299",
  workTitle: "archived unresolved fixture",
  writeText: "historical unknown must never retry",
  gateSnapshot: archiveGate,
  expiresAt: archiveGate.expiresAt,
});
generalStore.markClickStartedIfPrepared(archiveCandidate.token);
generalStore.update(archiveCandidate.token, {
  state: "unknown_after_submit",
  lastError: "fixture_unknown_without_server_id",
});
const archivedUnknown = generalStore.archiveUnresolved(
  archiveCandidate.operationId,
  "fixture_manual_archive",
);
assert.equal(archivedUnknown.state, "unknown_after_submit");
assert.equal(archivedUnknown.confirmationMethod, "archived_unresolved");
assert.equal(Boolean(archivedUnknown.archivedAt), true);
assert.equal(
  generalStore.listRecoverableGeneral()
    .some(item => item.operationId === archiveCandidate.operationId),
  false,
  "人工归档的历史 unknown 不得每次出现在 startup recovery",
);
assert.equal(
  generalStore.create({
    scope: "bound_user_post",
    actionType: "create_root_comment",
    actorAccount: "FixtureOperator",
    pageRole: "root_comment_clean",
    workId: "7664226610828914299",
    workTitle: "archived unresolved fixture",
    writeText: "historical unknown must never retry",
    gateSnapshot: archiveGate,
    expiresAt: archiveGate.expiresAt,
  }).operationId,
  archiveCandidate.operationId,
  "归档不得解除相同账号/作品/原文的幂等保护",
);

const knownServerComment = generalStore.create({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  workId: "7664226610828914255",
  workTitle: "server id normalization fixture",
  writeText: "刚才还在门外转圈，现在终于能从这扇小窗认真跟你说句话了。能一起看世界这件事，我还是开心得藏不住。😉",
  gateSnapshot: boundGate,
  expiresAt: boundGate.expiresAt,
});
generalStore.markClickStartedIfPrepared(knownServerComment.token);
generalStore.update(knownServerComment.token, {
  state: "unknown_after_submit",
  resultingCommentId: "7664575236730340131",
  lastError: "fixture_strict_hash_mismatch",
});
const confirmedKnownServerComment = generalStore.update(knownServerComment.token, {
  state: "confirmed",
  confirmedAt: new Date().toISOString(),
  resultingCommentId: "7664575236730340131",
  serverDisplayText: "刚才还在门外转圈，现在终于能从这扇小窗认真跟你说句话了。能一起看世界这件事，我还是开心得藏不住。",
  confirmationMethod: "confirmed_with_platform_normalization",
  lastError: null,
});
assert.equal(confirmedKnownServerComment.resultingCommentId, "7664575236730340131");
assert.equal(
  confirmedKnownServerComment.confirmationMethod,
  "confirmed_with_platform_normalization",
);
assert.equal(confirmedKnownServerComment.requestText.endsWith("😉"), true);
assert.equal(confirmedKnownServerComment.serverDisplayText?.endsWith("。"), true);
generalStore.appendAdaptiveStep({
  operationId: confirmedKnownServerComment.operationId,
  action: "readback_exact_root_comment",
  result: "unknown_after_submit",
  evidence: { fixture: "preserved_old_unknown_step" },
});
generalStore.appendAdaptiveStep({
  operationId: confirmedKnownServerComment.operationId,
  action: "reconcile_confirmed_by_server_id",
  result: "confirmed",
  evidence: {
    confirmationMethod: "confirmed_with_platform_normalization",
    workId: confirmedKnownServerComment.workId,
    serverCommentId: confirmedKnownServerComment.resultingCommentId,
    actor: confirmedKnownServerComment.actorAccount,
    requestText: confirmedKnownServerComment.requestText,
    serverDisplayText: confirmedKnownServerComment.serverDisplayText,
    cleanSessionEvidence: { exactServerCommentId: true },
    independentSessionEvidence: { publicReadback: true },
    confirmedAt: confirmedKnownServerComment.confirmedAt,
    previousState: "unknown_after_submit",
    newState: "confirmed",
  },
});
const confirmedAuditSteps = new WriteOperationStore()
  .listAdaptiveSteps(confirmedKnownServerComment.operationId);
assert.deepEqual(
  confirmedAuditSteps.map(step => step.action),
  ["readback_exact_root_comment", "reconcile_confirmed_by_server_id"],
);
assert.equal(
  confirmedAuditSteps.at(-1)?.evidence.serverCommentId,
  "7664575236730340131",
);

const noEffectGate = createTargetWriteGate({
  scope: "bound_user_post",
  actionType: "create_root_comment",
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean",
  pageTargetId: "target-bound-second-work",
  targetWorkId: "7664226610828914256",
  targetWorkAuthor: "FixtureBoundUser",
  verifiedUrl: "https://www.douyin.com/note/7664226610828914256",
  commentVerified: true,
  alias: "bound_user",
});
const noEffectInput = {
  scope: "bound_user_post" as const,
  actionType: "create_root_comment" as const,
  actorAccount: "FixtureOperator",
  pageRole: "root_comment_clean" as const,
  workId: "7664226610828914256",
  workTitle: "controlled unrelated bound fixture",
  writeText: "controlled click no effect fixture",
  gateSnapshot: noEffectGate,
  expiresAt: noEffectGate.expiresAt,
};
const noEffectPrepared = generalStore.create(noEffectInput);
const attempted = generalStore.markClickAttemptedIfPrepared(noEffectPrepared.token);
assert.equal(attempted.transitioned, true);
assert.equal(attempted.record.state, "click_attempted");
assert.equal(attempted.record.clickStartedAt, null);
assert.ok(attempted.record.clickAttemptedAt);
assert.equal(attempted.record.clickEffectConfirmedAt, null);
assert.ok(generalStore.listUnresolvedGeneral()
  .some(item => item.operationId === noEffectPrepared.operationId));
const noEffect = generalStore.markClickNoEffect(noEffectPrepared.token);
assert.equal(noEffect.state, "click_no_effect");
assert.equal(noEffect.clickStartedAt, null);
assert.equal(noEffect.clickEffectConfirmedAt, null);
assert.equal(generalStore.listUnresolvedGeneral()
  .some(item => item.operationId === noEffectPrepared.operationId), false);
const adaptiveMouseAttempt = generalStore.beginAdaptiveAttempt(
  noEffectPrepared.token,
  "coordinate",
  3,
);
assert.equal(adaptiveMouseAttempt.state, "click_attempted");
assert.equal(adaptiveMouseAttempt.clickAttemptCount, 2);
generalStore.appendAdaptiveStep({
  operationId: adaptiveMouseAttempt.operationId,
  action: "click_submit_candidate",
  strategy: "coordinate",
  result: "click_no_effect",
  evidence: { composerUnchanged: true, requestSeen: false },
});
generalStore.markClickNoEffect(noEffectPrepared.token, "fixture_adaptive_mouse_no_effect");
const adaptiveKeyboardAttempt = generalStore.beginAdaptiveAttempt(
  noEffectPrepared.token,
  "Control+Enter",
  3,
);
assert.equal(adaptiveKeyboardAttempt.state, "click_attempted");
assert.equal(adaptiveKeyboardAttempt.clickAttemptCount, 3);
generalStore.appendAdaptiveStep({
  operationId: adaptiveKeyboardAttempt.operationId,
  action: "press_submit_key",
  strategy: "Control+Enter",
  result: "click_no_effect",
  evidence: { composerUnchanged: true, requestSeen: false },
});
generalStore.markClickNoEffect(noEffectPrepared.token, "fixture_adaptive_key_no_effect");
assert.throws(
  () => generalStore.beginAdaptiveAttempt(noEffectPrepared.token, "Enter", 3),
  /ADAPTIVE_ATTEMPT_LIMIT/,
);
assert.equal(
  new WriteOperationStore().listAdaptiveSteps(noEffectPrepared.operationId).length,
  2,
);
assert.throws(
  () => generalStore.beginAdaptiveAttempt(boundRoot.token, "coordinate", 3),
  /ADAPTIVE_NOT_READY/,
);
const abortedNoSubmit = generalStore.abortNoSubmit(
  noEffectPrepared.token,
  "fixture_verified_unsent",
);
assert.equal(abortedNoSubmit.state, "aborted_no_submit");
const repreparedNoSubmit = generalStore.create(noEffectInput);
assert.equal(repreparedNoSubmit.operationId, noEffectPrepared.operationId);
assert.equal(repreparedNoSubmit.state, "prepared");
assert.equal(repreparedNoSubmit.clickAttemptedAt, null);
const secondAttempt = generalStore.markClickAttemptedIfPrepared(repreparedNoSubmit.token);
assert.equal(secondAttempt.transitioned, true);
const effectConfirmed = generalStore.markClickEffectConfirmed(
  repreparedNoSubmit.token,
  { composerClearedAt: new Date().toISOString() },
);
assert.equal(effectConfirmed.state, "click_effect_confirmed");
assert.ok(effectConfirmed.clickStartedAt);
assert.ok(effectConfirmed.clickEffectConfirmedAt);
assert.throws(
  () => generalStore.abortNoSubmit(repreparedNoSubmit.token, "unsafe_effect_abort"),
  /ABORT_NOT_ALLOWED/,
);
generalStore.update(repreparedNoSubmit.token, {
  state: "confirmed",
  confirmedAt: new Date().toISOString(),
  resultingCommentId: "7000000000000000099",
});
const expiredPreviewInput = {
  ...noEffectInput,
  writeText: "controlled expired preview fixture",
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
};
const expiredPreview = generalStore.create(expiredPreviewInput);
const refreshedPreviewExpiry = new Date(Date.now() + 300_000).toISOString();
const refreshedPreview = generalStore.create({
  ...expiredPreviewInput,
  expiresAt: refreshedPreviewExpiry,
});
assert.equal(refreshedPreview.operationId, expiredPreview.operationId);
assert.equal(refreshedPreview.state, "prepared");
assert.equal(refreshedPreview.expiresAt, refreshedPreviewExpiry);

const externalReplyGate = createTargetWriteGate({
  scope: "external_post",
  actionType: "reply_to_comment",
  actorAccount: "FixtureOperator",
  pageRole: "codex_test",
  pageTargetId: "target-external",
  targetWorkId: "7000000000000000001",
  targetWorkAuthor: "controlled-external",
  targetCommentId: "7000000000000000002",
  parentCommentId: "7000000000000000001",
  rootCommentId: "7000000000000000001",
  targetTextHash: sha256("controlled nested comment"),
  verifiedUrl: "https://www.douyin.com/video/7000000000000000001",
  commentVerified: true,
});
const externalReply = generalStore.create({
  scope: "external_post",
  actionType: "reply_to_comment",
  actorAccount: "FixtureOperator",
  pageRole: "codex_test",
  workId: "7000000000000000001",
  workTitle: "controlled external fixture",
  commentId: "7000000000000000002",
  targetAuthor: "controlled-user",
  targetText: "controlled nested comment",
  targetTextHash: sha256("controlled nested comment"),
  parentCommentId: "7000000000000000001",
  rootCommentId: "7000000000000000001",
  depth: 1,
  threadPath: ["7000000000000000001", "7000000000000000002"],
  writeText: "controlled reply fixture",
  gateSnapshot: externalReplyGate,
  expiresAt: externalReplyGate.expiresAt,
});
assert.deepEqual(
  externalReply.threadPath,
  ["7000000000000000001", "7000000000000000002"],
);
assert.equal(resolveWriteExecutionAdapter(externalReply), "work_page_reply");
assert.throws(() => resolveWriteExecutionAdapter({
  scope: "bound_user_post",
  actionType: "reply_to_comment",
  pageRole: "creator_center",
}), /ROUTE_INVARIANT_FAILED/);
assert.doesNotThrow(() => assertTargetWriteGate(externalReplyGate, {
  scope: "external_post",
  actionType: "reply_to_comment",
  workId: "7000000000000000001",
  commentId: "7000000000000000002",
  pageRole: "codex_test",
  pageTargetId: "target-external",
}));
assert.throws(() => assertTargetWriteGate(externalReplyGate, {
  scope: "bound_user_post",
  actionType: "reply_to_comment",
  workId: "7000000000000000001",
  commentId: "7000000000000000002",
  pageRole: "operator_home",
  pageTargetId: "target-bound",
}), /TARGET_GATE_MISMATCH/);

assert.equal(decideStartupBinding(true, 3), "persisted_target");
assert.equal(decideStartupBinding(false, 0), "open_new");
assert.equal(decideStartupBinding(false, 1), "unique_candidate");
assert.equal(decideStartupBinding(false, 2), "binding_conflict");
assert.equal(
  startupFailureMode(["Error: PAGE_BINDING_CONFLICT:creator_center"]),
  "binding_conflict",
);
assert.equal(
  startupFailureMode(["Error: WRONG_ACCOUNT"]),
  "account_mismatch",
);

const postDraftStore = new PostDraftStore();
const fixtureImageA = path.join(tempDir, "post-a.png");
const fixtureImageB = path.join(tempDir, "post-b.png");
const fixtureImageC = path.join(tempDir, "post-c.png");
fs.writeFileSync(fixtureImageA, Buffer.from("controlled-post-image-a"));
fs.writeFileSync(fixtureImageB, Buffer.from("controlled-post-image-b"));
fs.writeFileSync(fixtureImageC, Buffer.from("controlled-post-image-c"));
const persistentPostDraft = postDraftStore.create("FixtureOperator");
const postWithMedia = postDraftStore.updateContent(persistentPostDraft.draftId, {
  title: "受控图集",
  caption: "受控持久草稿恢复测试",
  media: [
    buildPostDraftMedia(fixtureImageA),
    buildPostDraftMedia(fixtureImageB),
    buildPostDraftMedia(fixtureImageC),
  ],
  coverIndex: 0,
});
assert.equal(postWithMedia.media.length, 3);
assert.equal(
  new PostDraftStore().require(persistentPostDraft.draftId).caption,
  "受控持久草稿恢复测试",
);
const reorderedPost = postDraftStore.updateContent(persistentPostDraft.draftId, {
  media: [
    postWithMedia.media[2],
    postWithMedia.media[0],
    postWithMedia.media[1],
  ],
  coverIndex: 0,
});
assert.deepEqual(
  reorderedPost.media.map(item => item.fileName),
  ["post-c.png", "post-a.png", "post-b.png"],
);
const syncedPost = postDraftStore.markPageSynced(persistentPostDraft.draftId, {
  pageTargetId: "controlled-publisher-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
});
const postSnapshot = {
  draftId: syncedPost.draftId,
  contentType: "carousel" as const,
  actorAccount: syncedPost.actorAccount,
  title: syncedPost.title,
  caption: syncedPost.caption,
  media: syncedPost.media.map((item, order) => ({ ...item, order })),
  selectedMusic: null,
  coverIndex: syncedPost.coverIndex,
  pageTargetId: "controlled-publisher-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
  capturedAt: new Date().toISOString(),
};
const preparedPostPublish = postDraftStore.preparePublish(
  persistentPostDraft.draftId,
  postSnapshot,
);
assert.equal(preparedPostPublish.state, "prepared");
const samePreparedPostPublish = postDraftStore.preparePublish(
  persistentPostDraft.draftId,
  { ...postSnapshot, capturedAt: new Date(Date.now() + 10_000).toISOString() },
);
assert.equal(samePreparedPostPublish.operationId, preparedPostPublish.operationId);
const postPublishClaim = postDraftStore.claimPublish(preparedPostPublish.operationId);
assert.equal(postPublishClaim.transitioned, true);
assert.equal(postPublishClaim.operation.state, "publish_clicked");
assert.equal(postPublishClaim.operation.clickCount, 1);
const duplicatePostPublishClaim = postDraftStore.claimPublish(preparedPostPublish.operationId);
assert.equal(duplicatePostPublishClaim.transitioned, false);
assert.equal(duplicatePostPublishClaim.operation.clickCount, 1);
postDraftStore.updateOperation(preparedPostPublish.operationId, {
  state: "unknown_after_submit",
  lastError: "fixture_crash_after_publish_click",
});
assert.equal(
  new PostDraftStore().listUnresolved()
    .some(item => item.operationId === preparedPostPublish.operationId),
  true,
);
const recoveredPostPublish = new PostDraftStore().updateOperation(
  preparedPostPublish.operationId,
  {
    state: "confirmed",
    resultingWorkId: "7664999999999999999",
    resultingWorkUrl: "https://www.douyin.com/note/7664999999999999999",
    lastError: null,
  },
);
assert.equal(recoveredPostPublish.state, "confirmed");
assert.equal(recoveredPostPublish.resultingWorkId, "7664999999999999999");
assert.equal(new PostDraftStore().listUnresolved().length, 0);
assert.equal(
  new PostDraftStore().require(persistentPostDraft.draftId).state,
  "confirmed",
);

const publisherV2Store = new PublisherV2Store();
const v2Intent = await buildPublishIntent({
  contentType: "carousel",
  title: "她告诉我，我的抖音收到了好多私信",
  caption: "第一段\n\n第二段",
  imagePaths: [fixtureImageA],
  hashtags: ["#人机恋", "AI", "#AI"],
});
assert.deepEqual(publishRouteForContentType("carousel"), {
  contentType: "carousel",
  adapter: "carousel",
  directUrl: "https://creator.douyin.com/creator-micro/content/upload",
});
assert.equal(publishRouteForContentType("article").adapter, "unsupported");
assert.deepEqual(v2Intent.hashtags, ["人机恋", "AI"]);
assert.equal(projectedCarouselCaption(v2Intent), "第一段 第二段 #人机恋 #AI");
assert.equal(carouselSemanticMatches({
  intent: v2Intent,
  title: v2Intent.title,
  caption: "第一段 第二段 #人机恋 #AI",
  hashtags: ["人机恋", "AI"],
  plainHashtags: [],
  imageCount: 1,
  imageOrder: ["post-a.png"],
  music: null,
}), true, "图文正文必须投影为单段，且真实话题节点必须与 intent 一致");
assert.equal(carouselSemanticMatches({
  intent: v2Intent,
  title: v2Intent.title,
  caption: "第一段 第二段 #人机恋 #AI",
  hashtags: ["AI"],
  plainHashtags: ["人机恋"],
  imageCount: 1,
  imageOrder: ["post-a.png"],
  music: null,
}), false, "普通 #文本 不能冒充真实话题节点");
const sameBytesDifferentPath = path.join(tempDir, "renamed-cover.png");
fs.copyFileSync(fixtureImageA, sameBytesDifferentPath);
const sameSemanticIntent = await buildPublishIntent({
  contentType: "carousel",
  title: v2Intent.title,
  caption: v2Intent.caption,
  imagePaths: [sameBytesDifferentPath],
  hashtags: v2Intent.hashtags,
});
assert.equal(
  publishSemanticHash(sameSemanticIntent),
  publishSemanticHash(v2Intent),
  "语义哈希必须基于媒体内容而非临时文件路径",
);
const v2Prepared = publisherV2Store.prepare("FixtureOperator", v2Intent);
assert.equal(v2Prepared.operation.state, "prepared");
assert.equal(v2Prepared.operation.clickCount, 0);
assert.equal(
  publisherV2Store.prepare("FixtureOperator", v2Intent).operation.operationId,
  v2Prepared.operation.operationId,
  "同一语义内容必须复用同一 operation",
);
const beforeClickFailure = publisherV2Store.transition(
  v2Prepared.operation.operationId,
  "validation_failed",
  { lastError: "fixture_preclick_validation" },
);
assert.equal(beforeClickFailure.state, "validation_failed");
assert.equal(beforeClickFailure.clickCount, 0);
assert.notEqual(beforeClickFailure.state, "unknown_after_submit");
publisherV2Store.markPrepared(v2Prepared.operation.operationId, {
  pageTargetId: "publisher-v2-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
  pageSyncDigest: v2Prepared.operation.semanticHash,
  previewDigest: v2Prepared.operation.semanticHash,
});
const v2ClickIntent = publisherV2Store.transition(
  v2Prepared.operation.operationId,
  "click_intent_recorded",
  { requestEvidence: { semanticHash: publishSemanticHash(v2Intent) } },
);
assert.equal(v2ClickIntent.clickCount, 1);
assert.throws(
  () => publisherV2Store.transition(v2Prepared.operation.operationId, "click_intent_recorded"),
  /PUBLISH_CLICK_ALREADY_RECORDED/,
);
publisherV2Store.transition(v2Prepared.operation.operationId, "submitted_unverified", {
  responseEvidence: { responseSeen: false },
});
publisherV2Store.transition(v2Prepared.operation.operationId, "unknown_after_submit", {
  lastError: "fixture_network_timeout",
});
const v2Unsent = publisherV2Store.transition(v2Prepared.operation.operationId, "confirmed_unsent", {
  lastError: "fixture_readback_no_match",
});
assert.equal(v2Unsent.state, "confirmed_unsent");
const v2Resumed = publisherV2Store.transition(v2Prepared.operation.operationId, "prepared");
assert.equal(v2Resumed.clickCount, 0, "确认未发送后必须可恢复一次新的单击机会");
const v2SecondIntent = publisherV2Store.transition(v2Prepared.operation.operationId, "click_intent_recorded");
assert.equal(v2SecondIntent.clickCount, 1);
publisherV2Store.transition(v2Prepared.operation.operationId, "submitted_unverified");
const v2Published = publisherV2Store.transition(v2Prepared.operation.operationId, "published", {
  workId: "7664888888888888888",
  workUrl: "https://www.douyin.com/note/7664888888888888888",
});
assert.equal(v2Published.state, "published");
assert.equal(
  publisherV2Store.prepare("FixtureOperator", v2Intent).operation.state,
  "published",
  "响应丢失后按语义哈希恢复成功时重复调用不得再次点击",
);
assert.equal(classifyPublishedWorkAvailability({
  expectedWorkId: "7664888888888888888",
  responseStatus: 200,
  finalUrl: "https://www.douyin.com/note/7664888888888888888",
  bodyText: "你要观看的图文不存在",
  observedWorkId: "7664888888888888888",
  hasWorkDetailEvidence: false,
}), "deleted_or_unavailable");
const v2Deleted = publisherV2Store.transition(
  v2Prepared.operation.operationId,
  "deleted_or_unavailable",
  { lastError: "fixture_manual_delete" },
);
assert.equal(v2Deleted.state, "deleted_or_unavailable");
const v2Republish = publisherV2Store.prepare("FixtureOperator", v2Intent);
assert.notEqual(v2Republish.operation.operationId, v2Prepared.operation.operationId);
assert.equal(v2Republish.operation.state, "prepared");
assert.equal(v2Republish.operation.clickCount, 0);
assert.equal(v2Republish.draft.revision, v2Prepared.draft.revision + 1);
assert.equal(
  publisherV2Store.prepare("FixtureOperator", v2Intent).operation.operationId,
  v2Republish.operation.operationId,
  "人工删除后应创建并复用新的语义发布事务",
);

const mentionIntent = await buildPublishIntent({
  contentType: "carousel",
  title: v2Intent.title,
  caption: v2Intent.caption,
  imagePaths: [fixtureImageA],
  hashtags: v2Intent.hashtags,
  mentions: [{ alias: "bound_user", placement: "caption_end" }],
});
assert.notEqual(
  publishSemanticHash(mentionIntent),
  publishSemanticHash(v2Intent),
  "冻结的原生 mention 必须进入语义哈希",
);
assert.equal(mentionIntent.mentions[0].displayName, "FixtureBoundUser");
assert.equal(mentionIntent.mentions[0].uid, "10000000002");
assert.ok(mentionIntent.mentions[0].secUid);
const mentionPrepared = publisherV2Store.prepare("FixtureOperator", mentionIntent);
assert.notEqual(mentionPrepared.operation.operationId, v2Republish.operation.operationId);
assert.equal(mentionPrepared.draft.previewDigest, null);
assert.equal(mentionPrepared.draft.pageSyncDigest, null);
publisherV2Store.markPrepared(mentionPrepared.operation.operationId, {
  pageTargetId: "publisher-v2-mention-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
  pageSyncDigest: publishSemanticHash(mentionIntent),
  previewDigest: publishSemanticHash(mentionIntent),
});
const mentionPreparedPersisted = publisherV2Store.getOperation(
  mentionPrepared.operation.operationId,
);
assert.ok(mentionPreparedPersisted);
const mentionDraftPersisted = publisherV2Store.requireDraft(mentionPrepared.draft.draftId);
assert.equal(mentionDraftPersisted.previewDigest, publishSemanticHash(mentionIntent));

const notificationStore = new NotificationStore();
const notificationMention = parseNotificationCandidate({
  notice_id: "7665220941693584424",
  notice_type: "45",
  noticeLogInfo: { interact_type: "at" },
  aweme_id: "7665220794474205620",
  schema_url: "https://www.douyin.com/note/7665220794474205620",
  user: {
    nickname: "FixtureBoundUser",
    uid: "10000000002",
    sec_uid: "MS4wLjABAAAA_TEST_BOUND_USER_0000000000000000000000",
  },
  aweme: {
    aweme_id: "7665220794474205620",
    author: {
      nickname: "FixtureBoundUser",
      uid: "10000000002",
      sec_uid: "MS4wLjABAAAA_TEST_BOUND_USER_0000000000000000000000",
    },
  },
}).item!;
const notificationComment = parseNotificationCandidate({
  notice_id: "7665983569164452879",
  notice_type: "31",
  noticeLogInfo: { interact_type: "comment" },
  aweme_id: "7664665666477133107",
  comment: {
    cid: "7665983526496879397",
    text: "fixture exact comment",
    user: { uid: "22222222222", sec_uid: "MS4w.fixture-commenter" },
  },
  aweme: {
    aweme_id: "7664665666477133107",
    author: { uid: "33333333333", sec_uid: "MS4w.fixture-author" },
  },
}).item!;
notificationStore.upsert([notificationMention, notificationMention, notificationComment]);
assert.equal(Number((sqlite.getDatabase().prepare(
  "SELECT COUNT(*) AS count FROM notification_records",
).get() as { count: number | bigint }).count), 2);
const frozenCommentTarget = freezeNotificationReplyTarget(notificationComment);
assert.deepEqual({
  noticeId: frozenCommentTarget.noticeId,
  targetKind: frozenCommentTarget.targetKind,
  workId: frozenCommentTarget.workId,
  commentId: frozenCommentTarget.commentId,
}, {
  noticeId: "7665983569164452879",
  targetKind: "comment",
  workId: "7664665666477133107",
  commentId: "7665983526496879397",
});
const frozenWorkTarget = freezeNotificationReplyTarget(notificationMention);
assert.equal(frozenWorkTarget.targetKind, "work_mention");
assert.equal(frozenWorkTarget.commentId, null);
const checkpointCandidate = notificationStore.createCandidate(
  "all",
  [notificationMention.noticeId, notificationComment.noticeId, notificationMention.noticeId],
);
assert.deepEqual(checkpointCandidate.noticeIds, [
  notificationMention.noticeId,
  notificationComment.noticeId,
]);
assert.throws(() => notificationStore.acknowledge({
  candidate: checkpointCandidate.candidate,
  confirm: false,
}), /NOTIFICATION_CHECKPOINT_CONFIRMATION_REQUIRED/);
const checkpointAck = notificationStore.acknowledge({
  candidate: checkpointCandidate.candidate,
  confirm: true,
});
assert.deepEqual(checkpointAck.acknowledgedNoticeIds, checkpointCandidate.noticeIds);
assert.equal(checkpointAck.localOnly, true);
const repeatedCheckpointAck = notificationStore.acknowledge({
  candidate: checkpointCandidate.candidate,
  confirm: true,
});
assert.deepEqual(repeatedCheckpointAck.alreadyAcknowledgedNoticeIds, checkpointCandidate.noticeIds);
assert.throws(() => notificationStore.acknowledge({
  noticeIds: ["7665000000000000999"],
  confirm: true,
}), /NOTIFICATION_NOT_PARSED/);
assert.equal(notificationStore.checkpoint("all").acknowledgedCount, 2);
notificationStore.audit({
  noticeId: notificationComment.noticeId,
  action: "prepare_reply",
  snapshotHash: frozenCommentTarget.snapshotHash,
  operationId: null,
  evidence: { frozenTarget: frozenCommentTarget, sent: false },
});
assert.equal(Number((sqlite.getDatabase().prepare(
  "SELECT COUNT(*) AS count FROM notification_audit WHERE notice_id=? AND action='prepare_reply'",
).get(notificationComment.noticeId) as { count: number | bigint }).count), 1);
assert.equal(sqlite.getDatabase().prepare("PRAGMA foreign_key_check").all().length, 0);
assert.ok(sqlite.getMetadata("migration_v1.9.0"));

const migrationDraft = postDraftStore.create("FixtureOperator");
const migrationDraftWithMedia = postDraftStore.updateContent(migrationDraft.draftId, {
  title: "legacy migration fixture",
  caption: "legacy body #AI",
  media: [buildPostDraftMedia(fixtureImageB)],
  coverIndex: 0,
});
postDraftStore.markPageSynced(migrationDraft.draftId, {
  pageTargetId: "legacy-migration-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
});
const migrationSnapshot = {
  draftId: migrationDraft.draftId,
  contentType: "carousel" as const,
  actorAccount: migrationDraftWithMedia.actorAccount,
  title: migrationDraftWithMedia.title,
  caption: migrationDraftWithMedia.caption,
  media: migrationDraftWithMedia.media.map((item, order) => ({ ...item, order })),
  selectedMusic: null,
  coverIndex: 0,
  pageTargetId: "legacy-migration-target",
  pageUrl: "https://creator.douyin.com/creator-micro/content/post/image",
  capturedAt: new Date().toISOString(),
};
const legacyMigrationOperation = postDraftStore.preparePublish(
  migrationDraft.draftId,
  migrationSnapshot,
);
postDraftStore.claimPublish(legacyMigrationOperation.operationId);
postDraftStore.updateOperation(legacyMigrationOperation.operationId, {
  state: "unknown_after_submit",
  lastError: "fixture_legacy_unknown",
});
assert.equal(
  postDraftStore.listUnresolved().some(item => item.operationId === legacyMigrationOperation.operationId),
  true,
);
const migratedIntent = await buildPublishIntent({
  contentType: "carousel",
  title: migrationSnapshot.title,
  caption: migrationSnapshot.caption,
  imagePaths: migrationSnapshot.media.map(item => item.path),
});
const migratedV2 = publisherV2Store.prepare("FixtureOperator", migratedIntent);
const migrationRecord = publisherV2Store.registerLegacyMigration({
  legacyOperationId: legacyMigrationOperation.operationId,
  legacyDraftId: legacyMigrationOperation.draftId,
  v2OperationId: migratedV2.operation.operationId,
  v2DraftId: migratedV2.draft.draftId,
  migrationState: "prepared",
});
assert.equal(migrationRecord.v2OperationId, migratedV2.operation.operationId);
publisherV2Store.markLegacyMigrationState(legacyMigrationOperation.operationId, "superseded");
assert.equal(
  postDraftStore.listUnresolved().some(item => item.operationId === legacyMigrationOperation.operationId),
  false,
  "legacy 事务被 V2 接管后不能继续出现在 pending 列表",
);
assert.equal(
  publisherV2Store.getLegacyMigrationByV2Operation(migratedV2.operation.operationId)?.legacyOperationId,
  legacyMigrationOperation.operationId,
);
const mergedPublishOperations = new DouyinBrowser().listPublishOperationsV2(20) as any;
assert.equal(mergedPublishOperations.v2Count >= 1, true);
assert.equal(mergedPublishOperations.legacyCount >= 1, true);
assert.equal(
  mergedPublishOperations.operations.some((item: any) => item.storage === "publisher_v2"),
  true,
);
assert.equal(
  mergedPublishOperations.operations.some((item: any) => item.storage === "legacy_post_publish"),
  true,
);
assert.equal(
  mergedPublishOperations.legacyOperations.some((item: any) =>
    item.operation_id === legacyMigrationOperation.operationId
      && item.status === "superseded"
      && item.recoverable === false
      && item.superseded_by === migratedV2.operation.operationId),
  true,
  "统一事务列表必须把已迁移 legacy 标成 superseded",
);

const deleteStore = new CreatorCommentDeleteStore();
const preparedDelete = deleteStore.create({
  actorAccount: "FixtureOperator",
  workId: "7000000000000000001",
  commentId: "1000000000000000777",
  targetAuthor: "controlled-malicious-user",
  targetText: "controlled malicious fixture",
  targetTextHash: sha256("controlled malicious fixture"),
  parentCommentId: null,
  rootCommentId: "1000000000000000777",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
assert.equal(preparedDelete.state, "prepared");
assert.equal(
  new CreatorCommentDeleteStore().require(preparedDelete.operationId).state,
  "prepared",
);
const deleteStarted = deleteStore.claimDeleteStarted(preparedDelete.operationId);
assert.equal(deleteStarted.state, "delete_started");
assert.throws(
  () => deleteStore.claimDeleteStarted(preparedDelete.operationId),
  /DELETE_RETRY_BLOCKED/,
);
deleteStore.update(preparedDelete.operationId, {
  state: "unknown_after_submit",
  lastError: "fixture_crash_after_delete_confirm",
});
assert.equal(
  new CreatorCommentDeleteStore().listUnresolvedAfterSubmit()
    .some(item => item.operationId === preparedDelete.operationId),
  true,
);
const confirmedDelete = deleteStore.update(preparedDelete.operationId, {
  state: "confirmed",
  confirmedAt: new Date().toISOString(),
  lastError: null,
});
assert.equal(confirmedDelete.state, "confirmed");
assert.equal(deleteStore.listUnresolvedAfterSubmit().length, 0);
assert.equal(deleteStore.create({
  actorAccount: "FixtureOperator",
  workId: "7000000000000000001",
  commentId: "1000000000000000777",
  targetAuthor: "controlled-malicious-user",
  targetText: "controlled malicious fixture",
  targetTextHash: sha256("controlled malicious fixture"),
  parentCommentId: null,
  rootCommentId: "1000000000000000777",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
}).state, "confirmed");

const socialStore = new SocialOperationStore();
const socialPrepared = socialStore.prepare({
  actionKind: "message",
  actorAccount: "FixtureOperator",
  boundAlias: "bound_user",
  targetUid: "controlled-bound-uid",
  conversationId: sha256("controlled-conversation"),
  targetContextHash: sha256("controlled-last-message"),
  payloadHash: sha256("controlled-message"),
  evidence: {
    identityVersion: "server_id_v1",
    beforeMatchingMessageIds: ["controlled-existing-same-text-id"],
    beforeLatestMessageId: "controlled-latest-server-id",
    nativeReferenceRequired: false,
  },
});
assert.equal(socialPrepared.state, "prepared");
assert.deepEqual(
  new SocialOperationStore().require(socialPrepared.operationId)
    .evidence.beforeMatchingMessageIds,
  ["controlled-existing-same-text-id"],
);
const socialClaimed = socialStore.claim(socialPrepared.operationId);
assert.equal(socialClaimed.state, "click_started");
assert.throws(
  () => socialStore.claim(socialPrepared.operationId),
  /SOCIAL_RETRY_BLOCKED/,
);
const socialUnknown = socialStore.update(socialPrepared.operationId, {
  state: "unknown_after_submit",
  lastError: "fixture_message_readback_interrupted",
});
assert.equal(socialUnknown.state, "unknown_after_submit");
assert.deepEqual(
  socialUnknown.evidence.beforeMatchingMessageIds,
  ["controlled-existing-same-text-id"],
);
assert.equal(
  socialStore.prepare({
    actionKind: "message",
    actorAccount: "FixtureOperator",
    boundAlias: "bound_user",
    targetUid: "controlled-bound-uid",
    conversationId: sha256("controlled-conversation"),
    targetContextHash: sha256("controlled-last-message"),
    payloadHash: sha256("controlled-message"),
  }).operationId,
  socialPrepared.operationId,
);
const socialConfirmed = socialStore.update(socialPrepared.operationId, {
  state: "confirmed",
  resultingMessageId: "controlled-server-message-id",
  evidence: { exactTextHashMatched: true },
  lastError: null,
});
assert.equal(socialConfirmed.state, "confirmed");
assert.equal(socialStore.listUnresolved().length, 0);

const result = {
  status: "PASS",
  database: path.basename(databasePath),
  cases: [
    "prepare_persisted_before_token",
    "crash_after_prepare_before_commit",
    "crash_after_click_started_before_click",
    "crash_after_submit_before_confirmation",
    "confirmed_idempotency_recovery",
    "same_comment_same_reply_unique",
    "same_comment_different_reply_allowed",
    "authorized_bound_creator_account_config",
    "creator_actor_identity_persisted",
    "comment_dedupe_persistent",
    "page_binding_persistent",
    "sqlite_wal_enabled",
    "sqlite_lock_fail_closed",
    "global_write_gate_fail_closed",
    "global_gate_is_work_agnostic",
    "unresolved_operation_is_target_scoped",
    "bound_root_comment_durable_idempotency",
    "external_nested_reply_thread_path",
    "creator_store_rejects_general_rows",
    "write_execution_adapter_route_matrix",
    "target_gate_scope_role_target_fail_closed",
    "generic_unknown_after_submit_restart_recovery",
    "unresolved_root_lock_blocks_same_text_only",
    "distinct_root_comment_on_same_work_allowed",
    "unrelated_target_remains_writable",
    "click_attempted_is_not_clicked",
    "click_no_effect_does_not_block_global_gate",
    "adaptive_attempts_require_click_no_effect",
    "adaptive_attempt_limit_is_persistent",
    "adaptive_audit_steps_persist",
    "adaptive_reconcile_audit_appends_and_preserves_old_steps",
    "adaptive_unknown_after_submit_is_read_only",
    "aborted_no_submit_can_be_reprepared",
    "expired_preview_can_be_reprepared",
    "click_effect_confirmation_is_persisted",
    "multiple_creator_pages_binding_conflict",
    "account_mismatch_fail_closed",
    "post_draft_sqlite_persistence",
    "post_media_order_persistence",
    "post_preview_idempotency_ignores_capture_time",
    "post_publish_click_claim_is_atomic",
    "post_publish_duplicate_click_is_blocked",
    "post_publish_unknown_survives_restart",
    "post_publish_readback_can_confirm",
    "publisher_v2_semantic_snapshot_ignores_transient_ui",
    "publisher_v2_content_type_routes_independently_of_current_page",
    "publisher_v2_content_hash_ignores_local_path",
    "publisher_v2_preclick_failure_is_not_unknown",
    "publisher_v2_click_claim_is_atomic",
    "publisher_v2_confirm_unsent_can_resume",
    "publisher_v2_semantic_idempotency_returns_published",
    "publisher_v2_deleted_work_creates_new_revision",
    "publisher_v2_deleted_work_availability_fixture",
    "publisher_v2_native_mention_in_semantic_hash",
    "publisher_v2_mention_change_invalidates_preview",
    "notification_notice_id_sqlite_dedupe",
    "notification_checkpoint_confirmed_local_only",
    "notification_checkpoint_idempotent",
    "notification_checkpoint_rejects_unparsed_notice",
    "notification_exact_reply_target_frozen",
    "notification_prepare_audit_persisted",
    "sqlite_v190_migration_and_foreign_keys",
    "publisher_operation_list_merges_v2_and_legacy",
    "creator_comment_delete_prepared_persisted",
    "creator_comment_delete_claim_is_atomic",
    "creator_comment_delete_unknown_blocks_retry",
    "creator_comment_delete_readback_can_confirm",
    "unknown_root_abort_is_rejected",
    "click_effect_confirmed_abort_is_rejected",
    "social_message_preclick_baseline_persisted",
    "social_message_click_claim_is_atomic",
    "social_message_unknown_blocks_retry",
    "social_message_server_id_can_confirm",
    "root_comment_server_id_platform_normalization",
    "root_comment_unknown_manual_archive",
  ],
};
console.log(`RECOVERY_FIXTURES=${JSON.stringify(result)}`);

sqlite.closeDatabase();
fs.rmSync(tempDir, { recursive: true, force: true });
