import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
} from "playwright-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { CONFIG } from "./config.js";
import {
  canonicalPageRoleReference,
  disposableDuplicatePageKey,
  pageReferenceAliases,
  rootCommentPagePreference,
  rootCommentWorkIdFromUrl,
} from "./browser-page-policy.js";
import {
  assertAllowedUrl,
  assertCreatorCommentManagerPage,
  assertDouyinPublishPage,
  assertDouyinWorkUrl,
  assertSafeElement,
} from "./safety.js";
import { log } from "./logger.js";
import {
  ARTICLE_PRIVACY_ERROR,
  assertWorkId,
  filterPrivateUiText,
  formatTimestamp,
  normalizeText,
  parseDouyinMetaDescription,
  parseNativeChapters,
  selectTrustedArticleCandidate,
  timelineSampleTimes,
  workIdFromUrl,
} from "./content.js";
import type {
  AllowedTab,
  ArticleTextResult,
  ArticleCoverResult,
  BoundConversationOpenResult,
  BoundMediaPageResult,
  BoundMediaQueueItem,
  BoundMediaQueueResult,
  BoundMessage,
  BoundMessageListResult,
  BoundMessageOpenResult,
  BoundMessageMediaOpenResult,
  BoundMessageUpdatesResult,
  BoundUserPost,
  BoundUserPostOpenResult,
  BoundUserPostPage,
  BoundUserPublic,
  ChapterResult,
  CommentReadResult,
  CommentActionResult,
  CreatorCommentItem,
  CreatorCommentFindItem,
  CreatorCommentFindResult,
  CreatorCommentListResult,
  CreatorCommentManagerOpenResult,
  CreatorCommentOpenByIdResult,
  CreatorCommentScanResult,
  CreatorCommentUpdatesResult,
  CreatorCompactComment,
  CreatorCurrentFilteredCommentsResult,
  CreatorReplyPlanResult,
  CreatorPrepareReplyFromMatchResult,
  CreatorReplyResult,
  CreatorReplyReconcileResult,
  CreatorReplyTransactionResult,
  PreparedPostWriteResult,
  CommittedPostWriteResult,
  CurrentWorkContextResult,
  DouyinHealthcheckResult,
  DouyinStartupSelfCheckResult,
  DouyinActionResult,
  DouyinComment,
  DouyinGalleryResult,
  InteractiveElement,
  LightweightScrollResult,
  MediaProbe,
  MusicActionResult,
  MusicItem,
  Observation,
  OwnCommentUpdatesResult,
  OwnPost,
  OwnPostOpenResult,
  OwnPostPage,
  ProfileRecommendation,
  ProfileRecommendationOpenResult,
  ProfileRecommendationPage,
  PostDraftListResult,
  PostDraftResult,
  PostMusicPickerDebugResult,
  PostMusicResult,
  PostPreviewResult,
  PostPublishResult,
  PostPublishStatusResult,
  PublishCarouselResult,
  PublishTextResult,
  DraftInspectionResult,
  SafeSocialActionStatus,
  TimelineInspectionResult,
  TranscriptRecord,
  ViewportDiagnostics,
  WorkContext,
} from "./types.js";
import { transcribeCurrentMedia } from "./transcript.js";
import {
  getBoundUser,
  loadActionSettings,
  loadBoundUsers,
  type BoundUser,
} from "./action-config.js";
import { appendActionLog } from "./action-log.js";
import { enforceWritePolicy } from "./action-policy.js";
import {
  getTextPreviewRecord,
  lockCurrentTextPreview,
  markTextPreviewSubmitAttempted,
  markTextPreviewPublished,
  prepareCarouselPublication,
  prepareTextPublication,
  verifyTextPreviewSnapshot,
} from "./publisher.js";
import { loadPageBindings, savePageBinding } from "./page-bindings.js";
import { browserProfileId } from "./page-bindings.js";
import { ensureDedicatedBrowserConnected } from "./browser-launcher.js";
import { assertWriteReady, getWriteGateState, setWriteGateState } from "./write-gate.js";
import { decideStartupBinding, startupFailureMode } from "./startup-recovery-policy.js";
import {
  assertTargetWriteGate,
  createTargetWriteGate,
  type TargetWriteGate,
  type TargetWriteScope,
} from "./target-write-gate.js";
import {
  WriteOperationStore,
  resolveWriteExecutionAdapter,
  type WriteOperationRecord,
} from "./write-operation-store.js";
import {
  chooseRootCommentComposer,
  type RootCommentComposerCandidate,
} from "./comment-composer.js";
import {
  inspectArticleEditor,
  inspectCurrentDraft,
  removeArticleCover,
  resetCurrentDraft,
  uploadArticleCover,
  verifyArticleCover,
} from "./publisher-tools.js";
import { decideCommentAction } from "./comment-workflow.js";
import {
  CreatorReplyStore,
  creatorReplyIdempotencyKey,
  frozenCreatorTargetMatches,
  sha256,
  type CreatorReplyPlanRecord,
} from "./creator-reply-store.js";
import {
  CreatorCommentDeleteStore,
  type CreatorCommentDeleteOperation,
} from "./creator-comment-delete-store.js";
import { SocialOperationStore } from "./social-operation-store.js";
import {
  creatorCommentCombinedMatchScore,
  creatorCommentMatchesQuery,
  normalizeCreatorReplyText,
  type CreatorCommentMatchMode,
} from "./creator-comment-match.js";
import { assertBoundPostTab, decideLikeTransition, workLockMatches } from "./bound-post-workflow.js";
import { getSafeSocialAction, loadSafeSocialActions, type SafeSocialAction } from "./social-config.js";
import { classifyAdaptiveSubmitEvidence } from "./adaptive-comment-policy.js";
import {
  compareMessageRecency,
  parseBoundMessageCandidate,
  type RawBoundMessageCandidate,
} from "./features/messages/message-parsing.js";
import {
  decodeFirstFrameAsPng,
  inspectImageBytes,
  synchronizeVisualMetadata,
  type SupportedImageMime,
} from "./features/messages/image-content.js";
import {
  classifyManualNetworkSignal,
  classifyManualTarget,
  decideManualRetry,
  pointInsideBox,
  type ManualPointInspection,
  type ManualTarget,
} from "./features/manual-control/manual-control-policy.js";
import { appError } from "./app/errors.js";
import {
  ensureRootCommentBrowserConnected,
  rootCommentProfileDir,
  rootCommentProfileId,
} from "./root-comment-browser-launcher.js";
import {
  classifyRootCommentSubmit,
  isRootCommentSubmitEndpoint,
  sanitizeRootCommentResponse,
  type RootCommentSubmitClassification,
  type SanitizedRootCommentResponse,
} from "./root-comment-submit-policy.js";
import { classifyPlatformCommentText } from "./comment-text-normalization.js";
import {
  PostDraftStore,
  buildPostDraftMedia,
  type PostDraftRecord,
  type PostPublishOperationRecord,
} from "./post-draft-store.js";
import {
  buildPostDraftSnapshot,
  carouselInspectionMatchesDraft,
  clickPublishCarouselOnce,
  dispatchPublishCarouselOnce,
  dismissCarouselTransientOverlays,
  closePostMusicPicker,
  debugPostMusicPicker,
  inspectCarouselPage,
  isPostMusicPickerOpen,
  locatePostMusicCandidateRows,
  openPostMusicPicker,
  postCaptionEquivalent,
  readPostMusicCandidates,
  readSelectedPostMusic,
  removeSelectedPostMusic,
  searchPostMusic,
  selectPostMusicCandidate,
  syncCarouselDraftToPage,
  type PostMusicCandidateSelector,
} from "./post-draft-publisher.js";
import {
  PublisherV2Store,
  asCarouselDraft,
  buildPublishIntent,
  carouselSemanticMatches,
  classifyPublishedWorkAvailability,
  projectedCarouselCaption,
  publishIntentSummary,
  publishRouteForContentType,
  type PublishAction,
  type PublishContentIntent,
  type PublishContentType,
  type PublishV2OperationRecord,
  type PublishVisibility,
} from "./publisher-v2.js";
import type { PublishMentionInput } from "./features/publisher/native-mention.js";
import {
  canonicalizeNotificationCandidate,
  compactNotification,
  dedupeNotifications,
  freezeNotificationReplyTarget,
  notificationExtractionFailureCode,
  notificationSnapshotHash,
  parseNotificationCandidate,
  type CanonicalNotificationCandidate,
  type NotificationExtractionDiagnostics,
  type NotificationFilter,
  type NotificationItem,
} from "./features/notifications/notification-parsing.js";
import { NotificationStore } from "./features/notifications/notification-store.js";
import {
  businessCodeSucceeded,
  classifyLowRiskVerification,
  inspectLowRiskMutationRequest,
  pageRoleForPostScope,
  responseBusinessCode,
  verificationIsSuccess,
  type LowRiskNetworkObservation,
  type LowRiskPostActionKind,
  type LowRiskVerification,
} from "./low-risk-post-action.js";

const ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS = 3;
const ADAPTIVE_COMMENT_SETTLE_MS = 1_800;
const postDraftStore = new PostDraftStore();
const publisherV2Store = new PublisherV2Store();
import {
  PersistentStateStore,
  type PageRole,
  type SavedPageState,
} from "./state-store.js";
import {
  resolveDetectedAccount,
  type DetectedAccountCandidate,
  type DetectedSetupAccount,
} from "./setup-config.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ResolvedPostWriteTarget = {
  page: Page;
  pageRole: "operator_home" | "codex_test";
  context: WorkContext;
  workId: string;
  author: string;
  accountVerified: true;
  autoplayLocked: true;
};

type CreatorApiComment = {
  commentId: string;
  text: string;
  author: string;
  authorUid: string | null;
  authorSecUid: string | null;
  createdAt: number | null;
  likeCount: number | null;
  status: number | null;
  parentCommentId: string | null;
  replyCount: number;
  level: number;
  avatarFingerprint: string | null;
};

type AuthorizedCreatorAccount = {
  alias: string;
  displayName: string;
  uid: string;
  secUid: string;
  source: "operator" | "bound_user";
};

type CreatorCommentSnapshot = {
  workId: string | null;
  comments: CreatorApiComment[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
};

type CreatorCommentMappingDiagnostics = {
  workId: string;
  commentId: string;
  parentCommentId: string | null;
  isReply: boolean;
  parentCommentFound: boolean;
  parentThreadExpanded: boolean;
  scannedRootCommentCount: number;
  scannedReplyCommentCount: number;
  stableIdCandidateCount: number;
  authorTextCandidateCount: number;
  selector: string;
  scope: "page" | "parent_thread";
  virtualListDetected: boolean;
};

type ResolvedCreatorReplyTarget = {
  target: CreatorCommentItem;
  threadRoot: CreatorCommentItem;
  immediateParent: CreatorCommentItem | null;
};

type CreatorReplyDomTarget = ResolvedCreatorReplyTarget & {
  targetApi: CreatorApiComment;
  threadRootRecord: Locator;
  targetRecord: Locator;
  parentThreadExpanded: boolean;
};

type CreatorScanCacheEntry = {
  snapshotId: string;
  signature: string;
  workId: string;
  workTitle: string | null;
  items: CreatorCommentItem[];
  filteredItems: CreatorCommentItem[];
  createdAt: number;
  expiresAt: number;
};

type CreatorCommentDatasetCacheEntry = {
  workId: string;
  workTitle: string | null;
  snapshot: CreatorCommentSnapshot;
  items: CreatorCommentItem[];
  includesReplies: boolean;
  completeRootScan?: boolean;
  capturedAt: number;
};

type CreatorCommentMatchTokenRecord = {
  token: string;
  item: CreatorCommentItem;
  matchScore: number;
  createdAt: number;
  expiresAt: number;
};

type CreatorCurrentFilteredRead = {
  keyword: string;
  workId: string;
  workTitle: string | null;
  items: CreatorCommentItem[];
};

function postDraftResult(record: PostDraftRecord): PostDraftResult {
  return {
    draftId: record.draftId,
    draft_id: record.draftId,
    contentType: record.contentType,
    actorAccount: record.actorAccount,
    state: record.state,
    title: record.title,
    caption: record.caption,
    media: record.media.map((item, order) => ({ ...item, order })),
    imageCount: record.media.length,
    selectedMusic: record.selectedMusic,
    coverIndex: record.coverIndex,
    pageSynced: record.desiredDigest === record.pageSyncedDigest,
    previewReady: Boolean(
      record.previewDigest
      && record.desiredDigest === record.pageSyncedDigest,
    ),
    pageTargetId: record.pageTargetId,
    pageUrl: record.pageUrl,
    publishedWorkId: record.publishedWorkId,
    publishedWorkUrl: record.publishedWorkUrl,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastVerifiedAt: record.lastVerifiedAt,
    lastError: record.lastError,
  };
}

type ObservationSnapshot = {
  observationId: string;
  ownerId: string;
  pageId: string;
  pageTargetId: string;
  url: string;
  snapshotHash: string;
  expiresAt: number;
  screenshotBase64: string | null;
  screenshotViewport: { width: number; height: number } | null;
  elements: Map<string, InteractiveElement>;
  selectors: Map<string, string>;
  fingerprints: Map<string, {
    selector: string;
    tag: string;
    role: string;
    label: string;
    href: string | null;
    dataE2e: string | null;
    kind: InteractiveElement["kind"];
  }>;
};

export class DouyinBrowser {
  private browser: Browser | null = null;
  private rootCommentBrowser: Browser | null = null;
  private rootCommentPageRef: Page | null = null;
  private latestElements = new Map<string, InteractiveElement>();
  private latestElementSelectors = new Map<string, string>();
  private latestElementFingerprints = new Map<string, {
    selector: string;
    tag: string;
    role: string;
    label: string;
    href: string | null;
    dataE2e: string | null;
    kind: InteractiveElement["kind"];
  }>();
  private readonly observationSnapshots = new Map<string, ObservationSnapshot>();
  private pageIds = new WeakMap<Page, string>();
  private pageTargetIds = new WeakMap<Page, string>();
  private pageRoles = new WeakMap<Page, PageRole>();
  private rolePages = new Map<PageRole, Page>();
  private readonly automationCreatedPages = new WeakSet<Page>();
  private readonly automationPagePurposes = new WeakMap<Page, string>();
  private activePageId: string | null = null;
  private pageSequence = 0;
  private operationLock: { id: string; startedAt: number } | null = null;
  private readonly operationContext = new AsyncLocalStorage<string>();
  private readonly stateStore = new PersistentStateStore();
  private readonly profileRecommendationCache = new Map<string, ProfileRecommendation>();
  private readonly boundUserPostCache = new Map<string, BoundUserPost>();
  private readonly ownPostCache = new Map<string, OwnPost>();
  private creatorAccountAvatarFingerprint: string | null = null;
  private activeCreatorAccount: AuthorizedCreatorAccount | null = null;
  private readonly creatorOwnReplyIds = new Map<string, string>();
  private readonly creatorReplyStore = new CreatorReplyStore();
  private readonly writeOperationStore = new WriteOperationStore();
  private readonly creatorCommentDeleteStore = new CreatorCommentDeleteStore();
  private readonly socialOperationStore = new SocialOperationStore();
  private readonly notificationStore = new NotificationStore();
  private readonly creatorScanCache = new Map<string, CreatorScanCacheEntry>();
  private readonly creatorCommentDatasetCache = new Map<string, CreatorCommentDatasetCacheEntry>();
  private readonly creatorCommentMatchTokens = new Map<string, CreatorCommentMatchTokenRecord>();
  private readonly lockedWorkContexts = new Map<"operator_home" | "codex_test", {
    workId: string;
    workUrl: string;
    alias: string | null;
    author: string | null;
    autoplayLocked: boolean;
    lockedAt: string;
  }>();
  private readonly feedWorkCache = new Map<string, {
    safeId: string;
    workId: string;
    url: string;
    title: string;
    author: string;
    contentType: "video" | "note" | "article";
    viewed: boolean;
  }>();
  private feedWorkOrder: string[] = [];
  private feedWorkIndex = -1;
  private readonly publishVerificationBaselines = new Map<string, {
    profileWorkCount: number;
    title: string;
    text: string;
    hashtags: string[];
  }>();

  private collectAllUnresolvedOperationIds(): string[] {
    return Array.from(new Set([
      ...this.creatorReplyStore
        .listUnresolvedAfterSubmit()
        .map(operation => operation.transactionId),
      ...this.writeOperationStore
        .listUnresolvedGeneral()
        .map(operation => operation.operationId),
      ...this.creatorCommentDeleteStore
        .listUnresolvedAfterSubmit()
        .map(operation => operation.operationId),
      ...postDraftStore
        .listUnresolved()
        .map(operation => operation.operationId),
      ...publisherV2Store
        .listUnresolved()
        .map(operation => operation.operationId),
      ...this.socialOperationStore
        .listUnresolved()
        .map(operation => operation.operationId),
    ]));
  }

  /**
   * Root-comment operations are protected by the durable target lock
   * (account + scope + work + action + exact text hash).  An old uncertain
   * root comment must therefore block only an identical re-send, not private
   * messages, creator replies, publishing, or a different root-comment text.
   * Other unresolved write families retain the fail-closed global gate.
   */
  private collectGlobalBlockingUnresolvedOperationIds(): string[] {
    return Array.from(new Set([
      ...this.creatorReplyStore
        .listUnresolvedAfterSubmit()
        .map(operation => operation.transactionId),
      ...this.writeOperationStore
        .listUnresolvedGeneral()
        .filter(operation => operation.actionType !== "create_root_comment")
        .map(operation => operation.operationId),
      ...this.creatorCommentDeleteStore
        .listUnresolvedAfterSubmit()
        .map(operation => operation.operationId),
      ...this.socialOperationStore
        .listUnresolved()
        .map(operation => operation.operationId),
    ]));
  }

  private async serial<T>(
    task: () => Promise<T>,
    options: { restoreOnError?: boolean; persistPageState?: boolean } = {},
  ): Promise<T> {
    if (this.operationLock) {
      if (this.operationContext.getStore() === this.operationLock.id) return task();
      const ageMs = Date.now() - this.operationLock.startedAt;
      throw new Error(`页面互斥锁被占用：已有工具正在操作专用抖音页面（已运行 ${Math.ceil(ageMs / 1000)} 秒）。请稍后重试，本次没有同时操作页面。`);
    }
    const lock = {
      id: `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      startedAt: Date.now(),
    };
    this.operationLock = lock;
    return this.operationContext.run(lock.id, async () => {
      let before: SavedPageState[] = [];
      try {
        await this.ensurePageRoles();
        if (options.restoreOnError !== false) {
          before = await this.captureRolePageStates();
        }
        const result = await task();
        if (options.persistPageState !== false) {
          await this.stateStore.savePageStates(await this.captureRolePageStates());
        }
        return result;
      } catch (error) {
        if (options.restoreOnError !== false && before.length) {
          await this.restoreRolePageStates(before).catch(() => null);
        }
        if (options.persistPageState !== false) {
          await this.stateStore.savePageStates(await this.captureRolePageStates()).catch(() => null);
        }
        throw error;
      } finally {
        if (this.operationLock?.id === lock.id) this.operationLock = null;
      }
    });
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.serial(task);
  }

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connectOverCDP(CONFIG.cdpUrl, { timeout: 6_000 });
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.latestElements.clear();
        this.rolePages.clear();
      });
      log("browser_connected", { cdpUrl: CONFIG.cdpUrl });
      return this.browser;
    } catch (error) {
      throw new Error(
        `没有连接到专用浏览器。请先双击 START_BRIDGE.cmd。原始错误：${String(error)}`,
      );
    }
  }

  private async connectRootCommentBrowser(
    allowLaunch = true,
  ): Promise<{
    browser: Browser;
    launched: boolean;
  }> {
    const state = await ensureRootCommentBrowserConnected(allowLaunch);
    if (this.rootCommentBrowser?.isConnected()) {
      return { browser: this.rootCommentBrowser, launched: state.launched };
    }
    try {
      this.rootCommentBrowser = await chromium.connectOverCDP(
        CONFIG.rootCommentCdpUrl,
        { timeout: 6_000 },
      );
      this.rootCommentBrowser.on("disconnected", () => {
        this.rootCommentBrowser = null;
        this.rootCommentPageRef = null;
      });
      log("root_comment_browser_connected", {
        cdpUrl: CONFIG.rootCommentCdpUrl,
        profileId: rootCommentProfileId,
      });
      return { browser: this.rootCommentBrowser, launched: state.launched };
    } catch (error) {
      throw new Error(
        "ROOT_COMMENT_BROWSER_CONNECT_FAILED:"
        + `无法连接 operator_root_comment_clean：${String(error)}`,
      );
    }
  }

  private async rootCommentPage(
    allowLaunch = true,
  ): Promise<{ page: Page; launched: boolean }> {
    const connected = await this.connectRootCommentBrowser(allowLaunch);
    const context = connected.browser.contexts()[0];
    if (!context) {
      throw new Error(
        "ROOT_COMMENT_BROWSER_CONTEXT_MISSING:"
        + "operator_root_comment_clean 没有可用浏览器上下文。",
      );
    }
    if (this.rootCommentPageRef
      && !this.rootCommentPageRef.isClosed()
      && context.pages().includes(this.rootCommentPageRef)) {
      return { page: this.rootCommentPageRef, launched: connected.launched };
    }
    const pages = context.pages().filter(page => !page.isClosed());
    const workPages = pages.filter(page => rootCommentWorkIdFromUrl(page.url()));
    const workIds = new Set(workPages.map(page => rootCommentWorkIdFromUrl(page.url())));
    if (workIds.size > 1) {
      throw new Error(
        `ROOT_COMMENT_BINDING_CONFLICT:独立 profile 中有 ${workIds.size} 个不同作品页；`
        + "请只保留一个根评论目标作品。",
      );
    }
    const preferredWorkPage = [...workPages].sort((left, right) =>
      rootCommentPagePreference(right.url()) - rootCommentPagePreference(left.url()))[0];
    this.rootCommentPageRef = preferredWorkPage
      ?? pages.find(page => page.url() === "about:blank")
      ?? await context.newPage();
    this.pageIds.set(this.rootCommentPageRef, "page-root-comment-clean");

    // This profile is dedicated to root-comment work. Old chat/profile tabs are
    // safe to retire only when they contain no visible user-entered text. Work
    // tabs for the same target are also reduced to one canonical page.
    for (const page of pages) {
      if (page === this.rootCommentPageRef || page.isClosed()) continue;
      const pageWorkId = rootCommentWorkIdFromUrl(page.url());
      if (pageWorkId && pageWorkId !== rootCommentWorkIdFromUrl(this.rootCommentPageRef.url())) {
        continue;
      }
      if (await this.pageHasProtectedUserInput(page)) {
        log("managed_page_cleanup_skipped", {
          profile: rootCommentProfileId,
          url: page.url(),
          reason: "visible_user_input",
        });
        continue;
      }
      await page.close({ runBeforeUnload: false }).then(() => {
        log("managed_page_closed", {
          profile: rootCommentProfileId,
          url: page.url(),
          reason: pageWorkId ? "duplicate_root_comment_work" : "out_of_scope_root_comment_page",
        });
      }).catch(error => {
        log("managed_page_cleanup_failed", {
          profile: rootCommentProfileId,
          url: page.url(),
          error: String(error),
        });
      });
    }
    return { page: this.rootCommentPageRef, launched: connected.launched };
  }

  private async pageHasProtectedUserInput(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;
    return page.evaluate(() => {
      const hasMeaningfulText = (value: string): boolean =>
        value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length > 0;
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const elements = Array.from(document.querySelectorAll(
        "textarea, [contenteditable='true'], input:not([type='hidden'])",
      ));
      return elements.some(element => {
        if (!visible(element)) return false;
        if (element instanceof HTMLInputElement) {
          if (["search", "checkbox", "radio", "button", "submit"].includes(element.type)) {
            return false;
          }
          return hasMeaningfulText(element.value);
        }
        if (element instanceof HTMLTextAreaElement) return hasMeaningfulText(element.value);
        return hasMeaningfulText(element.textContent ?? "");
      });
    }).catch(() => true);
  }

  private async createAutomationPage(
    context: BrowserContext,
    purpose: string,
  ): Promise<Page> {
    const page = await context.newPage();
    this.automationCreatedPages.add(page);
    this.automationPagePurposes.set(page, purpose);
    return page;
  }

  private forgetPageRole(page: Page): void {
    const role = this.pageRoles.get(page);
    if (role && this.rolePages.get(role) === page) this.rolePages.delete(role);
    this.pageRoles.delete(page);
  }

  private async closeAutomationPage(
    page: Page,
    reason: string,
  ): Promise<boolean> {
    if (page.isClosed() || !this.automationCreatedPages.has(page)) return false;
    if (await this.pageHasProtectedUserInput(page)) {
      log("managed_page_cleanup_skipped", {
        profile: browserProfileId,
        url: page.url(),
        purpose: this.automationPagePurposes.get(page) ?? "unknown",
        reason: "visible_user_input",
      });
      return false;
    }
    const url = page.url();
    const purpose = this.automationPagePurposes.get(page) ?? "unknown";
    this.forgetPageRole(page);
    return page.close({ runBeforeUnload: false }).then(() => {
      log("managed_page_closed", {
        profile: browserProfileId,
        url,
        purpose,
        reason,
      });
      return true;
    }).catch(error => {
      log("managed_page_cleanup_failed", {
        profile: browserProfileId,
        url,
        purpose,
        reason,
        error: String(error),
      });
      return false;
    });
  }

  private async closeSupersededAutomationPages(
    pages: Page[],
    keep: Page,
    purpose: string,
  ): Promise<void> {
    for (const candidate of pages) {
      if (candidate === keep || candidate.isClosed()) continue;
      if (this.automationPagePurposes.get(candidate) !== purpose) continue;
      const currentRole = this.pageRoles.get(candidate);
      if (currentRole && `role:${currentRole}` !== purpose) {
        log("managed_page_cleanup_skipped", {
          profile: browserProfileId,
          url: candidate.url(),
          purpose,
          currentRole,
          reason: "page_repurposed_for_another_role",
        });
        continue;
      }
      await this.closeAutomationPage(candidate, `superseded_${purpose.replaceAll(":", "_")}`);
    }
  }

  private async cleanupDuplicateUnassignedProfilePages(
    pages: Page[],
    assigned: Set<Page>,
  ): Promise<void> {
    const grouped = new Map<string, Page[]>();
    for (const page of pages) {
      if (page.isClosed() || assigned.has(page) || !this.automationCreatedPages.has(page)) continue;
      const key = disposableDuplicatePageKey(page.url());
      if (!key) continue;
      const group = grouped.get(key) ?? [];
      group.push(page);
      grouped.set(key, group);
    }
    for (const [key, duplicates] of grouped) {
      for (const page of duplicates.slice(1)) {
        if (await this.pageHasProtectedUserInput(page)) {
          log("managed_page_cleanup_skipped", {
            profile: browserProfileId,
            url: page.url(),
            reason: "visible_user_input",
          });
          continue;
        }
        await page.close({ runBeforeUnload: false }).then(() => {
          log("managed_page_closed", {
            profile: browserProfileId,
            url: page.url(),
            duplicateKey: key,
            reason: "duplicate_unassigned_profile",
          });
        }).catch(error => {
          log("managed_page_cleanup_failed", {
            profile: browserProfileId,
            url: page.url(),
            error: String(error),
          });
        });
      }
    }
  }

  private pageId(page: Page): string {
    const role = this.pageRoles.get(page);
    if (role) return `page-${role.replaceAll("_", "-")}`;
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `page-${++this.pageSequence}`;
    this.pageIds.set(page, id);
    return id;
  }

  private async pageTargetId(page: Page): Promise<string> {
    const existing = this.pageTargetIds.get(page);
    if (existing) return existing;
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send("Target.getTargetInfo") as {
        targetInfo?: { targetId?: string };
      };
      const targetId = result.targetInfo?.targetId;
      if (!targetId) throw new Error("浏览器没有返回 target_id。");
      this.pageTargetIds.set(page, targetId);
      return targetId;
    } finally {
      await session.detach().catch(() => null);
    }
  }

  private bindPageRole(page: Page, role: PageRole): void {
    const pagePreviousRole = this.pageRoles.get(page);
    if (pagePreviousRole && pagePreviousRole !== role) {
      this.rolePages.delete(pagePreviousRole);
    }
    const previous = this.rolePages.get(role);
    if (previous && previous !== page) this.pageRoles.delete(previous);
    this.rolePages.set(role, page);
    this.pageRoles.set(page, role);
    this.pageIds.set(page, `page-${role.replaceAll("_", "-")}`);
  }

  private async notificationPageDiagnostics(
    page: Page,
  ): Promise<NotificationExtractionDiagnostics> {
    const diagnostics = await page.evaluate(() => {
      const camelIds = new Set<string>();
      const snakeIds = new Set<string>();
      const rowElements = new Set<Element>();
      const seen = new Set<object>();
      const stable = (value: unknown): value is string =>
        typeof value === "string" && /^\d{8,24}$/.test(value);
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const walk = (start: unknown, source: Element): void => {
        const queue: Array<{ value: unknown; depth: number }> = [{ value: start, depth: 0 }];
        let visited = 0;
        while (queue.length && visited < 25_000) {
          const { value, depth } = queue.shift()!;
          if (!value || typeof value !== "object" || depth > 10) continue;
          if (seen.has(value as object)) continue;
          seen.add(value as object);
          visited += 1;
          if (Array.isArray(value)) {
            for (const item of value.slice(0, 120)) queue.push({ value: item, depth: depth + 1 });
            continue;
          }
          const object = value as Record<string, unknown>;
          if (stable(object.noticeId)) {
            camelIds.add(object.noticeId);
            if (visible(source)) rowElements.add(source);
          }
          if (stable(object.notice_id)) {
            snakeIds.add(object.notice_id);
            if (visible(source)) rowElements.add(source);
          }
          for (const child of Object.values(object).slice(0, 120)) {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      };
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (/^__react(?:Props|Fiber)\$/.test(key)) {
            walk((element as unknown as Record<string, unknown>)[key], element);
          }
        }
      }
      const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      const panelOpen = Boolean(document.querySelector("#noticeTypeList,#pushListBoxId"));
      const emptyStateConfirmed = panelOpen && /(?:\u6682\u65e0|\u8fd8\u6ca1\u6709|\u6ca1\u6709)(?:\u66f4\u591a)?(?:\u6d88\u606f|\u901a\u77e5)/.test(bodyText);
      return {
        visibleNotificationRowCount: rowElements.size,
        camelCaseNoticeIdCount: camelIds.size,
        snakeCaseNoticeIdCount: snakeIds.size,
        panelOpen,
        emptyStateConfirmed,
      };
    }).catch(() => ({
      visibleNotificationRowCount: 0,
      camelCaseNoticeIdCount: 0,
      snakeCaseNoticeIdCount: 0,
      panelOpen: false,
      emptyStateConfirmed: false,
    }));
    return {
      ...diagnostics,
      pageTargetId: await this.pageTargetId(page).catch(() => "unknown"),
    };
  }

  private async ensurePageRoles(): Promise<void> {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) return;
    for (const [role, page] of this.rolePages) {
      if (page.isClosed() || !context.pages().includes(page)) this.rolePages.delete(role);
    }
    const pages = context.pages();
    const persisted = loadPageBindings();
    for (const binding of persisted.values()) {
      if (this.rolePages.has(binding.role)) continue;
      for (const page of pages) {
        if (await this.pageTargetId(page).catch(() => "") === binding.targetId) {
          this.bindPageRole(page, binding.role);
          break;
        }
      }
    }
    if (!this.rolePages.has("notifications")) {
      const candidates: Array<{
        page: Page;
        diagnostics: NotificationExtractionDiagnostics;
      }> = [];
      for (const page of pages) {
        try {
          const url = new URL(page.url());
          if (!["douyin.com", "www.douyin.com"].includes(url.hostname.toLowerCase())) continue;
          const diagnostics = await this.notificationPageDiagnostics(page);
          if (diagnostics.panelOpen
            || diagnostics.camelCaseNoticeIdCount > 0
            || diagnostics.snakeCaseNoticeIdCount > 0) {
            candidates.push({ page, diagnostics });
          }
        } catch {
          // Ignore unrelated or transient pages while restoring the notification role.
        }
      }
      candidates.sort((left, right) => {
        const leftScore = (left.diagnostics.panelOpen ? 1_000_000 : 0)
          + left.diagnostics.camelCaseNoticeIdCount
          + left.diagnostics.snakeCaseNoticeIdCount;
        const rightScore = (right.diagnostics.panelOpen ? 1_000_000 : 0)
          + right.diagnostics.camelCaseNoticeIdCount
          + right.diagnostics.snakeCaseNoticeIdCount;
        return rightScore - leftScore;
      });
      const reusable = candidates[0];
      if (reusable) {
        this.bindPageRole(reusable.page, "notifications");
        savePageBinding({
          role: "notifications",
          pageId: this.pageId(reusable.page),
          targetId: reusable.diagnostics.pageTargetId,
          url: reusable.page.url(),
          account: loadActionSettings().operator.displayName,
          boundAt: new Date().toISOString(),
        });
      }
    }
    for (const page of pages) {
      if (this.pageRoles.has(page)) continue;
      let url: URL;
      try {
        url = new URL(page.url());
      } catch {
        continue;
      }
      const host = url.hostname.toLowerCase();
      if (host === "creator.douyin.com"
        && [
          "/creator-micro/interactive/comment",
          "/creator-micro/data/following/comment",
        ].includes(url.pathname)
        && !this.rolePages.has("creator_center")) {
        this.bindPageRole(page, "creator_center");
      } else if (["douyin.com", "www.douyin.com"].includes(host)
        && url.pathname === "/chat"
        && !this.rolePages.has("bound_messages")) {
        this.bindPageRole(page, "bound_messages");
      }
    }
    if (!this.rolePages.has("publisher")) {
      const creatorPages = pages.filter(page => {
        try {
          const url = new URL(page.url());
          return url.hostname.toLowerCase() === "creator.douyin.com"
            && url.pathname.startsWith("/creator-micro/content/");
        } catch {
          return false;
        }
      });
      if (creatorPages.length === 1) {
        const page = creatorPages[0];
        this.bindPageRole(page, "publisher");
        savePageBinding({
          role: "publisher",
          pageId: this.pageId(page),
          targetId: await this.pageTargetId(page),
          url: page.url(),
          account: loadActionSettings().operator.displayName,
          boundAt: new Date().toISOString(),
        });
      }
    }
    if (!this.rolePages.has("operator_home")) {
      const home = pages.find(page => {
        try {
          const url = new URL(page.url());
          return ["douyin.com", "www.douyin.com"].includes(url.hostname.toLowerCase())
            && url.pathname !== "/chat"
            && this.pageRoles.get(page) !== "codex_test";
        } catch {
          return false;
        }
      });
      if (home) this.bindPageRole(home, "operator_home");
    }
    if (!this.rolePages.has("codex_test")) {
      const unassigned = pages.find(page => {
        try {
          const url = new URL(page.url());
          return ["douyin.com", "www.douyin.com"].includes(url.hostname.toLowerCase())
            && !this.pageRoles.has(page);
        } catch {
          return false;
        }
      });
      if (unassigned) this.bindPageRole(unassigned, "codex_test");
    }
  }

  private async rolePage(role: PageRole, initialUrl?: string): Promise<Page> {
    await this.ensurePageRoles();
    const existing = this.rolePages.get(role);
    if (existing && !existing.isClosed()) return existing;
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("没有可用的专用浏览器上下文。");
    const page = await this.createAutomationPage(context, `role:${role}`);
    this.bindPageRole(page, role);
    if (initialUrl) {
      try {
        await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        await this.closeAutomationPage(page, `role_initial_navigation_failed_${role}`);
        throw error;
      }
    }
    return page;
  }

  private async notificationCenterPage(): Promise<Page> {
    const page = await this.rolePage("notifications", "https://www.douyin.com/jingxuan");
    const browser = await this.connect();
    await this.closeSupersededAutomationPages(
      browser.contexts()[0]?.pages() ?? [],
      page,
      "role:notifications",
    );
    assertAllowedUrl(page.url());
    await this.assertOperatorAccount(page);
    if ((await this.notificationPageDiagnostics(page)).panelOpen) {
      savePageBinding({
        role: "notifications",
        pageId: this.pageId(page),
        targetId: await this.pageTargetId(page),
        url: page.url(),
        account: loadActionSettings().operator.displayName,
        boundAt: new Date().toISOString(),
      });
      return page;
    }
    const panelTextLooksOpen = await page.evaluate(() => {
      const body = document.body.innerText || "";
      return body.includes("全部消息")
        && body.includes("@我的")
        && body.includes("评论")
        && body.includes("赞");
    }).catch(() => false);
    if (!(await this.notificationPageDiagnostics(page)).panelOpen) {
      const exactNoticeText = page.getByText("通知", { exact: true });
      const exactNoticeTextUtf8 = page.getByText("\u901a\u77e5", { exact: true });
      const currentClassEntry = exactNoticeTextUtf8.locator(
        "xpath=ancestor::div[contains(concat(' ',normalize-space(@class),' '),' f67Opf0t ')][1]",
      );
      const officialEntry = await currentClassEntry.count()
        ? currentClassEntry
        : exactNoticeTextUtf8.locator("xpath=ancestor::li[1]");
      const officialVisible: Locator[] = [];
      for (let index = 0; index < await officialEntry.count(); index += 1) {
        if (await officialEntry.nth(index).isVisible().catch(() => false)) {
          officialVisible.push(officialEntry.nth(index));
        }
      }
      if (officialVisible.length === 1) {
        await officialVisible[0].hover({ force: true, timeout: 5_000 });
        await page.waitForTimeout(1_000);
        const officialPanelOpen = await page.locator("#pushListBoxId,#noticeTypeList").count() > 0
          || await page.evaluate(() => {
            const body = document.body.innerText || "";
            return body.includes("全部消息") && body.includes("@我的");
          });
        if ((await this.notificationPageDiagnostics(page)).panelOpen) {
          savePageBinding({
            role: "notifications",
            pageId: this.pageId(page),
            targetId: await this.pageTargetId(page),
            url: page.url(),
            account: loadActionSettings().operator.displayName,
            boundAt: new Date().toISOString(),
          });
          return page;
        }
      }
      const triggers = page.locator([
        "button[aria-label*='通知']",
        "[role='button'][aria-label*='通知']",
        "button[title*='通知']",
        "[role='button'][title*='通知']",
        "[data-e2e*='notice']",
        "[data-e2e*='notification']",
      ].join(",")).or(page.getByText("通知", { exact: true }));
      const utf8Triggers = triggers.or(exactNoticeTextUtf8);
      const visible: Locator[] = [];
      for (let index = 0; index < await utf8Triggers.count(); index += 1) {
        if (await utf8Triggers.nth(index).isVisible().catch(() => false)) {
          visible.push(utf8Triggers.nth(index));
        }
      }
      if (visible.length !== 1) {
        throw new Error(`NOTIFICATION_ENTRY_NOT_UNIQUE:${visible.length}`);
      }
      const reactTriggers = await visible[0].evaluate(element => {
        document.querySelectorAll("[data-codex-notification-hover],[data-codex-notification-click]")
          .forEach(node => {
            node.removeAttribute("data-codex-notification-hover");
            node.removeAttribute("data-codex-notification-click");
          });
        let hoverTarget: HTMLElement | null = null;
        let clickFallback: HTMLElement | null = null;
        let current: HTMLElement | null = element as HTMLElement;
        for (let depth = 0; current && depth < 8; depth += 1) {
          for (const key of Object.getOwnPropertyNames(current)) {
            if (/^__reactProps\$/.test(key)) {
              const props = (current as unknown as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
              if (!props) continue;
              if (!hoverTarget && (typeof props.onMouseEnter === "function"
                || typeof props.onMouseOver === "function")) hoverTarget = current;
              if (!clickFallback && typeof props.onClick === "function") clickFallback = current;
            }
            if (/^__reactFiber\$/.test(key)) {
              let fiber = (current as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
              for (let level = 0; fiber && level < 20; level += 1) {
                const props = fiber.memoizedProps as Record<string, unknown> | undefined;
                const stateNode = fiber.stateNode;
                if (props && stateNode instanceof HTMLElement) {
                  if (!hoverTarget && (typeof props.onMouseEnter === "function"
                    || typeof props.onMouseOver === "function")) hoverTarget = stateNode;
                  if (!clickFallback && typeof props.onClick === "function") clickFallback = stateNode;
                }
                fiber = fiber.return as Record<string, unknown> | null;
              }
            }
          }
          current = current.parentElement;
        }
        if (hoverTarget) hoverTarget.setAttribute("data-codex-notification-hover", "true");
        if (clickFallback) {
          clickFallback.setAttribute("data-codex-notification-click", "true");
        }
        return { hover: Boolean(hoverTarget), click: Boolean(clickFallback) };
      }).catch(() => ({ hover: false, click: false }));
      const nearestClickable = visible[0].locator(
        "xpath=ancestor-or-self::*[self::button or self::a or @role='button' or contains(@data-e2e,'button')][1]",
      );
      const hoverTarget = reactTriggers.hover
        ? page.locator('[data-codex-notification-hover="true"]')
        : await nearestClickable.count() === 1 ? nearestClickable : visible[0];
      const clickTarget = reactTriggers.click
        ? page.locator('[data-codex-notification-click="true"]')
        : await nearestClickable.count() === 1 ? nearestClickable : visible[0];
      const invokedNoticeHover = await visible[0].evaluate(element => {
        const invoked = new Set<Function>();
        let current: HTMLElement | null = element as HTMLElement;
        for (let depth = 0; current && depth < 8; depth += 1) {
          for (const key of Object.getOwnPropertyNames(current)) {
            if (!/^__reactFiber\$/.test(key)) continue;
            let fiber = (current as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
            for (let level = 0; fiber && level < 24; level += 1) {
              const props = fiber.memoizedProps as Record<string, unknown> | undefined;
              const handler = props?.onMouseEnter;
              if (typeof handler === "function" && !invoked.has(handler)) {
                invoked.add(handler);
                try {
                  (handler as (event: Record<string, unknown>) => void)({
                    target: element,
                    currentTarget: fiber.stateNode instanceof HTMLElement ? fiber.stateNode : current,
                    type: "mouseenter",
                  });
                } catch {
                  // Continue to the outer notification-entry handler.
                }
              }
              fiber = fiber.return as Record<string, unknown> | null;
            }
          }
          current = current.parentElement;
        }
        return invoked.size > 0;
      }).catch(() => false);
      if (invokedNoticeHover) await page.waitForTimeout(700);
      const directlyOpened = invokedNoticeHover && (
        await page.evaluate(() => {
          const body = document.body.innerText || "";
          return body.includes("全部消息") && body.includes("@我的");
        })
      );
      if ((await this.notificationPageDiagnostics(page)).panelOpen) {
        savePageBinding({
          role: "notifications",
          pageId: this.pageId(page),
          targetId: await this.pageTargetId(page),
          url: page.url(),
          account: loadActionSettings().operator.displayName,
          boundAt: new Date().toISOString(),
        });
        return page;
      }
      const officialNoticeEntry = visible[0].locator(
        "xpath=ancestor::div[contains(concat(' ',normalize-space(@class),' '),' f67Opf0t ')][1]",
      );
      if (await officialNoticeEntry.count() === 1) {
        await officialNoticeEntry.hover({ force: true, timeout: 5_000 });
        await page.waitForTimeout(700);
        const officialEntryOpened = await page.evaluate(() => {
          const body = document.body.innerText || "";
          return body.includes("全部消息") && body.includes("@我的");
        });
        if ((await this.notificationPageDiagnostics(page)).panelOpen) {
          savePageBinding({
            role: "notifications",
            pageId: this.pageId(page),
            targetId: await this.pageTargetId(page),
            url: page.url(),
            account: loadActionSettings().operator.displayName,
            boundAt: new Date().toISOString(),
          });
          return page;
        }
      }
      const pointer = await hoverTarget.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          innerWidth,
          innerHeight,
        };
      });
      const playwrightViewport = page.viewportSize();
      await page.mouse.move(
        pointer.x * ((playwrightViewport?.width ?? pointer.innerWidth) / pointer.innerWidth),
        pointer.y * ((playwrightViewport?.height ?? pointer.innerHeight) / pointer.innerHeight),
      );
      await page.waitForTimeout(700);
      let pointerOpened = await page.evaluate(() => {
        const body = document.body.innerText || "";
        return body.includes("全部消息") && body.includes("@我的");
      });
      if (!pointerOpened) {
        await page.mouse.move(pointer.x, pointer.y);
        await page.waitForTimeout(700);
        pointerOpened = await page.evaluate(() => {
          const body = document.body.innerText || "";
          return body.includes("全部消息") && body.includes("@我的");
        });
      }
      await hoverTarget.evaluate(element => {
        element.dispatchEvent(new MouseEvent("mouseover", {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      });
      await page.waitForTimeout(700);
      let opened = pointerOpened || await page.evaluate(() => {
        const body = document.body.innerText || "";
        return body.includes("全部消息") && body.includes("@我的");
      });
      if (!(await this.notificationPageDiagnostics(page)).panelOpen) {
        await clickTarget.evaluate(element => (element as HTMLElement).click());
        await page.waitForTimeout(700);
        opened = await page.evaluate(() => {
          const body = document.body.innerText || "";
          return body.includes("全部消息") && body.includes("@我的");
        });
      }
      if (!(await this.notificationPageDiagnostics(page)).panelOpen) {
        throw new Error("NOTIFICATION_PANEL_NOT_OPEN");
      }
    }
    savePageBinding({
      role: "notifications",
      pageId: this.pageId(page),
      targetId: await this.pageTargetId(page),
      url: page.url(),
      account: loadActionSettings().operator.displayName,
      boundAt: new Date().toISOString(),
    });
    return page;
  }

  private async extractNotificationCandidates(
    page: Page,
  ): Promise<CanonicalNotificationCandidate[]> {
    const rawCandidates = await page.evaluate(() => {
      const allowedKeys = new Set([
        "notice_id", "noticeId", "notice_type", "noticeType", "noticeLogInfo", "notice_log_info", "log_info",
        "noticeInfo", "notice_info", "interact_type", "interactType", "aweme_id", "awemeId",
        "item_id", "schema_url", "schemaUrl",
        "aweme", "item", "work", "aweme_info", "item_info", "comment", "comment_info", "commentInfo",
        "user", "actor", "from_user", "author", "notice_user", "uid", "user_id", "sec_uid", "secUid",
        "nickname", "nick_name", "display_name", "cid", "comment_id", "text", "content", "comment_text",
        "reply_id", "parent_comment_id", "parent_id", "reply_to_reply_id", "root_comment_id", "root_id",
        "desc", "description", "title", "aweme_desc", "work_desc", "content_type", "aweme_type", "type",
        "share_url", "is_deleted", "is_delete", "deleted", "invalid", "is_invalid", "private",
        "availability", "status_text", "status_desc", "invalid_reason", "unread", "is_unread", "read_status",
        "time_text", "timeText", "create_time_text", "create_time", "createTime", "created_at", "timestamp",
      ]);
      const sanitize = (value: unknown, depth = 0): unknown => {
        if (depth > 8 || value == null) return null;
        if (["string", "number", "boolean"].includes(typeof value)) return value;
        if (Array.isArray(value)) return value.slice(0, 80).map(item => sanitize(item, depth + 1));
        if (typeof value !== "object") return null;
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 160)) {
          if (allowedKeys.has(key)) result[key] = sanitize(child, depth + 1);
        }
        return result;
      };
      const results = new Map<string, unknown>();
      const seen = new Set<object>();
      const walk = (start: unknown): void => {
        const queue: Array<{ value: unknown; depth: number }> = [{ value: start, depth: 0 }];
        let visited = 0;
        while (queue.length && visited < 25_000) {
          const { value, depth } = queue.shift()!;
          if (!value || typeof value !== "object" || depth > 10) continue;
          if (seen.has(value as object)) continue;
          seen.add(value as object);
          visited += 1;
          if (Array.isArray(value)) {
            for (const item of value.slice(0, 120)) queue.push({ value: item, depth: depth + 1 });
            continue;
          }
          const object = value as Record<string, unknown>;
          const noticeId = typeof object.notice_id === "string" && /^\d{8,24}$/.test(object.notice_id)
            ? object.notice_id
            : typeof object.noticeId === "string" && /^\d{8,24}$/.test(object.noticeId)
              ? object.noticeId
              : null;
          if (noticeId) {
            if (!results.has(noticeId)) results.set(noticeId, sanitize(object));
          }
          for (const child of Object.values(object).slice(0, 120)) {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      };
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (/^__react(?:Props|Fiber)\$/.test(key)) {
            walk((element as unknown as Record<string, unknown>)[key]);
          }
        }
        if (results.size >= 500) break;
      }
      return [...results.values()];
    });
    return rawCandidates
      .map(candidate => canonicalizeNotificationCandidate(candidate))
      .filter((candidate): candidate is CanonicalNotificationCandidate => Boolean(candidate));
  }

  private async selectNotificationPanelFilter(
    page: Page,
    filter: NotificationFilter,
  ): Promise<void> {
    const targetText = filter === "mentions" ? "@\u6211\u7684" : "\u5168\u90e8\u6d88\u606f";
    const trigger = page.locator("#noticeTypeList");
    for (let attempt = 0; attempt < 3 && await trigger.count() !== 1; attempt += 1) {
      await this.notificationCenterPage();
      await page.waitForTimeout(150);
    }
    if (await trigger.count() !== 1) throw new Error("NOTIFICATION_PANEL_NOT_OPEN");
    const currentText = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (currentText === targetText) {
      await page.waitForTimeout(300);
      return;
    }
    await trigger.click({ force: true, timeout: 5_000 });
    await page.waitForTimeout(250);
    const choices = page.getByText(targetText, { exact: true });
    const visibleChoices: Locator[] = [];
    for (let index = 0; index < await choices.count(); index += 1) {
      if (await choices.nth(index).isVisible().catch(() => false)) visibleChoices.push(choices.nth(index));
    }
    if (visibleChoices.length !== 1) {
      throw new Error(`NOTIFICATION_FILTER_NOT_UNIQUE:${filter}:${visibleChoices.length}`);
    }
    const invokedReactOption = await visibleChoices[0].evaluate(element => {
      let current: HTMLElement | null = element as HTMLElement;
      for (let depth = 0; current && depth < 5; depth += 1) {
        for (const key of Object.getOwnPropertyNames(current)) {
          if (/^__reactProps\$/.test(key)) {
            const props = (current as unknown as Record<string, unknown>)[key] as
              Record<string, unknown> | undefined;
            if (typeof props?.onClick === "function") {
              (props.onClick as (event: Record<string, unknown>) => void)({
                target: element,
                currentTarget: current,
                type: "click",
                preventDefault: () => undefined,
                stopPropagation: () => undefined,
              });
              return true;
            }
          }
        }
        current = current.parentElement;
      }
      return false;
    }).catch(() => false);
    if (invokedReactOption) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await page.waitForTimeout(100);
        const selectedText = (await trigger.innerText().catch(() => ""))
          .replace(/\s+/g, " ").trim();
        if (selectedText === targetText) {
          await page.waitForTimeout(700);
          return;
        }
      }
    }
    await visibleChoices[0].click({ force: true, timeout: 5_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(100);
      const selectedText = (await trigger.innerText().catch(() => ""))
        .replace(/\s+/g, " ").trim();
      if (selectedText === targetText) {
        await page.waitForTimeout(700);
        return;
      }
    }
    throw new Error(`NOTIFICATION_FILTER_NOT_SELECTED:${filter}`);
  }

  private async scrollNotificationList(page: Page): Promise<{ moved: boolean; atEnd: boolean }> {
    return page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("div,section,main,ul"))
        .filter(element => element.scrollHeight > element.clientHeight + 80)
        .map(element => ({
          element,
          score: ((element.innerText || "").includes("全部消息") ? 1_000_000 : 0)
            + Math.min(element.scrollHeight - element.clientHeight, 100_000),
        }))
        .sort((left, right) => right.score - left.score);
      const target = candidates[0]?.element;
      if (!target) return { moved: false, atEnd: true };
      const before = target.scrollTop;
      target.scrollTop = Math.min(
        target.scrollHeight - target.clientHeight,
        before + Math.max(300, Math.floor(target.clientHeight * 0.8)),
      );
      return {
        moved: target.scrollTop > before,
        atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 2,
      };
    });
  }

  private async scanNotificationsUnlocked(options: {
    filter: NotificationFilter;
    includeUnavailable: boolean;
    targetNoticeId?: string;
  }): Promise<{ items: NotificationItem[]; parseErrors: string[]; uiMayMarkSeen: true }> {
    const page = await this.notificationCenterPage();
    await this.selectNotificationPanelFilter(page, options.filter);
    const byId = new Map<string, NotificationItem>();
    const parseErrors: string[] = [];
    let stagnant = 0;
    for (let pass = 0; pass < 18; pass += 1) {
      const before = byId.size;
      const extracted = await this.extractNotificationCandidates(page);
      if (pass === 0) {
        const diagnostics = await this.notificationPageDiagnostics(page);
        const failureCode = notificationExtractionFailureCode(diagnostics, extracted.length);
        if (failureCode) {
          throw appError({
            code: failureCode,
            message: `${failureCode}: notification extraction did not prove a supported non-empty or empty state`,
            safeDetails: diagnostics,
          });
        }
      }
      for (const candidate of extracted) {
        const parsed = parseNotificationCandidate(candidate);
        if (parsed.item) byId.set(parsed.item.noticeId, parsed.item);
        else if (parsed.error) parseErrors.push(parsed.error);
      }
      if (options.targetNoticeId && byId.has(options.targetNoticeId)) break;
      stagnant = byId.size === before ? stagnant + 1 : 0;
      const scroll = await this.scrollNotificationList(page);
      if (scroll.atEnd && stagnant >= 2) break;
      if (!scroll.moved && stagnant >= 2) break;
      await page.waitForTimeout(220);
    }
    let items = dedupeNotifications([...byId.values()]);
    if (options.filter !== "all") items = items.filter(item => item.filterType === options.filter);
    if (!options.includeUnavailable) {
      items = items.filter(item => item.work.availability !== "unavailable"
        && item.comment.availability !== "unavailable");
    }
    this.notificationStore.upsert(items);
    return { items, parseErrors: [...new Set(parseErrors)], uiMayMarkSeen: true };
  }

  async listNotifications(options: {
    filter: NotificationFilter;
    limit: number;
    cursor?: string;
    responseMode: "compact" | "full";
    includeUnavailable: boolean;
  }): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const scanned = await this.scanNotificationsUnlocked(options);
      let offset = 0;
      if (options.cursor) {
        const match = options.cursor.match(/^notice:([^:]+):(\d{8,24})$/);
        if (!match || match[1] !== options.filter) throw new Error("NOTIFICATION_CURSOR_INVALID");
        const anchor = scanned.items.findIndex(item => item.noticeId === match[2]);
        if (anchor < 0) throw new Error("NOTIFICATION_CURSOR_ANCHOR_MISSING");
        offset = anchor + 1;
      }
      const limit = Math.max(1, Math.min(100, options.limit));
      const pageItems = scanned.items.slice(offset, offset + limit);
      const last = pageItems.at(-1);
      const hasMore = offset + pageItems.length < scanned.items.length;
      return {
        canonicalPack: "notifications",
        filter: options.filter,
        items: options.responseMode === "compact"
          ? pageItems.map(compactNotification)
          : pageItems,
        count: pageItems.length,
        nextCursor: hasMore && last ? `notice:${options.filter}:${last.noticeId}` : null,
        hasMore,
        parseErrors: scanned.parseErrors,
        checkpointAdvanced: false,
        uiMayMarkSeen: true,
      };
    }, { restoreOnError: false });
  }

  async getNotification(noticeId: string): Promise<NotificationItem> {
    return this.serial(async () => {
      const scanned = await this.scanNotificationsUnlocked({
        filter: "all",
        includeUnavailable: true,
        targetNoticeId: noticeId,
      });
      let item = scanned.items.find(candidate => candidate.noticeId === noticeId);
      if (!item) {
        const mentions = await this.scanNotificationsUnlocked({
          filter: "mentions",
          includeUnavailable: true,
          targetNoticeId: noticeId,
        });
        item = mentions.items.find(candidate => candidate.noticeId === noticeId);
      }
      if (!item) throw new Error(`NOTIFICATION_NOT_FOUND:${noticeId}`);
      return item;
    }, { restoreOnError: false });
  }

  async checkNotificationUpdates(options: {
    filter: NotificationFilter;
    limit: number;
    responseMode: "compact" | "full";
  }): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const previousCheckpoint = this.notificationStore.checkpoint(options.filter);
      const scanned = await this.scanNotificationsUnlocked({
        filter: options.filter,
        includeUnavailable: true,
      });
      const unacknowledged = this.notificationStore.unacknowledged(scanned.items);
      const limit = Math.max(1, Math.min(100, options.limit));
      const newItems = unacknowledged.slice(0, limit);
      const checkpointCandidate = newItems.length
        ? this.notificationStore.createCandidate(options.filter, newItems.map(item => item.noticeId))
        : null;
      return {
        canonicalPack: "notifications",
        filter: options.filter,
        newItems: options.responseMode === "compact"
          ? newItems.map(compactNotification)
          : newItems,
        newCount: newItems.length,
        checkpointCandidate,
        previousCheckpoint,
        hasMore: unacknowledged.length > newItems.length,
        checkpointAdvanced: false,
        uiMayMarkSeen: true,
      };
    }, { restoreOnError: false });
  }

  acknowledgeNotificationCheckpoint(input: {
    checkpointCandidate?: string;
    noticeIds?: string[];
    confirmAck: boolean;
  }): Record<string, unknown> {
    return {
      canonicalPack: "notifications",
      ...this.notificationStore.acknowledge({
        candidate: input.checkpointCandidate,
        noticeIds: input.noticeIds,
        confirm: input.confirmAck,
      }),
      douyinReadStateChanged: false,
    };
  }

  async openNotificationTarget(noticeId: string): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const scanned = await this.scanNotificationsUnlocked({
        filter: "all",
        includeUnavailable: true,
        targetNoticeId: noticeId,
      });
      const item = scanned.items.find(candidate => candidate.noticeId === noticeId);
      if (!item) throw new Error(`NOTIFICATION_NOT_FOUND:${noticeId}`);
      if (!item.openable || !item.work.workId || !item.work.url) {
        throw new Error(`NOTIFICATION_TARGET_UNAVAILABLE:${noticeId}`);
      }
      const targetUrl = item.work.url;
      await this.ensurePageRoles();
      const browser = await this.connect();
      const contextPages = browser.contexts()[0]?.pages() ?? [];
      const pageWorkId = (candidate: Page): string | null => {
        try {
          const url = new URL(candidate.url());
          return workIdFromUrl(candidate.url())
            ?? url.searchParams.get("modal_id")
            ?? url.searchParams.get("work_id");
        } catch {
          return null;
        }
      };
      const isManagedNotificationTarget = (candidate: Page): boolean =>
        this.automationPagePurposes.get(candidate) === "role:notification_target";
      const matchingPages = contextPages.filter(candidate => {
        return pageWorkId(candidate) === item.work.workId;
      });

      // notification_target is a single reusable work surface. A page that was
      // merely discovered in the user's browser may be read for this exact work,
      // but it is never adopted and later navigated to another work. Only pages
      // created by this MCP are eligible for cross-work reuse or automatic close.
      let page = this.rolePages.get("notification_target");
      if (page?.isClosed()) {
        this.forgetPageRole(page);
        page = undefined;
      }
      if (page && pageWorkId(page) !== item.work.workId
        && !isManagedNotificationTarget(page)) {
        this.forgetPageRole(page);
        page = undefined;
      }
      if (!page) {
        let exactExisting = matchingPages[0];
        for (const candidate of matchingPages) {
          if (await candidate.locator("[data-e2e='comment-list'],[data-scroll='comment']").count() > 0) {
            exactExisting = candidate;
            break;
          }
        }
        page = exactExisting;
      }
      if (!page) page = await this.rolePage("notification_target", targetUrl);

      const managedTargetPage = isManagedNotificationTarget(page);
      if (managedTargetPage) {
        this.bindPageRole(page, "notification_target");
        await this.closeSupersededAutomationPages(
          contextPages,
          page,
          "role:notification_target",
        );
      }
      try {
        if (pageWorkId(page) !== item.work.workId) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(1_000);
        }
        await this.assertOperatorAccount(page);
        const context = await this.captureWorkContext(page);
        if (context.workId !== item.work.workId) {
          throw new Error(`NOTIFICATION_WORK_TARGET_MISMATCH:${context.workId ?? "missing"}`);
        }
        let commentVerified = item.comment.commentId == null;
        if (item.comment.commentId) {
          const escapedCommentId = item.comment.commentId.replace(/[^0-9]/g, "");
          const directMatches = page.locator(
            `[data-e2e='comment-item'][data-comment-id='${escapedCommentId}'],`
            + `[data-e2e='comment-item']:has([id*='${escapedCommentId}'])`,
          );
          commentVerified = await directMatches.count() === 1;
        }
        const snapshotHash = notificationSnapshotHash(item);
        this.notificationStore.audit({
          noticeId,
          action: "open_target",
          snapshotHash,
          evidence: { workId: context.workId, commentId: item.comment.commentId, commentVerified },
        });
        return {
          canonicalPack: "notifications",
          notificationSnapshot: item,
          snapshotHash,
          pageRole: "notification_target",
          pageOwnership: managedTargetPage ? "mcp_created" : "existing_exact_target",
          pageTargetId: await this.pageTargetId(page),
          pageUrl: page.url(),
          workId: context.workId,
          commentId: item.comment.commentId,
          workVerified: true,
          commentVerified,
          commentVerification: commentVerified ? "direct_dom_id" : "notification_snapshot_only",
          uiMayMarkSeen: true,
        };
      } catch (error) {
        if (managedTargetPage) {
          await this.closeAutomationPage(page, "notification_target_validation_failed");
        }
        throw error;
      }
    }, { restoreOnError: false });
  }

  private notificationWriteScope(item: NotificationItem): {
    scope: TargetWriteScope;
    alias?: string;
  } {
    const operator = loadActionSettings().operator;
    const bound = getBoundUser("bound_user");
    const author = item.work.author.uid || item.work.author.secUid
      ? item.work.author
      : item.targetKind === "work_mention" ? item.actor : item.work.author;
    if (author.uid === operator.uid && author.secUid === operator.secUid) return { scope: "own_post" };
    if (author.uid === bound.uid && author.secUid === bound.secUid) {
      return { scope: "bound_user_post", alias: bound.alias };
    }
    if (author.uid && author.secUid) return { scope: "external_post" };
    throw new Error("NOTIFICATION_WORK_AUTHOR_STABLE_ID_MISSING");
  }

  async prepareReplyFromNotification(input: {
    noticeId: string;
    text: string;
  }): Promise<Record<string, unknown>> {
    const item = await this.getNotification(input.noticeId);
    const snapshotHash = notificationSnapshotHash(item);
    if (!item.replyable) {
      return {
        canonicalPack: "notifications",
        status: "not_replyable",
        notificationSnapshot: item,
        snapshotHash,
        targetKind: item.targetKind,
        sent: false,
        confirmationRequired: false,
        uiMayMarkSeen: true,
      };
    }
    const frozenTarget = freezeNotificationReplyTarget(item);
    const target = this.notificationWriteScope(item);
    const prepared = frozenTarget.targetKind === "comment"
      ? frozenTarget.commentId
        ? await this.prepareReplyToComment({
            workId: frozenTarget.workId,
            commentId: frozenTarget.commentId,
            text: input.text,
            scope: target.scope,
            alias: target.alias,
          })
        : null
      : await this.prepareCommentOnPost({
          workId: frozenTarget.workId,
          text: input.text,
          scope: target.scope,
          alias: target.alias,
        });
    if (!prepared) throw new Error("NOTIFICATION_COMMENT_ID_MISSING");
    this.notificationStore.audit({
      noticeId: item.noticeId,
      action: "prepare_reply",
      snapshotHash,
      operationId: prepared.operationId,
      evidence: {
        targetKind: item.targetKind,
        workId: frozenTarget.workId,
        commentId: frozenTarget.commentId,
        scope: target.scope,
        targetGate: prepared.targetGate,
        frozenTarget,
      },
    });
    return {
      canonicalPack: "notifications",
      notificationSnapshot: item,
      snapshotHash,
      targetGate: prepared.targetGate,
      operationId: prepared.operationId,
      replyPlanId: prepared.token,
      targetKind: item.targetKind,
      frozenTarget,
      sent: false,
      confirmationRequired: true,
      uiMayMarkSeen: true,
    };
  }

  private async captureRolePageStates(): Promise<SavedPageState[]> {
    const states: SavedPageState[] = [];
    for (const [role, page] of this.rolePages) {
      if (page.isClosed()) continue;
      const position = await page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => ({ x: 0, y: 0 }));
      let workId: string | null = null;
      try {
        workId = workIdFromUrl(page.url());
      } catch {
        workId = null;
      }
      states.push({
        pageId: this.pageId(page),
        targetId: await this.pageTargetId(page).catch(() => undefined),
        role,
        url: page.url(),
        workId,
        scrollX: position.x,
        scrollY: position.y,
        savedAt: new Date().toISOString(),
      });
    }
    return states;
  }

  private async restoreRolePageStates(states: SavedPageState[]): Promise<void> {
    for (const state of states) {
      // Never navigate the editor as error recovery. Keeping the scene intact is
      // safer than silently refreshing away an in-progress draft.
      if (state.role === "publisher" || state.role === "creator_center") continue;
      const page = this.rolePages.get(state.role);
      if (!page || page.isClosed()) continue;
      if (page.url() !== state.url) {
        await page.goto(state.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
      }
      await page.evaluate(({ x, y }) => scrollTo(x, y), { x: state.scrollX, y: state.scrollY }).catch(() => null);
    }
  }

  private async allowedPages(): Promise<Page[]> {
    const browser = await this.connect();
    const pages = browser.contexts().flatMap(context => context.pages());
    return pages.filter(page => {
      try {
        assertAllowedUrl(page.url());
        return true;
      } catch {
        return false;
      }
    }, { restoreOnError: false, persistPageState: false });
  }

  private async resolveAllowedPageReference(reference: string): Promise<Page | null> {
    await this.ensurePageRoles();
    const pages = await this.allowedPages();
    const normalized = reference.trim().toLocaleLowerCase().replace(/^page-/, "").replaceAll("-", "_");
    const role = canonicalPageRoleReference(reference);
    if (role) {
      const page = this.rolePages.get(role);
      if (page && !page.isClosed() && pages.includes(page)) return page;
    }
    for (const page of pages) {
      if (this.pageId(page) === reference) return page;
      if (await this.pageTargetId(page).catch(() => "") === reference) return page;
    }
    const persisted = [...loadPageBindings().values()].find(binding =>
      binding.pageId === reference
      || binding.targetId === reference
      || binding.role === normalized);
    if (!persisted) return null;
    return pages.find(page => this.pageRoles.get(page) === persisted.role) ?? null;
  }

  private async currentPage(): Promise<Page> {
    await this.ensurePageRoles();
    const pages = await this.allowedPages();
    if (pages.length === 0) throw new Error("浏览器里没有可查看的允许域名标签页。");
    const tracked = this.activePageId
      ? pages.find(page => this.pageId(page) === this.activePageId)
      : null;
    const rolePreferred = this.rolePages.get("codex_test");
    const page = tracked
      ?? (rolePreferred && pages.includes(rolePreferred) ? rolePreferred : null)
      ?? this.rolePages.get("operator_home")
      ?? pages.at(-1)!;
    assertAllowedUrl(page.url());
    await page.bringToFront();
    this.activePageId = this.pageId(page);
    return page;
  }

  async listAllowedTabs(): Promise<AllowedTab[]> {
    return this.serial(async () => {
      const pages = (await this.allowedPages()).filter(page => {
        const host = new URL(page.url()).hostname.toLowerCase();
        return ["douyin.com", "www.douyin.com", "creator.douyin.com"].includes(host);
      });
      return Promise.all(pages.map(async page => {
        const url = assertAllowedUrl(page.url());
        return {
          pageId: this.pageId(page),
          targetId: await this.pageTargetId(page),
          role: this.pageRoles.get(page) ?? null,
          title: await page.title(),
          url: url.toString(),
          host: url.hostname.toLowerCase(),
        };
      }));
    });
  }

  async switchAllowedTab(pageId: string): Promise<AllowedTab> {
    return this.serial(async () => {
      const page = await this.resolveAllowedPageReference(pageId);
      if (!page) throw new Error("安全拦截：找不到该允许域名标签页，或目标标签页属于其他私人网站。");
      const url = assertAllowedUrl(page.url());
      await page.bringToFront();
      this.activePageId = this.pageId(page);
      this.latestElements.clear();
      return {
        pageId: this.pageId(page),
        targetId: await this.pageTargetId(page),
        role: this.pageRoles.get(page) ?? null,
        title: await page.title(),
        url: url.toString(),
        host: url.hostname.toLowerCase(),
      };
    });
  }

  async bindAllowedTab(pageId: string, role: PageRole, confirmBinding: boolean): Promise<AllowedTab> {
    return this.serial(async () => {
      if (!confirmBinding) throw new Error("绑定页面必须提供 confirm_binding=true。");
      const page = await this.resolveAllowedPageReference(pageId);
      if (!page) throw new Error("PAGE_BINDING_LOST:找不到指定 page_id。");
      const url = assertAllowedUrl(page.url());
      const host = url.hostname.toLowerCase();
      if (role === "publisher") assertDouyinPublishPage(url.toString());
      if (role === "creator_center") assertCreatorCommentManagerPage(url.toString());
      if (role === "operator_home") {
        const operator = loadActionSettings().operator;
        if (url.pathname !== "/user/self" && !url.pathname.includes(`/user/${operator.secUid}`)) {
          throw new Error("WRONG_ACCOUNT:Operator 正式主页必须使用配置中的 sec_uid。");
        }
      }
      if (role === "codex_test" && !["douyin.com", "www.douyin.com"].includes(host)) {
        throw new Error("WRONG_PAGE:codex_test 必须绑定普通抖音页面。");
      }
      if (role === "publisher" || role === "operator_home") await this.assertOperatorAccount(page);
      const creatorAccount = role === "creator_center"
        ? await this.assertCreatorCenterAccount(page)
        : null;
      this.bindPageRole(page, role);
      const binding = {
        role,
        pageId: this.pageId(page),
        targetId: await this.pageTargetId(page),
        title: await page.title(),
        url: url.toString(),
        host,
      };
      savePageBinding({
        role,
        pageId: binding.pageId,
        targetId: binding.targetId,
        url: binding.url,
        account: role === "publisher" || role === "operator_home" || role === "creator_center"
          ? loadActionSettings().operator.displayName
          : null,
        boundAt: new Date().toISOString(),
      });
      return binding;
    });
  }

  private pageKind(url: string, title: string): string {
    const combined = `${url} ${title}`;
    if (/creator\.douyin\.com\/creator-micro\/interactive\/comment/.test(url)) {
      return "抖音创作者中心评论管理页";
    }
    if (/creator\.douyin\.com/.test(url)) return "抖音创作者发布页";
    if (/showTab=(?:collection|favorite)|收藏/.test(combined)) return "收藏列表";
    if (/showTab=like|喜欢/.test(combined)) return "喜欢列表";
    if (/\/(?:article|note)\//.test(url)) return "文章或图文";
    if (/\/video\//.test(url) || /modal_id=/.test(url)) return "作品详情";
    if (/\/user\//.test(url)) return "个人主页";
    if (/search/.test(url)) return "搜索页";
    return "抖音页面";
  }

  private async captureWorkContext(page: Page): Promise<WorkContext> {
    const url = page.url();
    assertAllowedUrl(url);
    const workId = workIdFromUrl(url);
    if (!workId) throw new Error("当前页面没有稳定的抖音作品 ID。请先打开具体作品。");
    const activeContainerSource = await page.evaluate((expectedWorkId: string) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.right > 0;
      };
      if (document.querySelector(`[class*="video_${expectedWorkId}"]`)) return `class:video_${expectedWorkId}`;
      const detail = Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='video-detail'],[role='dialog']"))
        .find(element => visible(element) && (
          element.querySelector(`a[href*="${expectedWorkId}"]`)
          || element.querySelector("video")
        ));
      if (detail) return detail.getAttribute("data-e2e") === "video-detail" ? "data-e2e:video-detail" : "role:dialog";
      const normalizedTitle = document.title.replace(/\s*-\s*抖音\s*$/, "").split("#")[0].replace(/\s+/g, "").trim();
      const titleElement = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,[role='heading'],main div"))
        .find(element => {
          const text = (element.innerText || element.textContent || "").replace(/\s+/g, "").trim();
          return visible(element) && text === normalizedTitle;
        });
      if (titleElement) {
        let ancestor: HTMLElement | null = titleElement.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (ancestor.querySelectorAll("p,h2,h3,h4,h5,blockquote").length >= 3) {
            return "title-linked-article-root";
          }
          ancestor = ancestor.parentElement;
        }
      }
      return "url-only";
    }, workId);
    return { url, workId, title: await page.title(), activeContainerSource };
  }

  private async assertWorkContext(page: Page, expected: WorkContext): Promise<void> {
    assertWorkId(expected.workId, page.url());
    const pageWorkId = await page.evaluate(() => {
      const url = new URL(location.href);
      return url.searchParams.get("modal_id")
        ?? url.searchParams.get("aweme_id")
        ?? url.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
        ?? null;
    });
    if (pageWorkId !== expected.workId) {
      assertWorkId(expected.workId, page.url().replace(expected.workId, pageWorkId ?? ""));
    }
  }

  private async lockedMediaData(page: Page, context: WorkContext, textLimit = 3_000): Promise<{
    durationSeconds: number | null;
    currentTimeSeconds: number | null;
    paused: boolean | null;
    muted: boolean | null;
    mediaCandidates: string[];
    videoIndex: number;
    visibleText: string;
    textSource: string;
    characterCount: number;
    truncated: boolean;
    chapterText: string;
  }> {
    await this.assertWorkContext(page, context);
    const data = await page.evaluate(({ workId, maxChars }: { workId: string; maxChars: number }) => {
      const clean = (value: string | null | undefined) => (value ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const allVideos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
      const workContainer = document.querySelector<HTMLElement>(`[class*="video_${workId}"]`);
      const detailContainers = Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='video-detail'],[role='dialog']"));
      const fallbackContainer = detailContainers
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 300 && rect.height > 180 && rect.bottom > 0 && rect.right > 0;
        })
        .sort((a, b) => {
          const aHas = a.querySelector(`a[href*="${workId}"]`) ? 1 : 0;
          const bHas = b.querySelector(`a[href*="${workId}"]`) ? 1 : 0;
          return bHas - aHas;
        })[0] ?? null;
      const container = workContainer ?? fallbackContainer;
      const candidates = allVideos.map((video, index) => {
        const rect = video.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
        const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        const inside = container?.contains(video) ? 1 : 0;
        const ancestorHasWorkId = video.closest(`[class*="video_${workId}"]`) ? 1 : 0;
        return {
          video,
          index,
          score: ancestorHasWorkId * 1_000_000_000 + inside * 100_000_000 + visibleWidth * visibleHeight,
          visibleArea: visibleWidth * visibleHeight,
        };
      }).filter(item => item.visibleArea > 10_000 || item.score >= 100_000_000)
        .sort((a, b) => b.score - a.score);
      const selected = candidates[0] ?? null;

      let textContainer: HTMLElement | null = container;
      if (!textContainer && selected) {
        textContainer = selected.video.closest<HTMLElement>("[data-e2e='video-detail'],[role='dialog'],[class*='leftContainer']");
      }

      const chapterCandidates = textContainer ? Array.from(textContainer.querySelectorAll<HTMLElement>("*"))
        .map(element => {
          const text = clean(element.innerText || element.textContent || "");
          const timestamps = (text.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) ?? []).length;
          return { text, timestamps };
        })
        .filter(item => item.text.includes("章节要点") && item.timestamps >= 2)
        .sort((a, b) => a.text.length - b.text.length) : [];

      const captionTexts = textContainer ? Array.from(textContainer.querySelectorAll<HTMLElement>(
        "[class*='subtitle'],[class*='Subtitle'],[class*='caption'],[class*='Caption']",
      )).map(element => clean(element.innerText || element.textContent || ""))
        .filter(text => text.length >= 1 && text.length <= 500) : [];
      const titleText = clean(document.title.replace(/\s*-\s*抖音\s*$/, ""));
      const timeText = selected && Number.isFinite(selected.video.duration)
        ? `当前时间 ${selected.video.currentTime.toFixed(2)} 秒 / 时长 ${selected.video.duration.toFixed(2)} 秒`
        : "";
      const safeTextAll = [...new Set([
        titleText,
        timeText,
        chapterCandidates[0]?.text ?? "",
        ...captionTexts,
      ].filter(Boolean))].join("\n");
      const safeVisibleText = safeTextAll.slice(0, maxChars);

      const direct = selected
        ? [selected.video.currentSrc, selected.video.src]
          .filter((value): value is string => Boolean(value) && /^(?:https?:|blob:)/i.test(value))
        : [];
      return {
        durationSeconds: selected && Number.isFinite(selected.video.duration) ? selected.video.duration : null,
        currentTimeSeconds: selected && Number.isFinite(selected.video.currentTime) ? selected.video.currentTime : null,
        paused: selected ? selected.video.paused : null,
        muted: selected ? selected.video.muted : null,
        mediaCandidates: [...new Set(direct)].slice(0, 8),
        videoIndex: selected?.index ?? -1,
        visibleText: safeVisibleText,
        textSource: workContainer
          ? `active-work-container:video_${workId}`
          : textContainer
            ? "active-work-container:video-detail"
            : "locked-work-url-metadata",
        characterCount: safeVisibleText.length,
        truncated: safeTextAll.length > safeVisibleText.length,
        chapterText: chapterCandidates[0]?.text ?? "",
        duringWorkId: new URL(location.href).searchParams.get("modal_id")
          ?? location.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? null,
      };
    }, { workId: context.workId, maxChars: textLimit });
    if ((data as typeof data & { duringWorkId?: string | null }).duringWorkId !== context.workId) {
      assertWorkId(context.workId, page.url().replace(context.workId, (data as typeof data & { duringWorkId?: string | null }).duringWorkId ?? ""));
    }
    await this.assertWorkContext(page, context);
    return data;
  }

  private async collectElements(page: Page, requestedLimit = CONFIG.maxElements): Promise<InteractiveElement[]> {
    const maxElements = Math.min(CONFIG.maxElements, Math.max(1, Math.round(requestedLimit)));
    const rawElements = await page.evaluate((limit: number) => {
      const selectors = [
        "a[href]",
        "button",
        "[role='button']",
        "[role='tab']",
        "[role='menuitem']",
        "[tabindex]:not([tabindex='-1'])",
        "video",
        "input",
        "textarea",
        "[contenteditable='true']",
      ].join(",");

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const seen = new Set<HTMLElement>();
      const result: Array<{
        id: string;
        tag: string;
        role: string;
        label: string;
        href: string | null;
        box: { x: number; y: number; width: number; height: number };
        kind: "link" | "button" | "tab" | "video" | "input" | "other";
        selector: string;
        dataE2e: string | null;
      }> = [];

      const clean = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const cssPath = (element: HTMLElement): string => {
        const parts: string[] = [];
        let current: HTMLElement | null = element;
        while (current && current !== document.body && parts.length < 10) {
          if (current.id && /^[A-Za-z][\w:.-]*$/.test(current.id)) {
            parts.unshift(`#${CSS.escape(current.id)}`);
            return parts.join(" > ");
          }
          const parent: HTMLElement | null = current.parentElement;
          if (!parent) break;
          const tag = current.tagName.toLowerCase();
          const siblings = Array.from(parent.children).filter(child => child.tagName === current!.tagName);
          const part = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag;
          parts.unshift(part);
          current = parent;
        }
        parts.unshift("body");
        return parts.join(" > ");
      };

      for (const element of candidates) {
        if (seen.has(element)) continue;
        seen.add(element);
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          Number(style.opacity) === 0 ||
          box.width < 8 ||
          box.height < 8 ||
          box.bottom < 0 ||
          box.right < 0 ||
          box.top > window.innerHeight ||
          box.left > window.innerWidth
        ) continue;

        const tag = element.tagName.toLowerCase();
        const role = clean(element.getAttribute("role"));
        const aria = clean(element.getAttribute("aria-label"));
        const title = clean(element.getAttribute("title"));
        const alt = clean(element.getAttribute("alt"));
        const text = clean(element.innerText || element.textContent);
        const label = aria || title || alt || text || (tag === "video" ? "当前视频" : "未命名元素");
        const href = element instanceof HTMLAnchorElement ? element.href : null;
        const id = `e${result.length + 1}`;

        let kind: "link" | "button" | "tab" | "video" | "input" | "other" = "other";
        if (tag === "a") kind = "link";
        else if (tag === "button" || role === "button" || role === "menuitem") kind = "button";
        else if (role === "tab") kind = "tab";
        else if (tag === "video") kind = "video";
        else if (tag === "input" || tag === "textarea" || element.isContentEditable) kind = "input";

        result.push({
          id,
          tag,
          role,
          label,
          href,
          box: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
          kind,
          selector: cssPath(element),
          dataE2e: element.getAttribute("data-e2e"),
        });
        if (result.length >= limit) break;
      }
      return result;
    }, maxElements);

    this.latestElementSelectors = new Map(rawElements.map(element => [element.id, element.selector]));
    this.latestElementFingerprints = new Map(rawElements.map(element => [element.id, {
      selector: element.selector,
      tag: element.tag,
      role: element.role,
      label: element.label,
      href: element.href,
      dataE2e: element.dataE2e,
      kind: element.kind,
    }]));
    const elements = rawElements.map(({ selector: _selector, dataE2e: _dataE2e, ...element }) => element);
    this.latestElements = new Map(elements.map(element => [element.id, element]));
    return elements;
  }

  private async viewportDiagnostics(page: Page): Promise<ViewportDiagnostics> {
    const playwright = page.viewportSize() ?? { width: 1280, height: 720 };
    const live = await page.evaluate(() => ({
      css: {
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight),
      },
      outer: {
        width: Math.max(1, window.outerWidth),
        height: Math.max(1, window.outerHeight),
      },
      devicePixelRatio: Number(window.devicePixelRatio || 1),
    })).catch(() => ({
      css: { ...playwright },
      outer: { ...playwright },
      devicePixelRatio: 1,
    }));
    const widthRatio = live.css.width / Math.max(1, playwright.width);
    const heightRatio = live.css.height / Math.max(1, playwright.height);
    return {
      playwright,
      css: live.css,
      outer: live.outer,
      devicePixelRatio: live.devicePixelRatio,
      widthRatio,
      heightRatio,
      mismatch: widthRatio < 0.7 || widthRatio > 1.3 || heightRatio < 0.7 || heightRatio > 1.3,
    };
  }

  private async screenshot(page: Page): Promise<string> {
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: CONFIG.screenshotQuality,
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      timeout: 10_000,
    });
    return buffer.toString("base64");
  }

  private async resolveObservedElement(
    page: Page,
    elementId: string,
    fingerprint: {
      selector: string;
      tag: string;
      role: string;
      label: string;
      href: string | null;
      dataE2e: string | null;
      kind: InteractiveElement["kind"];
    } | undefined = this.latestElementFingerprints.get(elementId),
  ): Promise<ReturnType<Page["locator"]> | null> {
    if (!fingerprint) return null;
    const candidates = page.locator([
      "a[href]",
      "button",
      "[role='button']",
      "[role='tab']",
      "[role='menuitem']",
      "[tabindex]:not([tabindex='-1'])",
      "video",
      "input",
      "textarea",
      "[contenteditable='true']",
    ].join(","));
    const matches = await candidates.evaluateAll((elements, expected) => {
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      return elements.map((element, index) => {
        const node = element as HTMLElement;
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (box.width < 8 || box.height < 8 || box.bottom < 0 || box.right < 0
          || style.display === "none" || style.visibility === "hidden") {
          return { index, score: -1 };
        }
        const href = node instanceof HTMLAnchorElement ? node.href : null;
        const label = clean(
          node.getAttribute("aria-label")
          || node.getAttribute("title")
          || node.getAttribute("alt")
          || node.innerText
          || node.textContent,
        );
        let score = 0;
        if (expected.href && href === expected.href) score += 10_000;
        if (expected.dataE2e && node.getAttribute("data-e2e") === expected.dataE2e) score += 3_000;
        if (node.tagName.toLowerCase() === expected.tag) score += 300;
        if (clean(node.getAttribute("role")) === expected.role) score += 200;
        if (label === expected.label) score += 1_000;
        return { index, score };
      }).filter(item => item.score >= 1_000).sort((a, b) => b.score - a.score);
    }, fingerprint);
    if (!matches.length || (matches[1] && matches[1].score === matches[0].score)) return null;
    return candidates.nth(matches[0].index);
  }

  private async createObservationSnapshot(
    page: Page,
    ownerId: string,
    elements: InteractiveElement[],
    capturedAt: string,
    screenshot?: {
      base64: string;
      viewport: { width: number; height: number };
    },
  ): Promise<Pick<Observation,
    "observationId" | "pageId" | "pageTargetId" | "snapshotHash" | "expiresAt">> {
    const now = Date.now();
    for (const [id, snapshot] of this.observationSnapshots) {
      if (snapshot.expiresAt <= now || snapshot.ownerId === ownerId) {
        this.observationSnapshots.delete(id);
      }
    }
    const observationId = randomUUID();
    const pageId = this.pageId(page);
    const pageTargetId = await this.pageTargetId(page);
    const expiresAt = now + 90_000;
    const snapshotHash = sha256(JSON.stringify({
      observationId,
      ownerId,
      pageId,
      pageTargetId,
      url: page.url(),
      capturedAt,
      elements,
    }));
    this.observationSnapshots.set(observationId, {
      observationId,
      ownerId,
      pageId,
      pageTargetId,
      url: page.url(),
      snapshotHash,
      expiresAt,
      screenshotBase64: screenshot?.base64 ?? null,
      screenshotViewport: screenshot?.viewport ?? null,
      elements: new Map(this.latestElements),
      selectors: new Map(this.latestElementSelectors),
      fingerprints: new Map(this.latestElementFingerprints),
    });
    return {
      observationId,
      pageId,
      pageTargetId,
      snapshotHash,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async requireObservationSnapshot(input: {
    ownerId: string;
    observationId: string;
    snapshotHash: string;
  }): Promise<{
    page: Page;
    snapshot: ObservationSnapshot;
  }> {
    const snapshot = this.observationSnapshots.get(input.observationId);
    if (!snapshot
      || snapshot.ownerId !== input.ownerId
      || snapshot.snapshotHash !== input.snapshotHash
      || snapshot.expiresAt <= Date.now()) {
      if (snapshot?.expiresAt && snapshot.expiresAt <= Date.now()) {
        this.observationSnapshots.delete(input.observationId);
      }
      throw new Error("STALE_OBSERVATION:观察快照不存在、已过期或不属于当前 MCP 会话。请重新观察。");
    }
    const pages = await this.allowedPages();
    const page = pages.find(candidate => this.pageId(candidate) === snapshot.pageId);
    if (!page || page.isClosed()) {
      throw new Error("STALE_OBSERVATION:原页面已经关闭。请重新观察。");
    }
    if (await this.pageTargetId(page) !== snapshot.pageTargetId
      || page.url() !== snapshot.url) {
      throw new Error("STALE_OBSERVATION:页面身份或 URL 已变化。请重新观察。");
    }
    return { page, snapshot };
  }

  async observe(note?: string, pageId?: string, ownerId = "local"): Promise<Observation> {
    return this.serial(async () => {
      await this.ensurePageRoles();
      const pages = await this.allowedPages();
      const page = pageId
        ? await this.resolveAllowedPageReference(pageId)
        : (this.activePageId ? pages.find(candidate => this.pageId(candidate) === this.activePageId) : undefined)
          ?? this.rolePages.get("codex_test")
          ?? this.rolePages.get("operator_home");
      if (!page || page.isClosed()) throw new Error("PAGE_BINDING_LOST:没有可观察的已绑定页面。");
      const url = page.url();
      assertAllowedUrl(url);
      const [title, viewport, elements, screenshotBase64, viewportDiagnostics] = await Promise.all([
        page.title(),
        Promise.resolve(page.viewportSize() ?? { width: 1280, height: 720 }),
        this.collectElements(page),
        this.screenshot(page),
        this.viewportDiagnostics(page),
      ]);

      const capturedAt = new Date().toISOString();
      const snapshot = await this.createObservationSnapshot(
        page,
        ownerId,
        elements,
        capturedAt,
        { base64: screenshotBase64, viewport },
      );
      const observation: Observation = {
        ...snapshot,
        url,
        title,
        pageKind: this.pageKind(url, title),
        viewport,
        viewportDiagnostics,
        elements,
        screenshotBase64,
        capturedAt,
        note,
      };
      log("observe", { url, pageKind: observation.pageKind, elements: elements.length });
      return observation;
    }, { restoreOnError: false, persistPageState: false });
  }

  async observeFast(pageId?: string, ownerId = "local"): Promise<Omit<Observation, "screenshotBase64"> & {
    screenshotIncluded: false;
    elapsedMs: number;
  }> {
    return this.serial(async () => {
      const startedAt = Date.now();
      await this.ensurePageRoles();
      const pages = await this.allowedPages();
      const page = pageId
        ? await this.resolveAllowedPageReference(pageId)
        : (this.activePageId ? pages.find(candidate => this.pageId(candidate) === this.activePageId) : undefined)
          ?? this.rolePages.get("codex_test")
          ?? this.rolePages.get("operator_home");
      if (!page || page.isClosed()) throw new Error("PAGE_BINDING_LOST:没有可观察的已绑定页面。");
      const url = page.url();
      assertAllowedUrl(url);
      const [title, elements, viewportDiagnostics] = await Promise.all([
        page.title(),
        this.collectElements(page, 36),
        this.viewportDiagnostics(page),
      ]);
      const capturedAt = new Date().toISOString();
      const snapshot = await this.createObservationSnapshot(
        page,
        ownerId,
        elements,
        capturedAt,
      );
      return {
        ...snapshot,
        url,
        title,
        pageKind: this.pageKind(url, title),
        viewport: page.viewportSize() ?? { width: 1280, height: 720 },
        viewportDiagnostics,
        elements,
        capturedAt,
        screenshotIncluded: false,
        elapsedMs: Date.now() - startedAt,
        note: "轻量观察未生成截图；需要视觉确认时再调用 douyin_observe。",
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async openSection(section: "home" | "profile" | "likes" | "favorites"): Promise<Observation> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const targets: Record<typeof section, string> = {
        home: "https://www.douyin.com/",
        profile: "https://www.douyin.com/user/self",
        likes: "https://www.douyin.com/user/self?showTab=like",
        favorites: "https://www.douyin.com/user/self?showTab=collection",
      };
      const target = targets[section];
      assertAllowedUrl(target);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await sleep(CONFIG.actionDelayMs);
      assertAllowedUrl(page.url());
      log("open_section", { section, url: page.url() });
      return this.observeUnlocked(`已打开${section === "home" ? "抖音首页" : section === "profile" ? "个人主页" : section === "likes" ? "喜欢列表" : "收藏列表"}。`);
    });
  }

  async scroll(
    direction: "down" | "up",
    amount: number,
    options: { observeAfter?: boolean; waitAfterMs?: number } = {},
  ): Promise<Observation | LightweightScrollResult> {
    return this.serial(async () => {
      const startedAt = Date.now();
      const page = await this.currentPage();
      const pixels = Math.min(1600, Math.max(200, Math.round(amount))) * (direction === "down" ? 1 : -1);
      const result = await page.evaluate((delta: number): {
        target: "inner" | "window";
        before: number;
        after: number;
        workLinks: number;
        timestampCount: number;
        transcriptHints: number;
        textPreview: string;
      } => {
        const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const sampled = new Set<HTMLElement>();
        const sampleX = [0.2, 0.5, 0.8].map(ratio => Math.max(1, Math.floor(innerWidth * ratio)));
        const sampleY = [0.2, 0.5, 0.8].map(ratio => Math.max(1, Math.floor(innerHeight * ratio)));
        for (const x of sampleX) {
          for (const y of sampleY) {
            for (const hit of document.elementsFromPoint(x, y)) {
              let element = hit instanceof HTMLElement ? hit : hit.parentElement;
              for (let depth = 0; element && depth < 12; depth += 1) {
                sampled.add(element);
                element = element.parentElement;
              }
            }
          }
        }
        if (document.body) sampled.add(document.body);
        if (document.documentElement) sampled.add(document.documentElement);
        const candidates = Array.from(sampled)
          .filter(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return element.scrollHeight > element.clientHeight + 80 &&
              /(auto|scroll)/.test(style.overflowY) &&
              rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < innerHeight;
          })
          .map(element => {
            const rect = element.getBoundingClientRect();
            const text = clean(element.innerText || element.textContent).slice(0, 4_000);
            const workLinks = element.querySelectorAll('a[href*="/video/"],a[href*="/note/"],a[href*="/article/"]').length;
            const timestampCount = (text.match(/(?:^|\s)\d{1,2}:\d{2}(?=\s|$)/g) ?? []).length;
            const transcriptHints = /转录文本|字幕|时间轴|复制该时间段|翻译该句/i.test(text) ? 1 : 0;
            const visibleArea = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
              Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
            const score = workLinks * 1_000_000 + timestampCount * 500_000 + transcriptHints * 2_000_000 +
              Math.min(500_000, text.length * 20) + visibleArea + Math.min(500_000, element.scrollHeight);
            return { element, score, workLinks, timestampCount, transcriptHints, textPreview: text.slice(0, 80) };
          })
          .sort((a, b) => b.score - a.score);

        for (const candidate of candidates.slice(0, 12)) {
          const before = candidate.element.scrollTop;
          candidate.element.scrollBy({ top: delta, behavior: "instant" });
          const after = candidate.element.scrollTop;
          if (Math.abs(after - before) >= 1) {
            return {
              target: "inner",
              before,
              after,
              workLinks: candidate.workLinks,
              timestampCount: candidate.timestampCount,
              transcriptHints: candidate.transcriptHints,
              textPreview: candidate.textPreview,
            };
          }
        }

        const before = window.scrollY;
        window.scrollBy({ top: delta, behavior: "instant" });
        return { target: "window", before, after: window.scrollY, workLinks: 0, timestampCount: 0, transcriptHints: 0, textPreview: "" };
      }, pixels);
      const waitAfterMs = options.observeAfter
        ? CONFIG.actionDelayMs
        : Math.min(1_000, Math.max(0, Math.round(options.waitAfterMs ?? 80)));
      if (waitAfterMs > 0) await sleep(waitAfterMs);
      assertAllowedUrl(page.url());
      log("scroll", { direction, pixels, url: page.url(), ...result });
      const moved = Math.abs(result.after - result.before);
      const targetName = result.target === "inner"
        ? (result.transcriptHints || result.timestampCount >= 2 ? "内部文字/转录区域" : "内容列表")
        : "网页";
      const note = `已向${direction === "down" ? "下" : "上"}滚动 ${Math.abs(pixels)} 像素（${targetName}实际移动 ${moved} 像素）。`;
      if (options.observeAfter) return this.observeUnlocked(note);
      const title = await page.title();
      return {
        url: page.url(),
        title,
        pageKind: this.pageKind(page.url(), title),
        direction,
        requestedPixels: Math.abs(pixels),
        movedPixels: moved,
        target: result.target,
        targetName,
        elapsedMs: Date.now() - startedAt,
        screenshotIncluded: false,
        capturedAt: new Date().toISOString(),
        note,
      };
    }, options.observeAfter ? {} : { restoreOnError: false, persistPageState: false });
  }

  async scrollRegion(options: {
    ownerId: string;
    observationId: string;
    snapshotHash: string;
    elementId: string;
    direction: "down" | "up";
    amount: number;
  }): Promise<Observation> {
    return this.serial(async () => {
      const { page, snapshot } = await this.requireObservationSnapshot(options);
      const { elementId, direction, amount } = options;
      if (!snapshot.elements.has(elementId)) {
        throw new Error(`找不到元素 ${elementId}。请重新调用 douyin_observe 获取最新编号。`);
      }
      const pixels = Math.min(2400, Math.max(120, Math.round(amount))) * (direction === "down" ? 1 : -1);
      const selector = snapshot.selectors.get(elementId);
      if (!selector) throw new Error(`元素 ${elementId} 缺少只读定位信息，请重新观察页面。`);
      const result = await page.evaluate(({ id, selector: css, delta }: { id: string; selector: string; delta: number }) => {
        const anchor = document.querySelector<HTMLElement>(css);
        if (!anchor) throw new Error(`元素 ${id} 已失效，请重新观察页面。`);
        const isScrollable = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          return element.scrollHeight > element.clientHeight + 20 && /(auto|scroll)/.test(style.overflowY);
        };
        const candidates: HTMLElement[] = [];
        let node: HTMLElement | null = anchor;
        while (node && node !== document.body) {
          if (isScrollable(node)) candidates.push(node);
          node = node.parentElement;
        }
        for (const target of candidates) {
          const before = target.scrollTop;
          target.scrollBy({ top: delta, behavior: "instant" });
          const after = target.scrollTop;
          if (Math.abs(after - before) >= 1 || candidates.length === 1) {
            const rect = target.getBoundingClientRect();
            return {
              target: "ancestor",
              before,
              after,
              scrollHeight: target.scrollHeight,
              clientHeight: target.clientHeight,
              box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              preview: (target.innerText || target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            };
          }
        }
        const before = window.scrollY;
        window.scrollBy({ top: delta, behavior: "instant" });
        return {
          target: "window",
          before,
          after: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: innerHeight,
          box: { x: 0, y: 0, width: innerWidth, height: innerHeight },
          preview: "",
        };
      }, { id: elementId, selector, delta: pixels });
      await sleep(CONFIG.actionDelayMs);
      assertAllowedUrl(page.url());
      const moved = Math.abs(result.after - result.before);
      log("scroll_region", { elementId, direction, pixels, url: page.url(), ...result });
      return this.observeBoundPageUnlocked(
        page,
        options.ownerId,
        `已围绕 ${elementId} 向${direction === "down" ? "下" : "上"}滚动 ${Math.abs(pixels)} 像素（最近的${result.target === "ancestor" ? "内部滚动框" : "网页"}实际移动 ${moved} 像素）。`,
      );
    });
  }

  async readRegion(options: {
    ownerId: string;
    pageId?: string;
    observationId?: string;
    snapshotHash?: string;
    elementId?: string;
    maxChars?: number;
  }): Promise<{
    url: string;
    title: string;
    pageId: string;
    elementId: string | null;
    source: string;
    text: string;
    characterCount: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }> {
    return this.serial(async () => {
      const elementId = options.elementId;
      const hasObservationAnchor = Boolean(options.observationId || options.snapshotHash);
      if (hasObservationAnchor && (!options.observationId || !options.snapshotHash)) {
        throw new Error("PAGE_ANCHOR_INCOMPLETE:observation_id 与 snapshot_hash 必须同时提供。");
      }
      if (options.pageId && hasObservationAnchor) {
        throw new Error("PAGE_ANCHOR_AMBIGUOUS:page_id 与 observation 快照只能选择一种。");
      }
      if (!options.pageId && !hasObservationAnchor) {
        throw new Error("PAGE_ANCHOR_REQUIRED:读取文字区域必须提供 page_id，或提供 observation_id + snapshot_hash。");
      }
      if (elementId && !hasObservationAnchor) {
        throw new Error("OBSERVATION_REQUIRED:使用 element_id 时必须同时提供 observation_id 与 snapshot_hash。");
      }
      const anchored = hasObservationAnchor
        ? await this.requireObservationSnapshot({
          ownerId: options.ownerId,
          observationId: options.observationId!,
          snapshotHash: options.snapshotHash!,
        })
        : null;
      const page = anchored?.page ?? await this.resolveAllowedPageReference(options.pageId!);
      if (!page || page.isClosed()) {
        throw new Error("PAGE_BINDING_LOST:指定页面不存在或已经关闭。");
      }
      if (elementId && !anchored?.snapshot.elements.has(elementId)) {
        throw new Error(`找不到元素 ${elementId}。请先重新调用 douyin_observe 获取最新编号。`);
      }
      const boundPageId = this.pageId(page);
      const boundTargetId = await this.pageTargetId(page);
      const boundUrl = page.url();
      const limit = Math.min(120_000, Math.max(500, Math.round(options.maxChars ?? 50_000)));
      const selector = elementId ? anchored?.snapshot.selectors.get(elementId) : undefined;
      const result = await page.evaluate(({ id, selector: css, limit }: { id?: string; selector?: string; limit: number }) => {
        const clean = (value: string | null | undefined) => (value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const textOf = (element: HTMLElement) => clean(element.innerText || element.textContent || "");
        const isScrollable = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          return element.scrollHeight > element.clientHeight + 20 && /(auto|scroll)/.test(style.overflowY);
        };

        let target: HTMLElement | null = null;
        let source = "auto";
        if (id) {
          const anchor = css ? document.querySelector<HTMLElement>(css) : null;
          if (!anchor) throw new Error(`元素 ${id} 已失效，请重新观察页面。`);
          let node: HTMLElement | null = anchor;
          while (node && node !== document.body) {
            if (isScrollable(node)) {
              target = node;
              source = "nearest-scrollable-ancestor";
              break;
            }
            node = node.parentElement;
          }
          target ??= anchor.closest<HTMLElement>("article,main,[role='main']") ?? anchor.parentElement ?? anchor;
          if (source === "auto") source = "near-element";
        } else {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *"))
            .filter(element => {
              const rect = element.getBoundingClientRect();
              return isScrollable(element) && rect.width > 180 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight;
            })
            .map(element => {
              const text = textOf(element);
              const rect = element.getBoundingClientRect();
              const timestamps = (text.match(/(?:^|\n)\s*\d{1,2}:\d{2}/g) ?? []).length;
              const hints = /转录文本|字幕|复制该时间段|翻译该句|时间轴/i.test(text) ? 1 : 0;
              const visibleArea = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
                Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
              const score = timestamps * 1_000_000 + hints * 3_000_000 + Math.min(1_000_000, text.length * 25) + visibleArea;
              return { element, text, score, timestamps, hints };
            })
            .filter(item => item.text.length >= 80)
            .sort((a, b) => b.score - a.score);
          if (candidates[0]) {
            target = candidates[0].element;
            source = candidates[0].hints || candidates[0].timestamps >= 2 ? "auto-transcript-region" : "auto-scrollable-region";
          }
        }

        target ??= document.querySelector<HTMLElement>("article,main,[role='main']") ?? document.body;
        const text = textOf(target).slice(0, limit);
        return {
          source,
          text,
          characterCount: text.length,
          scrollTop: target.scrollTop,
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
        };
      }, { id: elementId, selector, limit });
      if (await this.pageTargetId(page) !== boundTargetId || page.url() !== boundUrl) {
        throw new Error("PAGE_CONTEXT_CHANGED:读取期间原页面身份或 URL 已变化，结果已丢弃。请重新观察目标页。");
      }
      if (result.characterCount < 20) {
        throw new Error("没有从目标区域读到足够文字。可以换一个位于该滚动框内部的 element_id 再试。 ");
      }
      const output = {
        url: boundUrl,
        title: await page.title(),
        pageId: boundPageId,
        elementId: elementId ?? null,
        ...result,
      };
      log("read_region", {
        pageId: output.pageId,
        url: output.url,
        elementId: output.elementId,
        source: output.source,
        chars: output.characterCount,
      });
      return output;
    });
  }

  private async inspectVisualPoint(
    page: Page,
    x: number,
    y: number,
  ): Promise<ManualPointInspection> {
    return page.evaluate(({ requestedX, requestedY }): ManualPointInspection => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const x = Math.min(width - 1, Math.max(0, requestedX));
      const y = Math.min(height - 1, Math.max(0, requestedY));
      const clean = (value: string | null | undefined, limit = 180): string =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && style.pointerEvents !== "none"
          && rect.width >= 4
          && rect.height >= 4;
      };
      const labelOf = (element: Element): string => {
        const node = element as HTMLElement;
        return clean(
          node.getAttribute("aria-label")
          || node.getAttribute("title")
          || node.getAttribute("alt")
          || node.innerText
          || node.textContent,
        );
      };
      const stackElements = document.elementsFromPoint(x, y).slice(0, 10);
      const selector = [
        "a[href]",
        "button",
        "[role='button']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='link']",
        "[tabindex]:not([tabindex='-1'])",
        "video",
        "input",
        "textarea",
        "[contenteditable='true']",
      ].join(",");
      let targetElement: HTMLElement | null = null;
      let interactionSource: "semantic" | "music_candidate_ancestor" = "semantic";
      for (const element of stackElements) {
        const candidate = element.closest<HTMLElement>(selector);
        if (candidate && visible(candidate)) {
          targetElement = candidate;
          break;
        }
      }
      if (!targetElement) {
        const hasClickListener = (node: HTMLElement): boolean => {
          if (typeof node.onclick === "function") return true;
          for (const key of Object.keys(node)) {
            if (!key.startsWith("__reactProps$")) continue;
            const props = (node as unknown as Record<string, unknown>)[key];
            if (props && typeof props === "object"
              && typeof (props as Record<string, unknown>).onClick === "function") return true;
          }
          return getComputedStyle(node).cursor === "pointer";
        };
        outer: for (const element of stackElements) {
          let node = element instanceof HTMLElement ? element : element.parentElement;
          for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
            const inMusicPicker = Boolean(node.closest("[role='sidesheet'],.semi-sidesheet"));
            const candidateClass = /card-container-tmocjc|card-wrapper-/.test(String(node.className || ""));
            const hasSongText = Boolean(node.querySelector("[class*='song-name-']"));
            if (inMusicPicker && candidateClass && hasSongText && visible(node) && hasClickListener(node)) {
              targetElement = node;
              interactionSource = "music_candidate_ancestor";
              break outer;
            }
            if (node.matches("[role='sidesheet'],.semi-sidesheet")) break;
          }
        }
      }
      const stack = stackElements.map(element => {
        const node = element as HTMLElement;
        return {
          tag: node.tagName.toLowerCase(),
          role: clean(node.getAttribute("role"), 60),
          label: labelOf(node),
          dataE2e: node.getAttribute("data-e2e"),
          pointerEvents: getComputedStyle(node).pointerEvents,
        };
      });
      if (!targetElement) {
        return {
          point: { x, y, xRatio: x / width, yRatio: y / height },
          target: null,
          stack,
        };
      }
      const tag = targetElement.tagName.toLowerCase();
      const role = clean(targetElement.getAttribute("role"), 60);
      let kind: ManualTarget["kind"] = "other";
      if (interactionSource === "music_candidate_ancestor") kind = "button";
      else if (tag === "a" || role === "link") kind = "link";
      else if (tag === "button" || role === "button" || role === "menuitem") kind = "button";
      else if (role === "tab") kind = "tab";
      else if (tag === "video") kind = "video";
      else if (tag === "input" || tag === "textarea" || targetElement.isContentEditable) kind = "input";
      const contextRoot = targetElement.closest<HTMLElement>(
        "[role='dialog'],[role='sidesheet'],.semi-sidesheet,[data-e2e*='card'],[data-e2e*='item'],[class*='Card'],[class*='card'],[class*='modal'],[class*='dialog'],[class*='MessageItem']",
      );
      const rect = targetElement.getBoundingClientRect();
      return {
        point: { x, y, xRatio: x / width, yRatio: y / height },
        target: {
          label: labelOf(targetElement),
          role,
          kind,
          href: targetElement instanceof HTMLAnchorElement ? targetElement.href : null,
          pageUrl: location.href,
          contextText: contextRoot
            ? clean(contextRoot.innerText || contextRoot.textContent, 260)
            : clean(targetElement.parentElement?.innerText || targetElement.parentElement?.textContent, 260),
          tag,
          box: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          dataE2e: targetElement.getAttribute("data-e2e"),
          className: clean(String(targetElement.className || ""), 180),
          interactionSource,
        },
        stack,
      };
    }, { requestedX: x, requestedY: y });
  }

  async probeVisualPoint(options: {
    ownerId: string;
    observationId: string;
    snapshotHash: string;
    xRatio: number;
    yRatio: number;
  }): Promise<{
    observationId: string;
    pageId: string;
    pageTargetId: string;
    url: string;
    inspection: ManualPointInspection;
    decision: ReturnType<typeof classifyManualTarget> | null;
    cropBase64: string | null;
    cropMimeType: "image/png";
    crop: { x: number; y: number; width: number; height: number };
    cropSource: "observation_cache" | "live_capture" | "unavailable";
  }> {
    return this.serial(async () => {
      const { page, snapshot } = await this.requireObservationSnapshot(options);
      const viewport = await page.evaluate(() => ({
        width: Math.max(1, innerWidth),
        height: Math.max(1, innerHeight),
      }));
      const xRatio = Math.min(1, Math.max(0, options.xRatio));
      const yRatio = Math.min(1, Math.max(0, options.yRatio));
      const x = Math.min(viewport.width - 1, viewport.width * xRatio);
      const y = Math.min(viewport.height - 1, viewport.height * yRatio);
      const inspection = await this.inspectVisualPoint(page, x, y);
      const decision = inspection.target ? classifyManualTarget(inspection.target) : null;
      const cropWidth = Math.min(360, viewport.width);
      const cropHeight = Math.min(240, viewport.height);
      const crop = {
        x: Math.max(0, Math.min(viewport.width - cropWidth, x - cropWidth / 2)),
        y: Math.max(0, Math.min(viewport.height - cropHeight, y - cropHeight / 2)),
        width: cropWidth,
        height: cropHeight,
      };
      let cropBase64: string | null = null;
      let cropSource: "observation_cache" | "live_capture" | "unavailable" = "live_capture";
      if (snapshot.screenshotBase64 && snapshot.screenshotViewport) {
        cropBase64 = await page.evaluate((input) => new Promise<string>((resolve, reject) => {
          const image = new Image();
          const timer = window.setTimeout(() => reject(new Error("cached screenshot decode timed out")), 2_500);
          image.onload = () => {
            window.clearTimeout(timer);
            const scaleX = image.naturalWidth / Math.max(1, input.viewport.width);
            const scaleY = image.naturalHeight / Math.max(1, input.viewport.height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(input.crop.width * scaleX));
            canvas.height = Math.max(1, Math.round(input.crop.height * scaleY));
            const context = canvas.getContext("2d");
            if (!context) {
              reject(new Error("cached screenshot canvas unavailable"));
              return;
            }
            context.drawImage(
              image,
              input.crop.x * scaleX,
              input.crop.y * scaleY,
              input.crop.width * scaleX,
              input.crop.height * scaleY,
              0,
              0,
              canvas.width,
              canvas.height,
            );
            resolve(canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""));
          };
          image.onerror = () => {
            window.clearTimeout(timer);
            reject(new Error("cached screenshot decode failed"));
          };
          image.src = `data:image/jpeg;base64,${input.base64}`;
        }), {
          base64: snapshot.screenshotBase64,
          viewport: snapshot.screenshotViewport,
          crop,
        }).catch(() => null);
        if (cropBase64) cropSource = "observation_cache";
      }
      if (!cropBase64) {
        const buffer = await page.screenshot({
          type: "png",
          clip: crop,
          animations: "disabled",
          caret: "hide",
          timeout: 4_000,
        }).catch(() => null);
        if (buffer) cropBase64 = buffer.toString("base64");
        else cropSource = "unavailable";
      }
      return {
        observationId: snapshot.observationId,
        pageId: snapshot.pageId,
        pageTargetId: snapshot.pageTargetId,
        url: page.url(),
        inspection,
        decision,
        cropBase64,
        cropMimeType: "image/png",
        crop,
        cropSource,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async clickVisualInterface(options: {
    ownerId: string;
    observationId: string;
    snapshotHash: string;
    elementId?: string;
    xRatio?: number;
    yRatio?: number;
    offsetX?: number;
    offsetY?: number;
    intent: string;
    writeAction: "interface" | "close_popup" | "select_music" | "preview" | "publish";
    previewId?: string;
  }): Promise<{
    observation: Omit<Observation, "screenshotBase64"> & {
      screenshotIncluded: false;
      elapsedMs: number;
    };
    clickedPoint: { x: number; y: number; xRatio: number; yRatio: number };
    target: NonNullable<ManualPointInspection["target"]>;
    decision: ReturnType<typeof classifyManualTarget>;
    effect: ReturnType<typeof decideManualRetry>;
    mutatingRequestCount: number;
    mutatingResponseCount: number;
    backgroundRequestCount: number;
    backgroundResponseCount: number;
    urlChanged: boolean;
    domChanged: boolean;
    actionReadback: Record<string, unknown>;
  }> {
    return this.serial(async () => {
      const { page, snapshot } = await this.requireObservationSnapshot(options);
      assertWriteReady();
      const elementMode = typeof options.elementId === "string";
      const coordinateMode = options.xRatio != null || options.yRatio != null;
      if (elementMode === coordinateMode) {
        throw appError({
          code: "MANUAL_TARGET_MODE_INVALID",
          message: "必须且只能选择 element_id 或一组 x_ratio/y_ratio。",
          sideEffectStage: "before_click",
        });
      }

      let x = 0;
      let y = 0;
      let observedElement: InteractiveElement | null = null;
      if (elementMode) {
        observedElement = snapshot.elements.get(options.elementId!) ?? null;
        if (!observedElement) {
          throw appError({
            code: "MANUAL_TARGET_STALE",
            message: `观察快照中没有元素 ${options.elementId}。请重新观察。`,
            retryable: true,
            sideEffectStage: "before_click",
          });
        }
        const locator = await this.resolveObservedElement(
          page,
          options.elementId!,
          snapshot.fingerprints.get(options.elementId!),
        );
        const box = await locator?.boundingBox().catch(() => null);
        if (!locator || !box || box.width <= 0 || box.height <= 0) {
          throw appError({
            code: "MANUAL_TARGET_STALE",
            message: "目标元素已经失效或没有可点击区域。请重新观察。",
            retryable: true,
            sideEffectStage: "before_click",
          });
        }
        const point = pointInsideBox({
          box,
          offsetX: options.offsetX,
          offsetY: options.offsetY,
        });
        x = point.x;
        y = point.y;
      } else {
        if (options.xRatio == null || options.yRatio == null) {
          throw appError({
            code: "MANUAL_COORDINATES_INCOMPLETE",
            message: "坐标模式必须同时提供 x_ratio 和 y_ratio。",
            sideEffectStage: "before_click",
          });
        }
        const viewport = await page.evaluate(() => ({
          width: Math.max(1, innerWidth),
          height: Math.max(1, innerHeight),
        }));
        x = Math.min(viewport.width - 1, Math.max(0, viewport.width * options.xRatio));
        y = Math.min(viewport.height - 1, Math.max(0, viewport.height * options.yRatio));
      }

      const inspection = await this.inspectVisualPoint(page, x, y);
      if (!inspection.target) {
        throw appError({
          code: "MANUAL_POINT_NOT_INTERACTIVE",
          message: "该位置没有检测到可交互目标。请先探测附近位置。",
          retryable: true,
          sideEffectStage: "before_click",
        });
      }
      if (observedElement) {
        const observedLabel = observedElement.label.replace(/\s+/g, " ").trim();
        const actualLabel = inspection.target.label.replace(/\s+/g, " ").trim();
        if ((observedElement.href || inspection.target.href)
          && observedElement.href !== inspection.target.href) {
          throw appError({
            code: "MANUAL_TARGET_STALE",
            message: "落点覆盖的链接已不是观察时的目标。请重新观察。",
            retryable: true,
            sideEffectStage: "before_click",
          });
        }
        if (observedLabel && actualLabel
          && observedLabel !== actualLabel
          && !observedLabel.includes(actualLabel)
          && !actualLabel.includes(observedLabel)) {
          throw appError({
            code: "MANUAL_TARGET_OCCLUDED",
            message: "落点当前被另一个交互控件覆盖。请重新探测或调整落点。",
            retryable: true,
            sideEffectStage: "before_click",
            safeDetails: { observedLabel, actualLabel },
          });
        }
      }

      const decision = classifyManualTarget(inspection.target);
      const publisherOnlyAction = options.writeAction !== "interface";
      if (publisherOnlyAction && snapshot.pageId !== "page-publisher") {
        throw appError({
          code: "MANUAL_PUBLISHER_PAGE_REQUIRED",
          message: "音乐、预览和发布视觉动作只允许在已绑定的 page-publisher 上执行。",
          sideEffectStage: "before_click",
        });
      }
      const targetText = `${inspection.target.label} ${inspection.target.contextText ?? ""} ${inspection.target.className}`;
      const actionMatches = options.writeAction === "interface"
        ? decision.risk === "interface" && !decision.requiresDedicatedWorkflow
        : options.writeAction === "close_popup"
          ? /关闭|取消|close|sidesheet-close/i.test(targetText)
          : options.writeAction === "select_music"
            ? /选择音乐|修改音乐|使用|确定/.test(targetText)
            : options.writeAction === "preview"
              ? /预览/.test(inspection.target.label)
              : inspection.target.label.trim() === "发布";
      const actionAllowed = actionMatches
        || (options.writeAction === "select_music"
          && inspection.target.interactionSource === "music_candidate_ancestor");
      if (!actionAllowed) {
        throw appError({
          code: "MANUAL_WRITE_ACTION_MISMATCH",
          message: `现场目标与声明的 ${options.writeAction} 写动作不匹配，未点击。`,
          sideEffectStage: "before_click",
          safeDetails: { risk: decision.risk, reason: decision.reason },
        });
      }
      if (options.writeAction === "publish") {
        if (!options.previewId) {
          throw appError({
            code: "SNAPSHOT_REQUIRED",
            message: "视觉点击发布必须提供 preview_id。",
            sideEffectStage: "before_click",
          });
        }
        await this.assertOperatorAccount(page);
        await verifyTextPreviewSnapshot(page, options.previewId, {
          pageId: snapshot.pageId,
          targetId: snapshot.pageTargetId,
          account: loadActionSettings().operator.displayName,
        });
        markTextPreviewSubmitAttempted(options.previewId);
      } else if (options.writeAction === "select_music"
        && decision.risk !== "account" && decision.risk !== "interface") {
        throw appError({
          code: "MANUAL_ACTION_PREPARE_REQUIRED",
          message: "音乐目标没有被现场语义确认为音乐界面写操作，未点击。",
          sideEffectStage: "before_click",
        });
      } else if (options.writeAction === "close_popup" && decision.risk !== "interface") {
        throw appError({
          code: "MANUAL_ACTION_PREPARE_REQUIRED",
          message: "关闭目标没有被现场语义确认为可逆界面操作，未点击。",
          sideEffectStage: "before_click",
        });
      }
      if (inspection.target.href) assertAllowedUrl(inspection.target.href);

      const beforeUrl = page.url();
      const beforeState = await page.evaluate(() => ({
        title: document.title,
        text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 8_000),
        elementCount: document.querySelectorAll("*").length,
      }));
      const beforeToastCount = await page.locator(
        "[role='alert']:visible,[class*='toast']:visible,[class*='message']:visible",
      ).count().catch(() => 0);
      const mutatingRequests: string[] = [];
      const mutatingResponses: string[] = [];
      const backgroundRequests: string[] = [];
      const backgroundResponses: string[] = [];
      const onRequest = (request: { method(): string; url(): string }) => {
        const signal = classifyManualNetworkSignal({
          method: request.method(),
          url: request.url(),
        });
        if (signal === "mutation") mutatingRequests.push(request.url());
        else if (signal === "background") backgroundRequests.push(request.url());
      };
      const onResponse = (response: PlaywrightResponse) => {
        const signal = classifyManualNetworkSignal({
          method: response.request().method(),
          url: response.url(),
        });
        if (signal === "mutation") mutatingResponses.push(response.url());
        else if (signal === "background") backgroundResponses.push(response.url());
      };
      page.on("request", onRequest);
      page.on("response", onResponse);
      let clickError: unknown = null;
      try {
        await page.mouse.click(x, y);
        await page.waitForTimeout(700);
      } catch (error) {
        clickError = error;
      } finally {
        page.off("request", onRequest);
        page.off("response", onResponse);
      }
      if (clickError) {
        throw appError({
          code: "MANUAL_CLICK_FAILED",
          message: `视觉点击没有完成：${String(clickError)}`,
          retryable: false,
          sideEffectStage: "click_attempted",
          safeDetails: {
            mutatingRequestCount: mutatingRequests.length,
            mutatingResponseCount: mutatingResponses.length,
            backgroundRequestCount: backgroundRequests.length,
            backgroundResponseCount: backgroundResponses.length,
          },
          cause: clickError,
        });
      }

      try {
        assertAllowedUrl(page.url());
      } catch (error) {
        throw appError({
          code: "MANUAL_RESULT_OUT_OF_SCOPE",
          message: "点击后页面进入了通用视觉线不允许继续操作的区域，已停止。",
          retryable: false,
          sideEffectStage: "possible_side_effect",
          cause: error,
        });
      }
      const afterState = await page.evaluate(() => ({
        title: document.title,
        text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 8_000),
        elementCount: document.querySelectorAll("*").length,
      }));
      const afterToastCount = await page.locator(
        "[role='alert']:visible,[class*='toast']:visible,[class*='message']:visible",
      ).count().catch(() => beforeToastCount);
      const afterInspection = await this.inspectVisualPoint(page, x, y).catch(() => null);
      const urlChanged = page.url() !== beforeUrl;
      const domChanged = sha256(JSON.stringify(beforeState))
        !== sha256(JSON.stringify(afterState));
      const targetStillPresent = Boolean(afterInspection?.target
        && afterInspection.target.kind === inspection.target.kind
        && (!inspection.target.href || afterInspection.target.href === inspection.target.href)
        && (!inspection.target.label
          || afterInspection.target.label === inspection.target.label));
      const effect = decideManualRetry({
        requestSignalCount: mutatingRequests.length,
        responseSignalCount: mutatingResponses.length,
        toastCount: Math.max(0, afterToastCount - beforeToastCount),
        urlChanged,
        domChanged,
        composerCleared: false,
        loadingTransition: false,
        disabledTransition: false,
        targetStillPresent,
      });
      let actionReadback: Record<string, unknown> = {
        action: options.writeAction,
        status: effect.effect === "no_effect" ? "no_effect" : "uncertain",
      };
      if (options.writeAction === "interface") {
        actionReadback = {
          action: options.writeAction,
          status: effect.effect === "state_changed"
            ? "confirmed"
            : effect.effect === "no_effect"
              ? "no_effect"
              : "uncertain",
          retry_allowed: effect.retryAllowed,
          url_changed: urlChanged,
          dom_changed: domChanged,
          mutating_request_count: mutatingRequests.length,
          background_request_count: backgroundRequests.length,
        };
      } else if (options.writeAction === "close_popup") {
        const closed = !await isPostMusicPickerOpen(page);
        actionReadback = {
          action: options.writeAction,
          status: closed ? "confirmed" : "uncertain",
          closed,
        };
      } else if (options.writeAction === "select_music") {
        const selectedMusic = await readSelectedPostMusic(page);
        actionReadback = {
          action: options.writeAction,
          status: selectedMusic ? "confirmed" : "uncertain",
          selectedMusic,
        };
      } else if (options.writeAction === "preview") {
        const locked = await lockCurrentTextPreview(page, {
          pageId: snapshot.pageId,
          targetId: snapshot.pageTargetId,
          account: loadActionSettings().operator.displayName,
        });
        actionReadback = {
          action: options.writeAction,
          status: "confirmed",
          preview_id: locked.previewId,
        };
      } else {
        actionReadback = {
          action: options.writeAction,
          status: "uncertain",
          preview_id: options.previewId,
          retry_allowed: false,
          next_step: "douyin_verify_text_publish",
        };
      }
      const observation = {
        ...(await this.observeFast(snapshot.pageId, options.ownerId)),
        note: `已按视觉目标执行一次界面点击：${options.intent}`,
      };
      log("manual_visual_interface_click", {
        pageId: snapshot.pageId,
        label: inspection.target.label,
        intent: options.intent.slice(0, 160),
        risk: decision.risk,
        effect: effect.effect,
        mutatingRequestCount: mutatingRequests.length,
        backgroundRequestCount: backgroundRequests.length,
        urlChanged,
        domChanged,
      });
      return {
        observation,
        clickedPoint: inspection.point,
        target: inspection.target,
        decision,
        effect,
        mutatingRequestCount: mutatingRequests.length,
        mutatingResponseCount: mutatingResponses.length,
        backgroundRequestCount: backgroundRequests.length,
        backgroundResponseCount: backgroundResponses.length,
        urlChanged,
        domChanged,
        actionReadback,
      };
    }, { restoreOnError: false, persistPageState: false });
  }
  async clickElement(options: {
    ownerId: string;
    observationId: string;
    snapshotHash: string;
    elementId: string;
  }): Promise<Observation> {
    return this.serial(async () => {
      const { page, snapshot } = await this.requireObservationSnapshot(options);
      const { elementId } = options;
      const element = snapshot.elements.get(elementId);
      if (!element) throw new Error(`找不到元素 ${elementId}。请先重新调用 douyin_observe 获取最新编号。`);
      assertSafeElement(element, page.url());

      const linkedWorkId = element.href ? workIdFromUrl(element.href) : null;
      if (element.href) {
        const target = linkedWorkId
          ? assertDouyinWorkUrl(element.href).toString()
          : assertAllowedUrl(element.href).toString();
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(CONFIG.actionDelayMs + 300);
        if (linkedWorkId && workIdFromUrl(page.url()) !== linkedWorkId) {
          throw new Error("作品上下文已切换，已停止读取，避免把不同作品内容混在一起。");
        }
      } else {
        const locator = await this.resolveObservedElement(
          page,
          elementId,
          snapshot.fingerprints.get(elementId),
        );
        if (!locator) {
          throw new Error(`元素 ${elementId} 已失效，且无法通过 href/label/role/data-e2e 指纹唯一重定位。`);
        }
        await locator.scrollIntoViewIfNeeded({ timeout: 4_000 });
        await locator.click({ timeout: 6_000 });
      }
      await sleep(CONFIG.actionDelayMs);

      const activePage = await this.currentPage();
      assertAllowedUrl(activePage.url());
      log("click", { elementId, label: element.label, href: element.href, url: activePage.url() });
      return this.observeUnlocked(`已点击 ${elementId}：${element.label}`);
    });
  }

  async togglePlay(): Promise<Observation> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const media = await this.lockedMediaData(page, context);
      if (media.videoIndex < 0) throw new Error("当前活跃作品区域没有找到对应视频。");
      const video = page.locator("video").nth(media.videoIndex);
      const changed = await video.evaluate(async element => {
        const target = element as HTMLVideoElement;
        if (target.paused) {
          await target.play();
          return "已播放";
        }
        target.pause();
        return "已暂停";
      });
      await this.assertWorkContext(page, context);
      await sleep(350);
      log("toggle_play", { changed, url: page.url(), workId: context.workId });
      return this.observeUnlocked(changed);
    });
  }

  async back(preferEscape: boolean): Promise<Observation> {
    return this.serial(async () => {
      const page = await this.currentPage();
      if (preferEscape) {
        await page.keyboard.press("Escape");
        await sleep(500);
      } else {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => null);
        await sleep(CONFIG.actionDelayMs);
      }
      const activePage = await this.currentPage();
      assertAllowedUrl(activePage.url());
      log("back", { preferEscape, url: activePage.url() });
      return this.observeUnlocked(preferEscape ? "已按 Escape 关闭浮层。" : "已返回上一页。");
    });
  }

  async wait(options: {
    seconds: number;
    ownerId: string;
    pageId?: string;
    observationId?: string;
    snapshotHash?: string;
    responseMode?: "fast" | "full";
  }): Promise<Observation | (Omit<Observation, "screenshotBase64"> & {
    screenshotIncluded: false;
    elapsedMs: number;
  })> {
    return this.serial(async () => {
      const hasObservationAnchor = Boolean(options.observationId || options.snapshotHash);
      if (hasObservationAnchor && (!options.observationId || !options.snapshotHash)) {
        throw new Error("PAGE_ANCHOR_INCOMPLETE:observation_id 与 snapshot_hash 必须同时提供。");
      }
      if (options.pageId && hasObservationAnchor) {
        throw new Error("PAGE_ANCHOR_AMBIGUOUS:page_id 与 observation 快照只能选择一种。");
      }
      if (!options.pageId && !hasObservationAnchor) {
        throw new Error("PAGE_ANCHOR_REQUIRED:等待后回读必须提供 page_id，或提供 observation_id + snapshot_hash。");
      }
      const anchored = hasObservationAnchor
        ? await this.requireObservationSnapshot({
          ownerId: options.ownerId,
          observationId: options.observationId!,
          snapshotHash: options.snapshotHash!,
        })
        : null;
      const page = anchored?.page ?? await this.resolveAllowedPageReference(options.pageId!);
      if (!page || page.isClosed()) {
        throw new Error("PAGE_BINDING_LOST:指定页面不存在或已经关闭。");
      }
      const boundPageId = this.pageId(page);
      const boundTargetId = await this.pageTargetId(page);
      const boundUrl = page.url();
      const duration = Math.min(8, Math.max(0.5, options.seconds));
      await sleep(duration * 1000);
      if (page.isClosed()
        || await this.pageTargetId(page) !== boundTargetId
        || page.url() !== boundUrl) {
        throw new Error("PAGE_CONTEXT_CHANGED:等待期间原页面身份或 URL 已变化。请重新观察目标页。");
      }
      log("wait", { pageId: boundPageId, url: boundUrl, seconds: duration });
      const note = `已在 ${boundPageId} 等待 ${duration} 秒。`;
      return options.responseMode === "full"
        ? this.observeBoundPageUnlocked(page, options.ownerId, note)
        : this.observeBoundPageFastUnlocked(page, options.ownerId, note);
    });
  }

  async videoFrames(frameCount: number, intervalMs: number): Promise<{
    observation: Observation;
    frames: string[];
    visibleText: string;
    workId: string;
    textSource: string;
    characterCount: number;
    truncated: boolean;
  }> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const count = Math.min(6, Math.max(2, Math.round(frameCount)));
      const interval = Math.min(2500, Math.max(600, Math.round(intervalMs)));
      const media = await this.lockedMediaData(page, context, 3_000);
      if (media.videoIndex < 0) throw new Error("当前活跃作品区域没有找到对应视频。");
      const video = page.locator("video").nth(media.videoIndex);
      await video.evaluate(async element => {
        const target = element as HTMLVideoElement;
        try {
          if (target.paused) await target.play();
        } catch {
          // Autoplay may be blocked; frames are still useful.
        }
      });
      const frames: string[] = [];
      for (let index = 0; index < count; index += 1) {
        await this.assertWorkContext(page, context);
        const buffer = await video.screenshot({
          type: "jpeg",
          quality: CONFIG.screenshotQuality,
          animations: "allow",
          caret: "hide",
          timeout: 10_000,
        });
        frames.push(buffer.toString("base64"));
        if (index < count - 1) await sleep(interval);
      }
      await this.assertWorkContext(page, context);
      log("video_frames", { count, interval, url: page.url(), workId: context.workId });
      const observation = await this.observeUnlocked(`已采样当前视频 ${count} 帧，间隔 ${interval}ms。`);
      return {
        observation,
        frames,
        visibleText: media.visibleText,
        workId: context.workId,
        textSource: media.textSource,
        characterCount: media.characterCount,
        truncated: media.truncated,
      };
    });
  }

  async inspectTimeline(options: { mode?: "fast" | "balanced" | "full" } = {}): Promise<TimelineInspectionResult> {
    return this.serial(async () => {
      const mode = options.mode ?? "fast";
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const media = await this.lockedMediaData(page, context, 3_000);
      if (media.durationSeconds == null || media.durationSeconds <= 0) {
        throw new Error("当前活跃作品视频时长不可用，无法执行完整时间轴抽帧。");
      }
      const durationSeconds = media.durationSeconds;
      if (media.videoIndex < 0) throw new Error("当前活跃作品区域没有找到对应视频。");
      const video = page.locator("video").nth(media.videoIndex);
      const original = await video.evaluate(element => {
        const target = element as HTMLVideoElement;
        return {
          currentTime: target.currentTime,
          paused: target.paused,
          muted: target.muted,
        };
      });
      if (mode === "fast") {
        const buffer = await video.screenshot({
          type: "jpeg",
          quality: Math.min(CONFIG.screenshotQuality, 52),
          animations: "disabled",
          caret: "hide",
          timeout: 10_000,
        });
        const sampledTime = Number(original.currentTime.toFixed(3));
        const output: TimelineInspectionResult = {
          url: page.url(),
          title: await page.title(),
          workId: context.workId,
          duration: durationSeconds,
          sampledTimes: [sampledTime],
          frames: [{
            timeSeconds: sampledTime,
            timestamp: formatTimestamp(sampledTime),
            imageBase64: buffer.toString("base64"),
          }],
          restoredState: {
            currentTime: sampledTime,
            paused: original.paused,
            muted: original.muted,
          },
          visibleText: media.visibleText,
          textSource: media.textSource,
          characterCount: media.characterCount,
          truncated: media.truncated,
        };
        log("inspect_timeline", {
          mode,
          workId: context.workId,
          duration: output.duration,
          sampledTimes: output.sampledTimes,
          restored: output.restoredState,
        });
        return output;
      }
      const sampledTimes: number[] = [];
      const frames: TimelineInspectionResult["frames"] = [];
      try {
        const requestedTimes = mode === "full"
          ? timelineSampleTimes(durationSeconds)
          : [0.08, 0.5, 0.92].map(ratio =>
              Math.max(0, Math.min(durationSeconds - 0.1, durationSeconds * ratio)));
        for (const requestedTime of requestedTimes) {
          await this.assertWorkContext(page, context);
          const actualTime = await video.evaluate(async (element, targetTime) => {
            const target = element as HTMLVideoElement;
            const waitForMedia = () => new Promise<void>((resolve, reject) => {
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                target.removeEventListener("seeked", finish);
                target.removeEventListener("loadeddata", finish);
                clearTimeout(timeout);
                resolve();
              };
              const timeout = window.setTimeout(() => {
                if (finished) return;
                finished = true;
                target.removeEventListener("seeked", finish);
                target.removeEventListener("loadeddata", finish);
                reject(new Error(`seek-timeout:${targetTime}`));
              }, 5_000);
              target.addEventListener("seeked", finish, { once: true });
              target.addEventListener("loadeddata", finish, { once: true });
              target.currentTime = Math.max(0, Math.min(target.duration || targetTime, targetTime));
              if (Math.abs(target.currentTime - targetTime) < 0.05 && target.readyState >= 2) {
                window.setTimeout(finish, 80);
              }
            });
            await waitForMedia();
            return target.currentTime;
          }, requestedTime);
          await sleep(mode === "full" ? 120 : 40);
          await this.assertWorkContext(page, context);
          const buffer = await video.screenshot({
            type: "jpeg",
            quality: mode === "full" ? CONFIG.screenshotQuality : Math.min(CONFIG.screenshotQuality, 52),
            animations: "disabled",
            caret: "hide",
            timeout: 10_000,
          });
          sampledTimes.push(Number(actualTime.toFixed(3)));
          frames.push({
            timeSeconds: Number(actualTime.toFixed(3)),
            timestamp: formatTimestamp(actualTime),
            imageBase64: buffer.toString("base64"),
          });
        }
      } finally {
        await video.evaluate(async (element, state) => {
          const target = element as HTMLVideoElement;
          target.muted = state.muted;
          target.currentTime = state.currentTime;
          await new Promise<void>(resolve => {
            const done = () => resolve();
            target.addEventListener("seeked", done, { once: true });
            setTimeout(done, 2_000);
          });
          if (state.paused) {
            target.pause();
          } else {
            await target.play().catch(() => undefined);
          }
        }, original).catch(() => null);
      }
      await this.assertWorkContext(page, context);
      const restored = await video.evaluate(element => {
        const target = element as HTMLVideoElement;
        return { currentTime: target.currentTime, paused: target.paused, muted: target.muted };
      });
      const output: TimelineInspectionResult = {
        url: page.url(),
        title: await page.title(),
        workId: context.workId,
        duration: media.durationSeconds,
        sampledTimes,
        frames,
        restoredState: {
          currentTime: Number(restored.currentTime.toFixed(3)),
          paused: restored.paused,
          muted: restored.muted,
        },
        visibleText: media.visibleText,
        textSource: media.textSource,
        characterCount: media.characterCount,
        truncated: media.truncated,
      };
      log("inspect_timeline", {
        mode,
        workId: context.workId,
        duration: output.duration,
        sampledTimes,
        restored: output.restoredState,
      });
      return output;
    });
  }


  async openLink(rawUrl: string): Promise<Observation> {
    return this.serial(async () => {
      const page = await this.rolePage("codex_test", "https://www.douyin.com/");
      const target = assertAllowedUrl(rawUrl).toString();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(CONFIG.actionDelayMs + 500);
      assertAllowedUrl(page.url());
      await page.bringToFront();
      this.activePageId = this.pageId(page);
      log("open_link", { input: rawUrl, url: page.url() });
      return this.observeUnlocked("已打开提供的抖音分享链接。短链接如发生跳转，当前网址已更新为最终页面。");
    });
  }

  async extractArticleText(): Promise<ArticleTextResult> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      if (!/\/(?:article|note)\//.test(page.url())) {
        throw new Error(ARTICLE_PRIVACY_ERROR);
      }
      const scan = await page.evaluate((expectedWorkId: string) => {
        const clean = (value: string | null | undefined) => (value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const headingKey = (value: string) => clean(value).toLocaleLowerCase()
          .replace(/[\s\-—–_:：·•#"'“”‘’()（）[\]【】]/g, "");
        const forbiddenTokenPattern =
          /(?:^|[\s_-])(?:sidebar|aside|recommend(?:ed|ation)?|related|message|chat|comment|footer|nav)(?:$|[\s_-])/i;
        const forbiddenLabelPattern =
          /^(?:推荐视频|推荐内容|评论|全部评论|大家都在搜)(?:\s|[:：]|$)/;
        const isForbiddenRegion = (element: HTMLElement): boolean => {
          if (["NAV", "ASIDE", "FOOTER"].includes(element.tagName)) return true;
          const semanticTokens = [
            element.id,
            element.className,
            element.getAttribute("role"),
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-e2e"),
          ].filter(value => typeof value === "string").join(" ");
          if (forbiddenTokenPattern.test(semanticTokens)) return true;
          const text = clean(element.innerText || element.textContent || "");
          return text.length <= 240 && forbiddenLabelPattern.test(text);
        };
        const hasForbiddenAncestor = (element: HTMLElement, root: HTMLElement): number => {
          let count = 0;
          let cursor: HTMLElement | null = element;
          while (cursor) {
            if (isForbiddenRegion(cursor)) count += 1;
            if (cursor === root) break;
            cursor = cursor.parentElement;
          }
          return count;
        };
        const safeText = (element: HTMLElement) => {
          const clone = element.cloneNode(true) as HTMLElement;
          const fixedExcluded = Array.from(clone.querySelectorAll<HTMLElement>([
            "script", "style", "nav", "aside", "footer", "header", "button", "input", "textarea",
            "video", "xg-player", "[contenteditable='true']", "[role='menu']", "[role='dialog']",
            "[class*='comment']", "[class*='Comment']", "[class*='recommend']", "[class*='Recommend']",
            "[class*='sidebar']", "[class*='Sidebar']", "[class*='message']", "[class*='Message']",
            "[class*='chat']", "[class*='Chat']", "[class*='account']", "[class*='Account']",
            "[class*='footer']", "[class*='Footer']", "[class*='search']", "[class*='Search']",
            "[class*='related']", "[class*='Related']",
          ].join(",")));
          const semanticExcluded = Array.from(clone.querySelectorAll<HTMLElement>("*"))
            .filter(node => isForbiddenRegion(node));
          [...new Set([...fixedExcluded, ...semanticExcluded])]
            .sort((a, b) => {
              const depth = (node: Element) => {
                let value = 0;
                let cursor: Element | null = node;
                while (cursor.parentElement) {
                  value += 1;
                  cursor = cursor.parentElement;
                }
                return value;
              };
              return depth(b) - depth(a);
            })
            .forEach(node => node.remove());
          return clean(clone.innerText || clone.textContent || "");
        };
        const recommendationStructure = (text: string) => {
          const durations = (text.match(/\b\d{1,2}:\d{2}\b/g) ?? []).length;
          const playing = (text.match(/播放中/g) ?? []).length;
          return {
            durations,
            playing,
            looksLikeRecommendation: playing > 0
              || (durations >= 2 && /(?:推荐|点赞|获赞|作者)/.test(text)),
          };
        };
        const sourceSelector = (element: HTMLElement) => {
          const classes = Array.from(element.classList)
            .filter(className => className.length <= 60 && !forbiddenTokenPattern.test(className))
            .slice(0, 2)
            .map(className => `.${className.replace(/[^a-zA-Z0-9_-]/g, "")}`)
            .join("");
          return `title-linked-article-root > ${element.tagName.toLowerCase()}${classes || "[paragraph-cluster]"}`;
        };
        const countExcludedRegions = (root: HTMLElement) => {
          const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
          const excluded = all.filter(node => {
            if (isForbiddenRegion(node)) return true;
            const text = clean(node.innerText || node.textContent || "");
            return text.length <= 4_000 && recommendationStructure(text).looksLikeRecommendation;
          });
          return excluded.filter(node =>
            !excluded.some(parent => parent !== node && parent.contains(node))).length;
        };
        const currentId = new URL(location.href).searchParams.get("modal_id")
          ?? location.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? null;
        const pageTitle = clean(document.title.replace(/\s*-\s*抖音\s*$/, ""));
        const titleCore = clean(pageTitle.split("#")[0]);
        const titleKey = headingKey(titleCore);
        const titleElements = Array.from(document.querySelectorAll<HTMLElement>(
          "h1,h2,h3,[role='heading'],div",
        )).map(element => {
          const rect = element.getBoundingClientRect();
          if (rect.width < 240 || rect.height <= 0 || rect.height > 160) return null;
          const text = clean(element.innerText || element.textContent || "");
          if (text.length < 4 || text.length > titleCore.length + 40) return null;
          const matched = headingKey(text) === titleKey;
          if (!matched || hasForbiddenAncestor(element, document.body) > 0) return null;
          return {
            element,
            score: (["H1", "H2", "H3"].includes(element.tagName) ? 100 : 0)
              + (text === titleCore ? 50 : 0)
              - Math.abs(text.length - titleCore.length),
          };
        }).filter((item): item is { element: HTMLElement; score: number } => Boolean(item))
          .sort((a, b) => b.score - a.score);
        const candidates: Array<{
          text: string;
          sourceSelector: string;
          headingMatched: boolean;
          sameArticleRoot: boolean;
          titlePrecedesCandidate: boolean;
          paragraphCount: number;
          naturalParagraphCount: number;
          paragraphTextRatio: number;
          forbiddenAncestorCount: number;
          excludedRegionCount: number;
          recommendationDurationCount: number;
          recommendationPlaybackCount: number;
          depth: number;
        }> = [];
        for (const titleItem of titleElements.slice(0, 5)) {
          const roots: HTMLElement[] = [];
          let rootCursor = titleItem.element.parentElement;
          for (let level = 0; rootCursor && rootCursor !== document.body && level < 9; level += 1) {
            const rect = rootCursor.getBoundingClientRect();
            if (rect.width >= 400
              && rootCursor.querySelectorAll("p,h2,h3,h4,h5,blockquote").length >= 3
              && !isForbiddenRegion(rootCursor)) {
              roots.push(rootCursor);
            }
            rootCursor = rootCursor.parentElement;
          }
          for (const root of roots) {
            const excludedRegionCount = countExcludedRegions(root);
            for (const node of Array.from(root.querySelectorAll<HTMLElement>("article,section,div"))) {
              if (node === root || node.contains(titleItem.element)) continue;
              const rect = node.getBoundingClientRect();
              if (rect.width < 380 || rect.height < 80) continue;
              const forbiddenAncestorCount = hasForbiddenAncestor(node, root);
              if (forbiddenAncestorCount > 0) continue;
              const text = safeText(node);
              if (text.length < 300 || text.length > 50_000) continue;
              const paragraphs = Array.from(node.querySelectorAll<HTMLElement>("p,h2,h3,h4,h5,blockquote"))
                .filter(paragraph => hasForbiddenAncestor(paragraph, node) === 0)
                .map(paragraph => clean(paragraph.innerText || paragraph.textContent || ""))
                .filter(Boolean);
              const paragraphCount = paragraphs.length;
              const naturalParagraphCount = paragraphs.filter(paragraph =>
                paragraph.length >= 20
                && /[\p{Script=Han}A-Za-z]/u.test(paragraph)
                && /[。！？.!?，,:：；;]/u.test(paragraph)).length;
              const paragraphCharacters = paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
              const structure = recommendationStructure(text);
              let depth = 0;
              let depthCursor: HTMLElement | null = node;
              while (depthCursor && depthCursor !== root) {
                depth += 1;
                depthCursor = depthCursor.parentElement;
              }
              candidates.push({
                text,
                sourceSelector: sourceSelector(node),
                headingMatched: true,
                sameArticleRoot: root.contains(titleItem.element) && root.contains(node),
                titlePrecedesCandidate: Boolean(
                  titleItem.element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
                ),
                paragraphCount,
                naturalParagraphCount,
                paragraphTextRatio: text.length > 0 ? paragraphCharacters / text.length : 0,
                forbiddenAncestorCount,
                excludedRegionCount,
                recommendationDurationCount: structure.durations,
                recommendationPlaybackCount: structure.playing,
                depth,
              });
            }
          }
        }
        const metaDescription = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "";
        return {
          title: titleCore || pageTitle,
          metaDescription,
          currentId,
          candidates: candidates.slice(0, 80),
        };
      }, context.workId);
      if (scan.currentId !== context.workId) {
        throw new Error(ARTICLE_PRIVACY_ERROR);
      }
      const selected = selectTrustedArticleCandidate(scan.candidates);
      if (!selected) throw new Error(ARTICLE_PRIVACY_ERROR);
      await this.assertWorkContext(page, context);
      const filtered = filterPrivateUiText(selected.text, 50_000);
      if (filtered.characterCount < 300) throw new Error(ARTICLE_PRIVACY_ERROR);
      const metadata = parseDouyinMetaDescription(scan.metaDescription);
      log("extract_article", {
        url: page.url(),
        workId: context.workId,
        chars: filtered.characterCount,
        source: selected.sourceSelector,
        paragraphCount: selected.paragraphCount,
        excludedRegionCount: selected.excludedRegionCount,
      });
      return {
        url: page.url(),
        title: scan.title,
        author: metadata.author,
        publishedAt: metadata.publishedAt,
        workId: context.workId,
        text: filtered.text,
        characterCount: filtered.characterCount,
        sourceSelector: selected.sourceSelector,
        sourceType: "title-linked-article-root",
        headingMatched: true,
        excludedRegionCount: selected.excludedRegionCount,
        paragraphCount: selected.paragraphCount,
        privacyFiltered: true,
      };
    });
  }

  async probeMedia(): Promise<MediaProbe> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const data = await this.lockedMediaData(page, context, 3_000);
      const chapters = parseNativeChapters(data.chapterText).chapters;
      const galleryImageCount = await page.evaluate((expectedWorkId: string) => {
        for (const script of Array.from(document.scripts)) {
          const raw = script.textContent ?? "";
          if (!raw.includes(expectedWorkId)) continue;
          try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            const detail = parsed?.app?.videoDetail;
            if (String(detail?.awemeId ?? "") === expectedWorkId && Array.isArray(detail.images)) {
              return detail.images.length;
            }
          } catch {
            // React server-component payloads are handled below.
          }
          if (raw.startsWith("self.__pace_f.push(") && raw.includes(`\\"awemeId\\":\\"${expectedWorkId}`)) {
            try {
              const outer = JSON.parse(raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")));
              const payload = outer?.[1];
              if (typeof payload !== "string") continue;
              const inner = JSON.parse(payload.slice(payload.indexOf(":") + 1));
              const detail = inner?.[3]?.aweme?.detail;
              if (String(detail?.awemeId ?? "") === expectedWorkId && Array.isArray(detail.images)) {
                return detail.images.length;
              }
            } catch {
              continue;
            }
          }
        }
        return 0;
      }, context.workId);
      const probe: MediaProbe = {
        url: page.url(),
        title: await page.title(),
        workId: context.workId,
        durationSeconds: data.durationSeconds,
        currentTimeSeconds: data.currentTimeSeconds,
        paused: data.paused,
        mediaCandidates: data.mediaCandidates,
        visibleText: data.visibleText,
        textSource: data.textSource,
        characterCount: data.characterCount,
        truncated: data.truncated,
        chaptersAvailable: chapters.length >= 2,
        chapterCount: chapters.length,
        galleryAvailable: galleryImageCount > 0,
        galleryImageCount,
      };
      log("probe_media", {
        workId: context.workId,
        duration: probe.durationSeconds,
        candidates: probe.mediaCandidates.length,
        chapters: probe.chapterCount,
        galleryImages: probe.galleryImageCount,
      });
      return probe;
    });
  }

  async readCurrentGallery(maxImages = 10): Promise<DouyinGalleryResult> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const limit = Math.max(1, Math.min(20, Math.floor(maxImages)));
      const metadata = await page.evaluate((expectedWorkId: string) => {
        const scripts = Array.from(document.scripts);
        for (const script of scripts) {
          const raw = script.textContent ?? "";
          if (!raw.includes(expectedWorkId)) continue;
          let detail: any = null;
          try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            const candidate = parsed?.app?.videoDetail;
            if (String(candidate?.awemeId ?? "") === expectedWorkId) detail = candidate;
          } catch {
            // React server-component payloads are handled below.
          }
          if (!detail && raw.startsWith("self.__pace_f.push(")
            && raw.includes(`\\"awemeId\\":\\"${expectedWorkId}`)) {
            try {
              const outer = JSON.parse(raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")));
              const payload = outer?.[1];
              if (typeof payload === "string") {
                const inner = JSON.parse(payload.slice(payload.indexOf(":") + 1));
                const candidate = inner?.[3]?.aweme?.detail;
                if (String(candidate?.awemeId ?? "") === expectedWorkId) detail = candidate;
              }
            } catch {
              detail = null;
            }
          }
          if (!detail || String(detail.awemeId ?? "") !== expectedWorkId) continue;
          const seen = new Set<string>();
          const images = (Array.isArray(detail.images) ? detail.images : [])
            .map((image: any) => {
              const candidates = [
                ...(Array.isArray(image?.urlList) ? image.urlList : []),
                ...(Array.isArray(image?.downloadUrlList) ? image.downloadUrlList : []),
              ].filter((value: unknown): value is string => typeof value === "string" && /^https:\/\//i.test(value));
              const url = candidates[0] ?? "";
              const key = String(image?.uri ?? "") || (() => {
                try {
                  return new URL(url).pathname;
                } catch {
                  return url;
                }
              })();
              return {
                key,
                url,
                width: Number.isFinite(Number(image?.width)) ? Number(image.width) : null,
                height: Number.isFinite(Number(image?.height)) ? Number(image.height) : null,
              };
            })
            .filter((image: { key: string; url: string }) => {
              if (!image.url || !image.key || seen.has(image.key)) return false;
              seen.add(image.key);
              return true;
            });
          const hashtags = (Array.isArray(detail.textExtra) ? detail.textExtra : [])
            .map((item: any) => typeof item?.hashtagName === "string" ? item.hashtagName.trim() : "")
            .filter((value: string, index: number, all: string[]) => value && all.indexOf(value) === index);
          const stats = detail.stats ?? {};
          return {
            author: String(detail.authorInfo?.nickname ?? "").trim(),
            description: String(detail.desc ?? detail.caption ?? detail.itemTitle ?? "").trim(),
            hashtags,
            createTime: Number.isFinite(Number(detail.createTime)) ? Number(detail.createTime) : null,
            musicTitle: typeof detail.music?.title === "string" && detail.music.title.trim()
              ? detail.music.title.trim()
              : null,
            stats: {
              diggCount: Number(stats.diggCount ?? 0) || 0,
              commentCount: Number(stats.commentCount ?? 0) || 0,
              collectCount: Number(stats.collectCount ?? 0) || 0,
              shareCount: Number(stats.shareCount ?? 0) || 0,
            },
            images,
          };
        }
        return null;
      }, context.workId);
      if (!metadata) throw new Error("当前作品没有可验证的抖音原生图文元数据。");
      if (!metadata.images.length) throw new Error("当前作品不是可读取的图文/相册，或图片列表为空。");
      await this.assertWorkContext(page, context);

      const selected = metadata.images.slice(0, limit);
      const images: DouyinGalleryResult["images"] = [];
      for (let index = 0; index < selected.length; index += 1) {
        const source = selected[index];
        const response = await page.context().request.get(source.url, {
          timeout: 15_000,
          failOnStatusCode: false,
        }).catch(() => null);
        if (!response?.ok()) continue;
        const body = await response.body().catch(() => null);
        if (!body || body.length === 0 || body.length > 12 * 1024 * 1024) continue;
        const contentType = (response.headers()["content-type"] ?? "").toLowerCase();
        const mimeType = contentType.includes("image/png")
          ? "image/png" as const
          : contentType.includes("image/webp")
            ? "image/webp" as const
            : contentType.includes("image/jpeg") || contentType.includes("image/jpg")
              ? "image/jpeg" as const
              : null;
        if (!mimeType) continue;
        images.push({
          index,
          width: source.width,
          height: source.height,
          mimeType,
          imageBase64: body.toString("base64"),
        });
      }
      await this.assertWorkContext(page, context);
      if (!images.length) throw new Error("图文元数据有效，但原图读取失败。");
      const result: DouyinGalleryResult = {
        url: page.url(),
        title: await page.title(),
        workId: context.workId,
        author: metadata.author,
        description: metadata.description,
        hashtags: metadata.hashtags,
        publishedAt: metadata.createTime && metadata.createTime > 0
          ? new Date(metadata.createTime * 1_000).toISOString()
          : null,
        musicTitle: metadata.musicTitle,
        stats: metadata.stats,
        totalImageCount: metadata.images.length,
        returnedImageCount: images.length,
        truncated: metadata.images.length > selected.length || images.length < selected.length,
        images,
        source: "douyin-native-gallery",
        privacyFiltered: true,
      };
      log("read_gallery", {
        workId: result.workId,
        totalImageCount: result.totalImageCount,
        returnedImageCount: result.returnedImageCount,
        truncated: result.truncated,
      });
      return result;
    });
  }

  async readChapters(): Promise<ChapterResult> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const media = await this.lockedMediaData(page, context, 3_000);
      const parsed = parseNativeChapters(media.chapterText);
      if (parsed.chapters.length < 2) {
        throw new Error("当前活跃作品没有找到完整的抖音原生章节要点。");
      }
      await this.assertWorkContext(page, context);
      const result: ChapterResult = {
        url: page.url(),
        workId: context.workId,
        summary: parsed.summary,
        chapters: parsed.chapters,
        chapterCount: parsed.chapters.length,
        source: "douyin-native-chapters",
        privacyFiltered: true,
      };
      log("read_chapters", { workId: context.workId, chapterCount: result.chapterCount });
      return result;
    });
  }

  async transcribeCurrent(model?: string): Promise<TranscriptRecord> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      const data = await this.lockedMediaData(page, context, 3_000);
      const probe: MediaProbe = {
        url: page.url(),
        title: await page.title(),
        workId: context.workId,
        durationSeconds: data.durationSeconds,
        currentTimeSeconds: data.currentTimeSeconds,
        paused: data.paused,
        mediaCandidates: data.mediaCandidates,
        visibleText: data.visibleText,
        textSource: data.textSource,
        characterCount: data.characterCount,
        truncated: data.truncated,
        chaptersAvailable: parseNativeChapters(data.chapterText).chapters.length >= 2,
        chapterCount: parseNativeChapters(data.chapterText).chapters.length,
        galleryAvailable: false,
        galleryImageCount: 0,
      };
      if (!data.mediaCandidates.length && data.durationSeconds == null) {
        throw new Error("当前页面没有检测到正在播放的视频。请先打开一条作品并播放，再调用本地转写。");
      }
      const record = await transcribeCurrentMedia(
        page,
        probe,
        model,
        await this.currentAuthor(page, context),
      );
      await this.assertWorkContext(page, context);
      if (record.workId !== context.workId) {
        throw new Error("作品上下文已切换，已停止读取，避免把不同作品内容混在一起。");
      }
      return record;
    });
  }

  private async assertOperatorAccount(page: Page): Promise<void> {
    const operator = loadActionSettings().operator;
    const verified = await page.evaluate(({ uid, secUid, displayName }) => {
      const exactProfile = `/user/${secUid}`;
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      };
      const navigationMatch = Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href*="${exactProfile}"]`))
        .some(anchor => visible(anchor) && Boolean(anchor.closest("header,nav,[data-e2e*='navigation'],[class*='navigation']")));
      const raw = document.querySelector<HTMLScriptElement>("#RENDER_DATA")?.textContent ?? "";
      let renderMatch = false;
      if (raw) {
        try {
          const parsed = JSON.parse(decodeURIComponent(raw));
          const app = parsed?.app ?? parsed?.["app"] ?? {};
          const user = app?.user?.info ?? app?.userInfo ?? app?.user ?? parsed?.user?.info;
          renderMatch = Boolean(user && String(user.uid) === uid && String(user.secUid ?? user.sec_uid) === secUid);
        } catch {
          renderMatch = false;
        }
      }
      let localStorageMatch = false;
      try {
        const douyinRaw = localStorage.getItem("user_info");
        const creatorRaw = localStorage.getItem("userInfo");
        if (douyinRaw) {
          const user = JSON.parse(douyinRaw);
          localStorageMatch = String(user?.uid ?? "") === secUid
            && String(user?.nickname ?? "") === displayName;
        }
        if (!localStorageMatch && creatorRaw) {
          const user = JSON.parse(creatorRaw);
          localStorageMatch = String(user?.user_id_str ?? user?.user_id ?? "") === uid
            && String(user?.sec_user_id ?? "") === secUid;
        }
      } catch {
        localStorageMatch = false;
      }
      return navigationMatch || renderMatch || localStorageMatch;
    }, {
      uid: operator.uid,
      secUid: operator.secUid,
      displayName: operator.displayName,
    });
    if (!verified) {
      throw new Error(`账号校验失败：当前登录账号不是已配置的 ${operator.displayName}，已停止写操作。`);
    }
  }

  private avatarFingerprint(rawUrl: string | null | undefined): string | null {
    if (!rawUrl) return null;
    try {
      const pathname = decodeURIComponent(new URL(rawUrl).pathname);
      return pathname.match(/(tos-[^/~]+_[A-Za-z0-9]+)(?:~|\.|$)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private authorizedCreatorAccounts(): AuthorizedCreatorAccount[] {
    const operator = loadActionSettings().operator;
    const accounts: AuthorizedCreatorAccount[] = [{
      alias: "self",
      displayName: operator.displayName,
      uid: operator.uid,
      secUid: operator.secUid,
      source: "operator",
    }];
    for (const bound of loadBoundUsers().values()) {
      if (!bound.allowCreatorCenter) continue;
      accounts.push({
        alias: bound.alias,
        displayName: bound.displayName,
        uid: bound.uid,
        secUid: bound.secUid,
        source: "bound_user",
      });
    }
    return accounts;
  }

  private activateCreatorAccount(account: AuthorizedCreatorAccount): void {
    if (this.activeCreatorAccount?.uid !== account.uid
      || this.activeCreatorAccount?.secUid !== account.secUid) {
      this.creatorOwnReplyIds.clear();
      this.creatorScanCache.clear();
      this.creatorCommentDatasetCache.clear();
      this.creatorCommentMatchTokens.clear();
      this.creatorAccountAvatarFingerprint = null;
    }
    this.activeCreatorAccount = account;
  }

  private async assertCreatorCenterAccount(page: Page): Promise<AuthorizedCreatorAccount> {
    assertCreatorCommentManagerPage(page.url());
    const operator = loadActionSettings().operator;
    const authorized = this.authorizedCreatorAccounts();
    const storedIdentity = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("userInfo");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
          uid: String(parsed?.user_id_str ?? parsed?.user_id ?? ""),
          secUid: String(parsed?.sec_user_id ?? ""),
        };
      } catch {
        return null;
      }
    }).catch(() => null);
    if (storedIdentity?.uid || storedIdentity?.secUid) {
      const matches = authorized.filter(account =>
        (!storedIdentity.uid || storedIdentity.uid === account.uid)
        && (!storedIdentity.secUid || storedIdentity.secUid === account.secUid));
      if (matches.length !== 1) {
        throw new Error(
          "WRONG_ACCOUNT:创作者中心登录身份不属于已授权 creator account；"
          + "只允许 self 或 allow_creator_center=true 的稳定 uid/sec_uid。",
        );
      }
      this.activateCreatorAccount(matches[0]);
      this.creatorAccountAvatarFingerprint = this.avatarFingerprint(
        await page.locator("img[alt='author avatar']").first().getAttribute("src").catch(() => null),
      );
      return matches[0];
    }

    const creatorAvatar = this.avatarFingerprint(
      await page.locator("img[alt='author avatar']").first().getAttribute("src").catch(() => null),
    );
    if (!creatorAvatar) {
      throw new Error("LOGIN_REQUIRED:创作者中心评论管理页未显示已登录创作者头像。");
    }

    const operatorPage = this.rolePages.get("operator_home");
    if (!operatorPage || operatorPage.isClosed()) {
      throw new Error("PAGE_BINDING_LOST:缺少可用于交叉校验 Operator 的正式页。");
    }
    await this.assertOperatorAccount(operatorPage);
    const operatorTargetId = await this.pageTargetId(operatorPage);
    const persisted = loadPageBindings().get("operator_home");
    if (!persisted || persisted.targetId !== operatorTargetId) {
      savePageBinding({
        role: "operator_home",
        pageId: this.pageId(operatorPage),
        targetId: operatorTargetId,
        url: operatorPage.url(),
        account: loadActionSettings().operator.displayName,
        boundAt: new Date().toISOString(),
      });
    }
    const operatorImages = await operatorPage.locator("img[src]").evaluateAll(images =>
      images.map(image => (image as HTMLImageElement).src).filter(Boolean));
    const matchesOperator = operatorImages.some(src => this.avatarFingerprint(src) === creatorAvatar);
    if (!matchesOperator) {
      throw new Error(
        "CREATOR_IDENTITY_UNVERIFIABLE:创作者中心未暴露稳定 uid/sec_uid，"
        + "头像也无法证明是 Operator；绑定用户账号必须先完成稳定身份读取。",
      );
    }
    const account = authorized.find(candidate =>
      candidate.uid === operator.uid && candidate.secUid === operator.secUid);
    if (!account) throw new Error("WRONG_ACCOUNT:operator 未出现在授权创作者账号集合。");
    this.activateCreatorAccount(account);
    this.creatorAccountAvatarFingerprint = creatorAvatar;
    return account;
  }

  async verifyCreatorCenterAccount(alias?: string): Promise<{
    verified: true;
    alias: string;
    displayName: string;
    uid: string;
    secUid: string;
    source: "operator" | "bound_user";
    pageRole: "creator_center";
    pageTargetId: string;
    url: string;
    writeAccountReady: true;
  }> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      const account = await this.assertCreatorCenterAccount(page);
      if (alias && account.alias !== alias.trim().toLowerCase()) {
        throw new Error(
          `CREATOR_ACCOUNT_MISMATCH:当前创作者中心是 ${account.alias}/${account.displayName}，`
          + `请求的是 ${alias}。`,
        );
      }
      return {
        verified: true,
        ...account,
        pageRole: "creator_center",
        pageTargetId: await this.pageTargetId(page),
        url: page.url(),
        writeAccountReady: true,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async creatorCenterPage(): Promise<Page> {
    await this.ensurePageRoles();
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("PAGE_BINDING_LOST:没有可用的专用浏览器上下文。");
    const current = this.rolePages.get("creator_center");
    const persisted = loadPageBindings().get("creator_center");
    if (current && !current.isClosed()) {
      const currentTargetId = await this.pageTargetId(current).catch(() => "");
      if (persisted?.targetId === currentTargetId) {
        assertCreatorCommentManagerPage(current.url());
        await this.assertCreatorCenterAccount(current);
        return current;
      }
    }

    const candidates = context.pages().filter(page => {
      if (page.isClosed()) return false;
      try {
        const url = new URL(page.url());
        return url.hostname.toLowerCase() === "creator.douyin.com"
          && [
            "/creator-micro/interactive/comment",
            "/creator-micro/data/following/comment",
          ].includes(url.pathname);
      } catch {
        return false;
      }
    });
    if (candidates.length > 1) {
      throw new Error(
        `PAGE_BINDING_CONFLICT:检测到 ${candidates.length} 个创作者中心评论管理页，请只保留一个后重试。`,
      );
    }

    const page = candidates[0] ?? await this.createAutomationPage(context, "role:creator_center");
    if (candidates.length === 0) {
      await page.goto(
        "https://creator.douyin.com/creator-micro/interactive/comment",
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      await page.locator("img[alt='author avatar']").first().waitFor({
        state: "visible",
        timeout: 20_000,
      }).catch(() => null);
    }
    this.bindPageRole(page, "creator_center");
    assertCreatorCommentManagerPage(page.url());
    const creatorAccount = await this.assertCreatorCenterAccount(page);
    savePageBinding({
      role: "creator_center",
      pageId: this.pageId(page),
      targetId: await this.pageTargetId(page),
      url: page.url(),
      account: creatorAccount.displayName,
      accountUid: creatorAccount.uid,
      accountSecUid: creatorAccount.secUid,
      boundAt: new Date().toISOString(),
    });
    return page;
  }

  private normalizeCreatorApiComment(raw: any): CreatorApiComment | null {
    const commentId = String(raw?.cid ?? "");
    if (!/^\d{8,}$/.test(commentId)) return null;
    const avatarUri = String(raw?.user?.avatar_thumb?.uri ?? "");
    const avatarUrl = Array.isArray(raw?.user?.avatar_thumb?.url_list)
      ? String(raw.user.avatar_thumb.url_list[0] ?? "")
      : "";
    return {
      commentId,
      text: String(raw?.text ?? "").trim(),
      author: String(raw?.user?.nickname ?? "未知用户").trim() || "未知用户",
      authorUid: /^\d+$/.test(String(raw?.user?.uid ?? ""))
        ? String(raw.user.uid)
        : null,
      authorSecUid: String(raw?.user?.sec_uid ?? "").trim() || null,
      createdAt: Number.isFinite(Number(raw?.create_time)) ? Number(raw.create_time) : null,
      likeCount: Number.isFinite(Number(raw?.digg_count)) ? Number(raw.digg_count) : null,
      status: Number.isFinite(Number(raw?.status)) ? Number(raw.status) : null,
      parentCommentId: /^\d{8,}$/.test(String(raw?.reply_to_reply_id ?? ""))
        && String(raw.reply_to_reply_id) !== "0"
        ? String(raw.reply_to_reply_id)
        : /^\d{8,}$/.test(String(raw?.reply_id ?? ""))
          && String(raw.reply_id) !== "0"
          ? String(raw.reply_id)
          : null,
      replyCount: Math.max(0, Number(raw?.reply_comment_total ?? raw?.comment_reply_total ?? 0) || 0),
      level: Math.max(1, Number(raw?.level ?? 1) || 1),
      avatarFingerprint: this.avatarFingerprint(avatarUrl)
        ?? avatarUri.match(/(tos-[^/~]+_[A-Za-z0-9]+)(?:~|\.|$)/)?.[1]
        ?? null,
    };
  }

  private creatorSnapshotFromResponse(raw: any, responseUrl: string): CreatorCommentSnapshot {
    const comments = (Array.isArray(raw?.comments) ? raw.comments : [])
      .map((item: any) => this.normalizeCreatorApiComment(item))
      .filter((item: CreatorApiComment | null): item is CreatorApiComment => Boolean(item));
    const url = new URL(responseUrl);
    const responseWorkId = url.searchParams.get("aweme_id") ?? url.searchParams.get("item_id");
    const workId = comments[0]?.commentId
      ? String((raw?.comments?.[0] as any)?.aweme_id ?? responseWorkId ?? "")
      : responseWorkId;
    return {
      workId: workId && /^\d{16,20}$/.test(workId) ? workId : null,
      comments,
      cursor: raw?.cursor == null ? null : String(raw.cursor),
      hasMore: Boolean(raw?.has_more),
      total: Number.isFinite(Number(raw?.total)) ? Number(raw.total) : comments.length,
    };
  }

  private async loadMoreCreatorRootComments(
    page: Page,
    initial: CreatorCommentSnapshot,
    maxRootComments: number,
  ): Promise<CreatorCommentSnapshot> {
    const collected = new Map(initial.comments.map(comment => [comment.commentId, comment]));
    let snapshot = initial;
    for (let attempt = 0;
      snapshot.hasMore && collected.size < maxRootComments && attempt < 200;
      attempt += 1) {
      const expectedCursor = snapshot.cursor;
      const [response] = await Promise.all([
        page.waitForResponse(response => {
          try {
            const url = new URL(response.url());
            return url.hostname === "creator.douyin.com"
              && url.pathname.endsWith("/comment/list/select/")
              && url.searchParams.get("cursor") === expectedCursor;
          } catch {
            return false;
          }
        }, { timeout: 10_000 }),
        page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)),
      ]);
      const next = this.creatorSnapshotFromResponse(await response.json(), response.url());
      for (const comment of next.comments) collected.set(comment.commentId, comment);
      snapshot = {
        ...next,
        workId: next.workId ?? snapshot.workId,
        comments: [...collected.values()],
        total: Math.max(snapshot.total, next.total, collected.size),
      };
    }
    return snapshot;
  }

  private async captureCreatorRootSnapshot(
    page: Page,
    maxRootComments = 10,
  ): Promise<CreatorCommentSnapshot> {
    const [response] = await Promise.all([
      page.waitForResponse(response => {
        try {
          const url = new URL(response.url());
          return url.hostname === "creator.douyin.com"
            && url.pathname.endsWith("/comment/list/select/");
        } catch {
          return false;
        }
      }, { timeout: 20_000 }),
      page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    ]);
    const raw = await response.json();
    await page.locator("img[alt='author avatar']").first().waitFor({ state: "visible", timeout: 15_000 });
    await this.assertCreatorCenterAccount(page);
    return this.loadMoreCreatorRootComments(
      page,
      this.creatorSnapshotFromResponse(raw, response.url()),
      Math.max(1, Math.min(100, maxRootComments)),
    );
  }

  private async creatorSelectedWorkTitle(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const cover = Array.from(document.querySelectorAll<HTMLElement>("[class^='cover-']"))
        .find(element => !element.closest("[role='dialog']"));
      const card = cover?.parentElement ?? null;
      const title = card?.querySelector<HTMLElement>("[class^='title-']");
      const text = (title?.innerText || title?.textContent || "").trim();
      return text || null;
    });
  }

  private async creatorCurrentFilterKeyword(page: Page): Promise<string> {
    return page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
        .filter(candidate => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return candidate.placeholder.includes("搜索评论关键词")
            && style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        });
      if (inputs.length !== 1) {
        throw new Error(`creator_comment_search_input_count=${inputs.length}`);
      }
      return inputs[0].value.trim();
    });
  }

  private isCreatorOwnApiComment(
    comment: CreatorApiComment,
    account = this.activeCreatorAccount,
  ): boolean {
    if (!account) return false;
    return comment.authorUid === account.uid
      || comment.authorSecUid === account.secUid
      || (Boolean(this.creatorAccountAvatarFingerprint)
        && comment.avatarFingerprint === this.creatorAccountAvatarFingerprint);
  }

  private async readCurrentFilteredCreatorCommentsOnPage(
    page: Page,
    expectedWorkId?: string,
    requireUnique = true,
  ): Promise<CreatorCurrentFilteredRead> {
    await this.assertCreatorCenterAccount(page);
    const extracted = await page.evaluate(input => {
      type FiberNode = {
        memoizedProps?: any;
        return?: FiberNode | null;
      };
      type ComponentRow = {
        commentId: string;
        author: string;
        text: string;
        levelOneCid: string | null;
      };
      type RawRow = {
        commentId: string;
        workId: string;
        author: string;
        text: string;
        parentCommentId: string | null;
        rootCommentId: string;
        level: number;
        createdAt: number | null;
        likeCount: number | null;
        replyCount: number;
      };

      const isVisible = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      };
      const fiberFor = (element: Element): FiberNode | null => {
        const key = Object.keys(element).find(value => value.startsWith("__reactFiber$"));
        return key ? ((element as any)[key] as FiberNode | undefined) ?? null : null;
      };
      const componentFromProps = (props: any): ComponentRow | null => {
        const commentId = String(props?.id ?? props?.commentId ?? "");
        const author = typeof props?.username === "string" ? props.username.trim() : "";
        const text = typeof props?.content === "string" ? props.content.trim() : "";
        if (!/^\d{8,}$/.test(commentId) || !author || !text) return null;
        const levelOneCid = /^\d{8,}$/.test(String(props?.levelOneCid ?? ""))
          ? String(props.levelOneCid)
          : null;
        return { commentId, author, text, levelOneCid };
      };
      const componentFor = (textNode: HTMLElement): {
        row: ComponentRow;
        fiber: FiberNode;
      } | null => {
        let element: HTMLElement | null = textNode;
        for (let domDepth = 0; element && domDepth < 10; domDepth += 1) {
          const firstFiber = fiberFor(element);
          let fiber = firstFiber;
          for (let fiberDepth = 0; fiber && fiberDepth < 24; fiberDepth += 1) {
            const row = componentFromProps(fiber.memoizedProps);
            if (row) return { row, fiber: firstFiber ?? fiber };
            fiber = fiber.return ?? null;
          }
          element = element.parentElement;
        }
        return null;
      };
      const normalizedId = (value: unknown): string | null => {
        const id = String(value ?? "");
        return /^\d{8,}$/.test(id) && id !== "0" ? id : null;
      };
      const rawRow = (raw: any, component: ComponentRow): RawRow | null => {
        const commentId = normalizedId(raw?.cid);
        const workId = String(raw?.aweme_id ?? raw?.item_id ?? "");
        const author = String(raw?.user?.nickname ?? "").trim();
        const text = String(raw?.text ?? "").trim();
        const replyCountValue = raw?.reply_comment_total ?? raw?.comment_reply_total;
        if (!commentId
          || !/^\d{16,20}$/.test(workId)
          || !author
          || !text
          || !Number.isFinite(Number(replyCountValue))) return null;
        const level = Math.max(1, Number(raw?.level ?? 1) || 1);
        const parentCommentId = normalizedId(raw?.reply_to_reply_id)
          ?? normalizedId(raw?.reply_id);
        const rootCommentId = component.levelOneCid
          ?? (level === 1 ? commentId : normalizedId(raw?.reply_id));
        if (!rootCommentId) return null;
        return {
          commentId,
          workId,
          author,
          text,
          parentCommentId: level === 1 ? null : parentCommentId,
          rootCommentId,
          level,
          createdAt: Number.isFinite(Number(raw?.create_time))
            ? Number(raw.create_time)
            : null,
          likeCount: Number.isFinite(Number(raw?.digg_count))
            ? Number(raw.digg_count)
            : null,
          replyCount: Math.max(0, Number(replyCountValue) || 0),
        };
      };

      const searchInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
        .filter(candidate => candidate.placeholder.includes("搜索评论关键词")
          && isVisible(candidate));
      if (searchInputs.length !== 1) {
        return {
          ok: false as const,
          reason: "search_input_not_unique",
          keyword: "",
          visibleCount: 0,
          dataSourceCount: 0,
          noMore: false,
        };
      }
      const keyword = searchInputs[0].value.trim();
      if (!keyword) {
        return {
          ok: false as const,
          reason: "current_filter_empty",
          keyword,
          visibleCount: 0,
          dataSourceCount: 0,
          noMore: false,
        };
      }

      const visibleComponents = new Map<string, ComponentRow>();
      const seedFibers: FiberNode[] = [];
      const textNodes = Array.from(
        document.querySelectorAll<HTMLElement>("[class*='comment-content-text-']"),
      ).filter(isVisible);
      for (const textNode of textNodes) {
        const component = componentFor(textNode);
        if (!component) continue;
        const existing = visibleComponents.get(component.row.commentId);
        if (existing
          && (existing.author !== component.row.author || existing.text !== component.row.text)) {
          return {
            ok: false as const,
            reason: "conflicting_visible_component",
            keyword,
            visibleCount: visibleComponents.size,
            dataSourceCount: 0,
            noMore: false,
          };
        }
        visibleComponents.set(component.row.commentId, component.row);
        seedFibers.push(component.fiber);
      }
      const visibleIds = [...visibleComponents.keys()].sort();
      const dataSources = new Map<string, RawRow[]>();
      for (const seed of seedFibers) {
        let fiber: FiberNode | null = seed;
        for (let depth = 0; fiber && depth < 80; depth += 1) {
          const candidates = [
            fiber.memoizedProps?.value?.dataSource,
            fiber.memoizedProps?.dataSource,
          ];
          for (const candidate of candidates) {
            if (!Array.isArray(candidate)) continue;
            const candidateIds = candidate
              .map(raw => normalizedId(raw?.cid))
              .filter((id): id is string => Boolean(id))
              .sort();
            if (candidateIds.length !== candidate.length
              || JSON.stringify(candidateIds) !== JSON.stringify(visibleIds)) continue;
            const rows: RawRow[] = [];
            let valid = true;
            for (const raw of candidate) {
              const component = visibleComponents.get(String(raw?.cid ?? ""));
              const row = component ? rawRow(raw, component) : null;
              if (!row
                || row.author !== component!.author
                || row.text !== component!.text) {
                valid = false;
                break;
              }
              rows.push(row);
            }
            if (!valid) continue;
            rows.sort((left, right) => left.commentId.localeCompare(right.commentId));
            const signature = JSON.stringify(rows);
            dataSources.set(signature, rows);
          }
          fiber = fiber.return ?? null;
        }
      }

      const noMore = (document.body.innerText || document.body.textContent || "")
        .includes("没有更多评论");
      if (visibleComponents.size === 0 || dataSources.size !== 1) {
        return {
          ok: false as const,
          reason: visibleComponents.size === 0
            ? "no_verified_visible_comment"
            : "react_data_source_not_unique",
          keyword,
          visibleCount: visibleComponents.size,
          dataSourceCount: dataSources.size,
          noMore,
        };
      }
      const rows = [...dataSources.values()][0];
      if (!noMore) {
        return {
          ok: false as const,
          reason: "filtered_result_not_exhausted",
          keyword,
          visibleCount: visibleComponents.size,
          dataSourceCount: dataSources.size,
          noMore,
        };
      }
      if (input.requireUnique && (rows.length !== 1 || visibleComponents.size !== 1)) {
        return {
          ok: false as const,
          reason: "filtered_result_not_unique",
          keyword,
          visibleCount: visibleComponents.size,
          dataSourceCount: dataSources.size,
          noMore,
        };
      }
      const workIds = [...new Set(rows.map(row => row.workId))];
      if (workIds.length !== 1
        || (input.expectedWorkId && workIds[0] !== input.expectedWorkId)) {
        return {
          ok: false as const,
          reason: "filtered_work_id_mismatch",
          keyword,
          visibleCount: visibleComponents.size,
          dataSourceCount: dataSources.size,
          noMore,
        };
      }
      return {
        ok: true as const,
        keyword,
        rows,
        workId: workIds[0],
        visibleCount: visibleComponents.size,
        dataSourceCount: dataSources.size,
        noMore,
      };
    }, { expectedWorkId: expectedWorkId ?? null, requireUnique });

    if (!extracted.ok) {
      throw new Error(
        `VALIDATION_FAILED:无法从 creator_center 当前筛选结果可靠读取稳定 comment_id`
        + `（reason=${extracted.reason}; keyword=${extracted.keyword || "空"};`
        + ` visible=${extracted.visibleCount}; dataSources=${extracted.dataSourceCount};`
        + ` noMore=${extracted.noMore}）。未刷新页面，未改变筛选状态。`,
      );
    }

    const workTitle = await this.creatorSelectedWorkTitle(page);
    const items: CreatorCommentItem[] = [];
    for (const row of extracted.rows) {
      let ownReplyText: string | null = null;
      let hasReplied = false;
      if (row.replyCount > 0) {
        const replies = await this.fetchCreatorRepliesDirect(
          page,
          row.workId,
          row.rootCommentId,
        );
        if (!replies) {
          throw new Error(
            `VALIDATION_FAILED:comment_id=${row.commentId} 的回复线程无法只读回查，`
            + "不能可靠判断 hasReplied。未改变当前筛选状态。",
          );
        }
        for (const reply of replies) {
          if (!this.isCreatorOwnApiComment(reply)) continue;
          this.creatorOwnReplyIds.set(
            `${row.workId}:${reply.parentCommentId ?? row.rootCommentId}:${reply.text}`,
            reply.commentId,
          );
        }
        const ownReply = replies.find(reply =>
          reply.parentCommentId === row.commentId && this.isCreatorOwnApiComment(reply));
        hasReplied = Boolean(ownReply);
        ownReplyText = ownReply?.text ?? null;
      }
      const depth = row.parentCommentId ? Math.max(1, row.level - 1) : 0;
      const threadPath = row.parentCommentId
        ? row.rootCommentId === row.parentCommentId
          ? [row.rootCommentId, row.commentId]
          : [row.rootCommentId, row.parentCommentId, row.commentId]
        : [row.commentId];
      items.push({
        workId: row.workId,
        workTitle,
        commentId: row.commentId,
        parentCommentId: row.parentCommentId,
        rootCommentId: row.rootCommentId,
        depth,
        threadPath,
        author: row.author,
        text: row.text,
        time: row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null,
        likeCount: row.likeCount,
        replyCount: row.replyCount,
        isReply: Boolean(row.parentCommentId),
        hasReplied,
        ownReplyText,
      });
    }
    const keywordAfterRead = await this.creatorCurrentFilterKeyword(page);
    if (keywordAfterRead !== extracted.keyword) {
      throw new Error(
        "VALIDATION_FAILED:读取期间 creator_center 搜索条件发生变化，结果已丢弃且未执行任何写操作。",
      );
    }
    return {
      keyword: extracted.keyword,
      workId: extracted.workId,
      workTitle,
      items,
    };
  }

  async readCurrentFilteredCreatorComments(options: {
    expectedWorkId?: string;
    requireUnique?: boolean;
  } = {}): Promise<CreatorCurrentFilteredCommentsResult> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      const result = await this.readCurrentFilteredCreatorCommentsOnPage(
        page,
        options.expectedWorkId,
        options.requireUnique ?? true,
      );
      return {
        items: result.items.map(item => ({
          commentId: item.commentId,
          author: item.author,
          text: item.text,
          workId: item.workId,
          hasReplied: item.hasReplied,
          parentCommentId: item.parentCommentId,
          rootCommentId: item.rootCommentId,
          depth: item.depth,
          time: item.time,
          likeCount: item.likeCount,
          replyCount: item.replyCount,
        })),
        count: result.items.length,
        unique: result.items.length === 1,
        keyword: result.keyword,
        workId: result.workId,
        workTitle: result.workTitle,
        pageRole: "creator_center",
        accountVerified: true,
        source: "verified_react_filter_state",
        filterStatePreserved: true,
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async selectCreatorWork(
    page: Page,
    targetWorkId: string,
    current: CreatorCommentSnapshot,
  ): Promise<CreatorCommentSnapshot> {
    if (current.workId === targetWorkId) return current;
    let post = this.ownPostCache.get(targetWorkId);
    if (!post) {
      const ownPosts = await this.listOwnPosts(100, undefined, false);
      post = ownPosts.items.find(item => item.workId === targetWorkId);
    }
    if (!post?.title) {
      throw new Error(
        `WORK_NOT_FOUND:${this.activeCreatorAccount?.displayName ?? "当前创作者"}`
        + " 的创作者中心作品列表中没有目标 work_id。",
      );
    }
    const choose = page.getByRole("button", { name: "选择作品", exact: true });
    if (await choose.count() !== 1) {
      throw new Error("VALIDATION_FAILED:创作者中心没有唯一的“选择作品”入口。");
    }
    await choose.click();
    const dialog = page.locator("[role='dialog']:visible");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const title = dialog.locator("[class^='title-']").filter({ hasText: post.title });
    const matching: number[] = [];
    for (let index = 0; index < await title.count(); index += 1) {
      if ((await title.nth(index).innerText()).trim() === post.title.trim()) matching.push(index);
    }
    if (matching.length !== 1) {
      await page.locator(".douyin-creator-interactive-sidesheet-mask").click({ force: true }).catch(() => null);
      throw new Error("WORK_NOT_FOUND:创作者中心作品列表无法按目标 work_id 对应标题唯一定位作品。");
    }
    const [response] = await Promise.all([
      page.waitForResponse(response => {
        try {
          return new URL(response.url()).pathname.endsWith("/comment/list/select/");
        } catch {
          return false;
        }
      }, { timeout: 15_000 }),
      title.nth(matching[0]).locator("xpath=ancestor::*[starts-with(@class,'container-')][1]").click(),
    ]);
    const selected = this.creatorSnapshotFromResponse(await response.json(), response.url());
    if (selected.workId !== targetWorkId) {
      throw new Error("WRONG_PAGE:创作者中心选中作品后的 work_id 与 target_work_id 不一致。");
    }
    return selected;
  }

  private async setCreatorCommentFilters(
    page: Page,
    sort: "latest" | "hot",
    status: "all" | "unreplied" | "replied",
  ): Promise<void> {
    const targetSort = sort === "hot" ? "最多点赞" : "最新发布";
    const sortSelections = ["最新发布", "最早发布", "最多点赞"];
    const currentSort = page.locator(".douyin-creator-interactive-select-selection-text")
      .filter({ hasText: new RegExp(`^(${sortSelections.join("|")})$`) });
    if (await currentSort.count() === 1 && (await currentSort.innerText()).trim() !== targetSort) {
      await currentSort.click();
      await page.getByRole("option", { name: targetSort, exact: true }).click();
      await page.waitForTimeout(300);
    }

    const targetStatus = status === "unreplied" ? "未回复" : "全部评论";
    const statusSelections = ["全部评论", "未回复", "包含问题", "可能打扰"];
    const currentStatus = page.locator(".douyin-creator-interactive-select-selection-text")
      .filter({ hasText: new RegExp(`^(${statusSelections.join("|")})$`) });
    if (await currentStatus.count() === 1 && (await currentStatus.innerText()).trim() !== targetStatus) {
      await currentStatus.click();
      await page.getByRole("option", { name: targetStatus, exact: true }).click();
      await page.waitForTimeout(300);
    }
  }

  private async locateCreatorCommentRecord(
    page: Page,
    comment: CreatorApiComment,
    options: {
      workId?: string;
      scope?: Locator;
      parentCommentFound?: boolean;
      parentThreadExpanded?: boolean;
    } = {},
  ): Promise<Locator> {
    const marker = `creator-comment-${comment.commentId}-${Date.now()}`;
    const scopeMarker = options.scope
      ? `creator-thread-scope-${comment.commentId}-${Date.now()}`
      : null;
    if (options.scope && scopeMarker) {
      if (await options.scope.count() !== 1) {
        throw new Error("VALIDATION_FAILED:父评论线程作用域不唯一。");
      }
      await options.scope.evaluate((element, value) =>
        element.setAttribute("data-codex-creator-thread-scope", value), scopeMarker);
    }
    const marked = await page.evaluate(input => {
      const normalize = (value: string) => value
        .replace(/\[[^\]]{1,24}\]/g, "")
        .replace(/\s+/g, "")
        .trim();
      const expectedText = normalize(input.text);
      const scope = input.scopeMarker
        ? document.querySelector<HTMLElement>(
          `[data-codex-creator-thread-scope="${input.scopeMarker}"]`,
        )
        : document.documentElement;
      const selector = "[class*='comment-content-text-']";
      const textNodes = Array.from(scope?.querySelectorAll<HTMLElement>(selector) ?? []);
      const matches: HTMLElement[] = [];
      for (const textNode of textNodes) {
        const actualText = normalize(textNode.innerText || textNode.textContent || "");
        if (!actualText || !(actualText === expectedText
          || actualText.includes(expectedText)
          || expectedText.includes(actualText))) continue;
        let record: HTMLElement | null = textNode;
        for (let depth = 0; depth < 8 && record; depth += 1, record = record.parentElement) {
          const author = record.querySelector<HTMLElement>("[class*='username-']");
          const operations = record.querySelector<HTMLElement>("[class*='operations-']");
          if (author && operations && (author.innerText || author.textContent || "").trim() === input.author) {
            matches.push(record);
            break;
          }
        }
      }
      const unique = [...new Set(matches)];
      if (unique.length === 1) {
        unique[0].setAttribute("data-codex-creator-comment", input.marker);
      }
      const allRecords = Array.from(document.querySelectorAll<HTMLElement>(".container-sXKyMs"));
      const rootRecords = allRecords.filter(record => !record.closest("[class*='reply-list-']"));
      const replyRecords = allRecords.filter(record => Boolean(record.closest("[class*='reply-list-']")));
      const stableIdCandidates = Array.from(scope?.querySelectorAll<HTMLElement>(
        "[data-comment-id],[data-cid],[data-e2e*='comment'][id],[id*='comment']",
      ) ?? []);
      const parentScope = input.scopeMarker
        ? scope
        : null;
      const parentThreadExpanded = Boolean(parentScope
        && Array.from(parentScope.querySelectorAll<HTMLElement>("[class*='load-more-']"))
          .some(element => (element.innerText || element.textContent || "").trim() === "收起"));
      return {
        matchCount: unique.length,
        scannedRootCommentCount: rootRecords.length,
        scannedReplyCommentCount: replyRecords.length,
        stableIdCandidateCount: stableIdCandidates.length,
        authorTextCandidateCount: unique.length,
        selector,
        virtualListDetected: Boolean(document.querySelector(
          "[class*='virtual'],[data-e2e*='virtual'],[aria-rowcount]",
        )),
        parentThreadExpanded,
      };
    }, {
      author: comment.author,
      text: comment.text,
      marker,
      scopeMarker,
    });
    if (marked.matchCount !== 1) {
      const diagnostics: CreatorCommentMappingDiagnostics = {
        workId: options.workId ?? "",
        commentId: comment.commentId,
        parentCommentId: comment.parentCommentId,
        isReply: comment.level > 1 || Boolean(comment.parentCommentId),
        parentCommentFound: options.parentCommentFound ?? false,
        parentThreadExpanded: options.parentThreadExpanded ?? marked.parentThreadExpanded,
        scannedRootCommentCount: marked.scannedRootCommentCount,
        scannedReplyCommentCount: marked.scannedReplyCommentCount,
        stableIdCandidateCount: marked.stableIdCandidateCount,
        authorTextCandidateCount: marked.authorTextCandidateCount,
        selector: `${scopeMarker ? `[data-codex-creator-thread-scope] ` : ""}${marked.selector}`,
        scope: scopeMarker ? "parent_thread" : "page",
        virtualListDetected: marked.virtualListDetected,
      };
      const artifact = await this.saveCommentArtifact(page, "creator-comment-mapping-failed", diagnostics)
        .catch(() => ({ screenshotPath: "", diagnosticsPath: "" }));
      throw new Error(
        `VALIDATION_FAILED:comment_id=${comment.commentId} 无法映射到唯一创作者中心评论记录`
        + `（匹配 ${marked.matchCount}；父评论找到=${diagnostics.parentCommentFound}；`
        + `线程展开=${diagnostics.parentThreadExpanded}；主评论=${diagnostics.scannedRootCommentCount}；`
        + `子评论=${diagnostics.scannedReplyCommentCount}；diagnostics=${artifact.diagnosticsPath || "未保存"}）。`,
      );
    }
    return page.locator(`[data-codex-creator-comment="${marker}"]`);
  }

  private async collectCreatorReplyPages(
    page: Page,
    firstRaw: any,
    responseUrl: string,
  ): Promise<CreatorApiComment[]> {
    const all: CreatorApiComment[] = [];
    const seen = new Set<string>();
    let raw = firstRaw;
    let cursor = "";
    for (let pass = 0; pass < 20; pass += 1) {
      const replies = (Array.isArray(raw?.comments) ? raw.comments : [])
        .map((item: any) => this.normalizeCreatorApiComment(item))
        .filter((item: CreatorApiComment | null): item is CreatorApiComment => Boolean(item));
      for (const reply of replies) {
        if (seen.has(reply.commentId)) continue;
        seen.add(reply.commentId);
        all.push(reply);
      }
      const hasMore = Boolean(raw?.has_more ?? raw?.hasMore);
      const nextCursor = String(raw?.cursor ?? raw?.next_cursor ?? "");
      if (!hasMore || !nextCursor || nextCursor === cursor || all.length >= 500) break;
      cursor = nextCursor;
      const nextUrl = new URL(responseUrl);
      nextUrl.searchParams.set("cursor", cursor);
      raw = await page.evaluate(async url => {
        const response = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }, nextUrl.toString()).catch(() => null);
      if (!raw) break;
    }
    return all;
  }

  private async fetchCreatorRepliesDirect(
    page: Page,
    workId: string,
    rootCommentId: string,
  ): Promise<CreatorApiComment[] | null> {
    const all: CreatorApiComment[] = [];
    const seen = new Set<string>();
    let cursor = "0";
    for (let pass = 0; pass < 200; pass += 1) {
      const url = new URL(
        "https://creator.douyin.com/web/api/third_party/aweme/api/comment/read/"
        + "aweme/v1/web/comment/list/reply/",
      );
      url.searchParams.set("comment_id", rootCommentId);
      url.searchParams.set("item_id", workId);
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("count", "50");
      url.searchParams.set("app_id", "2906");
      url.searchParams.set("aid", "2906");
      url.searchParams.set("device_platform", "webapp");
      const raw = await page.evaluate(async requestUrl => {
        const response = await fetch(requestUrl, { credentials: "include", cache: "no-store" });
        if (!response.ok) return null;
        return response.json();
      }, url.toString()).catch(() => null);
      if (!raw || Number(raw?.status_code ?? -1) !== 0) return null;
      const replies = (Array.isArray(raw?.comments) ? raw.comments : [])
        .map((item: any) => this.normalizeCreatorApiComment(item))
        .filter((item: CreatorApiComment | null): item is CreatorApiComment => Boolean(item));
      for (const reply of replies) {
        if (seen.has(reply.commentId)) continue;
        seen.add(reply.commentId);
        all.push(reply);
      }
      const hasMore = Boolean(raw?.has_more ?? raw?.hasMore);
      const nextCursor = String(raw?.cursor ?? raw?.next_cursor ?? "");
      if (!hasMore) return all;
      if (!nextCursor || nextCursor === cursor) return null;
      cursor = nextCursor;
    }
    return null;
  }

  private async fetchAllCreatorRootCommentsDirect(
    page: Page,
    workId: string,
    requireDeclaredTotal = true,
  ): Promise<CreatorCommentSnapshot> {
    const collected = new Map<string, CreatorApiComment>();
    let cursor = "0";
    let total = 0;
    for (let pass = 0; pass < 200; pass += 1) {
      const url = new URL(
        "https://creator.douyin.com/web/api/third_party/aweme/api/comment/read/"
        + "aweme/v1/web/comment/list/select/",
      );
      url.searchParams.set("aweme_id", workId);
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("count", "50");
      url.searchParams.set("comment_select_options", "0");
      url.searchParams.set("sort_options", "0");
      url.searchParams.set("channel_id", "618");
      url.searchParams.set("app_id", "2906");
      url.searchParams.set("aid", "2906");
      url.searchParams.set("device_platform", "webapp");
      const raw = await page.evaluate(async requestUrl => {
        const response = await fetch(requestUrl, { credentials: "include", cache: "no-store" });
        if (!response.ok) return null;
        return response.json();
      }, url.toString()).catch(() => null);
      if (!raw || Number(raw?.status_code ?? -1) !== 0) {
        throw new Error(
          `COMMENT_INDEX_UNAVAILABLE:creator_center 稳定评论接口读取失败（cursor=${cursor}）。`
          + "未刷新或改变页面状态。",
        );
      }
      const snapshot = this.creatorSnapshotFromResponse(raw, url.toString());
      if (snapshot.workId !== workId) {
        throw new Error("WRONG_PAGE:稳定评论接口返回的 work_id 与请求不一致。");
      }
      for (const comment of snapshot.comments) collected.set(comment.commentId, comment);
      total = Math.max(snapshot.total, collected.size);
      if (!snapshot.hasMore) {
        if (requireDeclaredTotal && collected.size < total) {
          throw new Error(
            `COMMENT_INDEX_INCOMPLETE:接口声明 total=${total}，实际只读到 ${collected.size} 条主评论。`,
          );
        }
        return {
          workId,
          comments: [...collected.values()],
          cursor: snapshot.cursor,
          hasMore: false,
          total: requireDeclaredTotal ? total : collected.size,
        };
      }
      const nextCursor = snapshot.cursor;
      if (!nextCursor || nextCursor === cursor) {
        throw new Error(
          `COMMENT_INDEX_INCOMPLETE:分页游标未前进（cursor=${cursor}），结果已失败关闭。`,
        );
      }
      cursor = nextCursor;
    }
    throw new Error("COMMENT_INDEX_INCOMPLETE:主评论分页超过安全上限，结果已失败关闭。");
  }

  private async captureCreatorReplies(
    page: Page,
    root: CreatorApiComment,
    options: {
      collapseAfter?: boolean;
      workId?: string;
    } = {},
  ): Promise<CreatorApiComment[]> {
    if (root.replyCount <= 0) return [];
    if (options.workId) {
      const direct = await this.fetchCreatorRepliesDirect(page, options.workId, root.commentId);
      if (direct) return direct;
    }
    const record = await this.locateCreatorCommentRecord(page, root, {
      workId: options.workId,
    });
    const expand = record.locator("[class*='load-more-']").filter({ hasText: /查看\d+条回复/ });
    if (await expand.count() !== 1) return [];
    const [response] = await Promise.all([
      page.waitForResponse(response => {
        try {
          const url = new URL(response.url());
          return url.pathname.endsWith("/comment/list/reply/")
            && url.searchParams.get("comment_id") === root.commentId;
        } catch {
          return false;
        }
      }, { timeout: 10_000 }),
      expand.click(),
    ]);
    const raw = await response.json();
    const replies = await this.collectCreatorReplyPages(page, raw, response.url());
    if (options.collapseAfter !== false) {
      const collapse = record.locator("[class*='load-more-']").filter({ hasText: "收起" });
      if (await collapse.count() === 1) await collapse.click().catch(() => null);
    }
    return replies;
  }

  private async creatorItemsFromSnapshot(
    page: Page,
    snapshot: CreatorCommentSnapshot,
    title: string | null,
    includeReplies: boolean,
    directOnly: boolean,
  ): Promise<CreatorCommentItem[]> {
    const items: CreatorCommentItem[] = [];
    const prefetchedReplies = new Map<string, CreatorApiComment[] | null>();
    if (includeReplies && snapshot.workId) {
      const rootsWithReplies = snapshot.comments.filter(root => root.replyCount > 0);
      for (let offset = 0; offset < rootsWithReplies.length; offset += 6) {
        const batch = rootsWithReplies.slice(offset, offset + 6);
        const results = await Promise.all(batch.map(root =>
          this.fetchCreatorRepliesDirect(page, snapshot.workId!, root.commentId)));
        for (let index = 0; index < batch.length; index += 1) {
          prefetchedReplies.set(batch[index].commentId, results[index]);
        }
      }
    }
    for (const root of snapshot.comments) {
      let replies: CreatorApiComment[] = [];
      if (includeReplies) {
        const direct = prefetchedReplies.get(root.commentId);
        if (direct) {
          replies = direct;
        } else if (directOnly && root.replyCount > 0) {
          throw new Error(
            `COMMENT_INDEX_INCOMPLETE:comment_id=${root.commentId} 的回复分页无法只读完成。`,
          );
        } else {
          replies = await this.captureCreatorReplies(page, root, {
            workId: snapshot.workId ?? undefined,
          });
        }
      }
      const ownReplies = replies.filter(reply => this.isCreatorOwnApiComment(reply));
      const replyById = new Map(replies.map(reply => [reply.commentId, reply]));
      const replyChildCounts = new Map<string, number>();
      for (const reply of replies) {
        const directParentId = reply.parentCommentId ?? root.commentId;
        replyChildCounts.set(directParentId, (replyChildCounts.get(directParentId) ?? 0) + 1);
      }
      const threadPathFor = (reply: CreatorApiComment): string[] => {
        const reversed = [reply.commentId];
        let parentId = reply.parentCommentId ?? root.commentId;
        const visited = new Set<string>(reversed);
        while (parentId && parentId !== root.commentId && !visited.has(parentId)) {
          reversed.push(parentId);
          visited.add(parentId);
          parentId = replyById.get(parentId)?.parentCommentId ?? root.commentId;
        }
        reversed.push(root.commentId);
        return reversed.reverse();
      };
      for (const ownReply of ownReplies) {
        this.creatorOwnReplyIds.set(
          `${snapshot.workId}:${ownReply.parentCommentId ?? root.commentId}:${ownReply.text}`,
          ownReply.commentId,
        );
      }
      const directOwnReplies = ownReplies.filter(reply =>
        (reply.parentCommentId ?? root.commentId) === root.commentId);
      items.push({
        workId: snapshot.workId ?? "",
        workTitle: title,
        commentId: root.commentId,
        parentCommentId: null,
        rootCommentId: root.commentId,
        depth: 0,
        threadPath: [root.commentId],
        author: root.author,
        text: root.text,
        time: root.createdAt ? new Date(root.createdAt * 1000).toISOString() : null,
        likeCount: root.likeCount,
        replyCount: Math.max(root.replyCount, replyChildCounts.get(root.commentId) ?? 0),
        isReply: false,
        hasReplied: directOwnReplies.length > 0,
        ownReplyText: directOwnReplies[0]?.text ?? null,
      });
      for (const reply of replies) {
        const threadPath = threadPathFor(reply);
        const directParentId = reply.parentCommentId ?? root.commentId;
        if (directParentId !== root.commentId && !threadPath.includes(directParentId)) {
          threadPath.splice(-1, 0, directParentId);
        }
        const directReplies = ownReplies.filter(ownReply =>
          ownReply.parentCommentId === reply.commentId);
        items.push({
          workId: snapshot.workId ?? "",
          workTitle: title,
          commentId: reply.commentId,
          parentCommentId: reply.parentCommentId ?? root.commentId,
          rootCommentId: root.commentId,
          depth: Math.max(1, threadPath.length - 1),
          threadPath,
          author: reply.author,
          text: reply.text,
          time: reply.createdAt ? new Date(reply.createdAt * 1000).toISOString() : null,
          likeCount: reply.likeCount,
          replyCount: replyChildCounts.get(reply.commentId) ?? 0,
          isReply: true,
          hasReplied: directReplies.length > 0,
          ownReplyText: directReplies[0]?.text ?? null,
        });
      }
    }
    return items;
  }

  private async creatorCommentsForCurrentSelection(
    page: Page,
    workId: string | undefined,
    sort: "latest" | "hot",
    status: "all" | "unreplied" | "replied",
    includeReplies = true,
  ): Promise<{ snapshot: CreatorCommentSnapshot; title: string | null; items: CreatorCommentItem[] }> {
    const previousScrollTop = await page.evaluate(() => {
      const record = document.querySelector<HTMLElement>("[class*='comment-content-text-']");
      let current = record?.parentElement ?? null;
      while (current) {
        if (current.scrollHeight > current.clientHeight + 20) return current.scrollTop;
        current = current.parentElement;
      }
      return scrollY;
    }).catch(() => 0);
    await this.setCreatorCommentFilters(page, sort, status);
    let snapshot = await this.captureCreatorRootSnapshot(page, 100);
    if (workId) {
      const selected = await this.selectCreatorWork(page, workId, snapshot);
      snapshot = selected === snapshot
        ? selected
        : await this.loadMoreCreatorRootComments(page, selected, 100);
    }
    if (workId && snapshot.workId !== workId) {
      throw new Error("WRONG_PAGE:创作者中心当前筛选作品与 work_id 不一致。");
    }
    const title = await this.creatorSelectedWorkTitle(page);
    const items = await this.creatorItemsFromSnapshot(page, snapshot, title, includeReplies, false);
    const filtered = status === "all"
      ? items
      : items.filter(item => item.hasReplied === (status === "replied"));
    if (snapshot.workId) {
      this.creatorCommentDatasetCache.set(snapshot.workId, {
        workId: snapshot.workId,
        workTitle: title,
        snapshot,
        items,
        includesReplies: includeReplies,
        capturedAt: Date.now(),
      });
    }
    await page.evaluate(scrollTop => {
      const record = document.querySelector<HTMLElement>("[class*='comment-content-text-']");
      let current = record?.parentElement ?? null;
      while (current) {
        if (current.scrollHeight > current.clientHeight + 20) {
          current.scrollTop = scrollTop;
          return;
        }
        current = current.parentElement;
      }
      scrollTo(0, scrollTop);
    }, previousScrollTop).catch(() => null);
    return { snapshot, title, items: filtered };
  }

  private async markWorkAction(page: Page, action: "like" | "favorite" | "share"): Promise<{
    marker: string;
    state: string;
  }> {
    const marker = `codex-${action}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const index = action === "like" ? 0 : action === "favorite" ? 2 : 3;
    const stateInfo = await page.evaluate(({ actionName, actionIndex, actionMarker }) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      };
      const selectors: Record<string, string[]> = {
        like: [
          "[data-e2e='video-player-digg']",
          "[data-e2e='video-like-icon']",
          "[data-e2e*='like-icon']",
          "[data-e2e-state*='digg']",
        ],
        favorite: ["[data-e2e='video-favorite-icon']", "[data-e2e*='favorite-icon']", "[data-e2e*='collect-icon']"],
        share: ["[data-e2e='video-share-icon-container']", "[data-e2e*='share-icon']"],
      };
      let candidate: HTMLElement | null = null;
      for (const selector of selectors[actionName] ?? []) {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
          .filter(element => visible(element)
            && !element.closest(".related-list-item-in-small-card,[class*='recommend-list'],[data-e2e*='recommend']"));
        candidate = candidates.length === 1 ? candidates[0] : null;
        if (candidate) break;
      }
      if (!candidate) {
        const bars = Array.from(document.querySelectorAll<HTMLElement>(".NoBOOMd6"))
          .filter(visible);
        const bar = bars.length === 1 ? bars[0] : bars.find(item => item.querySelectorAll(":scope > div").length >= 4);
        const child = bar?.querySelectorAll<HTMLElement>(":scope > div")[actionIndex];
        candidate = child?.querySelector<HTMLElement>("[tabindex='0']") ?? child ?? null;
      }
      if (!candidate) return null;
      candidate.setAttribute("data-codex-action-target", actionMarker);
      const aria = candidate.getAttribute("aria-label") ?? candidate.getAttribute("title") ?? "";
      const classText = `${candidate.className || ""} ${candidate.parentElement?.className || ""}`;
      const e2eState = candidate.getAttribute("data-e2e-state") ?? "";
      const actionRoot = candidate.closest<HTMLElement>(".NoBOOMd6 > div");
      const active = actionName === "like" && /video-player-no-digged/i.test(e2eState)
        ? false
        : actionName === "like" && /video-player-digged/i.test(e2eState)
          ? true
          : actionName === "share" || !actionRoot
            ? null
            : actionRoot.classList.length > 1;
      return { hint: `${aria} ${classText}`.trim(), active };
    }, { actionName: action, actionIndex: index, actionMarker: marker });
    if (stateInfo == null) throw new Error(`当前作品没有找到可唯一验证的${action === "like" ? "点赞" : action === "favorite" ? "收藏" : "分享"}按钮。`);
    const locator = page.locator(`[data-codex-action-target="${marker}"]`);
    if (await locator.count() !== 1) throw new Error("作品动作按钮不唯一，已停止操作。");
    await locator.scrollIntoViewIfNeeded();
    if (stateInfo.active != null) {
      return {
        marker,
        state: stateInfo.active
          ? action === "like" ? "取消点赞" : "取消收藏"
          : action === "like" ? "点赞" : "收藏",
      };
    }
    await locator.hover();
    await sleep(300);
    const labels = action === "like"
      ? ["取消点赞", "点赞"]
      : action === "favorite"
        ? ["取消收藏", "收藏"]
        : ["分享"];
    for (const label of labels) {
      const matches = page.getByText(label, { exact: true });
      const count = await matches.count();
      for (let i = 0; i < count; i += 1) {
        if (await matches.nth(i).isVisible().catch(() => false)) return { marker, state: label };
      }
    }
    if (action === "share") return { marker, state: "分享" };
    const normalized = stateInfo.hint.toLowerCase();
    if (/active|selected|liked|collected/.test(normalized)) return { marker, state: action === "like" ? "取消点赞" : "取消收藏" };
    throw new Error(`无法确认${action === "like" ? "点赞" : "收藏"}按钮当前状态，未执行点击。`);
  }

  private async actionState(page: Page, action: "like" | "favorite"): Promise<string> {
    return (await this.markWorkAction(page, action)).state;
  }

  private async currentAuthor(page: Page, context: WorkContext): Promise<string | undefined> {
    const meta = await page.locator('meta[name="description"]').getAttribute("content").catch(() => null);
    const parsed = meta ? parseDouyinMetaDescription(meta) : null;
    if (parsed?.author) return parsed.author;
    return page.evaluate((workId: string) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      };
      const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='video-detail'],[role='dialog'],main"))
        .filter(visible);
      const root = roots.find(item => item.querySelector(`a[href*="${workId}"],video`)) ?? roots[0] ?? document.body;
      const link = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href*='/user/']"))
        .find(anchor => visible(anchor) && (anchor.innerText || anchor.textContent || "").trim());
      return (link?.innerText || link?.textContent || "").trim() || undefined;
    }, context.workId);
  }

  private actionLogBase(
    toolName: string,
    actionType: string,
    extra: Omit<Parameters<typeof appendActionLog>[0], "toolName" | "actionType" | "currentAccount">,
  ): Parameters<typeof appendActionLog>[0] {
    return {
      toolName,
      actionType,
      currentAccount: loadActionSettings().operator.displayName,
      ...extra,
    };
  }

  private installLowRiskNetworkMonitor(
    page: Page,
    kind: LowRiskPostActionKind,
    workId: string,
  ): {
    arm: () => void;
    finish: () => Promise<LowRiskNetworkObservation>;
    cancel: () => void;
  } {
    let armed = false;
    let targetRequest: ReturnType<PlaywrightResponse["request"]> | null = null;
    const observation: LowRiskNetworkObservation = {
      requestSeen: false,
      responseSeen: false,
      responseStatus: null,
      responseCode: null,
      businessSucceeded: false,
      targetMismatch: false,
    };
    let responseDone: (() => void) | null = null;
    const responsePromise = new Promise<void>(resolve => { responseDone = resolve; });
    const onRequest = (request: ReturnType<PlaywrightResponse["request"]>) => {
      if (!armed || targetRequest) return;
      const inspected = inspectLowRiskMutationRequest({
        kind,
        url: request.url(),
        postData: request.postData(),
        workId,
      });
      if (!inspected.relevant) return;
      observation.requestSeen = true;
      if (inspected.targetMatched === false) {
        observation.targetMismatch = true;
        responseDone?.();
        return;
      }
      if (inspected.targetMatched == null) return;
      targetRequest = request;
    };
    const onResponse = (response: PlaywrightResponse) => {
      if (!armed || !targetRequest || response.request() !== targetRequest) return;
      void (async () => {
        observation.responseSeen = true;
        observation.responseStatus = response.status();
        const body = await response.json().catch(() => null);
        observation.responseCode = responseBusinessCode(body);
        observation.businessSucceeded = businessCodeSucceeded(observation.responseCode);
        responseDone?.();
      })();
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    const cancel = () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    };
    return {
      arm: () => { armed = true; },
      finish: async () => {
        await Promise.race([responsePromise, sleep(Math.max(2_500, CONFIG.actionDelayMs * 3))]);
        cancel();
        return { ...observation };
      },
      cancel,
    };
  }

  async detectCurrentAccountForSetup(): Promise<DetectedSetupAccount> {
    const pages = (await this.allowedPages()).filter(page => {
      const host = new URL(page.url()).hostname.toLowerCase();
      return ["douyin.com", "www.douyin.com", "creator.douyin.com"].includes(host);
    });
    if (pages.length === 0) {
      throw new Error(
        "SETUP_NO_ALLOWED_TAB: Open a signed-in Douyin profile or Creator Center tab in the dedicated browser, then retry.",
      );
    }

    const candidates = (await Promise.all(pages.map(async page => {
      const pageUrl = page.url();
      const extracted = await page.evaluate(() => {
        type Candidate = {
          displayName: string;
          uid: string;
          secUid: string;
          source: string;
        };
        const results: Candidate[] = [];
        const text = (value: unknown): string =>
          typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
        const first = (record: Record<string, unknown> | null | undefined, keys: string[]): string => {
          if (!record) return "";
          for (const key of keys) {
            const value = text(record[key]);
            if (value) return value;
          }
          return "";
        };
        const append = (record: Record<string, unknown> | null | undefined, source: string): void => {
          if (!record) return;
          results.push({
            displayName: first(record, ["nickname", "nick_name", "display_name", "displayName"]),
            uid: first(record, ["user_id_str", "user_id", "uid"]),
            secUid: first(record, ["sec_user_id", "sec_uid", "secUid"]),
            source,
          });
        };
        const parseJson = (raw: string | null): Record<string, unknown> | null => {
          if (!raw) return null;
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return null;
          }
        };

        append(parseJson(localStorage.getItem("userInfo")), "localStorage:userInfo");
        append(parseJson(localStorage.getItem("user_info")), "localStorage:user_info");
        const renderData = document.querySelector<HTMLScriptElement>("#RENDER_DATA")?.textContent ?? null;
        if (renderData) {
          try {
            const parsed = parseJson(decodeURIComponent(renderData)) as any;
            append(parsed?.app?.user?.info ?? parsed?.app?.userInfo ?? parsed?.app?.user ?? parsed?.user?.info, "render_data");
          } catch {
            const parsed = parseJson(renderData) as any;
            append(parsed?.app?.user?.info ?? parsed?.app?.userInfo ?? parsed?.app?.user ?? parsed?.user?.info, "render_data");
          }
        }
        return results;
      }).catch(() => [] as Array<Omit<DetectedAccountCandidate, "pageUrl">>);
      return extracted.map(candidate => ({ ...candidate, pageUrl }));
    }))).flat();

    return resolveDetectedAccount(candidates);
  }

  private async readLowRiskState(
    page: Page,
    kind: LowRiskPostActionKind,
  ): Promise<{ marker: string; state: string; author?: string }> {
    if (kind === "follow") {
      await page.evaluate(() => {
        const route = document.querySelector<HTMLElement>(".route-scroll-container");
        if (route) route.scrollTop = 0;
        else window.scrollTo({ top: 0 });
      });
      await sleep(350);
      return this.markCurrentAuthorFollow(page);
    }
    return this.markWorkAction(page, kind);
  }

  private targetLowRiskState(kind: LowRiskPostActionKind, add: boolean): string {
    if (kind === "like") return add ? "取消点赞" : "点赞";
    if (kind === "favorite") return add ? "取消收藏" : "收藏";
    return add ? "已关注" : "未关注";
  }

  private lowRiskStateMatches(kind: LowRiskPostActionKind, state: string, add: boolean): boolean {
    if (kind === "follow") {
      const following = state === "已关注" || state === "相互关注";
      return following === add;
    }
    return state === this.targetLowRiskState(kind, add);
  }

  private async reloadLowRiskState(
    target: ResolvedPostWriteTarget,
    kind: LowRiskPostActionKind,
    add: boolean,
  ): Promise<{ completed: boolean; state: string; matched: boolean }> {
    try {
      await target.page.reload({ waitUntil: "commit", timeout: 20_000 }).catch(error => {
        if (workIdFromUrl(target.page.url()) !== target.workId) throw error;
      });
      const context = await this.navigateToStableWork(
        target.page,
        target.context.url,
        target.workId,
      );
      if (context.workId !== target.workId) return { completed: false, state: "wrong_work", matched: false };
      await this.assertOperatorAccount(target.page);
      await this.assertWorkContext(target.page, context);
      const contentType = /\/note\//.test(context.url)
        ? "note" as const
        : /\/article\//.test(context.url)
          ? "article" as const
          : "video" as const;
      if (!await this.lockWorkAutoplay(target.page, target.workId, contentType)) {
        return { completed: false, state: "autoplay_lock_failed", matched: false };
      }
      let lastState = "unknown";
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const state = await this.readLowRiskState(target.page, kind)
          .then(item => item.state)
          .catch(() => "unknown");
        lastState = state;
        if (state !== "unknown") {
          return { completed: true, state, matched: this.lowRiskStateMatches(kind, state, add) };
        }
        await sleep(500);
      }
      return { completed: false, state: lastState, matched: false };
    } catch {
      return { completed: false, state: "unknown", matched: false };
    }
  }

  private releasePostWriteTarget(target: ResolvedPostWriteTarget): void {
    const lock = this.lockedWorkContexts.get(target.pageRole);
    if (lock?.workId === target.workId) this.lockedWorkContexts.delete(target.pageRole);
  }

  private async executeLowRiskPostAction(input: {
    kind: LowRiskPostActionKind;
    add: boolean;
    workId: string;
    scope: TargetWriteScope;
    alias?: string;
    dryRun?: boolean;
    toolName: string;
  }): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const actionType = input.kind;
      let target: ResolvedPostWriteTarget | null = null;
      let workUrl: string | undefined;
      let author: string | undefined;
      let beforeState = "unknown";
      let activeMonitor: ReturnType<DouyinBrowser["installLowRiskNetworkMonitor"]> | null = null;
      try {
        target = await this.resolvePostWriteTarget({
          workId: input.workId,
          scope: input.scope,
          alias: input.alias,
          requireGlobalReady: !input.dryRun,
        });
        workUrl = target.context.url;
        author = target.author;
        await this.assertWorkContext(target.page, target.context);
        const marked = await this.readLowRiskState(target.page, input.kind);
        beforeState = marked.state;
        const targetState = this.targetLowRiskState(input.kind, input.add);
        const beforeLiked = input.kind === "like" ? beforeState === "取消点赞" : undefined;
        if (input.kind === "like") {
          const decision = decideLikeTransition(Boolean(beforeLiked), input.add ? "like" : "unlike");
          if (decision.changed !== !this.lowRiskStateMatches(input.kind, beforeState, input.add)) {
            throw new Error("VALIDATION_FAILED:点赞状态判断不一致。");
          }
        }

        if (input.dryRun || this.lowRiskStateMatches(input.kind, beforeState, input.add)) {
          const reloaded = await this.reloadLowRiskState(target, input.kind, input.add);
          const readbackConfirmed = reloaded.completed
            && (input.dryRun ? reloaded.state === beforeState : reloaded.matched);
          const verification: LowRiskVerification = {
            level: readbackConfirmed ? "reload_confirmed" : "failed",
            requestSeen: false,
            responseSeen: false,
            responseStatus: null,
            responseCode: null,
            persistedAfterReload: readbackConfirmed,
          };
          const success = verificationIsSuccess(verification);
          appendActionLog(this.actionLogBase(input.toolName, input.dryRun ? `${actionType}_dry_run` : actionType, {
            workUrl,
            author,
            recipientAlias: input.alias,
            beforeState,
            afterState: reloaded.state,
            success,
            verification,
          }));
          return {
            toolName: input.toolName,
            actionType,
            success,
            changed: false,
            beforeState,
            afterState: reloaded.state,
            workId: target.workId,
            workUrl,
            author,
            targetAlias: input.alias,
            beforeLiked,
            afterLiked: input.kind === "like" ? reloaded.state === "取消点赞" : undefined,
            verified: success,
            dryRun: Boolean(input.dryRun),
            verification,
            message: input.dryRun
              ? `只读检查完成：目标作品 ${target.workId} 当前状态为“${beforeState}”；未执行点击。`
              : `目标作品 ${target.workId} 已经是“${targetState}”状态；重新加载确认后未重复点击。`,
          };
        }

        await enforceWritePolicy(actionType, workUrl);
        await this.assertWorkContext(target.page, target.context);
        const button = target.page.locator(`[data-codex-action-target="${marked.marker}"]`);
        if (await button.count() !== 1) throw new Error("作品动作按钮在点击前发生变化，已停止操作。");
        activeMonitor = this.installLowRiskNetworkMonitor(target.page, input.kind, target.workId);
        activeMonitor.arm();
        await button.click();
        await sleep(CONFIG.actionDelayMs);
        const currentContext = await this.captureWorkContext(target.page).catch(() => null);
        const contextStable = currentContext?.workId === target.workId;
        const optimisticState = contextStable
          ? await this.readLowRiskState(target.page, input.kind).then(item => item.state).catch(() => "unknown")
          : "wrong_work";
        const optimisticTargetState = contextStable
          && this.lowRiskStateMatches(input.kind, optimisticState, input.add);
        const network = await activeMonitor.finish();
        activeMonitor = null;
        // Reopen the same work even after an explicit HTTP/business success.
        // This catches acknowledgements that the platform later rolls back and
        // proves the account state, while still never issuing a second click.
        if (network.responseSeen) await sleep(5_000);
        const reloaded = contextStable
          ? await this.reloadLowRiskState(target, input.kind, input.add)
          : { completed: false, state: "wrong_work", matched: false };
        const reloadCompleted = reloaded.completed;
        const persistedAfterReload = reloaded.matched;
        const afterState = reloaded.state;
        const verification = classifyLowRiskVerification({
          network,
          optimisticTargetState,
          reloadCompleted,
          persistedAfterReload,
        });
        const success = contextStable && verificationIsSuccess(verification);
        appendActionLog(this.actionLogBase(input.toolName, actionType, {
          workUrl,
          author,
          recipientAlias: input.alias,
          beforeState,
          afterState,
          success,
          verification,
          failureReason: success ? undefined : `LOW_RISK_VERIFICATION_${verification.level.toUpperCase()}`,
        }));
        return {
          toolName: input.toolName,
          actionType,
          success,
          changed: success,
          beforeState,
          afterState,
          workId: target.workId,
          workUrl,
          author,
          targetAlias: input.alias,
          beforeLiked,
          afterLiked: input.kind === "like" && success ? input.add : undefined,
          verified: success,
          dryRun: false,
          uncertainAfterSubmit: verification.level === "unknown_after_submit",
          verification,
          message: success
            ? `${input.kind === "like" ? "点赞" : input.kind === "favorite" ? "收藏" : "关注"}已由${verification.level === "server_confirmed" ? "服务端响应" : "重新加载后的持久状态"}确认。`
            : `动作未被判定为成功：${verification.level}。没有自动重试，也没有第二次点击。`,
        };
      } catch (error) {
        appendActionLog(this.actionLogBase(input.toolName, actionType, {
          workUrl,
          author,
          beforeState,
          success: false,
          failureReason: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      } finally {
        activeMonitor?.cancel();
        if (target) this.releasePostWriteTarget(target);
      }
    });
  }

  async likePost(options: {
    workId: string;
    action: "like" | "unlike";
    scope?: TargetWriteScope;
    alias?: string;
    dryRun?: boolean;
    toolName?: string;
  }): Promise<DouyinActionResult> {
    return this.executeLowRiskPostAction({
      kind: "like",
      add: options.action === "like",
      workId: options.workId,
      scope: options.scope ?? "external_post",
      alias: options.alias,
      dryRun: options.dryRun,
      toolName: options.toolName ?? "douyin_like_post",
    });
  }

  async favoritePost(options: {
    workId: string;
    action: "favorite" | "unfavorite";
    scope?: TargetWriteScope;
    alias?: string;
    dryRun?: boolean;
    toolName?: string;
  }): Promise<DouyinActionResult> {
    return this.executeLowRiskPostAction({
      kind: "favorite",
      add: options.action === "favorite",
      workId: options.workId,
      scope: options.scope ?? "external_post",
      alias: options.alias,
      dryRun: options.dryRun,
      toolName: options.toolName ?? "douyin_favorite_post",
    });
  }

  async followPostAuthor(options: {
    workId: string;
    action: "follow" | "unfollow";
    scope?: TargetWriteScope;
    alias?: string;
    dryRun?: boolean;
    toolName?: string;
  }): Promise<DouyinActionResult> {
    return this.executeLowRiskPostAction({
      kind: "follow",
      add: options.action === "follow",
      workId: options.workId,
      scope: options.scope ?? "external_post",
      alias: options.alias,
      dryRun: options.dryRun,
      toolName: options.toolName ?? "douyin_follow_post_author",
    });
  }

  private async currentPostWriteReference(): Promise<{
    workId: string;
    scope: TargetWriteScope;
    alias?: string;
  }> {
    const page = await this.currentPage();
    const context = await this.captureWorkContext(page);
    const role = this.pageRoles.get(page);
    if (role === "codex_test") return { workId: context.workId, scope: "external_post" };
    if (role === "operator_home") {
      const lock = this.lockedWorkContexts.get("operator_home");
      if (!lock || lock.workId !== context.workId) {
        throw new Error("WORK_NOT_LOCKED:兼容入口无法从当前页得到稳定的作品锁。");
      }
      if (lock.alias === "self") return { workId: context.workId, scope: "own_post" };
      if (lock.alias) return { workId: context.workId, scope: "bound_user_post", alias: lock.alias };
    }
    throw new Error("TARGET_SCOPE_UNKNOWN:兼容入口无法确定当前作品作用域；请改用显式 work_id 工具。");
  }

  async setCurrentWorkReaction(
    kind: "like" | "favorite",
    action: "add" | "remove",
    options: { dryRun?: boolean; toolName?: string } = {},
  ): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const current = await this.currentPostWriteReference();
      return kind === "like"
        ? this.likePost({
            ...current,
            action: action === "add" ? "like" : "unlike",
            dryRun: options.dryRun,
            toolName: options.toolName ?? "douyin_like_current",
          })
        : this.favoritePost({
            ...current,
            action: action === "add" ? "favorite" : "unfavorite",
            dryRun: options.dryRun,
            toolName: options.toolName ?? "douyin_favorite_current",
          });
    });
  }

  async likeBoundUserPost(options: {
    alias?: string;
    workId: string;
    action: "like" | "unlike";
    dryRun?: boolean;
  }): Promise<DouyinActionResult> {
    return this.likePost({
      workId: options.workId,
      action: options.action,
      scope: "bound_user_post",
      alias: options.alias ?? "bound_user",
      dryRun: options.dryRun ?? true,
      toolName: "douyin_like_bound_user_post",
    });
  }

  private async markCurrentAuthorFollow(page: Page): Promise<{ marker: string; state: string; author?: string }> {
    const marker = `codex-follow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await page.evaluate((actionMarker: string) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.right > 0;
      };
      const texts = ["关注", "已关注", "相互关注"];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
        .filter(element => visible(element) && texts.includes((element.innerText || element.textContent || "").trim()))
        .filter(element => !element.closest("nav,[data-e2e='douyin-navigation'],.tab-follow,[data-e2e='conversation-item'],[class*='recommend'],[class*='suggest']"));
      const scored = candidates.map(element => {
        const parent = element.parentElement;
        const profile = parent?.querySelector<HTMLAnchorElement>("a[href*='/user/']")
          ?? parent?.parentElement?.querySelector<HTMLAnchorElement>("a[href*='/user/']");
        const rect = element.getBoundingClientRect();
        const score = (profile ? 10 : 0) + (rect.top > 40 && rect.top < innerHeight - 20 ? 4 : 0);
        return { element, profile, score };
      }).sort((a, b) => b.score - a.score);
      if (!scored.length || (scored.length > 1 && scored[0].score === scored[1].score)) return null;
      const best = scored[0];
      best.element.setAttribute("data-codex-action-target", actionMarker);
      return {
        state: (best.element.innerText || best.element.textContent || "").trim(),
        author: (best.profile?.innerText || best.profile?.textContent || "").trim() || undefined,
      };
    }, marker);
    if (!result) throw new Error("无法唯一确认当前作品作者的关注按钮，未执行操作。");
    return { marker, ...result };
  }

  async setCurrentAuthorFollow(action: "follow" | "unfollow"): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const current = await this.currentPostWriteReference();
      return this.followPostAuthor({
        ...current,
        action,
        toolName: "douyin_follow_current_author",
      });
    });
  }

  private async collectStableWorks(page: Page, needed: number): Promise<Array<{
    safeId: string;
    workId: string;
    url: string;
    title: string;
    author: string;
    contentType: "video" | "note" | "article";
  }>> {
    const collected = new Map<string, {
      safeId: string;
      workId: string;
      url: string;
      title: string;
      author: string;
      contentType: "video" | "note" | "article";
    }>();
    let stablePasses = 0;
    let previousCount = -1;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
        "a[href*='/video/'],a[href*='/note/'],a[href*='/article/'],[data-aweme-id]",
      )).map(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return null;
        const link = element instanceof HTMLAnchorElement ? element : element.querySelector<HTMLAnchorElement>(
          "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
        );
        const url = link ? new URL(link.href, location.href) : null;
        const urlMatch = url?.pathname.match(/\/(video|note|article)\/(\d{16,20})/) ?? null;
        const attributeWorkId = element.getAttribute("data-aweme-id");
        const workId = urlMatch?.[2] ?? attributeWorkId;
        if (!workId || !/^\d{16,20}$/.test(workId)) return null;
        const contentType = (urlMatch?.[1] ?? "video") as "video" | "note" | "article";
        const image = element.querySelector<HTMLImageElement>("img[alt]");
        const alt = (image?.alt ?? "").replace(/\s+/g, " ").trim();
        const separator = alt.search(/[:：]/);
        const lines = (element.innerText || element.textContent || "")
          .split(/\n+/)
          .map(line => line.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const authorLine = lines.find(line => line.startsWith("@")) ?? "";
        const author = separator >= 0 ? alt.slice(0, separator).trim() : authorLine.replace(/^@\s*/, "");
        const contentLines = lines.filter(line =>
          !line.startsWith("@")
          && !/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(line)
          && !/^[\d.]+\s*[万亿]?$/.test(line)
          && !/^(?:正在直播|直播中|[·•]\s*)/.test(line)
          && !/(?:分钟前|小时前|天前|周前|月前|年前|月\d+日)$/.test(line));
        const title = separator >= 0
          ? alt.slice(separator + 1).trim()
          : (contentLines.sort((left, right) => right.length - left.length)[0] ?? "");
        if (!title) return null;
        return {
          safeId: `work-${workId}`,
          workId,
          url: url ? `${url.origin}${url.pathname}` : `https://www.douyin.com/video/${workId}`,
          title,
          author,
          contentType,
        };
      }).filter((item): item is NonNullable<typeof item> => Boolean(item)));
      for (const item of found) collected.set(item.workId, item);
      if (collected.size >= needed) break;
      await page.evaluate(() => scrollBy(0, Math.max(600, Math.floor(innerHeight * 0.85))));
      await sleep(500);
      stablePasses = collected.size === previousCount ? stablePasses + 1 : 0;
      previousCount = collected.size;
      if (stablePasses >= 4) break;
    }
    return Array.from(collected.values());
  }

  private async decorateWorks(items: Awaited<ReturnType<DouyinBrowser["collectStableWorks"]>>) {
    const viewed = await this.stateStore.viewedWorkIds();
    const decorated = items.map(item => ({ ...item, viewed: viewed.has(item.workId) }));
    for (const item of decorated) this.feedWorkCache.set(item.workId, item);
    this.feedWorkOrder = decorated.map(item => item.workId);
    return decorated;
  }

  async searchContent(query: string, limit = 20, cursor?: string): Promise<{
    query: string;
    items: Array<ReturnType<DouyinBrowser["feedWorkCache"]["get"]> extends infer T ? Exclude<T, undefined> : never>;
    count: number;
    cursor: string | null;
    nextCursor: string | null;
    privacyFiltered: true;
  }> {
    return this.serial(async () => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) throw new Error("搜索词不能为空。");
      const cursorMatch = cursor?.match(/^search-(\d+)$/);
      if (cursor && !cursorMatch) throw new Error("搜索游标无效。");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const page = await this.rolePage("codex_test");
      const url = `https://www.douyin.com/search/${encodeURIComponent(normalizedQuery)}?type=video`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator("a[href*='/video/'],a[href*='/note/'],a[href*='/article/'],[data-aweme-id]")
        .first().waitFor({ state: "attached", timeout: 15_000 });
      const all = await this.decorateWorks(await this.collectStableWorks(page, offset + pageSize + 20));
      const items = all.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return {
        query: normalizedQuery,
        items,
        count: items.length,
        cursor: cursor ?? null,
        nextCursor: nextOffset < all.length ? `search-${nextOffset}` : null,
        privacyFiltered: true,
      };
    });
  }

  async listCurrentFeed(limit = 20, cursor?: string): Promise<{
    items: Array<ReturnType<DouyinBrowser["feedWorkCache"]["get"]> extends infer T ? Exclude<T, undefined> : never>;
    count: number;
    cursor: string | null;
    nextCursor: string | null;
    privacyFiltered: true;
  }> {
    return this.serial(async () => {
      const cursorMatch = cursor?.match(/^feed-(\d+)$/);
      if (cursor && !cursorMatch) throw new Error("推荐流游标无效。");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const page = await this.rolePage("codex_test", "https://www.douyin.com/jingxuan");
      if (!/\/(?:jingxuan|discover|recommend)/.test(new URL(page.url()).pathname)) {
        await page.goto("https://www.douyin.com/jingxuan", { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await page.locator("a[href*='/video/'],a[href*='/note/'],a[href*='/article/'],[data-aweme-id]")
        .first().waitFor({ state: "attached", timeout: 15_000 });
      const all = await this.decorateWorks(await this.collectStableWorks(page, offset + pageSize + 20));
      const items = all.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return {
        items,
        count: items.length,
        cursor: cursor ?? null,
        nextCursor: nextOffset < all.length ? `feed-${nextOffset}` : null,
        privacyFiltered: true,
      };
    });
  }

  async openFeedItem(workId?: string, safeId?: string): Promise<{
    item: Exclude<ReturnType<DouyinBrowser["feedWorkCache"]["get"]>, undefined>;
    pageId: string;
    opened: true;
  }> {
    return this.serial(async () => {
      const requested = workId ?? safeId?.match(/^work-(\d{16,20})$/)?.[1];
      if (!requested) throw new Error("必须提供有效 work_id 或 safe_id。");
      let item = this.feedWorkCache.get(requested);
      if (!item) {
        await this.listCurrentFeed(100);
        item = this.feedWorkCache.get(requested);
      }
      if (!item) throw new Error("当前搜索结果或推荐流中没有找到该作品。");
      const page = await this.rolePage("codex_test");
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction((expected: string) =>
        new URL(location.href).pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1] === expected,
      item.workId, { timeout: 15_000 });
      await this.stateStore.markWorkViewed(item.workId);
      const viewedItem = { ...item, viewed: true };
      this.feedWorkCache.set(item.workId, viewedItem);
      this.feedWorkIndex = this.feedWorkOrder.indexOf(item.workId);
      this.activePageId = this.pageId(page);
      return { item: viewedItem, pageId: this.pageId(page), opened: true };
    });
  }

  async moveFeed(direction: "next" | "previous"): Promise<{
    item: Exclude<ReturnType<DouyinBrowser["feedWorkCache"]["get"]>, undefined>;
    pageId: string;
    opened: true;
  }> {
    return this.serial(async () => {
      if (!this.feedWorkOrder.length) await this.listCurrentFeed(50);
      const delta = direction === "next" ? 1 : -1;
      const targetIndex = Math.max(0, Math.min(
        this.feedWorkOrder.length - 1,
        (this.feedWorkIndex < 0 ? (direction === "next" ? -1 : this.feedWorkOrder.length) : this.feedWorkIndex) + delta,
      ));
      const workId = this.feedWorkOrder[targetIndex];
      if (!workId || targetIndex === this.feedWorkIndex) {
        throw new Error(direction === "next" ? "当前推荐流没有下一条作品。" : "当前推荐流没有上一条作品。");
      }
      return this.openFeedItem(workId);
    });
  }

  private async verifyBoundProfile(page: Page, bound: BoundUser): Promise<{ mutualFollow: boolean }> {
    const current = new URL(page.url());
    if (!["douyin.com", "www.douyin.com"].includes(current.hostname.toLowerCase())
      || current.pathname !== `/user/${bound.secUid}`) {
      throw new Error("绑定校验失败：页面 URL 与配置中的稳定 sec_uid 不一致。");
    }
    const verified = await page.evaluate(({ uid, secUid }) => {
      const text = Array.from(document.scripts).map(script => script.textContent ?? "").join("\n");
      return text.includes(uid) && text.includes(secUid);
    }, { uid: bound.uid, secUid: bound.secUid });
    if (!verified) throw new Error("绑定校验失败：页面数据与配置中的稳定 uid/sec_uid 不一致。");
    const mutualFollow = await page.getByText("相互关注", { exact: true }).count().then(async count => {
      for (let i = 0; i < count; i += 1) {
        if (await page.getByText("相互关注", { exact: true }).nth(i).isVisible().catch(() => false)) return true;
      }
      return false;
    });
    return { mutualFollow };
  }

  private async withBoundProfile<T>(bound: BoundUser, task: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.rolePage("codex_test", bound.profileUrl);
    if (page.url() !== bound.profileUrl) {
      await page.goto(bound.profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.locator("[data-e2e='user-detail']").waitFor({ state: "visible", timeout: 30_000 });
    if (bound.allowMessage) {
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='user-detail'] button"))
        .some(button => (button.innerText || button.textContent || "").trim() === "私信"), undefined, { timeout: 30_000 });
    }
    await sleep(CONFIG.actionDelayMs);
    await this.assertOperatorAccount(page);
    await this.verifyBoundProfile(page, bound);
    return task(page);
  }

  async getBoundUserPublic(alias = "bound_user"): Promise<BoundUserPublic> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      return this.withBoundProfile(bound, async page => {
        const status = await this.verifyBoundProfile(page, bound);
        return {
          alias: bound.alias,
          displayName: bound.displayName,
          profileUrl: bound.profileUrl,
          mutualFollow: status.mutualFollow,
          allowShare: bound.allowShare,
          allowMessage: bound.allowMessage,
          verifiedAt: new Date().toISOString(),
        };
      });
    });
  }

  async listProfileRecommendations(
    alias = "bound_user",
    limit = 30,
    cursor?: string,
    unseenOnly = false,
  ): Promise<ProfileRecommendationPage> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const cursorMatch = cursor?.match(/^profile-(\d+)$/);
      if (cursor && !cursorMatch) throw new Error("主页推荐游标无效，请使用上一次返回的 nextCursor。");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const viewed = await this.stateStore.viewedProfileWorkIds();
      const all = await this.withBoundProfile(bound, async page => {
        const marker = `codex-profile-recommend-${Date.now()}`;
        const marked = await page.evaluate((actionMarker: string) => {
          const candidates = Array.from(document.querySelectorAll<HTMLElement>("span,div,h2"))
            .filter(element => {
              const rect = element.getBoundingClientRect();
              return element.children.length === 0
                && (element.innerText || element.textContent || "").trim() === "推荐"
                && rect.width > 20
                && rect.height > 16
                && rect.top > 150
                && rect.bottom < innerHeight;
            })
            .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
          if (!candidates.length) return false;
          const target = candidates[0].parentElement ?? candidates[0];
          target.setAttribute("data-codex-action-target", actionMarker);
          return true;
        }, marker);
        if (!marked) throw new Error("没有找到绑定主页的“推荐”标签。");
        await page.locator(`[data-codex-action-target="${marker}"]`).click();
        await page.waitForFunction(() => new URL(location.href).searchParams.get("showTab") === "recommend", undefined, {
          timeout: 10_000,
        });

        const collected = new Map<string, Omit<ProfileRecommendation, "viewed">>();
        let stablePasses = 0;
        let previousCount = -1;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const items = await page.evaluate(() => {
            const parseCount = (value: string): number | null => {
              const text = value.trim().replace(/,/g, "");
              const match = text.match(/^([\d.]+)\s*([万亿]?)$/);
              if (!match) return null;
              const base = Number(match[1]);
              if (!Number.isFinite(base)) return null;
              return Math.round(base * (match[2] === "万" ? 10_000 : match[2] === "亿" ? 100_000_000 : 1));
            };
            return Array.from(document.querySelectorAll<HTMLAnchorElement>(
              "a.RZuwF26I[href*='/video/'],a.RZuwF26I[href*='/note/'],a.RZuwF26I[href*='/article/']",
            )).map(link => {
              const url = new URL(link.href, location.href);
              const match = url.pathname.match(/\/(video|note|article)\/(\d{16,20})/);
              if (!match) return null;
              const image = link.querySelector<HTMLImageElement>("img[alt]");
              const alt = (image?.alt ?? "").replace(/\s+/g, " ").trim();
              const separator = alt.search(/[：:]/);
              const author = separator >= 0 ? alt.slice(0, separator).trim() : "";
              const title = separator >= 0 ? alt.slice(separator + 1).trim() : alt;
              const textLines = (link.innerText || link.textContent || "")
                .split(/\n+/)
                .map(line => line.trim())
                .filter(Boolean);
              if (!image || separator < 0 || !author || !title) return null;
              return {
                safeId: `profile-${match[2]}`,
                workId: match[2],
                url: `${url.origin}${url.pathname}`,
                title: title || textLines.at(-1) || "",
                author,
                contentType: match[1] as "video" | "note" | "article",
                publishedAt: null,
                stats: {
                  diggCount: textLines.length ? parseCount(textLines[0]) : null,
                  commentCount: null,
                  collectCount: null,
                  shareCount: null,
                },
              };
            }).filter((item): item is NonNullable<typeof item> => Boolean(item));
          });
          for (const item of items) collected.set(item.workId, item);
          await page.evaluate(() => scrollBy(0, Math.max(600, Math.floor(innerHeight * 0.85))));
          await sleep(500);
          if (collected.size === previousCount) stablePasses += 1;
          else stablePasses = 0;
          previousCount = collected.size;
          if (stablePasses >= 4 || collected.size >= Math.max(120, offset + pageSize + 20)) break;
        }
        await page.evaluate(() => scrollTo(0, 0)).catch(() => null);
        return Array.from(collected.values());
      });
      const decorated = all.map(item => ({ ...item, viewed: viewed.has(item.workId) }));
      for (const item of decorated) this.profileRecommendationCache.set(item.workId, item);
      const filtered = unseenOnly ? decorated.filter(item => !item.viewed) : decorated;
      const items = filtered.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return {
        alias: bound.alias,
        displayName: bound.displayName,
        items,
        count: items.length,
        cursor: cursor ?? null,
        nextCursor: nextOffset < filtered.length ? `profile-${nextOffset}` : null,
        unseenOnly,
        privacyFiltered: true,
      };
    });
  }

  async listBoundUserPosts(
    alias = "bound_user",
    limit = 20,
    cursor?: string,
    unseenOnly = false,
  ): Promise<BoundUserPostPage> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const cursorMatch = cursor?.match(/^bound-post-(\d+)$/);
      if (cursor && !cursorMatch) throw new Error("绑定作品游标无效，请使用上一次返回的 nextCursor。");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const viewed = await this.stateStore.viewedProfileWorkIds();
      const all = await this.withBoundProfile(bound, async page => {
        const postTab = page.locator("#semiTabpost,[role='tab'][data-tabkey='semiTabpost']");
        await postTab.first().waitFor({ state: "visible", timeout: 20_000 });
        if (await postTab.count() !== 1) throw new Error("WRONG_PROFILE_TAB:没有唯一找到绑定主页的“作品”标签。");
        if (await postTab.getAttribute("aria-selected") !== "true") {
          await postTab.click();
        }
        await page.waitForFunction(() => {
          const post = document.querySelector<HTMLElement>("#semiTabpost,[role='tab'][data-tabkey='semiTabpost']");
          return post?.getAttribute("aria-selected") === "true";
        }, undefined, { timeout: 10_000 });

        const videoTab = page.locator("#semiTabvideo,[role='tab'][data-tabkey='semiTabvideo']");
        if (await videoTab.count() !== 1) throw new Error("WRONG_PROFILE_TAB:没有唯一找到“作品”子标签。");
        if (await videoTab.getAttribute("aria-selected") !== "true") await videoTab.click();
        const tabState = await page.evaluate(() => ({
          postSelected: document.querySelector("#semiTabpost")?.getAttribute("aria-selected") === "true",
          recommendSelected: document.querySelector("#semiTabrecommend")?.getAttribute("aria-selected") === "true",
          likeSelected: document.querySelector("#semiTablike")?.getAttribute("aria-selected") === "true",
          videoSelected: document.querySelector("#semiTabvideo")?.getAttribute("aria-selected") === "true",
        }));
        assertBoundPostTab(tabState);

        const collected = new Map<string, Omit<BoundUserPost, "viewed">>();
        let stablePasses = 0;
        let previousCount = -1;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const items = await page.evaluate((expectedAuthor: string) => {
            const parseCount = (value: string): number | null => {
              const text = value.trim().replace(/,/g, "");
              const match = text.match(/^([\d.]+)\s*([万亿]?)$/);
              if (!match) return null;
              const base = Number(match[1]);
              if (!Number.isFinite(base)) return null;
              return Math.round(base * (match[2] === "万" ? 10_000 : match[2] === "亿" ? 100_000_000 : 1));
            };
            return Array.from(document.querySelectorAll<HTMLAnchorElement>(
              "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
            )).map(link => {
              const url = new URL(link.href, location.href);
              const match = url.pathname.match(/\/(video|note|article)\/(\d{16,20})/);
              if (!match) return null;
              const image = link.querySelector<HTMLImageElement>("img[alt]");
              const alt = (image?.alt ?? "").replace(/\s+/g, " ").trim();
              const separator = alt.search(/[：:]/);
              const author = separator >= 0 ? alt.slice(0, separator).trim() : "";
              const title = separator >= 0 ? alt.slice(separator + 1).trim() : "";
              if (!author || author !== expectedAuthor || !title) return null;
              const textLines = (link.innerText || link.textContent || "")
                .split(/\n+/)
                .map(line => line.trim())
                .filter(Boolean);
              return {
                safeId: `bound-post-${match[2]}`,
                workId: match[2],
                url: `${url.origin}${url.pathname}`,
                title,
                author,
                contentType: match[1] as "video" | "note" | "article",
                publishedAt: link.querySelector("time")?.getAttribute("datetime") ?? null,
                stats: {
                  diggCount: textLines.length ? parseCount(textLines[0]) : null,
                  commentCount: null,
                },
              };
            }).filter((item): item is NonNullable<typeof item> => Boolean(item));
          }, bound.displayName);
          for (const item of items) {
            if (!collected.has(item.workId)) collected.set(item.workId, item);
          }
          await page.evaluate(() => scrollBy(0, Math.max(600, Math.floor(innerHeight * 0.85))));
          await sleep(450);
          if (collected.size === previousCount) stablePasses += 1;
          else stablePasses = 0;
          previousCount = collected.size;
          if (stablePasses >= 4 || collected.size >= Math.max(120, offset + pageSize + 20)) break;
        }
        await page.evaluate(() => scrollTo(0, 0)).catch(() => null);
        return [...collected.values()];
      });
      const decorated = all.map(item => ({ ...item, viewed: viewed.has(item.workId) }));
      for (const item of decorated) this.boundUserPostCache.set(`${bound.alias}:${item.workId}`, item);
      const filtered = unseenOnly ? decorated.filter(item => !item.viewed) : decorated;
      const items = filtered.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return {
        alias: bound.alias,
        displayName: bound.displayName,
        items,
        count: items.length,
        cursor: cursor ?? null,
        nextCursor: nextOffset < filtered.length ? `bound-post-${nextOffset}` : null,
        unseenOnly,
        profileTab: "post",
        profileSubTab: "video",
        privacyFiltered: true,
      };
    });
  }

  private async verifyBoundWorkAuthor(page: Page, bound: BoundUser, context: WorkContext): Promise<string> {
    const visibleAuthor = await this.currentAuthor(page, context);
    if (visibleAuthor !== bound.displayName) {
      throw new Error("WRONG_AUTHOR:当前作品的可见作者与绑定用户不一致。");
    }
    const verified = await page.evaluate(({ uid, secUid, workId }) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const scripts = Array.from(document.scripts).map(script => script.textContent ?? "").join("\n");
      const authorLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href*="/user/${secUid}"]`))
        .filter(visible);
      const workPresent = new URL(location.href).pathname.includes(workId)
        || new URL(location.href).searchParams.get("modal_id") === workId;
      return {
        stableIdsMatch: scripts.includes(uid) && scripts.includes(secUid),
        visibleAuthorLink: authorLinks.length > 0,
        workPresent,
        authorName: (authorLinks.find(anchor => (anchor.innerText || anchor.textContent || "").trim())
          ?.innerText || "").trim(),
      };
    }, { uid: bound.uid, secUid: bound.secUid, workId: context.workId });
    if (!verified.stableIdsMatch || !verified.visibleAuthorLink || !verified.workPresent) {
      throw new Error("WRONG_AUTHOR:当前作品作者与本地绑定 uid/sec_uid 不一致。");
    }
    return visibleAuthor;
  }

  private async lockWorkAutoplay(
    page: Page,
    workId: string,
    contentType: BoundUserPost["contentType"],
  ): Promise<boolean> {
    if (contentType !== "video") {
      await this.assertWorkContext(page, await this.captureWorkContext(page));
      return true;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const locked = await page.evaluate((expectedWorkId: string) => {
        const current = new URL(location.href);
        const pageWorkId = current.searchParams.get("modal_id")
          ?? current.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? null;
        if (pageWorkId !== expectedWorkId) return false;
        const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"))
          .filter(video => {
            const rect = video.getBoundingClientRect();
            return rect.width > 100 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight;
          })
          .sort((left, right) => {
            const a = left.getBoundingClientRect();
            const b = right.getBoundingClientRect();
            return b.width * b.height - a.width * a.height;
          });
        const video = videos[0];
        if (!video) return false;
        video.loop = true;
        video.dataset.codexWorkLock = expectedWorkId;
        return video.loop && video.dataset.codexWorkLock === expectedWorkId;
      }, workId);
      if (locked) return true;
      await sleep(200);
    }
    return false;
  }

  private async navigateToStableWork(
    page: Page,
    workUrl: string,
    expectedWorkId: string,
  ): Promise<WorkContext> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const currentUrl = new URL(page.url());
        const currentWorkId = currentUrl.searchParams.get("modal_id")
          ?? currentUrl.searchParams.get("aweme_id")
          ?? currentUrl.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? null;
        if (currentWorkId !== expectedWorkId) {
          // Douyin keeps long-lived requests open and occasionally delays the
          // browser's DOMContentLoaded signal. Commit proves that a new
          // document navigation started; the URL + React/work-data checks
          // below are the authoritative readiness barrier.
          await page.goto(workUrl, { waitUntil: "commit", timeout: 20_000 }).catch(error => {
            const reached = new URL(page.url());
            const reachedWorkId = reached.searchParams.get("modal_id")
              ?? reached.searchParams.get("aweme_id")
              ?? reached.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
              ?? null;
            if (reachedWorkId !== expectedWorkId) throw error;
          });
        }
        await page.waitForURL(url => {
          const parsed = new URL(url);
          return (parsed.searchParams.get("modal_id")
            ?? parsed.searchParams.get("aweme_id")
            ?? parsed.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
            ?? null) === expectedWorkId;
        }, { timeout: 20_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => null);
        await page.waitForFunction((workId: string) => {
          const current = new URL(location.href);
          const currentWorkId = current.searchParams.get("modal_id")
            ?? current.searchParams.get("aweme_id")
            ?? current.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
            ?? null;
          if (currentWorkId !== workId) return false;
          const reactRoot = document.querySelector(
            "#root,#douyin-right-container,[data-e2e='modal-video-container'],[data-e2e='video-detail']",
          );
          const workData = document.querySelector(
            `[data-e2e='modal-video-container'],[data-e2e='video-detail'],`
            + `[data-aweme-id='${workId}'],[data-work-id='${workId}']`,
          );
          return Boolean(reactRoot && (workData || document.body.innerText.length > 100));
        }, expectedWorkId, { timeout: 20_000 });
        const context = await this.captureWorkContext(page);
        if (context.workId !== expectedWorkId) {
          throw new Error(
            `WRONG_PAGE:导航后 work_id=${context.workId}，目标为 ${expectedWorkId}。`,
          );
        }
        return context;
      } catch (error) {
        lastError = error;
        const recoverable = /Execution context was destroyed|navigation|Target page, context or browser has been closed/i
          .test(String(error));
        if (attempt === 0 && recoverable && !page.isClosed()) {
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => null);
          continue;
        }
        break;
      }
    }
    throw new Error(`NAVIGATION_UNSTABLE:${String(lastError)}`);
  }

  async openBoundUserPost(
    alias = "bound_user",
    workId?: string,
    safeId?: string,
  ): Promise<BoundUserPostOpenResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const requestedWorkId = workId ?? safeId?.match(/^bound-post-(\d{16,20})$/)?.[1];
      if (!requestedWorkId || !/^\d{16,20}$/.test(requestedWorkId)) {
        throw new Error("必须提供有效的 work_id 或 douyin_list_bound_user_posts 返回的 safe_id。");
      }
      let item = this.boundUserPostCache.get(`${bound.alias}:${requestedWorkId}`);
      if (!item) {
        const listed = await this.listBoundUserPosts(bound.alias, 100, undefined, false);
        item = listed.items.find(candidate => candidate.workId === requestedWorkId);
      }
      if (!item) throw new Error("BOUND_POST_NOT_FOUND:绑定用户“作品”列表中没有找到目标作品。");

      const page = await this.formalOperatorPage();
      const context = await this.navigateToStableWork(page, item.url, item.workId);
      await this.assertOperatorAccount(page);
      const author = await this.verifyBoundWorkAuthor(page, bound, context);
      const autoplayLocked = await this.lockWorkAutoplay(page, item.workId, item.contentType);
      if (!autoplayLocked) throw new Error("WORK_LOCK_FAILED:无法锁定当前作品的自动播放上下文。");
      await this.assertWorkContext(page, context);
      this.lockedWorkContexts.set("operator_home", {
        workId: item.workId,
        workUrl: page.url(),
        alias: bound.alias,
        author,
        autoplayLocked,
        lockedAt: new Date().toISOString(),
      });
      await this.stateStore.markProfileWorkViewed(item.workId);
      await page.bringToFront();
      this.activePageId = this.pageId(page);
      this.latestElements.clear();
      return {
        opened: true,
        pageRole: "operator_home",
        pageId: this.pageId(page),
        alias: bound.alias,
        workId: item.workId,
        workUrl: page.url(),
        title: item.title,
        author,
        authorVerified: true,
        loginVerified: true,
        workLocked: true,
        autoplayLocked,
        contentType: item.contentType,
      };
    });
  }

  async openLatestBoundUserPost(alias = "bound_user"): Promise<BoundUserPostOpenResult> {
    return this.serial(async () => {
      const posts = await this.listBoundUserPosts(alias, 1, undefined, false);
      const latest = posts.items[0];
      if (!latest) throw new Error("绑定用户当前没有可打开的发布作品。");
      return this.openBoundUserPost(alias, latest.workId);
    });
  }

  async listOwnPosts(
    limit = 20,
    cursor?: string,
    unseenOnly = false,
  ): Promise<OwnPostPage> {
    return this.serial(async () => {
      const cursorMatch = cursor?.match(/^own-post-(\d+)$/);
      if (cursor && !cursorMatch) throw new Error("自己的作品游标无效，请使用上一次返回的 nextCursor。");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const operator = loadActionSettings().operator;
      const page = await this.formalOperatorPage();
      const profileUrl = "https://www.douyin.com/user/self?from_tab_name=main";
      if (!page.url().startsWith("https://www.douyin.com/user/self")) {
        this.lockedWorkContexts.delete("operator_home");
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      await this.assertOperatorAccount(page);
      await page.locator("[data-e2e='user-detail']").waitFor({ state: "visible", timeout: 20_000 });
      const postTab = page.locator("#semiTabpost,[role='tab'][data-tabkey='semiTabpost']");
      await postTab.first().waitFor({ state: "visible", timeout: 20_000 });
      if (await postTab.count() !== 1) throw new Error("WRONG_PROFILE_TAB:没有唯一找到 Operator 主页的“作品”标签。");
      if (await postTab.getAttribute("aria-selected") !== "true") await postTab.click();
      await page.waitForFunction(() =>
        document.querySelector("#semiTabpost")?.getAttribute("aria-selected") === "true",
      undefined, { timeout: 10_000 });
      const videoTab = page.locator("#semiTabvideo,[role='tab'][data-tabkey='semiTabvideo']");
      if (await videoTab.count() !== 1) throw new Error("WRONG_PROFILE_TAB:没有唯一找到 Operator 的“作品”子标签。");
      if (await videoTab.getAttribute("aria-selected") !== "true") await videoTab.click();
      assertBoundPostTab(await page.evaluate(() => ({
        postSelected: document.querySelector("#semiTabpost")?.getAttribute("aria-selected") === "true",
        recommendSelected: document.querySelector("#semiTabrecommend")?.getAttribute("aria-selected") === "true",
        likeSelected: document.querySelector("#semiTablike")?.getAttribute("aria-selected") === "true",
        videoSelected: document.querySelector("#semiTabvideo")?.getAttribute("aria-selected") === "true",
      })));

      const viewed = await this.stateStore.viewedProfileWorkIds();
      const collected = new Map<string, Omit<OwnPost, "viewed">>();
      let stablePasses = 0;
      let previousCount = -1;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const items = await page.evaluate((expectedAuthor: string) => {
          const parseCount = (value: string): number | null => {
            const text = value.trim().replace(/,/g, "");
            const match = text.match(/^([\d.]+)\s*([万亿]?)$/);
            if (!match) return null;
            const base = Number(match[1]);
            if (!Number.isFinite(base)) return null;
            return Math.round(base * (match[2] === "万" ? 10_000 : match[2] === "亿" ? 100_000_000 : 1));
          };
          return Array.from(document.querySelectorAll<HTMLAnchorElement>(
            "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
          )).map(link => {
            const url = new URL(link.href, location.href);
            const match = url.pathname.match(/\/(video|note|article)\/(\d{16,20})/);
            if (!match) return null;
            const alt = (link.querySelector<HTMLImageElement>("img[alt]")?.alt ?? "")
              .replace(/\s+/g, " ").trim();
            const separator = alt.search(/[：:]/);
            const author = separator >= 0 ? alt.slice(0, separator).trim() : "";
            const title = separator >= 0 ? alt.slice(separator + 1).trim() : "";
            if (author !== expectedAuthor || !title) return null;
            const numberLines = (link.innerText || link.textContent || "")
              .split(/\n+/).map(line => line.trim()).filter(line => /^[\d.]+\s*[万亿]?$/.test(line));
            return {
              safeId: `own-post-${match[2]}`,
              workId: match[2],
              url: `${url.origin}${url.pathname}`,
              title,
              contentType: match[1] as "video" | "note" | "article",
              publishedAt: link.querySelector("time")?.getAttribute("datetime") ?? null,
              stats: {
                playCount: numberLines.length ? parseCount(numberLines[0]) : null,
                diggCount: null,
                commentCount: numberLines.length > 1 ? parseCount(numberLines[1]) : null,
              },
            };
          }).filter((item): item is NonNullable<typeof item> => Boolean(item));
        }, operator.displayName);
        for (const item of items) {
          if (!collected.has(item.workId)) collected.set(item.workId, item);
        }
        await page.evaluate(() => scrollBy(0, Math.max(600, Math.floor(innerHeight * 0.85))));
        await sleep(450);
        if (collected.size === previousCount) stablePasses += 1;
        else stablePasses = 0;
        previousCount = collected.size;
        if (stablePasses >= 4 || collected.size >= Math.max(120, offset + pageSize + 20)) break;
      }
      await page.evaluate(() => scrollTo(0, 0)).catch(() => null);
      const decorated = [...collected.values()].map(item => ({ ...item, viewed: viewed.has(item.workId) }));
      for (const item of decorated) this.ownPostCache.set(item.workId, item);
      const filtered = unseenOnly ? decorated.filter(item => !item.viewed) : decorated;
      const items = filtered.slice(offset, offset + pageSize);
      const nextOffset = offset + items.length;
      return {
        items,
        count: items.length,
        cursor: cursor ?? null,
        nextCursor: nextOffset < filtered.length ? `own-post-${nextOffset}` : null,
        unseenOnly,
        pageRole: "operator_home",
        profileTab: "post",
        profileSubTab: "video",
      };
    });
  }

  private async verifyOwnWorkAuthor(page: Page, context: WorkContext): Promise<string> {
    const operator = loadActionSettings().operator;
    await page.waitForFunction(({ secUid, displayName }) => {
      return Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href*="/user/${secUid}"]`))
        .some(anchor => {
          const rect = anchor.getBoundingClientRect();
          return rect.width > 0
            && rect.height > 0
            && (anchor.innerText || anchor.textContent || "").trim() === displayName;
        });
    }, { secUid: operator.secUid, displayName: operator.displayName }, { timeout: 20_000 });
    const visibleAuthor = await this.currentAuthor(page, context);
    if (visibleAuthor !== operator.displayName) {
      throw new Error("WRONG_AUTHOR:当前作品的可见作者不是已验证的 Operator。");
    }
    const verified = await page.evaluate(({ uid, secUid, workId }) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const scripts = Array.from(document.scripts).map(script => script.textContent ?? "").join("\n");
      const authorLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(`a[href*="/user/${secUid}"]`))
        .filter(visible);
      const url = new URL(location.href);
      const currentWorkId = url.searchParams.get("modal_id")
        ?? url.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
        ?? null;
      return {
        stableIdsMatch: scripts.includes(uid) && scripts.includes(secUid),
        visibleAuthorLink: authorLinks.length > 0,
        currentWorkId,
        authorName: (authorLinks.find(anchor => (anchor.innerText || anchor.textContent || "").trim())
          ?.innerText || "").trim(),
        expectedWorkId: workId,
      };
    }, { uid: operator.uid, secUid: operator.secUid, workId: context.workId });
    if (!verified.stableIdsMatch || !verified.visibleAuthorLink || verified.currentWorkId !== context.workId) {
      throw new Error("WRONG_AUTHOR:当前作品不是已验证的 Operator 自有作品。");
    }
    return visibleAuthor;
  }

  async openOwnPost(workId: string): Promise<OwnPostOpenResult> {
    return this.serial(async () => {
      if (!/^\d{16,20}$/.test(workId)) throw new Error("work_id 格式无效。");
      let item = this.ownPostCache.get(workId);
      if (!item) {
        const posts = await this.listOwnPosts(100, undefined, false);
        item = posts.items.find(candidate => candidate.workId === workId);
      }
      if (!item) throw new Error("OWN_POST_NOT_FOUND:Operator 的“作品”列表中没有找到目标作品。");
      const page = await this.formalOperatorPage();
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction((expectedWorkId: string) => {
        const url = new URL(location.href);
        return (url.searchParams.get("modal_id")
          ?? url.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]) === expectedWorkId;
      }, item.workId, { timeout: 15_000 });
      await this.assertOperatorAccount(page);
      const context = await this.captureWorkContext(page);
      const author = await this.verifyOwnWorkAuthor(page, context);
      const autoplayLocked = await this.lockWorkAutoplay(page, item.workId, item.contentType);
      if (!autoplayLocked) throw new Error("WORK_LOCK_FAILED:无法锁定 Operator 自有作品上下文。");
      await this.assertWorkContext(page, context);
      this.lockedWorkContexts.set("operator_home", {
        workId: item.workId,
        workUrl: page.url(),
        alias: "self",
        author,
        autoplayLocked,
        lockedAt: new Date().toISOString(),
      });
      await this.stateStore.markProfileWorkViewed(item.workId);
      await page.bringToFront();
      this.activePageId = this.pageId(page);
      this.latestElements.clear();
      return {
        opened: true,
        pageRole: "operator_home",
        pageId: this.pageId(page),
        workId: item.workId,
        workUrl: page.url(),
        title: item.title,
        author,
        authorVerified: true,
        loginVerified: true,
        workLocked: true,
        autoplayLocked,
        contentType: item.contentType,
      };
    });
  }

  async readOwnPostComments(options: {
    workId: string;
    sort?: "hot" | "latest";
    limit?: number;
    includeReplies?: boolean;
    repliesPerComment?: number;
  }): Promise<CommentReadResult> {
    return this.serial(async () => {
      await this.openOwnPost(options.workId);
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      await this.verifyOwnWorkAuthor(page, context);
      const sort = options.sort ?? "hot";
      if (sort === "latest") {
        const latest = page.getByText("最新", { exact: true });
        const visible: number[] = [];
        for (let index = 0; index < await latest.count(); index += 1) {
          if (await latest.nth(index).isVisible().catch(() => false)) visible.push(index);
        }
        if (visible.length === 1) await latest.nth(visible[0]).click();
        else if (visible.length > 1) throw new Error("VALIDATION_FAILED:评论排序控件不唯一。");
      }
      const limit = Math.max(1, Math.min(100, options.limit ?? 30));
      const includeReplies = options.includeReplies ?? true;
      const repliesPerComment = Math.max(1, Math.min(100, options.repliesPerComment ?? 20));
      await this.loadComments(page, limit);
      if (includeReplies) {
        const expand = page.locator(".comment-reply-expand-btn:visible").filter({ hasText: "展开" });
        for (let index = 0; index < Math.min(await expand.count(), limit); index += 1) {
          await expand.nth(index).click({ timeout: 3_000 }).catch(() => null);
          await sleep(150);
        }
      }
      await this.assertWorkContext(page, context);
      const comments = await this.parseComments(page, limit, includeReplies, repliesPerComment);
      return {
        url: context.url,
        workId: context.workId,
        sort,
        comments,
        count: comments.length,
        privacyFiltered: true,
      };
    });
  }

  async checkOwnCommentUpdates(limit = 20): Promise<OwnCommentUpdatesResult> {
    return this.serial(async () => {
      const posts = await this.listOwnPosts(Math.max(1, Math.min(20, limit)), undefined, false);
      const all: OwnCommentUpdatesResult["items"] = [];
      for (const post of posts.items) {
        const result = await this.readOwnPostComments({
          workId: post.workId,
          sort: "latest",
          limit: 100,
          includeReplies: true,
          repliesPerComment: 100,
        });
        for (const comment of result.comments) {
          all.push({
            workId: post.workId,
            workTitle: post.title,
            commentId: comment.commentId,
            parentCommentId: null,
            author: comment.author,
            text: comment.text,
            time: comment.time,
            isReply: false,
          });
          for (const reply of comment.replies ?? []) {
            all.push({
              workId: post.workId,
              workTitle: post.title,
              commentId: reply.commentId,
              parentCommentId: comment.commentId,
              author: reply.author,
              text: reply.text,
              time: reply.time,
              isReply: true,
            });
          }
        }
      }
      const fresh = await this.stateStore.consumeNewOwnCommentIds(all.map(item => item.commentId));
      const items = all.filter(item => fresh.has(item.commentId)).slice(0, Math.max(1, Math.min(100, limit)));
      return {
        items,
        newCount: items.length,
        scannedWorkCount: posts.items.length,
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async openCreatorCommentManager(workId?: string): Promise<CreatorCommentManagerOpenResult> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      let snapshot = await this.captureCreatorRootSnapshot(page);
      if (workId) snapshot = await this.selectCreatorWork(page, workId, snapshot);
      if (workId && snapshot.workId !== workId) {
        throw new Error("WRONG_PAGE:创作者中心评论管理页没有筛选到 target work_id。");
      }
      await page.bringToFront();
      this.activePageId = this.pageId(page);
      return {
        opened: true,
        pageRole: "creator_center",
        accountVerified: true,
        workId: snapshot.workId,
        workTitle: await this.creatorSelectedWorkTitle(page),
        commentManagerReady: true,
      };
    }, { restoreOnError: false });
  }

  private async recoverStartupPageBindings(): Promise<
    DouyinStartupSelfCheckResult["bindingsRecovered"]
  > {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("PAGE_BINDING_LOST:没有可用的专用浏览器上下文。");
    type StartupRole = Exclude<PageRole, "notifications" | "notification_target">;
    const roles: StartupRole[] = [
      "operator_home",
      "creator_center",
      "publisher",
      "bound_messages",
      "codex_test",
    ];
    for (const role of roles) {
      const page = this.rolePages.get(role);
      if (page) this.pageRoles.delete(page);
      this.rolePages.delete(role);
    }
    const persisted = loadPageBindings();
    const assigned = new Set<Page>();
    const recovered: DouyinStartupSelfCheckResult["bindingsRecovered"] = [];
    const operator = loadActionSettings().operator;

    const roleMatches = (page: Page, role: StartupRole): boolean => {
      if (page.isClosed()) return false;
      try {
        const url = new URL(page.url());
        const host = url.hostname.toLowerCase();
        if (role === "creator_center") {
          return host === "creator.douyin.com"
            && ["/creator-micro/interactive/comment", "/creator-micro/data/following/comment"]
              .includes(url.pathname);
        }
        if (role === "publisher") {
          return host === "creator.douyin.com"
            && url.pathname.startsWith("/creator-micro/content/");
        }
        if (role === "bound_messages") {
          return ["douyin.com", "www.douyin.com"].includes(host) && url.pathname === "/chat";
        }
        if (role === "operator_home") {
          return ["douyin.com", "www.douyin.com"].includes(host)
            && (
              url.pathname === "/user/self"
              || url.pathname.includes(`/user/${operator.secUid}`)
              || /\/(?:video|note|article)\/\d{16,20}/.test(url.pathname)
            );
        }
        return ["douyin.com", "www.douyin.com"].includes(host)
          && (
            /\/(?:jingxuan|discover|recommend|search)/.test(url.pathname)
            || /\/(?:video|note|article)\/\d{16,20}/.test(url.pathname)
          );
      } catch {
        return false;
      }
    };
    const openUrls: Record<StartupRole, string> = {
      creator_center: "https://creator.douyin.com/creator-micro/interactive/comment",
      operator_home: "https://www.douyin.com/user/self?from_tab_name=main",
      publisher: "https://creator.douyin.com/creator-micro/content/manage",
      bound_messages: "https://www.douyin.com/chat",
      codex_test: "https://www.douyin.com/jingxuan",
    };

    for (const role of roles) {
      const binding = persisted.get(role);
      let page: Page | undefined;
      let source: "persisted_target" | "unique_candidate" | "opened";
      if (binding?.browserProfileId === browserProfileId) {
        page = context.pages().find(candidate =>
          !assigned.has(candidate)
          && roleMatches(candidate, role)
          && this.pageTargetIds.get(candidate) === binding.targetId);
        if (!page) {
          for (const candidate of context.pages()) {
            if (assigned.has(candidate) || !roleMatches(candidate, role)) continue;
            if (await this.pageTargetId(candidate).catch(() => "") === binding.targetId) {
              page = candidate;
              break;
            }
          }
        }
      }
      if (page) {
        source = "persisted_target";
      } else {
        const candidates = context.pages().filter(candidate =>
          !assigned.has(candidate) && roleMatches(candidate, role));
        const decision = decideStartupBinding(false, candidates.length);
        if (decision === "binding_conflict") {
          throw new Error(
            `PAGE_BINDING_CONFLICT:role=${role} 有 ${candidates.length} 个可信候选页，禁止猜测。`,
          );
        }
        if (decision === "unique_candidate") {
          page = candidates[0];
          source = "unique_candidate";
        } else {
          page = await this.createAutomationPage(context, `role:${role}`);
          await page.goto(openUrls[role], {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          source = "opened";
        }
      }
      this.bindPageRole(page, role);
      assigned.add(page);
      const targetId = await this.pageTargetId(page);
      const creatorAccount = role === "creator_center"
        ? await this.assertCreatorCenterAccount(page)
        : null;
      if (role === "operator_home" || role === "publisher") {
        await this.assertOperatorAccount(page);
      }
      savePageBinding({
        role,
        pageId: this.pageId(page),
        targetId,
        url: page.url(),
        account: role === "creator_center"
          ? creatorAccount?.displayName ?? null
          : ["operator_home", "publisher"].includes(role)
            ? operator.displayName
            : null,
        accountUid: creatorAccount?.uid,
        accountSecUid: creatorAccount?.secUid,
        pageTitle: await page.title().catch(() => null),
        browserProfileId,
        verifiedAt: new Date().toISOString(),
        boundAt: new Date().toISOString(),
      });
      const pageId = this.pageId(page);
      recovered.push({
        role,
        pageId,
        aliases: pageReferenceAliases(role, targetId),
        targetId,
        url: page.url(),
        source,
      });
    }
    await this.cleanupDuplicateUnassignedProfilePages(context.pages(), assigned);
    return recovered;
  }

  async startupSelfCheck(options: {
    workId?: string;
    allowBrowserLaunch?: boolean;
    reconcilePendingOperations?: boolean;
  } = {}): Promise<DouyinStartupSelfCheckResult> {
    const checkedAt = new Date().toISOString();
    const requestedWorkId = options.workId ?? null;
    let browserLaunched = false;
    try {
      const browserState = await ensureDedicatedBrowserConnected(
        options.allowBrowserLaunch ?? true,
      );
      browserLaunched = browserState.launched;
    } catch (error) {
      const blockedReasons = [String(error)];
      setWriteGateState({
        mode: "read_only",
        globalWriteReady: false,
        browserConnected: false,
        profileVerified: false,
        accountVerified: false,
        creatorCenterReady: false,
        workVerified: false,
        ledgerWritable: false,
        workId: null,
        unresolvedOperationIds: [],
        blockedReasons,
        checkedAt,
      });
      return {
        browserConnected: false,
        accountVerified: false,
        creatorCenterReady: false,
        workVerified: true,
        globalWriteReady: false,
        requestedWorkId,
        browserLaunched: false,
        browserProfileId: null,
        bindingsRecovered: [],
        pendingOperations: [],
        pendingOperationsBlockGlobalWrites: false,
        rootCommentLockMode: "same_text_only",
        reconciledOperations: [],
        commentDedupeCount: 0,
        writeReady: false,
        mode: "read_only",
        blockedReasons,
        checkedAt,
      };
    }

    return this.serial(async () => {
      const blockedReasons: string[] = [];
      let bindingsRecovered: DouyinStartupSelfCheckResult["bindingsRecovered"] = [];
      let accountVerified = false;
      let creatorCenterReady = false;
      const pendingOperations = [
        ...this.creatorReplyStore
          .listRecoverable()
          .map(operation => operation.transactionId),
        ...this.writeOperationStore
          .listRecoverableGeneral()
          .map(operation => operation.operationId),
        ...this.creatorCommentDeleteStore
          .listUnresolvedAfterSubmit()
          .map(operation => operation.operationId),
        ...postDraftStore
          .listUnresolved()
          .map(operation => operation.operationId),
        ...publisherV2Store
          .listUnresolved()
          .map(operation => operation.operationId),
        ...this.socialOperationStore
          .listUnresolved()
          .map(operation => operation.operationId),
      ];
      let reconcile: CreatorReplyReconcileResult = {
        checkedAt,
        operations: [],
        unresolvedOperationIds: [],
        sent: false,
      };
      const ledger = this.writeOperationStore.health();
      if (!ledger.writable) blockedReasons.push(`ledger_unavailable:${ledger.error}`);
      const deleteLedger = this.creatorCommentDeleteStore.health();
      if (!deleteLedger.writable) {
        blockedReasons.push(`delete_ledger_unavailable:${deleteLedger.error}`);
      }
      const socialLedger = this.socialOperationStore.health();
      if (!socialLedger.writable) {
        blockedReasons.push(`social_ledger_unavailable:${socialLedger.error}`);
      }
      try {
        bindingsRecovered = await this.recoverStartupPageBindings();
        creatorCenterReady = true;
        accountVerified = true;
      } catch (error) {
        blockedReasons.push(String(error));
      }
      if (options.reconcilePendingOperations ?? true) {
        reconcile = await this.reconcileReplyOperationsUnlocked();
        const general = await this.reconcileGeneralWriteOperationsUnlocked();
        reconcile.operations.push(...general.operations);
        reconcile.unresolvedOperationIds.push(...general.unresolvedOperationIds);
        const social = await this.reconcileSocialOperationsUnlocked();
        reconcile.operations.push(...social.operations);
        reconcile.unresolvedOperationIds.push(...social.unresolvedOperationIds);
        for (const pendingDelete of this.creatorCommentDeleteStore
          .listUnresolvedAfterSubmit()) {
          const previousState: "delete_started" | "unknown_after_submit" =
            pendingDelete.state === "delete_started"
              ? "delete_started"
              : "unknown_after_submit";
          const readback = await this.readCreatorCommentDeleteStatusUnlocked(
            pendingDelete.operationId,
          );
          reconcile.operations.push({
            operationId: pendingDelete.operationId,
            previousState,
            state: readback.state === "confirmed"
              ? "confirmed"
              : "unknown_after_submit",
            result: readback.state === "confirmed"
              ? "confirmed"
              : "still_unknown",
            commentId: pendingDelete.commentId,
            error: readback.lastError,
            operationType: "delete_creator_comment",
          });
          if (readback.state !== "confirmed") {
            reconcile.unresolvedOperationIds.push(pendingDelete.operationId);
          }
        }
        for (const operation of postDraftStore.listUnresolved()) {
          const previousState = operation.state;
          try {
            const readback = await this.verifyPublishedPostOperation(operation);
            if (readback.confirmed) {
              const confirmed = postDraftStore.updateOperation(operation.operationId, {
                state: "confirmed",
                resultingWorkId: readback.workId,
                resultingWorkUrl: readback.workUrl,
                lastError: null,
              });
              reconcile.operations.push({
                operationId: operation.operationId,
                previousState,
                state: confirmed.state,
                result: "confirmed",
                resultingWorkId: confirmed.resultingWorkId,
                error: null,
                operationType: "publish_post",
              });
            } else {
              const unknown = postDraftStore.updateOperation(operation.operationId, {
                state: "unknown_after_submit",
                lastError: readback.reason,
              });
              reconcile.operations.push({
                operationId: operation.operationId,
                previousState,
                state: unknown.state,
                result: "still_unknown",
                resultingWorkId: unknown.resultingWorkId,
                error: readback.reason,
                operationType: "publish_post",
              });
              reconcile.unresolvedOperationIds.push(operation.operationId);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const unknown = postDraftStore.updateOperation(operation.operationId, {
              state: "unknown_after_submit",
              lastError: message,
            });
            reconcile.operations.push({
              operationId: operation.operationId,
              previousState,
              state: unknown.state,
              result: "still_unknown",
              resultingWorkId: unknown.resultingWorkId,
              error: message,
              operationType: "publish_post",
            });
            reconcile.unresolvedOperationIds.push(operation.operationId);
          }
        }
      } else {
        reconcile.unresolvedOperationIds = [
          ...this.creatorReplyStore
            .listUnresolvedAfterSubmit()
            .map(operation => operation.transactionId),
          ...this.writeOperationStore
            .listUnresolvedGeneral()
            .map(operation => operation.operationId),
          ...this.creatorCommentDeleteStore
            .listUnresolvedAfterSubmit()
            .map(operation => operation.operationId),
          ...postDraftStore
            .listUnresolved()
            .map(operation => operation.operationId),
        ];
      }
      reconcile.unresolvedOperationIds = this.collectAllUnresolvedOperationIds();
      const globalBlockingOperationIds = this.collectGlobalBlockingUnresolvedOperationIds();
      if (globalBlockingOperationIds.length > 0
        && !blockedReasons.includes("unresolved_reply_operations")) {
        blockedReasons.push("unresolved_reply_operations");
      }
      const commentDedupeCount = (await this.stateStore.knownCreatorCommentIds()).size;
      const mode = startupFailureMode(blockedReasons);
      const globalWriteReady = mode === "write_ready"
        && ledger.writable
        && deleteLedger.writable
        && socialLedger.writable
        && accountVerified
        && bindingsRecovered.length === 5;
      setWriteGateState({
        mode: globalWriteReady ? "write_ready" : mode,
        globalWriteReady,
        browserConnected: true,
        profileVerified: true,
        accountVerified,
        creatorCenterReady,
        workVerified: true,
        ledgerWritable: ledger.writable,
        workId: null,
        unresolvedOperationIds: globalBlockingOperationIds,
        blockedReasons,
        checkedAt,
      });
      return {
        browserConnected: true,
        accountVerified,
        creatorCenterReady,
        workVerified: true,
        globalWriteReady,
        requestedWorkId,
        browserLaunched,
        browserProfileId,
        bindingsRecovered,
        pendingOperations,
        pendingOperationsBlockGlobalWrites: globalBlockingOperationIds.length > 0,
        rootCommentLockMode: "same_text_only",
        reconciledOperations: reconcile.operations,
        commentDedupeCount,
        writeReady: globalWriteReady,
        mode: globalWriteReady ? "write_ready" : mode,
        blockedReasons,
        checkedAt,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async healthcheck(): Promise<DouyinHealthcheckResult> {
    return this.serial(async () => {
      await this.ensurePageRoles();
      let creatorReady = false;
      let creatorReason: string | null = null;
      let publisherReady = false;
      let publisherReason: string | null = null;
      try {
        await this.creatorCenterPage();
        creatorReady = true;
      } catch (error) {
        creatorReason = String(error);
      }
      try {
        await this.publisherPage();
        publisherReady = true;
      } catch (error) {
        publisherReason = String(error);
      }
      const bindings = loadPageBindings();
      const roles: PageRole[] = [
        "operator_home",
        "creator_center",
        "publisher",
        "bound_messages",
        "codex_test",
      ];
      const pages: DouyinHealthcheckResult["pages"] = [];
      for (const role of roles) {
        const page = this.rolePages.get(role);
        const binding = bindings.get(role);
        const targetId = page && !page.isClosed()
          ? await this.pageTargetId(page).catch(() => null)
          : null;
        let accountVerified: boolean | null = null;
        let reason: string | null = null;
        if (role === "creator_center") {
          accountVerified = creatorReady;
          reason = creatorReason;
        } else if (role === "operator_home" && page && !page.isClosed()) {
          accountVerified = await this.assertOperatorAccount(page)
            .then(() => true)
            .catch(error => {
              reason = String(error);
              return false;
            });
        }
        const viewportDiagnostics = page && !page.isClosed()
          ? await this.viewportDiagnostics(page).catch(() => null)
          : null;
        const warnings = viewportDiagnostics?.mismatch
          ? [
              `viewport_mismatch:playwright=${viewportDiagnostics.playwright.width}x${viewportDiagnostics.playwright.height};css=${viewportDiagnostics.css.width}x${viewportDiagnostics.css.height}`,
            ]
          : [];
        pages.push({
          role,
          pageId: page && !page.isClosed() ? this.pageId(page) : `page-${role.replaceAll("_", "-")}`,
          targetId,
          url: page && !page.isClosed() ? page.url() : null,
          ready: Boolean(page && !page.isClosed() && (!reason)),
          accountVerified,
          bindingFresh: Boolean(binding && targetId && binding.targetId === targetId),
          viewportDiagnostics,
          warnings,
          reason: page && !page.isClosed() ? reason : "page_missing",
        });
      }
      const creatorCapability = {
        status: creatorReady ? "ready" as const : "unavailable" as const,
        reason: creatorReady ? null : creatorReason ?? "creator_center_unavailable",
      };
      const publisherCapability = {
        status: publisherReady ? "ready" as const : "unavailable" as const,
        reason: publisherReady ? null : publisherReason ?? "publisher_unavailable",
      };
      const deleteLedger = this.creatorCommentDeleteStore.health();
      const creatorDeleteCapability = creatorReady && deleteLedger.writable
        ? { status: "ready" as const, reason: null }
        : {
            status: "unavailable" as const,
            reason: !creatorReady
              ? creatorReason ?? "creator_center_unavailable"
              : `delete_ledger_unavailable:${deleteLedger.error}`,
          };
      const runtimeGate = getWriteGateState();
      const ownRootCommentCapability = runtimeGate.globalWriteReady
        ? { status: "ready" as const, reason: null }
        : {
            status: "unavailable" as const,
            reason: runtimeGate.blockedReasons.join(",") || runtimeGate.mode,
          };
      const postCommitCapability = publisherCapability;
      return {
        version: CONFIG.version,
        checkedAt: new Date().toISOString(),
        pages,
        workLocks: Array.from(this.lockedWorkContexts.entries()).map(([pageRole, lock]) => ({
          pageRole,
          workId: lock.workId,
          author: lock.author,
          lockedAt: lock.lockedAt,
        })),
        capabilities: {
          creator_center_auto_rebind: creatorCapability,
          creator_comment_scan: creatorCapability,
          creator_comment_find: creatorCapability,
          creator_comment_open_by_id: creatorCapability,
          creator_reply_prepare: creatorCapability,
          creator_reply_prepare_from_match: creatorCapability,
          creator_reply_commit: creatorCapability,
          creator_reply_status: creatorCapability,
          creator_comment_like: creatorCapability,
          creator_comment_delete: creatorDeleteCapability,
          creator_own_root_comment: ownRootCommentCapability,
          post_draft_persistence: publisherCapability,
          post_media_ordering: publisherCapability,
          post_music_selection: publisherCapability,
          post_preview: publisherCapability,
          post_publish_commit: postCommitCapability,
          post_publish_status: publisherCapability,
          detail_video_comment_like: { status: "ready", reason: null },
          detail_note_comment_like: { status: "ready", reason: null },
          detail_article_comment_like: { status: "ready", reason: null },
        },
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async listCreatorComments(options: {
    workId?: string;
    sort?: "latest" | "hot";
    status?: "all" | "unreplied" | "replied";
    limit?: number;
    cursor?: string;
  }): Promise<CreatorCommentListResult> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      const sort = options.sort ?? "latest";
      const status = options.status ?? "all";
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
      const cursorMatch = options.cursor?.match(/^creator-comment-(\d+)$/);
      if (options.cursor && !cursorMatch) {
        throw new Error("INVALID_CURSOR:请使用上一次返回的 creator comment nextCursor。");
      }
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const result = await this.creatorCommentsForCurrentSelection(
        page,
        options.workId,
        sort,
        status,
      );
      const pageItems = result.items.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      return {
        items: pageItems,
        count: pageItems.length,
        total: result.items.length,
        cursor: options.cursor ?? null,
        nextCursor: nextOffset < result.items.length ? `creator-comment-${nextOffset}` : null,
        workId: result.snapshot.workId,
        workTitle: result.title,
        sort,
        status,
        pageRole: "creator_center",
        accountVerified: true,
        privacyFiltered: true,
      };
    }, { restoreOnError: false });
  }

  private compactCreatorComment(item: CreatorCommentItem): CreatorCompactComment {
    return {
      commentId: item.commentId,
      parentCommentId: item.parentCommentId,
      rootCommentId: item.rootCommentId,
      depth: item.depth,
      author: item.author,
      text: item.text,
      time: item.time,
      likeCount: item.likeCount,
      hasReplied: item.hasReplied,
      replyCount: item.replyCount,
    };
  }

  private async completeCreatorCommentDataset(
    page: Page,
    workId: string,
    forceRefresh = false,
    requireDeclaredTotal = true,
  ): Promise<CreatorCommentDatasetCacheEntry> {
    const cached = this.creatorCommentDatasetCache.get(workId);
    if (!forceRefresh
      && cached
      && cached.completeRootScan
      && cached.includesReplies
      && Date.now() - cached.capturedAt <= 60_000) {
      return cached;
    }
    await this.assertCreatorCenterAccount(page);
    let snapshot: CreatorCommentSnapshot | null = null;
    let items: CreatorCommentItem[] | null = null;
    let lastError: unknown = null;
    const title = cached?.workTitle ?? null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        snapshot = await this.fetchAllCreatorRootCommentsDirect(
          page,
          workId,
          requireDeclaredTotal,
        );
        items = await this.creatorItemsFromSnapshot(page, snapshot, title, true, true);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2 && String(error).includes("COMMENT_INDEX_INCOMPLETE")) {
          await page.waitForTimeout(300);
          continue;
        }
        throw error;
      }
    }
    if (!snapshot || !items) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`COMMENT_INDEX_INCOMPLETE:${String(lastError)}`);
    }
    const entry: CreatorCommentDatasetCacheEntry = {
      workId,
      workTitle: title,
      snapshot,
      items,
      includesReplies: true,
      completeRootScan: requireDeclaredTotal,
      capturedAt: Date.now(),
    };
    this.creatorCommentDatasetCache.set(workId, entry);
    return entry;
  }

  async findCreatorComments(options: {
    workId: string;
    authorQuery?: string;
    textQuery?: string;
    status?: "all" | "unreplied" | "replied";
    rootOnly?: boolean;
    matchMode?: CreatorCommentMatchMode;
    limit?: number;
  }): Promise<CreatorCommentFindResult> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      const status = options.status ?? "all";
      const rootOnly = options.rootOnly ?? false;
      const matchMode = options.matchMode ?? "fuzzy";
      const authorQuery = options.authorQuery?.trim() || null;
      const textQuery = options.textQuery?.trim() || null;
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const dataset = await this.completeCreatorCommentDataset(page, options.workId);
      const matched = dataset.items
        .filter(item => !rootOnly || item.depth === 0)
        .filter(item => status === "all" || item.hasReplied === (status === "replied"))
        .map(item => {
          const authorMatch = creatorCommentMatchesQuery(
            item.author,
            authorQuery ?? undefined,
            matchMode,
          );
          const textMatch = creatorCommentMatchesQuery(
            item.text,
            textQuery ?? undefined,
            matchMode,
          );
          if (!authorMatch.matched || !textMatch.matched) return null;
          const scores = [
            ...(authorQuery ? [authorMatch.score] : []),
            ...(textQuery ? [textMatch.score] : []),
          ];
          return {
            item,
            matchScore: creatorCommentCombinedMatchScore(scores),
          };
        })
        .filter((value): value is { item: CreatorCommentItem; matchScore: number } =>
          Boolean(value))
        .sort((left, right) =>
          right.matchScore - left.matchScore
          || (Date.parse(right.item.time ?? "") || 0) - (Date.parse(left.item.time ?? "") || 0)
          || right.item.commentId.localeCompare(left.item.commentId));
      const now = Date.now();
      for (const [token, record] of this.creatorCommentMatchTokens) {
        if (record.expiresAt <= now) this.creatorCommentMatchTokens.delete(token);
      }
      const tokenExpiresAt = now + 5 * 60_000;
      const items: CreatorCommentFindItem[] = matched.slice(0, limit).map(({ item, matchScore }) => {
        const matchToken = randomUUID();
        this.creatorCommentMatchTokens.set(matchToken, {
          token: matchToken,
          item: { ...item, threadPath: [...item.threadPath] },
          matchScore,
          createdAt: now,
          expiresAt: tokenExpiresAt,
        });
        return {
          commentId: item.commentId,
          author: item.author,
          text: item.text,
          workId: item.workId,
          parentCommentId: item.parentCommentId,
          rootCommentId: item.rootCommentId,
          hasReplied: item.hasReplied,
          time: item.time,
          matchScore,
          matchToken,
          matchTokenExpiresAt: new Date(tokenExpiresAt).toISOString(),
        };
      });
      return {
        items,
        count: items.length,
        totalMatched: matched.length,
        scannedRootCount: dataset.snapshot.comments.length,
        scannedCommentCount: dataset.items.length,
        workId: options.workId,
        authorQuery,
        textQuery,
        status,
        rootOnly,
        matchMode,
        complete: true,
        source: "creator_api_complete_scan",
        pageStatePreserved: true,
        readAt: new Date(now).toISOString(),
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async scanCreatorComments(options: {
    workId: string;
    status?: "all" | "unreplied" | "replied";
    scope?: "all" | "new";
    rootOnly?: boolean;
    questionOnly?: boolean;
    query?: string[];
    limit?: number;
    cursor?: string;
    includeThreadContext?: boolean;
    responseMode?: "compact" | "full";
  }): Promise<CreatorCommentScanResult> {
    return this.serial(async () => {
      const status = options.status ?? "all";
      const scope = options.scope ?? "all";
      const rootOnly = options.rootOnly ?? false;
      const questionOnly = options.questionOnly ?? false;
      const query = (options.query ?? []).map(value => value.trim()).filter(Boolean).slice(0, 20);
      const responseMode = options.responseMode ?? "compact";
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
      const signature = JSON.stringify({
        workId: options.workId,
        status,
        scope,
        rootOnly,
        questionOnly,
        query,
        includeThreadContext: Boolean(options.includeThreadContext),
        responseMode,
      });
      const cursorMatch = options.cursor?.match(/^creator-scan-([a-f0-9]{24})-(\d+)$/);
      if (options.cursor && !cursorMatch) {
        throw new Error("INVALID_CURSOR:请原样使用 scan_comments 返回的 nextCursor。");
      }
      const offset = cursorMatch ? Number(cursorMatch[2]) : 0;
      let cached: CreatorScanCacheEntry | undefined;
      if (cursorMatch) {
        cached = this.creatorScanCache.get(cursorMatch[1]);
        if (!cached || cached.expiresAt <= Date.now()) {
          this.creatorScanCache.delete(cursorMatch[1]);
          throw new Error("CURSOR_EXPIRED:评论扫描快照已过期，请从无 cursor 的扫描重新开始。");
        }
        if (cached.signature !== signature) {
          throw new Error("INVALID_CURSOR:cursor 与本次筛选条件不一致。");
        }
      }

      if (!cached) {
        const page = await this.creatorCenterPage();
        const needsReplies = !rootOnly || status !== "all" || Boolean(options.includeThreadContext);
        const recentDataset = this.creatorCommentDatasetCache.get(options.workId);
        const result = recentDataset
          && Date.now() - recentDataset.capturedAt <= 60_000
          && (!needsReplies || recentDataset.includesReplies)
          ? {
              snapshot: recentDataset.snapshot,
              title: recentDataset.workTitle,
              items: recentDataset.items,
            }
          : await this.creatorCommentsForCurrentSelection(
              page,
              options.workId,
              "latest",
              "all",
              needsReplies,
            );
        if (result.snapshot.workId !== options.workId) {
          throw new Error("WRONG_PAGE:创作者中心当前作品与 work_id 不一致。");
        }
        const knownIds = scope === "new"
          ? await this.stateStore.knownCreatorCommentIds()
          : new Set<string>();
        const questionPattern = /[?？]|(?:怎么|怎样|如何|为什么|为何|什么|啥|哪[里个]|能不能|可不可以|有没有|请问|吗|么|呢)(?:[啊呀嘛吧]?[?？]?)$/u;
        const filteredItems = result.items.filter(item => {
          if (rootOnly && item.depth !== 0) return false;
          if (status === "unreplied" && item.hasReplied) return false;
          if (status === "replied" && !item.hasReplied) return false;
          if (scope === "new" && knownIds.has(item.commentId)) return false;
          if (questionOnly && !questionPattern.test(item.text.trim())) return false;
          if (query.length) {
            const haystack = `${item.author}\n${item.text}`.toLocaleLowerCase();
            if (!query.every(term => haystack.includes(term.toLocaleLowerCase()))) return false;
          }
          return true;
        });
        const snapshotId = sha256(JSON.stringify({
          signature,
          workId: result.snapshot.workId,
          comments: result.items.map(item => [
            item.commentId,
            item.parentCommentId,
            item.author,
            item.text,
            item.hasReplied,
          ]),
        })).slice(0, 24);
        cached = {
          snapshotId,
          signature,
          workId: options.workId,
          workTitle: result.title,
          items: result.items,
          filteredItems,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60_000,
        };
        this.creatorScanCache.set(snapshotId, cached);
        for (const [id, entry] of this.creatorScanCache) {
          if (entry.expiresAt <= Date.now()) this.creatorScanCache.delete(id);
        }
        if (scope === "new") {
          await this.stateStore.markCreatorCommentIds(result.items.map(item => ({
            commentId: item.commentId,
            workId: item.workId,
            hasReplied: item.hasReplied,
            ownReplyCommentId: item.ownReplyText
              ? this.creatorOwnReplyIds.get(
                  `${item.workId}:${item.commentId}:${item.ownReplyText}`,
                ) ?? null
              : null,
          })));
        }
      }

      const selected = cached.filteredItems.slice(offset, offset + limit);
      const nextOffset = offset + selected.length;
      const threadContext = options.includeThreadContext
        ? Array.from(new Set(selected.map(item => item.rootCommentId))).map(rootCommentId => ({
            rootCommentId,
            items: cached!.items
              .filter(item => item.rootCommentId === rootCommentId)
              .map(item => this.compactCreatorComment(item)),
          }))
        : undefined;
      return {
        snapshotId: cached.snapshotId,
        workId: cached.workId,
        workTitle: cached.workTitle,
        items: responseMode === "compact"
          ? selected.map(item => this.compactCreatorComment(item))
          : selected,
        count: selected.length,
        totalMatched: cached.filteredItems.length,
        cursor: options.cursor ?? null,
        nextCursor: nextOffset < cached.filteredItems.length
          ? `creator-scan-${cached.snapshotId}-${nextOffset}`
          : null,
        status,
        scope,
        rootOnly,
        questionOnly,
        query,
        responseMode,
        ...(threadContext ? { threadContext } : {}),
        pageRole: "creator_center",
        accountVerified: true,
        privacyFiltered: true,
      };
    }, { restoreOnError: false });
  }

  async checkCreatorCommentUpdates(limit = 20): Promise<CreatorCommentUpdatesResult> {
    return this.serial(async () => {
      const result = await this.listCreatorComments({
        sort: "latest",
        status: "all",
        limit: 100,
      });
      const fresh = await this.stateStore.consumeNewCreatorCommentIds(
        result.items.map(item => ({
          commentId: item.commentId,
          workId: item.workId,
          hasReplied: item.hasReplied,
          ownReplyCommentId: item.ownReplyText
            ? this.creatorOwnReplyIds.get(
                `${item.workId}:${item.commentId}:${item.ownReplyText}`,
              ) ?? null
            : null,
        })),
      );
      const items = result.items
        .filter(item => fresh.has(item.commentId))
        .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
        .map(item => ({
          workId: item.workId,
          workTitle: item.workTitle,
          commentId: item.commentId,
          parentCommentId: item.parentCommentId,
          author: item.author,
          text: item.text,
          time: item.time,
          hasReplied: item.hasReplied,
        }));
      return {
        items,
        newCount: items.length,
        checkedAt: new Date().toISOString(),
      };
    }, { restoreOnError: false });
  }

  private creatorApiCommentFromItem(item: CreatorCommentItem, replyCount = 0): CreatorApiComment {
    return {
      commentId: item.commentId,
      text: item.text,
      author: item.author,
      authorUid: null,
      authorSecUid: null,
      createdAt: item.time ? Math.floor(Date.parse(item.time) / 1000) : null,
      likeCount: item.likeCount,
      status: 1,
      parentCommentId: item.parentCommentId,
      replyCount,
      level: item.isReply ? 2 : 1,
      avatarFingerprint: null,
    };
  }

  private resolveCreatorReplyTarget(
    items: CreatorCommentItem[],
    commentId: string,
  ): ResolvedCreatorReplyTarget {
    const matches = items.filter(item => item.commentId === commentId);
    if (matches.length !== 1) {
      throw new Error("VALIDATION_FAILED:目标 work_id 中没有唯一匹配的 comment_id。");
    }
    const target = matches[0];
    const byId = new Map(items.map(item => [item.commentId, item]));
    const immediateParent = target.parentCommentId
      ? byId.get(target.parentCommentId) ?? null
      : null;
    let threadRoot = target;
    const visited = new Set<string>();
    while (threadRoot.parentCommentId) {
      if (visited.has(threadRoot.commentId)) {
        throw new Error("VALIDATION_FAILED:创作者中心评论父级链出现循环。");
      }
      visited.add(threadRoot.commentId);
      const parent = byId.get(threadRoot.parentCommentId);
      if (!parent) {
        throw new Error(
          `VALIDATION_FAILED:子评论 ${threadRoot.commentId} 的父评论 ${threadRoot.parentCommentId} 未在已验证列表中。`,
        );
      }
      threadRoot = parent;
    }
    return { target, threadRoot, immediateParent };
  }

  private async expandAndLocateCreatorReplyTarget(
    page: Page,
    workId: string,
    resolved: ResolvedCreatorReplyTarget,
  ): Promise<CreatorReplyDomTarget> {
    const rootApi = this.creatorApiCommentFromItem(
      resolved.threadRoot,
      resolved.target.isReply ? 1 : 0,
    );
    if (!resolved.target.isReply) {
      const targetRecord = await this.locateCreatorCommentRecord(page, rootApi, {
        workId,
        parentCommentFound: true,
        parentThreadExpanded: false,
      });
      return {
        ...resolved,
        targetApi: rootApi,
        threadRootRecord: targetRecord,
        targetRecord,
        parentThreadExpanded: false,
      };
    }

    if (!resolved.immediateParent) {
      const diagnostics = {
        workId,
        commentId: resolved.target.commentId,
        parentCommentId: resolved.target.parentCommentId,
        isReply: true,
        parentCommentFound: false,
        parentThreadExpanded: false,
      };
      const artifact = await this.saveCommentArtifact(
        page,
        "creator-child-comment-parent-missing",
        diagnostics,
      ).catch(() => ({ diagnosticsPath: "" }));
      throw new Error(
        `VALIDATION_FAILED:楼中楼子评论缺少已验证父评论；diagnostics=${artifact.diagnosticsPath || "未保存"}。`,
      );
    }

    const threadRootRecord = await this.locateCreatorCommentRecord(page, rootApi, {
      workId,
      parentCommentFound: true,
      parentThreadExpanded: false,
    });
    const collapsed = threadRootRecord.locator("[class*='load-more-']").filter({ hasText: /查看\d+条回复/ });
    const expanded = threadRootRecord.locator("[class*='load-more-']").filter({ hasText: "收起" });
    if (await collapsed.count() === 1) {
      await collapsed.click();
    } else if (await expanded.count() !== 1) {
      const artifact = await this.saveCommentArtifact(page, "creator-child-comment-thread-expand-failed", {
        workId,
        commentId: resolved.target.commentId,
        parentCommentId: resolved.target.parentCommentId,
        isReply: true,
        parentCommentFound: true,
        parentThreadExpanded: false,
        expandCandidateCount: await collapsed.count(),
        expandedCandidateCount: await expanded.count(),
      }).catch(() => ({ diagnosticsPath: "" }));
      throw new Error(
        `VALIDATION_FAILED:父评论已找到，但没有唯一的线程展开入口；`
        + `diagnostics=${artifact.diagnosticsPath || "未保存"}。`,
      );
    }
    await page.waitForFunction(input => {
      const normalize = (value: string) => value
        .replace(/\[[^\]]{1,24}\]/g, "")
        .replace(/\s+/g, "")
        .trim();
      const scope = document.querySelector<HTMLElement>(
        `[data-codex-creator-comment="${input.rootMarker}"]`,
      );
      if (!scope) return false;
      const expectedText = normalize(input.text);
      return Array.from(scope.querySelectorAll<HTMLElement>("[class*='comment-content-text-']"))
        .some(textNode => {
          const actualText = normalize(textNode.innerText || textNode.textContent || "");
          if (!(actualText === expectedText
            || actualText.includes(expectedText)
            || expectedText.includes(actualText))) return false;
          let record: HTMLElement | null = textNode;
          for (let depth = 0; depth < 8 && record; depth += 1, record = record.parentElement) {
            const author = record.querySelector<HTMLElement>("[class*='username-']");
            if ((author?.innerText || author?.textContent || "").replace(/\s*作者\s*$/, "").trim()
              === input.author) return true;
          }
          return false;
        });
    }, {
      rootMarker: await threadRootRecord.getAttribute("data-codex-creator-comment"),
      author: resolved.target.author,
      text: resolved.target.text,
    }, { timeout: 10_000 });
    const targetApi = this.creatorApiCommentFromItem(resolved.target);
    const targetRecord = await this.locateCreatorCommentRecord(page, targetApi, {
      workId,
      scope: threadRootRecord,
      parentCommentFound: true,
      parentThreadExpanded: true,
    });
    return {
      ...resolved,
      targetApi,
      threadRootRecord,
      targetRecord,
      parentThreadExpanded: true,
    };
  }

  private async positionCreatorReplyTargetInDom(
    page: Page,
    workId: string,
    resolved: ResolvedCreatorReplyTarget,
  ): Promise<{ domTarget: CreatorReplyDomTarget; searchKeyword: string }> {
    await this.assertCreatorCenterAccount(page);
    const currentWorkId = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource")
        .map(entry => entry.name)
        .filter(url => url.includes("/comment/list/select/"))
        .reverse();
      for (const resource of resources) {
        try {
          const url = new URL(resource);
          const candidate = url.searchParams.get("aweme_id") ?? url.searchParams.get("item_id");
          if (candidate && /^\d{16,20}$/.test(candidate)) return candidate;
        } catch {
          // Ignore stale or malformed performance entries.
        }
      }
      return null;
    });
    if (currentWorkId !== workId) {
      const current: CreatorCommentSnapshot = currentWorkId
        ? {
            workId: currentWorkId,
            comments: [],
            cursor: null,
            hasMore: false,
            total: 0,
          }
        : await this.captureCreatorRootSnapshot(page, 10);
      await this.selectCreatorWork(page, workId, current);
    }
    await this.setCreatorCommentFilters(page, "latest", "all");

    const searchInputs = page.locator("input[placeholder*='搜索评论关键词']:visible");
    if (await searchInputs.count() !== 1) {
      throw new Error(
        `VALIDATION_FAILED:creator_center 搜索输入框不唯一（${await searchInputs.count()}）。`,
      );
    }
    const searchInput = searchInputs.first();
    const normalizedRootText = resolved.threadRoot.text.replace(/\s+/gu, " ").trim();
    const withoutEmojiLabels = normalizedRootText.replace(/\[[^\]]{1,24}\]/gu, "").trim();
    const keywords = [...new Set([
      withoutEmojiLabels.slice(0, 100),
      normalizedRootText.slice(0, 100),
      withoutEmojiLabels.slice(0, 60),
      withoutEmojiLabels.slice(0, 30),
    ].filter(keyword => keyword.length >= 2))];
    if (!keywords.length) {
      throw new Error("VALIDATION_FAILED:目标根评论没有可用于页面定位的稳定正文片段。");
    }

    const failures: string[] = [];
    for (const keyword of keywords) {
      try {
        await searchInput.fill(keyword);
        const [response] = await Promise.all([
          page.waitForResponse(candidate => {
            try {
              const url = new URL(candidate.url());
              return url.pathname.endsWith("/comment/list/select/")
                && url.searchParams.get("aweme_id") === workId
                && url.searchParams.get("keyword") === keyword;
            } catch {
              return false;
            }
          }, { timeout: 15_000 }),
          searchInput.press("Enter"),
        ]);
        const raw = await response.json();
        if (Number(raw?.status_code ?? -1) !== 0) {
          failures.push(`${keyword}:status_code=${String(raw?.status_code)}`);
          continue;
        }
        let snapshot = this.creatorSnapshotFromResponse(raw, response.url());
        if (snapshot.workId !== workId) {
          failures.push(`${keyword}:work_id_mismatch`);
          continue;
        }
        if (!snapshot.comments.some(comment =>
          comment.commentId === resolved.threadRoot.commentId) && snapshot.hasMore) {
          snapshot = await this.loadMoreCreatorRootComments(
            page,
            snapshot,
            Math.max(snapshot.total, snapshot.comments.length),
          );
        }
        if (!snapshot.comments.some(comment =>
          comment.commentId === resolved.threadRoot.commentId)) {
          failures.push(`${keyword}:root_comment_not_in_search_results`);
          continue;
        }
        await page.waitForTimeout(300);
        const domTarget = await this.expandAndLocateCreatorReplyTarget(page, workId, resolved);
        if (domTarget.target.commentId !== resolved.target.commentId
          || domTarget.target.author !== resolved.target.author
          || domTarget.target.text !== resolved.target.text) {
          failures.push(`${keyword}:dom_target_mismatch`);
          continue;
        }
        return { domTarget, searchKeyword: keyword };
      } catch (error) {
        failures.push(`${keyword}:${String(error)}`);
      }
    }
    throw new Error(
      `COMMENT_DOM_POSITION_FAILED:creator API 已验证 comment_id=${resolved.target.commentId}，`
      + "但无法把其根线程稳定定位到 creator_center DOM；未打开编辑器、未点击发送。"
      + ` attempts=${failures.join(" | ").slice(0, 1000)}`,
    );
  }

  async openCreatorCommentById(
    workId: string,
    commentId: string,
  ): Promise<CreatorCommentOpenByIdResult> {
    return this.serial(async () => {
      const page = await this.creatorCenterPage();
      const dataset = await this.completeCreatorCommentDataset(page, workId, true, false);
      const resolved = this.resolveCreatorReplyTarget(dataset.items, commentId);
      const positioned = await this.positionCreatorReplyTargetInDom(page, workId, resolved);
      return {
        workId,
        commentId: resolved.target.commentId,
        author: resolved.target.author,
        text: resolved.target.text,
        parentCommentId: resolved.target.parentCommentId,
        rootCommentId: resolved.target.rootCommentId,
        searchKeyword: positioned.searchKeyword,
        targetVisible: true,
        threadExpanded: positioned.domTarget.parentThreadExpanded,
        accountVerified: true,
        apiVerified: true,
        domVerified: true,
        sent: false,
      };
    }, { restoreOnError: false });
  }

  private creatorCommentDeleteResult(
    operation: CreatorCommentDeleteOperation,
    extra: Record<string, unknown> = {},
  ) {
    return {
      operationId: operation.operationId,
      operation_id: operation.operationId,
      token: operation.token,
      state: operation.state,
      actorAccount: operation.actorAccount,
      workId: operation.workId,
      work_id: operation.workId,
      commentId: operation.commentId,
      comment_id: operation.commentId,
      targetAuthor: operation.targetAuthor,
      targetText: operation.targetText,
      targetTextHash: operation.targetTextHash,
      parentCommentId: operation.parentCommentId,
      rootCommentId: operation.rootCommentId,
      expiresAt: operation.expiresAt,
      deleteStartedAt: operation.deleteStartedAt,
      confirmedAt: operation.confirmedAt,
      lastError: operation.lastError,
      deleted: operation.state === "confirmed",
      sent: false,
      ...extra,
    };
  }

  async prepareDeleteCreatorComment(options: {
    workId: string;
    commentId: string;
  }) {
    return this.serial(async () => {
      assertWriteReady();
      const ledger = this.creatorCommentDeleteStore.health();
      if (!ledger.writable) {
        throw new Error(`LEDGER_UNAVAILABLE:${ledger.error ?? "unknown"}`);
      }
      const page = await this.creatorCenterPage();
      const creatorAccount = await this.assertCreatorCenterAccount(page);
      if (creatorAccount.source !== "operator") {
        throw new Error(
          "WRONG_ACCOUNT:删除评论工具只允许 Operator 自己的 creator_center，"
          + "不会删除绑定用户账号作品下的评论。",
        );
      }
      const dataset = await this.completeCreatorCommentDataset(
        page,
        options.workId,
        true,
        true,
      );
      const resolved = this.resolveCreatorReplyTarget(dataset.items, options.commentId);
      const targetTextHash = sha256(resolved.target.text);
      createTargetWriteGate({
        scope: "own_post",
        actionType: "delete_comment",
        actorAccount: creatorAccount.displayName,
        pageRole: "creator_center",
        pageTargetId: await this.pageTargetId(page),
        targetWorkId: options.workId,
        targetWorkAuthor: creatorAccount.displayName,
        targetCommentId: resolved.target.commentId,
        parentCommentId: resolved.target.parentCommentId,
        rootCommentId: resolved.target.rootCommentId,
        targetTextHash,
        verifiedUrl: page.url(),
        commentVerified: true,
      });
      const operation = this.creatorCommentDeleteStore.create({
        actorAccount: creatorAccount.displayName,
        workId: options.workId,
        commentId: resolved.target.commentId,
        targetAuthor: resolved.target.author,
        targetText: resolved.target.text,
        targetTextHash,
        parentCommentId: resolved.target.parentCommentId,
        rootCommentId: resolved.target.rootCommentId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      return this.creatorCommentDeleteResult(operation, {
        accountVerified: true,
        workVerified: true,
        commentVerified: true,
        apiVerified: true,
        destructiveActionPending: operation.state === "prepared",
      });
    }, { restoreOnError: false, persistPageState: false });
  }

  private async readCreatorCommentDeleteStatusUnlocked(
    reference: string,
  ) {
    let operation = this.creatorCommentDeleteStore.require(reference);
    if (operation.state === "confirmed") {
      return this.creatorCommentDeleteResult(operation, {
        readOnly: true,
        commentStillExists: false,
      });
    }
    if (operation.state === "prepared"
      && Date.parse(operation.expiresAt) <= Date.now()) {
      operation = this.creatorCommentDeleteStore.update(operation.operationId, {
        state: "expired",
        lastError: "prepare_expired",
      });
      return this.creatorCommentDeleteResult(operation, {
        readOnly: true,
        commentStillExists: true,
      });
    }
    if (!["delete_started", "unknown_after_submit"].includes(operation.state)) {
      return this.creatorCommentDeleteResult(operation, {
        readOnly: true,
        commentStillExists: null,
      });
    }
    try {
      const page = await this.creatorCenterPage();
      const account = await this.assertCreatorCenterAccount(page);
      if (account.source !== "operator") {
        throw new Error(
          "WRONG_ACCOUNT:删除评论状态回查只允许 Operator 自己的 creator_center。",
        );
      }
      if (account.displayName !== operation.actorAccount) {
        throw new Error(
          `WRONG_ACCOUNT:${operation.actorAccount}->${account.displayName}`,
        );
      }
      const dataset = await this.completeCreatorCommentDataset(
        page,
        operation.workId,
        true,
        true,
      );
      const matches = dataset.items.filter(item =>
        item.commentId === operation.commentId);
      if (matches.length === 0) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "confirmed",
          confirmedAt: new Date().toISOString(),
          lastError: null,
        });
        return this.creatorCommentDeleteResult(operation, {
          readOnly: true,
          commentStillExists: false,
          apiReadbackConfirmed: true,
        });
      }
      const sameTarget = matches.length === 1
        && matches[0].author === operation.targetAuthor
        && sha256(matches[0].text) === operation.targetTextHash;
      operation = this.creatorCommentDeleteStore.update(operation.operationId, {
        state: "unknown_after_submit",
        lastError: sameTarget
          ? "comment_still_exists_after_delete_submit"
          : "comment_id_reused_or_target_changed",
      });
      return this.creatorCommentDeleteResult(operation, {
        readOnly: true,
        commentStillExists: true,
        targetStillMatches: sameTarget,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      operation = this.creatorCommentDeleteStore.update(operation.operationId, {
        state: "unknown_after_submit",
        lastError: message,
      });
      return this.creatorCommentDeleteResult(operation, {
        readOnly: true,
        commentStillExists: null,
        readbackError: message,
      });
    }
  }

  async getCreatorCommentDeleteStatus(reference: string) {
    return this.serial(
      () => this.readCreatorCommentDeleteStatusUnlocked(reference),
      { restoreOnError: false, persistPageState: false },
    );
  }

  async commitDeleteCreatorComment(
    reference: string,
    confirmDelete: boolean,
  ) {
    return this.serial(async () => {
      let operation = this.creatorCommentDeleteStore.require(reference);
      if (operation.state === "confirmed") {
        return this.creatorCommentDeleteResult(operation, {
          alreadyConfirmed: true,
          commentStillExists: false,
        });
      }
      if (operation.state === "delete_started"
        || operation.state === "unknown_after_submit") {
        return this.readCreatorCommentDeleteStatusUnlocked(operation.operationId);
      }
      if (!confirmDelete) {
        throw new Error(
          "FINAL_CONFIRMATION_REQUIRED:删除评论必须显式传 confirm_delete=true。",
        );
      }
      if (operation.state !== "prepared") {
        throw new Error(
          `DELETE_OPERATION_NOT_PREPARED:state=${operation.state}`,
        );
      }
      assertWriteReady();
      const page = await this.creatorCenterPage();
      const account = await this.assertCreatorCenterAccount(page);
      if (account.source !== "operator") {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "rejected",
          lastError: "creator_account_is_not_operator",
        });
        throw new Error(
          "WRONG_ACCOUNT:删除评论工具只允许 Operator 自己的 creator_center。",
        );
      }
      if (account.displayName !== operation.actorAccount) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "rejected",
          lastError: `creator_account_changed:${operation.actorAccount}->${account.displayName}`,
        });
        throw new Error(`WRONG_ACCOUNT:${operation.lastError}`);
      }
      const dataset = await this.completeCreatorCommentDataset(
        page,
        operation.workId,
        true,
        true,
      );
      const resolved = this.resolveCreatorReplyTarget(
        dataset.items,
        operation.commentId,
      );
      if (resolved.target.author !== operation.targetAuthor
        || sha256(resolved.target.text) !== operation.targetTextHash
        || resolved.target.parentCommentId !== operation.parentCommentId
        || resolved.target.rootCommentId !== operation.rootCommentId) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "rejected",
          lastError: "frozen_target_mismatch",
        });
        throw new Error("TARGET_CHANGED:作者、原文哈希或评论线程与 prepare 冻结值不一致。");
      }
      const gate = createTargetWriteGate({
        scope: "own_post",
        actionType: "delete_comment",
        actorAccount: account.displayName,
        pageRole: "creator_center",
        pageTargetId: await this.pageTargetId(page),
        targetWorkId: operation.workId,
        targetWorkAuthor: account.displayName,
        targetCommentId: operation.commentId,
        parentCommentId: operation.parentCommentId,
        rootCommentId: operation.rootCommentId,
        targetTextHash: operation.targetTextHash,
        verifiedUrl: page.url(),
        commentVerified: true,
      });
      assertTargetWriteGate(gate, {
        scope: "own_post",
        actionType: "delete_comment",
        workId: operation.workId,
        commentId: operation.commentId,
        pageRole: "creator_center",
        pageTargetId: await this.pageTargetId(page),
      });
      const positioned = await this.positionCreatorReplyTargetInDom(
        page,
        operation.workId,
        resolved,
      );
      const staleDialog = page.locator("[role='dialog']:visible");
      for (let index = 0; index < await staleDialog.count(); index += 1) {
        const candidate = staleDialog.nth(index);
        if (!/确定要删除吗/.test(await candidate.innerText().catch(() => ""))) {
          continue;
        }
        const cancel = candidate.getByRole("button", { name: "取消" });
        if (await cancel.count() === 1) await cancel.click();
      }
      const operations = positioned.domTarget.targetRecord
        .locator("[class*='operations-']")
        .first();
      const deleteControl = operations
        .locator(":scope > [class*='item-']")
        .filter({ hasText: /^删除$/ });
      if (await deleteControl.count() !== 1
        || !await deleteControl.first().isVisible().catch(() => false)) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "failed_before_click",
          lastError: "delete_control_not_unique",
        });
        throw new Error(
          "CAPABILITY_UNAVAILABLE:目标评论没有唯一可见的 creator_center 删除入口。",
        );
      }
      await enforceWritePolicy(
        "comment_delete",
        `${page.url()}#${operation.workId}:${operation.commentId}`,
      );
      operation = this.creatorCommentDeleteStore.claimDeleteStarted(
        operation.operationId,
      );
      try {
        await deleteControl.first().click();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "unknown_after_submit",
          lastError: `delete_control_click_error:${message}`,
        });
        throw new Error(`DELETE_STATUS_UNKNOWN:${message}`);
      }
      const dialog = page.locator("[role='dialog']:visible");
      await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);
      if (await dialog.count() !== 1
        || !/确定要删除吗/.test(await dialog.first().innerText().catch(() => ""))) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "unknown_after_submit",
          lastError: "delete_confirmation_dialog_not_verified",
        });
        throw new Error(
          "DELETE_STATUS_UNKNOWN:删除入口点击后确认框没有唯一出现；只能只读回查。",
        );
      }
      const confirm = dialog.getByRole("button", { name: "确定", exact: true });
      if (await confirm.count() !== 1
        || !await confirm.first().isVisible().catch(() => false)) {
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "unknown_after_submit",
          lastError: "delete_confirm_button_not_unique",
        });
        throw new Error(
          "DELETE_STATUS_UNKNOWN:删除入口点击后确认按钮不唯一；只能只读回查。",
        );
      }
      const responsePromise = page.waitForResponse(response => {
        try {
          const url = new URL(response.url());
          return url.hostname === "creator.douyin.com"
            && /comment/i.test(url.pathname)
            && /(delete|remove)/i.test(url.pathname);
        } catch {
          return false;
        }
      }, { timeout: 10_000 }).catch(() => null);
      try {
        await confirm.first().click();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        operation = this.creatorCommentDeleteStore.update(operation.operationId, {
          state: "unknown_after_submit",
          lastError: `confirm_click_error:${message}`,
        });
        return this.creatorCommentDeleteResult(operation, {
          clicked: true,
          deliveryConfirmed: false,
          uncertainAfterSubmit: true,
        });
      }
      const response = await responsePromise;
      const responseSummary = response
        ? await (async () => {
            const raw = await response.json().catch(() => null);
            return {
              endpoint: new URL(response.url()).pathname,
              httpStatus: response.status(),
              code: raw?.status_code ?? raw?.code ?? null,
              message: String(raw?.status_msg ?? raw?.message ?? "").slice(0, 200),
            };
          })()
        : null;
      await page.waitForTimeout(Math.max(CONFIG.actionDelayMs, 500));
      const readback = await this.readCreatorCommentDeleteStatusUnlocked(
        operation.operationId,
      );
      if (readback.state === "confirmed") {
        appendActionLog(this.actionLogBase(
          "douyin_creator_commit_delete_comment",
          "comment_delete",
          {
            workUrl: `${page.url()}#${operation.workId}`,
            author: operation.targetAuthor,
            beforeState: "exists",
            afterState: "deleted",
            success: true,
          },
        ));
      }
      return {
        ...readback,
        clicked: true,
        response: responseSummary,
        deliveryConfirmed: readback.state === "confirmed",
        uncertainAfterSubmit: readback.state === "unknown_after_submit",
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async creatorReplyEditor(
    page: Page,
    resolved: CreatorReplyDomTarget,
  ): Promise<{ editor: Locator; send: Locator }> {
    const target = resolved.target;
    const operations = resolved.targetRecord.locator("[class*='operations-']").first();
    const reply = operations.locator("[class*='item-']").filter({ hasText: /^回复$/ });
    if (await reply.count() !== 1) {
      throw new Error("VALIDATION_FAILED:目标 comment_id 对应记录内部没有唯一回复入口。");
    }
    await reply.click();
    const editorMarker = `creator-reply-editor-${target.commentId}-${Date.now()}`;
    await page.waitForFunction(author => {
      const normalize = (value: string) => value.replace(/\s+/g, "");
      return Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']"))
        .some(editor => {
          const rect = editor.getBoundingClientRect();
          const prompt = editor.getAttribute("placeholder")
            ?? editor.getAttribute("aria-placeholder")
            ?? "";
          return rect.width > 0 && rect.height > 0
            && normalize(prompt).startsWith(`回复${normalize(author)}：`);
        });
    }, target.author, { timeout: 10_000 });
    const marked = await page.evaluate(input => {
      const normalize = (value: string) => value.replace(/\s+/g, "");
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']"))
        .filter(editor => {
          const rect = editor.getBoundingClientRect();
          const prompt = editor.getAttribute("placeholder")
            ?? editor.getAttribute("aria-placeholder")
            ?? "";
          return rect.width > 0 && rect.height > 0
            && normalize(prompt).startsWith(`回复${normalize(input.author)}：`);
        });
      if (candidates.length !== 1) return candidates.length;
      candidates[0].setAttribute("data-codex-creator-reply-editor", input.marker);
      return 1;
    }, { author: target.author, marker: editorMarker });
    if (marked !== 1) {
      throw new Error(`VALIDATION_FAILED:目标评论回复编辑器不唯一（${marked}）。`);
    }
    const editor = page.locator(`[data-codex-creator-reply-editor="${editorMarker}"]`);
    const wrap = editor.locator("xpath=ancestor::*[starts-with(@class,'wrap-')][1]");
    const send = wrap.getByRole("button", { name: "发送", exact: true });
    if (await wrap.count() !== 1 || await send.count() !== 1) {
      throw new Error("VALIDATION_FAILED:回复编辑器没有唯一的发送按钮。");
    }
    return { editor, send };
  }

  private creatorReplyTransactionResult(
    plan: CreatorReplyPlanRecord,
    alreadyConfirmed = false,
  ): CreatorReplyTransactionResult {
    const status: CreatorReplyTransactionResult["status"] =
      plan.status === "confirmed"
        ? "confirmed"
        : plan.status === "prepared"
          ? "prepared"
          : plan.status === "click_started" || plan.status === "unknown_after_submit"
            ? "unknown_after_submit"
            : "blocked";
    const resultCode: CreatorReplyTransactionResult["resultCode"] =
      plan.status === "confirmed"
        ? (alreadyConfirmed ? "already_confirmed" : "confirmed")
        : status;
    return {
      replyPlanId: plan.replyPlanId,
      transactionId: plan.transactionId,
      token: plan.replyPlanId,
      operationId: plan.transactionId,
      operation_id: plan.transactionId,
      status,
      operationState: plan.status,
      resultCode,
      actorAccount: plan.actorAccount,
      workId: plan.workId,
      targetCommentId: plan.targetCommentId,
      targetAuthor: plan.targetAuthor,
      targetText: plan.targetText,
      parentCommentId: plan.parentCommentId,
      rootCommentId: plan.rootCommentId,
      replyText: plan.replyText,
      clicked: plan.clicked,
      replyCommentId: plan.replyCommentId,
      verifiedInCreatorCenter: plan.verifiedInCreatorCenter,
      blockedReason: plan.blockedReason,
      expiresAt: plan.expiresAt,
    };
  }

  private async refreshCreatorReplyThread(
    page: Page,
    resolved: ResolvedCreatorReplyTarget,
    plan: CreatorReplyPlanRecord,
  ): Promise<string | null> {
    const recordReplies = (replies: CreatorApiComment[]): string | null => {
      const creatorAccount = this.activeCreatorAccount;
      if (!creatorAccount || creatorAccount.displayName !== plan.actorAccount) return null;
      const isOwnReply = (reply: CreatorApiComment): boolean =>
        reply.authorUid === creatorAccount.uid
        || reply.authorSecUid === creatorAccount.secUid
        || (Boolean(this.creatorAccountAvatarFingerprint)
          && reply.avatarFingerprint === this.creatorAccountAvatarFingerprint);
      for (const reply of replies) {
        if (isOwnReply(reply)) {
          this.creatorOwnReplyIds.set(
            `${plan.workId}:${reply.parentCommentId ?? resolved.threadRoot.commentId}:${reply.text}`,
            reply.commentId,
          );
        }
      }
      const verified = replies.find(reply =>
        reply.parentCommentId === plan.targetCommentId
        && reply.author === creatorAccount.displayName
        && reply.text === plan.replyText
        && isOwnReply(reply));
      return verified?.commentId ?? null;
    };
    const direct = await this.fetchCreatorRepliesDirect(
      page,
      plan.workId,
      resolved.threadRoot.commentId,
    );
    if (direct) return recordReplies(direct);

    const rootApi = this.creatorApiCommentFromItem(resolved.threadRoot, 1);
    const rootRecord = await this.locateCreatorCommentRecord(page, rootApi, {
      workId: plan.workId,
      parentCommentFound: true,
    });
    const collapse = rootRecord.locator("[class*='load-more-']").filter({ hasText: "收起" });
    if (await collapse.count() === 1) {
      await collapse.click().catch(() => null);
      await page.waitForTimeout(150);
    }
    const expand = rootRecord.locator("[class*='load-more-']").filter({ hasText: /查看\d+条回复/ });
    if (await expand.count() !== 1) return null;
    const [response] = await Promise.all([
      page.waitForResponse(response => {
        try {
          const url = new URL(response.url());
          return url.pathname.endsWith("/comment/list/reply/")
            && url.searchParams.get("comment_id") === resolved.threadRoot.commentId;
        } catch {
          return false;
        }
      }, { timeout: 4_000 }).catch(() => null),
      expand.click(),
    ]);
    if (!response) return null;
    const raw = await response.json().catch(() => null);
    const replies = await this.collectCreatorReplyPages(page, raw, response.url());
    return recordReplies(replies);
  }

  private async pollCreatorReplyConfirmation(
    page: Page,
    resolved: ResolvedCreatorReplyTarget,
    plan: CreatorReplyPlanRecord,
    timeoutMs = 10_000,
  ): Promise<string | null> {
    const deadline = Date.now() + Math.max(8_000, Math.min(12_000, timeoutMs));
    while (Date.now() < deadline) {
      const replyCommentId = await this.refreshCreatorReplyThread(page, resolved, plan)
        .catch(() => null);
      if (replyCommentId) return replyCommentId;
      await page.waitForTimeout(Math.min(1_000, Math.max(0, deadline - Date.now())));
    }
    return null;
  }

  private createCreatorReplyPlan(
    workId: string,
    target: CreatorCommentItem,
    replyText: string,
    targetSource: "dataset" | "current_filtered" | "match_index",
    filterKeyword: string | null,
  ): CreatorReplyPlanResult {
    const creatorAccount = this.activeCreatorAccount;
    if (!creatorAccount) {
      throw new Error("CREATOR_ACCOUNT_UNVERIFIED:必须先验证当前创作者中心账号。");
    }
    const unresolvedConflict = this.creatorReplyStore
      .listUnresolvedAfterSubmit()
      .find(operation =>
        operation.actorAccount === creatorAccount.displayName
        && operation.workId === workId
        && operation.targetCommentId === target.commentId);
    if (unresolvedConflict) {
      throw new Error(
        `TARGET_WRITE_CONFLICT:operation_id=${unresolvedConflict.transactionId};`
        + `target_lock=${creatorAccount.displayName}:own_post:reply_to_comment:`
        + `${workId}:${target.commentId};state=${unresolvedConflict.status}`,
      );
    }
    if (target.hasReplied) {
      throw new Error(
        `ALREADY_REPLIED:comment_id=${target.commentId} 已有 ${creatorAccount.displayName} 回复，未创建发送计划。`,
      );
    }
    const targetTextHash = sha256(target.text);
    const replyTextHash = sha256(replyText);
    const baseIdempotencyKey = creatorReplyIdempotencyKey(
      workId,
      target.commentId,
      replyTextHash,
    );
    const idempotencyKey = creatorAccount.source === "operator"
      ? baseIdempotencyKey
      : sha256(`${creatorAccount.uid}:${baseIdempotencyKey}`);
    const existing = this.creatorReplyStore.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.status === "prepared" && Date.parse(existing.expiresAt) > Date.now()) {
        return {
          replyPlanId: existing.replyPlanId,
          transactionId: existing.transactionId,
          token: existing.replyPlanId,
          operationId: existing.transactionId,
          operation_id: existing.transactionId,
          status: "prepared",
          actorAccount: existing.actorAccount,
          workId: existing.workId,
          workTitle: existing.workTitle,
          targetCommentId: existing.targetCommentId,
          targetAuthor: existing.targetAuthor,
          targetText: existing.targetText,
          targetTextHash: existing.targetTextHash,
          parentCommentId: existing.parentCommentId,
          rootCommentId: existing.rootCommentId,
          depth: existing.depth,
          threadPath: existing.threadPath,
          alreadyReplied: false,
          replyText: existing.replyText,
          replyTextHash: existing.replyTextHash,
          snapshotId: existing.snapshotId,
          expiresAt: existing.expiresAt,
          verified: true,
        };
      }
      if (existing.status === "prepared" && Date.parse(existing.expiresAt) <= Date.now()) {
        this.creatorReplyStore.update(existing.replyPlanId, {
          status: "expired",
          blockedReason: "reply_plan_expired",
        });
      }
      if (existing.status === "confirmed") {
        throw new Error(
          `ALREADY_CONFIRMED:operation_id=${existing.transactionId};`
          + `reply_comment_id=${existing.replyCommentId ?? "unknown"}`,
        );
      }
      throw new Error(
        `DUPLICATE_TRANSACTION:相同 workId、targetCommentId 和回复文字已有事务 `
        + `${existing.transactionId}（status=${existing.status}），禁止创建可重复发送计划。`,
      );
    }
    const snapshotId = sha256(JSON.stringify({
      workId,
      targetCommentId: target.commentId,
      targetAuthor: target.author,
      targetTextHash,
      parentCommentId: target.parentCommentId,
      rootCommentId: target.rootCommentId,
      depth: target.depth,
      threadPath: target.threadPath,
    })).slice(0, 24);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const plan = this.creatorReplyStore.create({
      idempotencyKey,
      actorAccount: creatorAccount.displayName,
      workId,
      workTitle: target.workTitle,
      targetCommentId: target.commentId,
      targetAuthor: target.author,
      targetText: target.text,
      targetTextHash,
      parentCommentId: target.parentCommentId,
      rootCommentId: target.rootCommentId,
      depth: target.depth,
      threadPath: target.threadPath,
      alreadyReplied: false,
      replyText,
      replyTextHash,
      snapshotId,
      targetSource,
      filterKeyword,
      expiresAt,
    });
    return {
      replyPlanId: plan.replyPlanId,
      transactionId: plan.transactionId,
      token: plan.replyPlanId,
      operationId: plan.transactionId,
      operation_id: plan.transactionId,
      status: "prepared",
      workId: plan.workId,
      workTitle: plan.workTitle,
      targetCommentId: plan.targetCommentId,
      targetAuthor: plan.targetAuthor,
      targetText: plan.targetText,
      targetTextHash: plan.targetTextHash,
      parentCommentId: plan.parentCommentId,
      rootCommentId: plan.rootCommentId,
      depth: plan.depth,
      threadPath: plan.threadPath,
      alreadyReplied: false,
      replyText: plan.replyText,
      replyTextHash: plan.replyTextHash,
      snapshotId: plan.snapshotId,
      expiresAt: plan.expiresAt,
      verified: true,
      actorAccount: plan.actorAccount,
    };
  }

  async prepareCreatorReplyFromMatch(options: {
    workId: string;
    authorQuery?: string;
    textQuery?: string;
    replyText: string;
    status?: "all" | "unreplied" | "replied";
    rootOnly?: boolean;
    matchMode?: CreatorCommentMatchMode;
  }): Promise<CreatorPrepareReplyFromMatchResult> {
    return this.serial(async () => {
    assertWriteReady();
    const replyText = options.replyText.trim();
    if (!replyText || replyText.length > 500) {
      throw new Error("VALIDATION_FAILED:回复必须是 1-500 个字符。");
    }
    const found = await this.findCreatorComments({
      workId: options.workId,
      authorQuery: options.authorQuery,
      textQuery: options.textQuery,
      status: options.status ?? "unreplied",
      rootOnly: options.rootOnly,
      matchMode: options.matchMode,
      limit: 20,
    });
    if (found.totalMatched === 0) {
      return {
        matchStatus: "not_found",
        candidates: [],
        candidateCount: 0,
        sent: false,
        workId: options.workId,
        replyText,
      };
    }
    if (found.totalMatched !== 1) {
      return {
        matchStatus: "ambiguous",
        candidates: found.items,
        candidateCount: found.totalMatched,
        sent: false,
        workId: options.workId,
        replyText,
      };
    }
    const candidate = found.items[0];
    if (candidate.matchScore < 0.8) {
      return {
        matchStatus: "low_confidence",
        candidates: [candidate],
        candidateCount: 1,
        sent: false,
        workId: options.workId,
        replyText,
      };
    }
    const tokenRecord = this.creatorCommentMatchTokens.get(candidate.matchToken);
    if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) {
      throw new Error("MATCH_TOKEN_EXPIRED:匹配快照已过期，未创建回复计划。");
    }
    const page = await this.creatorCenterPage();
    const dataset = await this.completeCreatorCommentDataset(page, options.workId);
    const current = dataset.items.filter(item => item.commentId === tokenRecord.item.commentId);
    if (current.length !== 1
      || current[0].workId !== tokenRecord.item.workId
      || current[0].author !== tokenRecord.item.author
      || current[0].text !== tokenRecord.item.text
      || current[0].parentCommentId !== tokenRecord.item.parentCommentId
      || current[0].rootCommentId !== tokenRecord.item.rootCommentId) {
      throw new Error("MATCH_TARGET_CHANGED:匹配目标在冻结前发生变化，未创建回复计划。");
    }
    const plan = this.createCreatorReplyPlan(
      options.workId,
      current[0],
      replyText,
      "match_index",
      null,
    );
    return {
      ...plan,
      matchStatus: "prepared",
      candidates: [candidate],
    };
    }, { restoreOnError: false, persistPageState: false });
  }

  async prepareCreatorReply(options: {
    workId: string;
    commentId: string;
    text: string;
  }): Promise<CreatorReplyPlanResult> {
    return this.serial(async () => {
      assertWriteReady();
      const replyText = options.text.trim();
      if (!replyText || replyText.length > 500) {
        throw new Error("VALIDATION_FAILED:回复必须是 1-500 个字符。");
      }

      try {
        const page = await this.creatorCenterPage();
        const currentFilterKeyword = await this.creatorCurrentFilterKeyword(page);
        let targetSource: "dataset" | "current_filtered" = "dataset";
        let filterKeyword: string | null = null;
        let listed: {
          workId: string | null;
          workTitle: string | null;
          items: CreatorCommentItem[];
        };
        if (currentFilterKeyword) {
          const filtered = await this.readCurrentFilteredCreatorCommentsOnPage(
            page,
            options.workId,
            true,
          );
          listed = filtered;
          targetSource = "current_filtered";
          filterKeyword = filtered.keyword;
        } else {
          const recentDataset = this.creatorCommentDatasetCache.get(options.workId);
          listed = recentDataset
            && recentDataset.includesReplies
            && Date.now() - recentDataset.capturedAt <= 60_000
            ? {
                workId: recentDataset.workId,
                workTitle: recentDataset.workTitle,
                items: recentDataset.items,
              }
            : await this.listCreatorComments({
                workId: options.workId,
                sort: "latest",
                status: "all",
                limit: 100,
              });
        }
        if (listed.workId !== options.workId) {
          throw new Error("WRONG_PAGE:creator_center 当前作品与 work_id 不一致。");
        }
        const preparedItems = targetSource === "current_filtered"
          ? listed.items
          : this.creatorCommentDatasetCache.get(options.workId)?.items ?? listed.items;
        const resolved = this.resolveCreatorReplyTarget(preparedItems, options.commentId);
        return this.createCreatorReplyPlan(
          options.workId,
          resolved.target,
          replyText,
          targetSource,
          filterKeyword,
        );
      } catch (error) {
        const message = String(error);
        const targetUnavailable = message.includes(
          "VALIDATION_FAILED:目标 work_id 中没有唯一匹配的 comment_id。",
        ) || message.includes(
          "VALIDATION_FAILED:无法从 creator_center 当前筛选结果可靠读取稳定 comment_id",
        );
        if (!targetUnavailable) throw error;
      }

      const detailTarget = await this.createScopedTargetGate({
        scope: "own_post",
        actionType: "reply_to_comment",
        workId: options.workId,
        commentId: options.commentId,
      });
      if (!detailTarget.targetComment || !detailTarget.rootComment) {
        throw new Error("TARGET_COMMENT_NOT_VERIFIED:作品页备用路线未能唯一验证目标评论。");
      }
      const targetComment = detailTarget.targetComment;
      const duplicate = (detailTarget.rootComment.replies ?? [])
        .filter(reply => reply.parentCommentId === targetComment.commentId)
        .some(reply => reply.author === loadActionSettings().operator.displayName
          && normalizeCreatorReplyText(reply.text)
            === normalizeCreatorReplyText(replyText));
      if (duplicate) {
        throw new Error("DUPLICATE_COMMENT:目标评论下已有相同 Operator 回复。");
      }
      const operation = this.writeOperationStore.create({
        scope: "own_post",
        actionType: "reply_to_comment",
        actorAccount: loadActionSettings().operator.displayName,
        pageRole: detailTarget.gate.pageRole,
        workId: options.workId,
        workTitle: detailTarget.workTitle,
        commentId: targetComment.commentId,
        targetAuthor: targetComment.author,
        targetText: targetComment.text,
        targetTextHash: sha256(targetComment.text),
        parentCommentId: targetComment.parentCommentId,
        rootCommentId: targetComment.rootCommentId,
        depth: targetComment.depth,
        threadPath: targetComment.threadPath,
        writeText: replyText,
        gateSnapshot: detailTarget.gate,
        expiresAt: detailTarget.gate.expiresAt,
      });
      if (operation.state === "confirmed") {
        throw new Error(
          `ALREADY_CONFIRMED:operation_id=${operation.operationId};`
          + `reply_comment_id=${operation.resultingCommentId ?? "unknown"}`,
        );
      }
      if (operation.state !== "prepared") {
        throw new Error(
          `DUPLICATE_TRANSACTION:作品页备用回复事务状态为 ${operation.state}，未创建重复计划。`,
        );
      }
      return {
        replyPlanId: operation.token,
        transactionId: operation.operationId,
        token: operation.token,
        operationId: operation.operationId,
        operation_id: operation.operationId,
        status: "prepared",
        actorAccount: operation.actorAccount,
        workId: operation.workId,
        workTitle: operation.workTitle,
        targetCommentId: operation.commentId!,
        targetAuthor: operation.targetAuthor!,
        targetText: operation.targetText!,
        targetTextHash: operation.targetTextHash!,
        parentCommentId: operation.parentCommentId,
        rootCommentId: operation.rootCommentId!,
        depth: operation.depth,
        threadPath: operation.threadPath,
        alreadyReplied: false,
        replyText: operation.writeText,
        replyTextHash: operation.writeTextHash,
        snapshotId: sha256(JSON.stringify(operation.gateSnapshot)).slice(0, 24),
        expiresAt: operation.expiresAt,
        verified: true,
      };
    }, { restoreOnError: false });
  }

  async commitCreatorReply(
    replyPlanId: string,
    confirmSend: boolean,
  ): Promise<CreatorReplyTransactionResult> {
    return this.serial(async () => {
      let plan = this.creatorReplyStore.get(replyPlanId)
        ?? this.creatorReplyStore.getByTransactionId(replyPlanId);
      if (!plan) throw new Error("REPLY_PLAN_NOT_FOUND:token/operation_id 不存在。");
      if (!confirmSend) {
        throw new Error("CONFIRMATION_REQUIRED:commit 必须提供 confirm_send=true。");
      }
      if (plan.status !== "prepared" || plan.clicked) {
        return this.creatorReplyTransactionResult(plan, plan.status === "confirmed");
      }
      if (Date.parse(plan.expiresAt) <= Date.now()) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "expired",
          blockedReason: "reply_plan_expired",
        });
        return this.creatorReplyTransactionResult(plan);
      }

      const page = await this.creatorCenterPage();
      const creatorAccount = await this.assertCreatorCenterAccount(page);
      if (creatorAccount.displayName !== plan.actorAccount) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "failed_before_click",
          blockedReason: `creator_account_changed:${plan.actorAccount}->${creatorAccount.displayName}`,
        });
        return this.creatorReplyTransactionResult(plan);
      }
      let currentWorkId: string | null;
      let commitItems: CreatorCommentItem[];
      if (plan.targetSource === "current_filtered") {
        let filtered: CreatorCurrentFilteredRead;
        try {
          filtered = await this.readCurrentFilteredCreatorCommentsOnPage(
            page,
            plan.workId,
            true,
          );
        } catch (error) {
          plan = this.creatorReplyStore.update(plan.replyPlanId, {
            status: "failed_before_click",
            blockedReason: `current_filtered_target_unavailable:${String(error)}`,
          });
          return this.creatorReplyTransactionResult(plan);
        }
        if (filtered.keyword !== plan.filterKeyword) {
          plan = this.creatorReplyStore.update(plan.replyPlanId, {
            status: "failed_before_click",
            blockedReason: "current_filter_changed",
          });
          return this.creatorReplyTransactionResult(plan);
        }
        currentWorkId = filtered.workId;
        commitItems = filtered.items;
      } else if (plan.targetSource === "match_index") {
        const dataset = await this.completeCreatorCommentDataset(page, plan.workId, true, false);
        currentWorkId = dataset.workId;
        commitItems = dataset.items;
      } else {
        const listed = await this.listCreatorComments({
          workId: plan.workId,
          sort: "latest",
          status: "all",
          limit: 100,
        });
        currentWorkId = listed.workId;
        commitItems = this.creatorCommentDatasetCache.get(plan.workId)?.items
          ?? listed.items;
      }
      let resolved: ResolvedCreatorReplyTarget;
      try {
        resolved = this.resolveCreatorReplyTarget(commitItems, plan.targetCommentId);
      } catch (error) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "failed_before_click",
          blockedReason: `target_missing:${String(error)}`,
        });
        return this.creatorReplyTransactionResult(plan);
      }
      const target = resolved.target;
      const frozenMatches = frozenCreatorTargetMatches(plan, {
        workId: currentWorkId ?? "",
        commentId: target.commentId,
        author: target.author,
        text: target.text,
        parentCommentId: target.parentCommentId,
        rootCommentId: target.rootCommentId,
        depth: target.depth,
        threadPath: target.threadPath,
      });
      if (!frozenMatches || target.hasReplied) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "rejected",
          blockedReason: target.hasReplied ? "already_replied" : "frozen_target_changed",
        });
        return this.creatorReplyTransactionResult(plan);
      }

      await enforceWritePolicy(
        "creator_comment_reply",
        `${page.url()}#${plan.targetCommentId}`,
      );
      await this.assertCreatorCenterAccount(page);
      const domTarget = plan.targetSource === "match_index"
        ? (await this.positionCreatorReplyTargetInDom(page, plan.workId, resolved)).domTarget
        : await this.expandAndLocateCreatorReplyTarget(page, plan.workId, resolved);
      if (domTarget.target.commentId !== plan.targetCommentId
        || domTarget.target.author !== plan.targetAuthor
        || domTarget.target.text !== plan.targetText) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "failed_before_click",
          blockedReason: "dom_target_mismatch",
        });
        return this.creatorReplyTransactionResult(plan);
      }
      const composer = await this.creatorReplyEditor(page, domTarget);
      await composer.editor.fill(plan.replyText);
      if ((await composer.editor.innerText()).trim() !== plan.replyText) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "failed_before_click",
          blockedReason: "reply_text_fill_mismatch",
        });
        return this.creatorReplyTransactionResult(plan);
      }
      const beforeSendRecord = await this.locateCreatorCommentRecord(page, domTarget.targetApi, {
        workId: plan.workId,
        scope: target.isReply ? domTarget.threadRootRecord : undefined,
        parentCommentFound: !target.isReply || Boolean(domTarget.immediateParent),
        parentThreadExpanded: domTarget.parentThreadExpanded,
      });
      if (await beforeSendRecord.count() !== 1 || await composer.send.isDisabled()) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "failed_before_click",
          blockedReason: "pre_submit_target_or_button_changed",
        });
        return this.creatorReplyTransactionResult(plan);
      }

      const clickTransition = this.creatorReplyStore.markClickStartedIfPrepared(plan.replyPlanId);
      plan = clickTransition.record;
      if (!clickTransition.transitioned) {
        return this.creatorReplyTransactionResult(plan);
      }
      let clickError: string | null = null;
      try {
        await composer.send.click();
      } catch (error) {
        clickError = String(error);
      }
      const replyCommentId = await this.pollCreatorReplyConfirmation(
        page,
        resolved,
        plan,
        10_000,
      );
      if (replyCommentId) {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "confirmed",
          replyCommentId,
          verifiedInCreatorCenter: true,
          confirmedAt: new Date().toISOString(),
          blockedReason: null,
        });
      } else {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "unknown_after_submit",
          blockedReason: clickError
            ? `click_result_unknown:${clickError}`
            : "reply_confirmation_not_found_after_submit",
        });
      }
      appendActionLog(this.actionLogBase(
        "douyin_creator_commit_reply",
        "creator_comment_reply",
        {
          workUrl: `${page.url()}#${plan.workId}`,
          author: plan.targetAuthor,
          beforeState: plan.targetCommentId,
          afterState: plan.replyCommentId ?? plan.status,
          success: plan.status === "confirmed",
        },
      ));
      return this.creatorReplyTransactionResult(plan);
    }, { restoreOnError: false });
  }

  private creatorReplyCandidateMatchesPlan(
    reply: CreatorApiComment,
    plan: CreatorReplyPlanRecord,
  ): boolean {
    const creatorAccount = this.activeCreatorAccount;
    if (!creatorAccount || creatorAccount.displayName !== plan.actorAccount) return false;
    const clickedAt = Date.parse(plan.clickedAt ?? "");
    const createdAt = reply.createdAt == null ? Number.NaN : reply.createdAt * 1000;
    const withinSubmitWindow = Number.isFinite(clickedAt)
      && Number.isFinite(createdAt)
      && createdAt >= clickedAt - 30_000
      && createdAt <= clickedAt + 10 * 60_000;
    return reply.parentCommentId === plan.targetCommentId
      && reply.author === creatorAccount.displayName
      && this.isCreatorOwnApiComment(reply, creatorAccount)
      && normalizeCreatorReplyText(reply.text) === normalizeCreatorReplyText(plan.replyText)
      && sha256(normalizeCreatorReplyText(reply.text))
        === sha256(normalizeCreatorReplyText(plan.replyText))
      && withinSubmitWindow;
  }

  private async readVisibleCreatorReplyCandidates(page: Page): Promise<CreatorApiComment[]> {
    const rows = await page.evaluate(() => {
      type FiberNode = {
        memoizedProps?: any;
        return?: FiberNode | null;
      };
      const fiberFor = (element: Element): FiberNode | null => {
        const key = Object.keys(element).find(value => value.startsWith("__reactFiber$"));
        return key ? ((element as any)[key] as FiberNode | undefined) ?? null : null;
      };
      const normalizedId = (value: unknown): string | null => {
        const id = String(value ?? "");
        return /^\d{8,}$/.test(id) && id !== "0" ? id : null;
      };
      const found = new Map<string, {
        cid: string;
        text: string;
        nickname: string;
        uid: string | null;
        secUid: string | null;
        parentCommentId: string | null;
        createdAt: number | null;
      }>();
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[class*='comment-content-text-']"),
      );
      for (const node of nodes) {
        let element: HTMLElement | null = node;
        let captured = false;
        for (let domDepth = 0; element && domDepth < 10; domDepth += 1) {
          let fiber = fiberFor(element);
          for (let fiberDepth = 0; fiber && fiberDepth < 24; fiberDepth += 1) {
            const props = fiber.memoizedProps;
            const cid = normalizedId(props?.id ?? props?.commentId ?? props?.comment?.cid);
            const text = String(props?.content ?? props?.comment?.text ?? "").trim();
            const nickname = String(
              props?.username ?? props?.comment?.user?.nickname ?? "",
            ).trim();
            if (cid && text && nickname) {
              const levelOneCid = normalizedId(props?.levelOneCid ?? props?.comment?.reply_id);
              const directParent = normalizedId(
                props?.replyToReplyId
                ?? props?.reply_to_reply_id
                ?? props?.comment?.reply_to_reply_id,
              );
              const rawCreatedAt = props?.createTime
                ?? props?.create_time
                ?? props?.comment?.create_time;
              found.set(cid, {
                cid,
                text,
                nickname,
                uid: normalizedId(props?.comment?.user?.uid),
                secUid: String(props?.comment?.user?.sec_uid ?? "").trim() || null,
                parentCommentId: directParent ?? levelOneCid,
                createdAt: Number.isFinite(Number(rawCreatedAt)) ? Number(rawCreatedAt) : null,
              });
              captured = true;
              break;
            }
            fiber = fiber.return ?? null;
          }
          if (captured) break;
          element = element.parentElement;
        }
      }
      return [...found.values()];
    });
    return rows.map(row => ({
      commentId: row.cid,
      text: row.text,
      author: row.nickname,
      authorUid: row.uid,
      authorSecUid: row.secUid,
      createdAt: row.createdAt,
      likeCount: null,
      status: null,
      parentCommentId: row.parentCommentId,
      replyCount: 0,
      level: 2,
      avatarFingerprint: null,
    }));
  }

  private async reconcileCreatorReplyPlanReadOnly(
    page: Page,
    pendingPlan: CreatorReplyPlanRecord,
  ): Promise<CreatorReplyPlanRecord> {
      let plan = pendingPlan;
      if (plan.status === "click_started") {
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "unknown_after_submit",
          blockedReason: "recovered_from_click_started_after_restart",
        });
      }
      const direct = await this.fetchCreatorRepliesDirect(
        page,
        plan.workId,
        plan.rootCommentId,
      );
      const candidates = (direct ?? []).filter(reply =>
        this.creatorReplyCandidateMatchesPlan(reply, plan));
      if (!direct || candidates.length === 0) {
        const visible = await this.readVisibleCreatorReplyCandidates(page).catch(() => []);
        candidates.push(...visible.filter(reply =>
          this.creatorReplyCandidateMatchesPlan(reply, plan)));
      }
      const unique = new Map(candidates.map(reply => [reply.commentId, reply]));
      if (unique.size === 1) {
        const verified = [...unique.values()][0];
        plan = this.creatorReplyStore.update(plan.replyPlanId, {
          status: "confirmed",
          replyCommentId: verified.commentId,
          verifiedInCreatorCenter: true,
          confirmedAt: new Date().toISOString(),
          blockedReason: null,
        });
        this.creatorOwnReplyIds.set(
          `${plan.workId}:${plan.targetCommentId}:${plan.replyText}`,
          verified.commentId,
        );
        appendActionLog(this.actionLogBase(
          "douyin_creator_get_reply_status",
          "creator_comment_reply_status",
          {
            workUrl: `${page.url()}#${plan.workId}`,
            author: plan.targetAuthor,
            beforeState: "unknown_after_submit",
            afterState: verified.commentId,
            success: true,
          },
        ));
      }
      return plan;
  }

  private async reconcileReplyOperationsUnlocked(): Promise<CreatorReplyReconcileResult> {
    const operations: CreatorReplyReconcileResult["operations"] = [];
    const recoverable = this.creatorReplyStore.listRecoverable();
    let page: Page | null = null;
    for (const original of recoverable) {
      if (original.status === "prepared") {
        if (Date.parse(original.expiresAt) <= Date.now()) {
          const expired = this.creatorReplyStore.update(original.replyPlanId, {
            status: "expired",
            blockedReason: "expired_during_startup_recovery",
          });
          operations.push({
            operationId: original.transactionId,
            previousState: original.status,
            state: expired.status,
            result: "expired",
            replyCommentId: null,
            error: null,
          });
        } else {
          operations.push({
            operationId: original.transactionId,
            previousState: original.status,
            state: original.status,
            result: "left_prepared",
            replyCommentId: null,
            error: null,
          });
        }
        continue;
      }
      try {
        page ??= await this.creatorCenterPage();
        const reconciled = await this.reconcileCreatorReplyPlanReadOnly(page, original);
        const confirmed = reconciled.status === "confirmed";
        operations.push({
          operationId: original.transactionId,
          previousState: original.status,
          state: reconciled.status,
          result: confirmed ? "confirmed" : "still_unknown",
          replyCommentId: reconciled.replyCommentId,
          error: confirmed ? null : reconciled.blockedReason,
        });
      } catch (error) {
        const unknown = this.creatorReplyStore.update(original.replyPlanId, {
          status: "unknown_after_submit",
          blockedReason: `reconcile_failed:${String(error)}`,
        });
        operations.push({
          operationId: original.transactionId,
          previousState: original.status,
          state: unknown.status,
          result: "still_unknown",
          replyCommentId: null,
          error: String(error),
        });
      }
    }
    return {
      checkedAt: new Date().toISOString(),
      operations,
      unresolvedOperationIds: this.creatorReplyStore
        .listUnresolvedAfterSubmit()
        .map(operation => operation.transactionId),
      sent: false,
    };
  }

  private async reconcileGeneralWriteOperationsUnlocked(): Promise<CreatorReplyReconcileResult> {
    const operations: CreatorReplyReconcileResult["operations"] = [];
    for (const original of this.writeOperationStore.listRecoverableGeneral()) {
      if (original.state === "prepared") {
        if (Date.parse(original.expiresAt) <= Date.now()) {
          const expired = this.writeOperationStore.update(original.token, {
            state: "expired",
            lastError: "expired_during_startup_recovery",
          });
          operations.push({
            operationId: original.operationId,
            previousState: original.state,
            state: expired.state,
            result: "expired",
            replyCommentId: null,
            error: null,
          });
        } else {
          operations.push({
            operationId: original.operationId,
            previousState: original.state,
            state: original.state,
            result: "left_prepared",
            replyCommentId: null,
            error: null,
          });
        }
        continue;
      }
      try {
        if (original.actionType === "create_root_comment") {
          const readback = await this.strictRootCommentReadbackUnlocked(
            original,
          );
          if (readback.confirmed && readback.serverCommentId) {
            const confirmed = this.writeOperationStore.update(
              original.token,
              {
                state: "confirmed",
                confirmedAt: new Date().toISOString(),
                resultingCommentId: readback.serverCommentId,
                serverDisplayText: readback.serverDisplayText,
                confirmationMethod: readback.confirmationMethod,
                lastError: null,
              },
            );
            operations.push({
              operationId: original.operationId,
              previousState: original.state,
              state: confirmed.state,
              result: "confirmed",
              replyCommentId: confirmed.resultingCommentId,
              error: null,
            });
          } else {
            const unknown = this.writeOperationStore.update(original.token, {
              state: "unknown_after_submit",
              lastError: readback.serverCommentId
                ? "strict_readback_not_confirmed"
                : "server_comment_id_missing",
            });
            operations.push({
              operationId: original.operationId,
              previousState: original.state,
              state: unknown.state,
              result: "still_unknown",
              replyCommentId: null,
              error: unknown.lastError,
            });
          }
          continue;
        }
        const target = await this.pageForTargetWriteScope(
          original.scope,
          original.workId,
          original.gateSnapshot.alias ?? undefined,
          false,
        );
        if (!original.commentId) {
          throw new Error("TARGET_COMMENT_NOT_VERIFIED:回复恢复事务缺少 comment_id。");
        }
        await this.ensureCommentIdLoaded(
          target.page,
          original.commentId,
          original.rootCommentId,
        );
        const comments = await this.parseComments(target.page, 500, true, 500);
        const matches = comments.flatMap(comment => [comment, ...(comment.replies ?? [])])
          .filter(comment =>
            comment.author === original.actorAccount
            && normalizeCreatorReplyText(comment.text)
              === normalizeCreatorReplyText(original.writeText)
            && (original.actionType === "create_root_comment"
              ? comment.parentCommentId == null
              : comment.parentCommentId === original.commentId));
        if (matches.length === 1) {
          const confirmed = this.writeOperationStore.update(original.token, {
            state: "confirmed",
            confirmedAt: new Date().toISOString(),
            resultingCommentId: matches[0].commentId,
            lastError: null,
          });
          operations.push({
            operationId: original.operationId,
            previousState: original.state,
            state: confirmed.state,
            result: "confirmed",
            replyCommentId: confirmed.resultingCommentId,
            error: null,
          });
        } else {
          const unknown = this.writeOperationStore.update(original.token, {
            state: "unknown_after_submit",
            lastError: matches.length > 1
              ? "readback_ambiguous"
              : "readback_not_found",
          });
          operations.push({
            operationId: original.operationId,
            previousState: original.state,
            state: unknown.state,
            result: "still_unknown",
            replyCommentId: null,
            error: unknown.lastError,
          });
        }
      } catch (error) {
        const unknown = this.writeOperationStore.update(original.token, {
          state: "unknown_after_submit",
          lastError: `reconcile_failed:${String(error)}`,
        });
        operations.push({
          operationId: original.operationId,
          previousState: original.state,
          state: unknown.state,
          result: "still_unknown",
          replyCommentId: null,
          error: unknown.lastError,
        });
      }
    }
    return {
      checkedAt: new Date().toISOString(),
      operations,
      unresolvedOperationIds: this.writeOperationStore
        .listUnresolvedGeneral()
        .map(operation => operation.operationId),
      sent: false,
    };
  }

  private async reconcileSocialOperationsUnlocked(): Promise<CreatorReplyReconcileResult> {
    const operations: CreatorReplyReconcileResult["operations"] = [];
    for (const original of this.socialOperationStore.listUnresolved()) {
      const previousState = original.state === "click_started"
        ? "click_started" as const
        : "unknown_after_submit" as const;
      if (original.actionKind === "safe_social") {
        operations.push({
          operationId: original.operationId,
          previousState,
          state: "unknown_after_submit",
          result: "still_unknown",
          resultingMessageId: original.resultingMessageId,
           error: "authoritative_readback_not_implemented_for_safe_social_action",
           operationType: "safe_social",
        });
        continue;
      }
      try {
        const bound = getBoundUser(original.boundAlias);
        if (bound.uid !== original.targetUid) {
          throw new Error("BOUND_USER_CHANGED:stable uid mismatch");
        }
        const baselineValues = original.evidence.beforeMatchingMessageIds;
        const baselineAvailable = Array.isArray(baselineValues)
          && baselineValues.every(value => typeof value === "string");
        if (original.actionKind === "message" && !baselineAvailable) {
          throw new Error("BOUND_MESSAGE_RECOVERY_BASELINE_MISSING");
        }
        const baselineIds = new Set<string>(
          baselineAvailable ? baselineValues as string[] : [],
        );
        const latestBaselineId = typeof original.evidence.beforeLatestMessageId === "string"
          ? original.evidence.beforeLatestMessageId
          : null;
        const matches = await this.withBoundProfile(bound, async page => {
          const conversationPage = await this.openBoundConversationFullscreen(page, bound);
          const messages = await this.parseBoundMessages(
            conversationPage,
            bound,
            100,
            false,
            latestBaselineId ? new Set([latestBaselineId]) : undefined,
          );
          if (original.actionKind === "share") {
            return messages.filter(message =>
              message.direction !== "incoming"
              && message.messageType === "shared_work"
              && Boolean(original.workId)
              && message.workId === original.workId);
          }
          return messages.filter(message =>
            !baselineIds.has(message.messageId)
            && message.direction === "outgoing"
            && message.messageType === "text"
            && (original.actionKey !== "native_reply" || Boolean(message.nativeReference))
            && sha256(normalizeCreatorReplyText(message.text))
              === original.payloadHash);
        });
        if (matches.length === 1) {
          const confirmed = this.socialOperationStore.update(original.operationId, {
            state: "confirmed",
            resultingMessageId: matches[0].messageId,
            evidence: {
              ...original.evidence,
              recoveredBy: original.actionKind === "share"
                ? "bound_conversation_exact_shared_work_id"
                : original.actionKey === "native_reply"
                  ? "bound_conversation_new_server_id_native_reply"
                  : "bound_conversation_new_server_id_outgoing_text",
              recoveryCandidateIds: matches.map(message => message.messageId),
            },
            lastError: null,
          });
          operations.push({
            operationId: original.operationId,
            previousState,
            state: "confirmed",
            result: "confirmed",
            resultingMessageId: confirmed.resultingMessageId,
            error: null,
             operationType: original.actionKind === "share" ? "social_share" : "social_message",
          });
        } else {
          this.socialOperationStore.update(original.operationId, {
            state: "unknown_after_submit",
            evidence: original.evidence,
            lastError: original.lastError ?? "message_readback_still_unknown",
          });
          operations.push({
            operationId: original.operationId,
            previousState,
            state: "unknown_after_submit",
            result: "still_unknown",
            resultingMessageId: original.resultingMessageId,
            error: original.lastError ?? "message_readback_still_unknown",
             operationType: original.actionKind === "share" ? "social_share" : "social_message",
          });
        }
      } catch (error) {
        this.socialOperationStore.update(original.operationId, {
          state: "unknown_after_submit",
          evidence: original.evidence,
          lastError: String(error),
        });
        operations.push({
          operationId: original.operationId,
          previousState,
          state: "unknown_after_submit",
          result: "still_unknown",
          resultingMessageId: original.resultingMessageId,
          error: String(error),
          operationType: original.actionKind === "share" ? "social_share" : "social_message",
        });
      }
    }
    return {
      checkedAt: new Date().toISOString(),
      operations,
      unresolvedOperationIds: this.socialOperationStore
        .listUnresolved()
        .map(operation => operation.operationId),
      sent: false,
    };
  }

  async reconcileReplyOperations(): Promise<CreatorReplyReconcileResult> {
    return this.serial(async () => {
      const result = await this.reconcileReplyOperationsUnlocked();
      const general = await this.reconcileGeneralWriteOperationsUnlocked();
      result.operations.push(...general.operations);
      result.unresolvedOperationIds.push(...general.unresolvedOperationIds);
      const social = await this.reconcileSocialOperationsUnlocked();
      result.operations.push(...social.operations);
      result.unresolvedOperationIds.push(...social.unresolvedOperationIds);
      const gate = getWriteGateState();
      result.unresolvedOperationIds = this.collectAllUnresolvedOperationIds();
      const globalBlockingOperationIds = this.collectGlobalBlockingUnresolvedOperationIds();
      const blockedReasons = gate.blockedReasons
        .filter(reason => reason !== "unresolved_reply_operations");
      if (globalBlockingOperationIds.length > 0) {
        blockedReasons.push("unresolved_reply_operations");
      }
      const canWrite = blockedReasons.length === 0
        && gate.browserConnected
        && gate.profileVerified
        && gate.accountVerified
        && gate.creatorCenterReady
        && gate.ledgerWritable;
      setWriteGateState({
        ...gate,
        mode: canWrite ? "write_ready" : startupFailureMode(blockedReasons),
        globalWriteReady: canWrite,
        unresolvedOperationIds: globalBlockingOperationIds,
        blockedReasons,
        checkedAt: new Date().toISOString(),
      });
      return result;
    }, { restoreOnError: false, persistPageState: false });
  }

  async getCreatorReplyStatus(transactionId: string): Promise<CreatorReplyTransactionResult> {
    return this.serial(async () => {
      let plan = this.creatorReplyStore.getByTransactionId(transactionId);
      if (!plan) throw new Error("TRANSACTION_NOT_FOUND:transactionId 不存在。");
      if (plan.status !== "click_started" && plan.status !== "unknown_after_submit") {
        return this.creatorReplyTransactionResult(plan);
      }
      const page = await this.creatorCenterPage();
      plan = await this.reconcileCreatorReplyPlanReadOnly(page, plan);
      return this.creatorReplyTransactionResult(plan);
    }, { restoreOnError: false, persistPageState: false });
  }

  async replyCreatorComment(options: {
    commentId: string;
    targetWorkId: string;
    text: string;
    action?: "preview" | "send";
    confirmSend?: boolean;
  }): Promise<CreatorReplyResult> {
    return this.serial(async () => {
      const text = options.text.trim();
      if (!text || text.length > 500) throw new Error("回复必须是 1-500 个字符。");
      const listed = await this.listCreatorComments({
        workId: options.targetWorkId,
        sort: "latest",
        status: "all",
        limit: 100,
      });
      if (listed.workId !== options.targetWorkId) {
        throw new Error("WRONG_PAGE:creator_center 当前作品与 target_work_id 不一致。");
      }
      const resolvedTarget = this.resolveCreatorReplyTarget(listed.items, options.commentId);
      const target = resolvedTarget.target;
      const decision = decideCommentAction({
        action: options.action,
        confirmSend: options.confirmSend,
        text,
        existingTexts: target.ownReplyText
          ? [target.ownReplyText]
          : this.creatorOwnReplyIds.has(
            `${options.targetWorkId}:${options.commentId}:${text}`,
          ) ? [text] : [],
      });
      if (decision.errorCode === "CONFIRMATION_REQUIRED") {
        throw new Error("CONFIRMATION_REQUIRED:真实回复必须同时提供 action=send 和 confirm_send=true。");
      }
      if (decision.errorCode === "DUPLICATE_COMMENT") {
        throw new Error("DUPLICATE_COMMENT:创作者中心已存在完全相同的本人回复，未重复发送。");
      }
      const page = await this.creatorCenterPage();
      if (!decision.shouldSend) {
        const artifact = await this.saveCommentArtifact(page, "creator-reply-preview", {
          targetWorkId: options.targetWorkId,
          targetCommentId: options.commentId,
          parentCommentId: target.parentCommentId,
          isReply: target.isReply,
          targetAuthor: target.author,
          targetText: target.text,
          replyText: text,
          sent: false,
        });
        return {
          preview: true,
          sent: false,
          workId: options.targetWorkId,
          workTitle: target.workTitle,
          targetCommentId: options.commentId,
          targetAuthor: target.author,
          targetText: target.text,
          replyText: text,
          alreadyReplied: target.hasReplied,
          verified: true,
          ...artifact,
        };
      }

      throw new Error(
        "WORKFLOW_REQUIRED:真实回复已迁移到 douyin_creator_prepare_reply → "
        + "douyin_creator_commit_reply；旧接口只保留 preview，未发送。",
      );

      await enforceWritePolicy("creator_comment_reply", `${page.url()}#${options.commentId}`);
      await this.assertCreatorCenterAccount(page);
      const domTarget = await this.expandAndLocateCreatorReplyTarget(
        page,
        options.targetWorkId,
        resolvedTarget,
      );
      const composer = await this.creatorReplyEditor(page, domTarget);
      await composer.editor.fill(text);
      const filled = (await composer.editor.innerText()).trim();
      if (filled !== text) {
        throw new Error("VALIDATION_FAILED:回复文字没有稳定写入目标评论编辑器。");
      }
      await this.assertCreatorCenterAccount(page);
      const beforeSendRecord = await this.locateCreatorCommentRecord(page, domTarget.targetApi, {
        workId: options.targetWorkId,
        scope: target.isReply ? domTarget.threadRootRecord : undefined,
        parentCommentFound: !target.isReply || Boolean(domTarget.immediateParent),
        parentThreadExpanded: domTarget.parentThreadExpanded,
      });
      if (await beforeSendRecord.count() !== 1 || await composer.send.isDisabled()) {
        throw new Error("VALIDATION_FAILED:发送前目标评论或发送按钮状态已改变。");
      }

      await composer.send.click();
      await page.waitForTimeout(CONFIG.actionDelayMs);
      let verified = false;
      let replyCommentId: string | null = null;
      try {
        const refreshed = await this.listCreatorComments({
          workId: options.targetWorkId,
          sort: "latest",
          status: "all",
          limit: 100,
        });
        const refreshedTarget = refreshed.items.find(item => item.commentId === options.commentId);
        replyCommentId = this.creatorOwnReplyIds.get(
          `${options.targetWorkId}:${options.commentId}:${text}`,
        ) ?? null;
        verified = Boolean(refreshedTarget?.hasReplied
          && refreshedTarget?.ownReplyText === text
          && replyCommentId);
      } catch {
        verified = false;
      }

      const status = verified ? "sent" as const : "unknown_after_submit" as const;
      const artifact = await this.saveCommentArtifact(page, `creator-reply-${status}`, {
        targetWorkId: options.targetWorkId,
        targetCommentId: options.commentId,
        replyCommentId,
        text,
        status,
        verifiedInCreatorCenter: verified,
      });
      appendActionLog(this.actionLogBase("douyin_creator_reply_comment", "creator_comment_reply", {
        workUrl: `${page.url()}#${options.targetWorkId}`,
        author: target.author,
        beforeState: options.commentId,
        afterState: replyCommentId ?? status,
        success: verified,
      }));
      return {
        preview: false,
        sent: true,
        success: verified,
        status,
        workId: options.targetWorkId,
        workTitle: target.workTitle,
        targetCommentId: options.commentId,
        replyCommentId,
        creatorReplyRecordId: replyCommentId,
        text,
        verifiedInCreatorCenter: verified,
        ...artifact,
      };
    }, { restoreOnError: false });
  }

  async getCurrentWorkContext(
    pageRole: "operator_home" | "codex_test" = "operator_home",
  ): Promise<CurrentWorkContextResult> {
    return this.serial(async () => {
      await this.ensurePageRoles();
      const page = this.rolePages.get(pageRole);
      if (!page || page.isClosed()) throw new Error(`PAGE_BINDING_LOST:${pageRole} 页面不存在。`);
      let loggedInAccount: string | null = null;
      await this.assertOperatorAccount(page).then(() => {
        loggedInAccount = loadActionSettings().operator.displayName;
      }).catch(() => null);
      let context: WorkContext | null = null;
      try {
        context = await this.captureWorkContext(page);
      } catch {
        context = null;
      }
      const bound = getBoundUser("bound_user");
      let authorName: string | null = null;
      let authorMatchesAlias: boolean | null = null;
      let isOwnWork: boolean | null = null;
      if (context) {
        authorName = await this.currentAuthor(page, context) ?? null;
        authorMatchesAlias = await this.verifyBoundWorkAuthor(page, bound, context)
          .then(() => true)
          .catch(() => false);
        isOwnWork = await this.verifyOwnWorkAuthor(page, context)
          .then(() => true)
          .catch(() => false);
      }
      const lock = this.lockedWorkContexts.get(pageRole);
      const workLocked = Boolean(context && workLockMatches(lock, context.workId));
      const type = context?.url.match(/\/(video|note|article)\//)?.[1] as
        | "video" | "note" | "article" | undefined;
      return {
        pageRole,
        loggedInAccount,
        workId: context?.workId ?? null,
        workUrl: context?.url ?? null,
        authorName,
        authorMatchesAlias,
        isOwnWork,
        contentType: type ?? (context ? "unknown" : null),
        workLocked,
        autoplayLocked: workLocked ? lock?.autoplayLocked === true : false,
        commentPanelOpen: await page.locator("[data-e2e='comment-list'],[data-scroll='comment']")
          .first().isVisible().catch(() => false),
      };
    });
  }

  async openProfileRecommendation(
    alias = "bound_user",
    workId?: string,
    safeId?: string,
  ): Promise<ProfileRecommendationOpenResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const requestedWorkId = workId ?? safeId?.match(/^profile-(\d{16,20})$/)?.[1];
      if (!requestedWorkId || !/^\d{16,20}$/.test(requestedWorkId)) {
        throw new Error("必须提供有效的 work_id 或工具返回的安全内部 ID。");
      }
      let item = this.profileRecommendationCache.get(requestedWorkId);
      if (!item) {
        const recommendations = await this.listProfileRecommendations(alias, 100, undefined, false);
        item = recommendations.items.find(candidate => candidate.workId === requestedWorkId);
      }
      if (!item) throw new Error("绑定主页推荐列表中没有找到该作品，已停止打开。");
      const page = await this.rolePage("codex_test", bound.profileUrl);
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.bringToFront();
      await page.waitForFunction((expectedWorkId: string) => {
        const current = new URL(location.href);
        return current.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1] === expectedWorkId;
      }, item.workId, { timeout: 15_000 });
      this.activePageId = this.pageId(page);
      this.latestElements.clear();
      await this.stateStore.markProfileWorkViewed(item.workId);
      return {
        alias: bound.alias,
        displayName: bound.displayName,
        item: { ...item, viewed: true },
        opened: true,
        pageId: this.pageId(page),
      };
    });
  }

  async openNextProfileRecommendation(alias = "bound_user"): Promise<ProfileRecommendationOpenResult> {
    return this.serial(async () => {
      const page = await this.listProfileRecommendations(alias, 1, undefined, true);
      const next = page.items[0];
      if (!next) throw new Error("绑定主页推荐中暂时没有未看的作品。");
      return this.openProfileRecommendation(alias, next.workId);
    });
  }

  private async openBoundConversation(page: Page, bound: BoundUser): Promise<Page> {
    if (!bound.allowMessage) throw new Error(`绑定用户 ${bound.alias} 未授权私信。`);
    await this.verifyBoundProfile(page, bound);
    const marker = `codex-bound-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let marked = false;
    for (let attempt = 0; attempt < 10 && !marked; attempt += 1) {
      marked = await page.evaluate((actionMarker: string) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='user-detail'] button"))
          .filter(button => {
            const rect = button.getBoundingClientRect();
            return rect.width > 20
              && rect.height > 16
              && rect.bottom > 0
              && rect.top < innerHeight
              && button.getAttribute("aria-disabled") !== "true"
              && (button.innerText || button.textContent || "").trim() === "私信";
          });
        if (!candidates.length) return false;
        candidates[0].setAttribute("data-codex-action-target", actionMarker);
        return true;
      }, marker);
      if (!marked) await sleep(300);
    }
    if (!marked) throw new Error("没有找到绑定用户主页上的可用“私信”按钮。");
    const direct = page.locator(`[data-codex-action-target="${marker}"]`);
    if (await direct.count() !== 1) throw new Error("绑定用户私信按钮标记失败。");
    const context = page.context();
    const knownPages = new Set(context.pages());
    const popupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    await direct.click();
    const samePageDialog = await page.locator("[data-e2e='im-dialog']")
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true, () => false);
    const popup = samePageDialog ? null : await popupPromise;
    const conversationPage = popup ?? context.pages().find(candidate => !knownPages.has(candidate)) ?? page;
    if (conversationPage !== page) {
      this.automationCreatedPages.add(conversationPage);
      this.automationPagePurposes.set(conversationPage, "transient:bound_conversation_dialog");
      await conversationPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
    }
    await sleep(CONFIG.actionDelayMs);
    let dialogReady = await conversationPage.locator("[data-e2e='im-dialog']")
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true, () => false);
    if (!dialogReady && conversationPage === page) {
      await direct.click().catch(() => null);
      dialogReady = await conversationPage.locator("[data-e2e='im-dialog']")
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true, () => false);
    }
    if (!dialogReady) {
      if (conversationPage !== page) {
        await this.closeAutomationPage(conversationPage, "bound_dialog_validation_failed");
      }
      throw new Error("私信按钮未打开可验证的绑定会话窗口。");
    }
    await conversationPage.waitForFunction((displayName: string) => {
      const dialog = document.querySelector<HTMLElement>("[data-e2e='im-dialog']");
      if (!dialog) return false;
      const rect = dialog.getBoundingClientRect();
      if (rect.width <= 20 || rect.height <= 20 || rect.bottom <= 0 || rect.top >= innerHeight) return false;
      const header = dialog.querySelector<HTMLElement>(".RightPanelHeadertitle");
      if ((header?.innerText || header?.textContent || "").trim() === displayName) return true;
      return Array.from(dialog.querySelectorAll<HTMLElement>("[data-e2e='conversation-item']"))
        .some(item => (item.innerText || item.textContent || "").includes(displayName));
    }, bound.displayName, { timeout: 15_000 });
    const conversation = conversationPage.locator("[data-e2e='conversation-item']").filter({ hasText: bound.displayName });
    const conversationCount = await conversation.count();
    const header = conversationPage.locator("[data-e2e='im-dialog'] .RightPanelHeadertitle")
      .filter({ hasText: bound.displayName });
    const headerReady = await header.count() === 1
      && (await header.innerText()).trim() === bound.displayName
      && await header.isVisible().catch(() => false);
    if (!headerReady && conversationCount === 1 && await conversation.isVisible().catch(() => false)) {
      await conversation.click();
      await sleep(CONFIG.actionDelayMs);
    }
    const verifiedIdentity = await conversationPage.waitForFunction((expected: {
      displayName: string;
      secUid: string;
    }) => {
      const header = document.querySelector<HTMLElement>("[data-e2e='im-dialog'] .RightPanelHeadertitle");
      const store = (window as unknown as {
        conversationStore?: {
          curConversation?: {
            toParticipantSecUserId?: string;
            _toParticipantSecUserId?: string;
            id?: unknown;
          };
        };
      }).conversationStore;
      const current = store?.curConversation;
      const participantSecUid = current?.toParticipantSecUserId
        ?? current?._toParticipantSecUserId
        ?? null;
      return (header?.innerText || header?.textContent || "").trim() === expected.displayName
        && participantSecUid === expected.secUid
        && Boolean(current?.id);
    }, {
      displayName: bound.displayName,
      secUid: bound.secUid,
    }, { timeout: 10_000 }).then(() => true, () => false);
    if (!verifiedIdentity) {
      if (conversationPage !== page) {
        await this.closeAutomationPage(conversationPage, "bound_dialog_identity_mismatch");
      }
      throw new Error("BOUND_CONVERSATION_IDENTITY_MISMATCH:标题或稳定 sec_uid 与绑定用户不一致。");
    }
    return conversationPage;
  }

  private async isBoundFullscreenConversation(page: Page, bound: BoundUser): Promise<boolean> {
    if (page.isClosed()) return false;
    let url: URL;
    try {
      url = new URL(page.url());
    } catch {
      return false;
    }
    if (!["douyin.com", "www.douyin.com"].includes(url.hostname.toLowerCase()) || url.pathname !== "/chat") {
      return false;
    }
    return page.locator("body")
      .evaluate((body, expected: { displayName: string; secUid: string }) => {
        const elements = Array.from(body.querySelectorAll<HTMLElement>(".RightPanelHeadertitle"));
        const headerReady = elements.some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 20
          && rect.height > 12
          && rect.bottom > 0
          && rect.top < innerHeight
          && (element.textContent ?? "").trim() === expected.displayName;
        });
        const messageSurface = body.querySelector<HTMLElement>(
          ".messageMessageListlist,textarea,input[placeholder*='消息'],[contenteditable='true']",
        );
        const surfaceRect = messageSurface?.getBoundingClientRect();
        const store = (window as unknown as {
          conversationStore?: {
            curConversation?: {
              toParticipantSecUserId?: string;
              _toParticipantSecUserId?: string;
              id?: unknown;
            };
          };
        }).conversationStore;
        const current = store?.curConversation;
        const participantSecUid = current?.toParticipantSecUserId
          ?? current?._toParticipantSecUserId
          ?? null;
        const stableIdentityReady = participantSecUid === expected.secUid
          && Boolean(current?.id);
        return headerReady
          && stableIdentityReady
          && Boolean(surfaceRect && surfaceRect.width > 50 && surfaceRect.height > 20);
      }, { displayName: bound.displayName, secUid: bound.secUid })
      .catch(() => false);
  }

  private async findBoundFullscreenConversation(bound: BoundUser, pages: Page[]): Promise<Page | null> {
    for (const candidate of pages) {
      if (await this.isBoundFullscreenConversation(candidate, bound)) return candidate;
    }
    return null;
  }

  private async openBoundConversationFullscreen(
    page: Page,
    bound: BoundUser,
    focus = false,
  ): Promise<Page> {
    const context = page.context();
    const existing = await this.findBoundFullscreenConversation(bound, context.pages());
    if (existing) {
      this.bindPageRole(existing, "bound_messages");
      if (focus) await existing.bringToFront();
      return existing;
    }

    const conversationPage = await this.openBoundConversation(page, bound);
    const fullscreenButton = conversationPage.locator(
      "[data-e2e='im-dialog'] .RightPanelHeaderopenNewImPage",
    );
    const visibleButtonCount = await fullscreenButton.evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < innerHeight;
    }).length);
    if (visibleButtonCount !== 1) {
      throw new Error("没有唯一找到私信浮窗顶部的“进入完整私信页”按钮。");
    }

    const knownPages = new Set(context.pages());
    const popupPromise = context.waitForEvent("page", { timeout: 12_000 }).catch(() => null);
    await fullscreenButton.click();
    const popup = await popupPromise;
    const fullscreenPage = popup
      ?? context.pages().find(candidate => !knownPages.has(candidate))
      ?? conversationPage;
    if (fullscreenPage !== conversationPage) {
      this.automationCreatedPages.add(fullscreenPage);
      this.automationPagePurposes.set(fullscreenPage, "role:bound_messages");
      await fullscreenPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
    }
    const verified = await fullscreenPage.waitForFunction((displayName: string) => {
      const current = new URL(location.href);
      if (!["douyin.com", "www.douyin.com"].includes(current.hostname.toLowerCase())
        || current.pathname !== "/chat") return false;
      return Array.from(document.querySelectorAll<HTMLElement>(".RightPanelHeadertitle"))
        .some(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 20
            && rect.height > 12
            && rect.bottom > 0
            && rect.top < innerHeight
            && (element.innerText || element.textContent || "").trim() === displayName;
        });
    }, bound.displayName, { timeout: 20_000 }).then(() => true, () => false);
    if (!verified || !await this.isBoundFullscreenConversation(fullscreenPage, bound)) {
      if (fullscreenPage !== conversationPage) {
        await this.closeAutomationPage(fullscreenPage, "bound_fullscreen_validation_failed");
      }
      throw new Error("点击私信全屏按钮后，没有进入可验证的 Bound User 完整私信视图。");
    }
    this.bindPageRole(fullscreenPage, "bound_messages");
    if (conversationPage !== page && conversationPage !== fullscreenPage) {
      await this.closeAutomationPage(conversationPage, "bound_fullscreen_replaced_dialog_popup");
    }
    if (focus) await fullscreenPage.bringToFront();
    return fullscreenPage;
  }

  private async parseBoundMessages(
    page: Page,
    bound: BoundUser,
    limit: number,
    unreadOnly: boolean,
    stopAtMessageIds?: ReadonlySet<string>,
  ): Promise<BoundMessage[]> {
    const operator = loadActionSettings().operator;
    const targetCount = Math.max(1, Math.min(500, Math.floor(limit)));
    const originalPosition = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".messageMessageListlist");
      if (!list) return null;
      const max = Math.max(0, list.scrollHeight - list.clientHeight);
      const top = Math.max(0, list.scrollTop);
      return {
        top,
        atStart: top <= 2,
        atEnd: top >= max - 2,
      };
    }).catch(() => null);

    const scanCurrentDom = async (): Promise<BoundMessage[]> => {
      const rawCandidates = await page.evaluate((onlyUnread: boolean): RawBoundMessageCandidate[] => {
        const safeGet = (value: object, key: PropertyKey): unknown => {
          try {
            return Reflect.get(value, key);
          } catch {
            return undefined;
          }
        };
        const safeKeys = (value: object): string[] => {
          try {
            return Object.keys(value);
          } catch {
            return [];
          }
        };
        const cloneValue = (
          value: unknown,
          depth = 0,
          seen = new WeakSet<object>(),
        ): unknown => {
          if (value == null || typeof value === "string"
            || typeof value === "number" || typeof value === "boolean") {
            return value;
          }
          if (typeof value === "bigint") return value.toString();
          if (typeof value !== "object" || depth > 7 || seen.has(value)) return null;
          seen.add(value);
          if (value instanceof Date) return value.toISOString();
          if (Array.isArray(value)) {
            return value.slice(0, 80).map(item => cloneValue(item, depth + 1, seen));
          }
          const output: Record<string, unknown> = {};
          for (const key of safeKeys(value).slice(0, 120)) {
            const nested = safeGet(value, key);
            if (typeof nested === "function" || typeof nested === "symbol") continue;
            output[key] = cloneValue(nested, depth + 1, seen);
          }
          return output;
        };
        const primitiveString = (value: unknown): string | null => {
          if (typeof value === "string") return value;
          if (typeof value === "bigint") return value.toString();
          if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
          return null;
        };
        const dateString = (value: unknown): string | null => {
          if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
          if (typeof value === "string" && value.trim()) return value;
          if (typeof value === "number" && Number.isFinite(value)) {
            return new Date(value > 10_000_000_000 ? value : value * 1_000).toISOString();
          }
          return null;
        };
        const root = document.querySelector<HTMLElement>(".componentsRightPanelwrapper")
          ?? document.querySelector<HTMLElement>("[data-e2e='im-dialog']")
          ?? document.body;
        const primary = Array.from(root.querySelectorAll<HTMLElement>("[data-e2e='msg-item-content']"));
        const elements = primary.length ? primary : Array.from(root.querySelectorAll<HTMLElement>(
          "[data-e2e*='message-item'],[data-testid*='message-item'],[class*='message-item'],[class*='chat-message'],[class*='message_bubble']",
        ));
        const getReactMessage = (element: HTMLElement): Record<string, unknown> | null => {
          const indexed = element.closest<HTMLElement>("[data-index]");
          if (!indexed) return null;
          const reactPropsKey = Object.keys(indexed).find(key => key.startsWith("__reactProps$"));
          if (!reactPropsKey) return null;
          const reactProps = (indexed as unknown as Record<string, unknown>)[reactPropsKey] as {
            children?: { props?: { message?: Record<string, unknown> } };
          } | undefined;
          return reactProps?.children?.props?.message ?? null;
        };
        const found: RawBoundMessageCandidate[] = [];
        for (const element of elements) {
          if (element.closest("[data-e2e='conversation-item']")
            || element.querySelector(".MessageItemHiGroupHiBox")) continue;
          const box = element.closest<HTMLElement>("[class*='messageMessageBoxmessageBox']");
          const contentBox = element.closest<HTMLElement>("[class*='messageMessageBoxcontentBox']");
          const historyContainer = element.closest<HTMLElement>("[data-index]");
          const parsedHistoryIndex = Number(historyContainer?.getAttribute("data-index"));
          const historyIndex = Number.isInteger(parsedHistoryIndex) ? parsedHistoryIndex : null;
          const reactMessage = getReactMessage(element);
          const parsedContent = reactMessage
            ? cloneValue(safeGet(reactMessage, "parsedContent"))
            : null;
          const textElement = element.querySelector<HTMLElement>(
            ".TextMessageTextpureText,.MessageItemShareAwemeauthorName,.BulletBulletVideoauthorName,[class*='ShareAwemeauthorName'],[class*='BulletVideoauthorName'],[class*='CommentShare']",
          );
          const exactText = textElement?.innerText
            ?? textElement?.textContent
            ?? element.querySelector<HTMLElement>("[class*='share'],[class*='card']")?.innerText
            ?? element.innerText
            ?? element.textContent
            ?? "";
          const text = exactText.replace(/\s+/g, " ").trim();
          if (text.length > 2_000) continue;
          const className = `${String(element.className || "")} ${String(box?.className || "")} ${String(contentBox?.className || "")}`;
          const hrefs = Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
            .map(link => link.href)
            .filter(Boolean)
            .slice(0, 30);
          const attributeValues: string[] = [];
          for (const candidate of [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))].slice(0, 160)) {
            for (const attribute of Array.from(candidate.attributes)) {
              const explicitWorkAttribute = /(aweme|item)/i.test(attribute.name);
              const workUrlValue = /\/(?:video|note|article|detaillist)\/\d{16,20}/i
                .test(attribute.value);
              if (!explicitWorkAttribute && !workUrlValue) continue;
              attributeValues.push(attribute.name + "=" + attribute.value);
              if (attributeValues.length >= 100) break;
            }
            if (attributeValues.length >= 100) break;
          }
          const cardDom = Boolean(element.querySelector(
            ".MessageItemShareAwemecontainer,.BulletBulletVideocontainer,[class*='ShareAweme'][class*='container'],[class*='BulletVideo'][class*='container'],[class*='CommentShare']",
          ));
          const cover = Boolean(element.querySelector(
            "img[class*='awemeContainer'],img[class*='Aweme'][class*='cover'],img[class*='Video'][class*='cover']",
          ) && element.querySelector("[class*='playIcon'],[class*='PlayIcon'],svg"));
          const systemCardDom = Boolean(element.querySelector(
            ".BulletGeneralCardcontainer,.MessageItemGeneralCardcontainer,[class*='GeneralCard']",
          ));
          const textDom = Boolean(element.querySelector(".TextMessageTextpureText"));
          const mediaImage = element.querySelector<HTMLImageElement>("img[src]");
          let mediaKey = "";
          try {
            mediaKey = mediaImage?.src ? new URL(mediaImage.src).pathname : "";
          } catch {
            mediaKey = mediaImage?.src ?? "";
          }
          const nativeReferenceElement = element.querySelector<HTMLElement>(
            ".MessageBoxRefContainerrefTextContainer,[class*='MsgRefContainer'],[class*='Reference'][class*='content']",
          );
          const nativeReferenceText = nativeReferenceElement
            ? (nativeReferenceElement.innerText || nativeReferenceElement.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
            : "";
          const unread = /unread|未读/.test(`${className} ${text}`.toLowerCase());
          if (onlyUnread && !unread) continue;
          const rawType = reactMessage ? safeGet(reactMessage, "type") : null;
          found.push({
            domId: element.getAttribute("data-message-id") || element.id || null,
            historyIndex,
            className,
            text,
            hrefs,
            attributeValues,
            cardDom,
            cover,
            systemCardDom,
            textDom,
            mediaKey,
            time: box?.querySelector<HTMLElement>("time,[class*='Time'],[class*='time']")?.innerText?.trim() || null,
            unread,
            nativeReferenceText,
            nativeReferenceMedia: Boolean(nativeReferenceElement?.querySelector("img,video,[class*='Aweme']")),
            parsedContent,
            serverId: reactMessage ? primitiveString(safeGet(reactMessage, "serverId")) : null,
            senderId: reactMessage ? primitiveString(safeGet(reactMessage, "sender")) : null,
            conversationId: reactMessage ? primitiveString(safeGet(reactMessage, "conversationId")) : null,
            orderInConversation: reactMessage ? primitiveString(safeGet(reactMessage, "orderInConversation")) : null,
            createdAt: reactMessage ? dateString(safeGet(reactMessage, "createdAt")) : null,
            sdkType: typeof rawType === "number" && Number.isSafeInteger(rawType) ? rawType : null,
          });
        }
        return found;
      }, unreadOnly);

      const parsed: BoundMessage[] = [];
      for (const candidate of rawCandidates) {
        try {
          parsed.push(parseBoundMessageCandidate(candidate, {
            operatorUid: operator.uid,
            boundUid: bound.uid,
          }));
        } catch (error) {
          log("bound_message_candidate_parse_failed", {
            serverId: candidate.serverId,
            sdkType: candidate.sdkType,
            historyIndex: candidate.historyIndex,
            error: String(error),
          });
        }
      }
      await page.evaluate(entries => {
        for (const entry of entries) {
          if (entry.historyIndex == null) continue;
          const row = document.querySelector<HTMLElement>(`[data-index="${entry.historyIndex}"]`);
          const content = row?.querySelector<HTMLElement>("[data-e2e='msg-item-content']");
          if (content) content.setAttribute("data-codex-bound-message-id", entry.messageId);
        }
      }, parsed.map(message => ({
        historyIndex: message.historyIndex,
        messageId: message.messageId,
      }))).catch(() => null);
      return parsed;
    };

    const merged = new Map<string, BoundMessage>();
    let stableEndPasses = 0;
    let previousHeight = -1;
    let previousCount = -1;
    try {
      await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".messageMessageListlist");
        if (!list) return;
        list.scrollTop = 0;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
      }).catch(() => null);
      await sleep(220);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const current = await scanCurrentDom();
        for (const message of current) merged.set(message.messageId, message);
        if (stopAtMessageIds?.size
          && current.some(message => stopAtMessageIds.has(message.messageId))) {
          break;
        }
        if (!stopAtMessageIds?.size
          && merged.size >= targetCount
          && targetCount <= 100) break;
        const state = await page.evaluate(() => {
          const list = document.querySelector<HTMLElement>(".messageMessageListlist");
          if (!list) return { available: false, top: 0, max: 0, height: 0 };
          const max = Math.max(0, list.scrollHeight - list.clientHeight);
          const top = Math.max(0, list.scrollTop);
          const next = Math.min(max, top + Math.max(240, Math.floor(list.clientHeight * 0.8)));
          list.scrollTop = next;
          list.dispatchEvent(new Event("scroll", { bubbles: true }));
          return { available: true, top: next, max, height: list.scrollHeight };
        });
        if (!state.available) break;
        await sleep(300);
        const atEnd = state.top >= state.max - 2;
        if (atEnd && state.height === previousHeight && merged.size === previousCount) stableEndPasses += 1;
        else stableEndPasses = 0;
        previousHeight = state.height;
        previousCount = merged.size;
        if (stableEndPasses >= 3) break;
      }
      const finalMessages = await scanCurrentDom();
      for (const message of finalMessages) merged.set(message.messageId, message);
    } finally {
      if (originalPosition) {
        await page.evaluate(saved => {
          const list = document.querySelector<HTMLElement>(".messageMessageListlist");
          if (!list) return;
          const max = Math.max(0, list.scrollHeight - list.clientHeight);
          list.scrollTop = saved.atStart ? 0 : saved.atEnd ? max : Math.min(max, saved.top);
          list.dispatchEvent(new Event("scroll", { bubbles: true }));
        }, originalPosition).catch(() => null);
      }
    }
    return Array.from(merged.values())
      .sort(compareMessageRecency)
      .slice(0, targetCount);
  }
  async listMessagesFromBound(
    alias = "bound_user",
    limit = 10,
    unreadOnly = false,
    stopAtMessageIds?: ReadonlySet<string>,
  ): Promise<BoundMessageListResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const browser = await this.connect();
      const existing = await this.findBoundFullscreenConversation(
        bound,
        browser.contexts()[0]?.pages() ?? [],
      );
      const messages = existing
        ? await this.parseBoundMessages(existing, bound, limit, unreadOnly, stopAtMessageIds)
        : await this.withBoundProfile(bound, async page => {
          const conversationPage = await this.openBoundConversationFullscreen(page, bound);
          return this.parseBoundMessages(conversationPage, bound, limit, unreadOnly, stopAtMessageIds);
        });
      return {
        alias: bound.alias,
        displayName: bound.displayName,
        messages,
        count: messages.length,
        unreadOnly,
        privacyFiltered: true,
      };
    });
  }

  async openMessageFromBound(
    alias: string,
    messageId?: string,
    messageIndex?: number,
  ): Promise<BoundMessageOpenResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const selectAndCapture = async (conversationPage: Page): Promise<BoundMessageOpenResult> => {
        let messages = await this.parseBoundMessages(conversationPage, bound, 100, false);
        let message = messageId
          ? messages.find(candidate => candidate.messageId === messageId)
          : messages[messageIndex ?? 0];
        if (messageId && !message) {
          messages = await this.parseBoundMessages(conversationPage, bound, 500, false);
          message = messages.find(candidate => candidate.messageId === messageId);
        }
        if (!message) {
          throw new Error(messageId
            ? "绑定会话中没有找到该 message_id。"
            : `绑定会话中没有第 ${messageIndex ?? 0} 条消息。`);
        }
        let visualImageBase64: string | null = null;
        let visualMimeType: BoundMessageOpenResult["visualMimeType"] = null;
        let visualSource: BoundMessageOpenResult["visualSource"] = null;
        let visualOriginalMimeType: BoundMessageOpenResult["visualOriginalMimeType"] = null;
        let visualOriginalUrl: string | null = null;
        let visualWidth: number | null = message.visual?.width ?? null;
        let visualHeight: number | null = message.visual?.height ?? null;
        let visualAnimated: boolean | null = message.visual?.animated ?? null;

        if (message.visual) {
          const escapedId = message.messageId
            .replaceAll("\\", "\\\\")
            .replaceAll('"', '\\"');
          const target = conversationPage.locator(
            `[data-codex-bound-message-id="${escapedId}"]`,
          );
          if (await target.count() === 1) {
            const images = target.locator("img");
            const selected = await images.evaluateAll(elements => elements
              .map((element, index) => {
                const node = element as HTMLImageElement;
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const visible = rect.width >= 20
                  && rect.height >= 20
                  && style.display !== "none"
                  && style.visibility !== "hidden"
                  && Number(style.opacity || "1") > 0;
                return {
                  index,
                  area: visible ? rect.width * rect.height : -1,
                  src: node.currentSrc || node.src || null,
                  width: node.naturalWidth || null,
                  height: node.naturalHeight || null,
                };
              })
              .sort((left, right) => right.area - left.area)[0] ?? null)
              .catch(() => null);
            if (selected && selected.index >= 0 && selected.area > 0) {
              visualOriginalUrl = selected.src;
              visualWidth = selected.width ?? visualWidth;
              visualHeight = selected.height ?? visualHeight;
              visualOriginalMimeType = selected.src && /\.gif(?:\?|$)/i.test(selected.src)
                ? "image/gif"
                : selected.src && /\.webp(?:\?|$)/i.test(selected.src)
                  ? "image/webp"
                  : selected.src && /\.jpe?g(?:\?|$)/i.test(selected.src)
                    ? "image/jpeg"
                    : selected.src && /\.png(?:\?|$)/i.test(selected.src)
                      ? "image/png"
                      : null;
              if (selected.src) {
                let trusted = false;
                try {
                  const host = new URL(selected.src).hostname.toLowerCase();
                  trusted = host === "douyinpic.com" || host.endsWith(".douyinpic.com");
                } catch {
                  trusted = false;
                }
                if (trusted) {
                  const response = await conversationPage.context().request.get(selected.src, {
                    timeout: 10_000,
                    headers: { Referer: "https://www.douyin.com/" },
                  }).catch(() => null);
                  const body = response?.ok() ? await response.body().catch(() => null) : null;
                  if (body && body.length > 0 && body.length <= 8 * 1024 * 1024) {
                    const metadata = inspectImageBytes(body);
                    visualOriginalMimeType = metadata.mimeType ?? visualOriginalMimeType;
                    visualWidth = metadata.width ?? visualWidth;
                    visualHeight = metadata.height ?? visualHeight;
                    visualAnimated = metadata.animated;
                    const png = metadata.mimeType === "image/gif"
                      ? await decodeFirstFrameAsPng(conversationPage, body, "image/gif")
                      : null;
                    if (png) {
                      visualImageBase64 = png.data.toString("base64");
                      visualMimeType = "image/png";
                      visualSource = "dom_first_frame";
                      visualWidth = png.width;
                      visualHeight = png.height;
                      visualAnimated = metadata.animated;
                    }
                  }
                }
              }
              if (!visualImageBase64) {
                const buffer = await images.nth(selected.index).screenshot({
                  type: "png",
                  animations: "disabled",
                  caret: "hide",
                  timeout: 8_000,
                }).catch(() => null);
                if (buffer) {
                  visualImageBase64 = buffer.toString("base64");
                  visualMimeType = "image/png";
                  visualSource = "dom_screenshot";
                }
              }
            }
          }
          if (!visualImageBase64) {
            for (const resourceUrl of message.visual.urls) {
              let trusted = false;
              try {
                const parsed = new URL(resourceUrl);
                const host = parsed.hostname.toLowerCase();
                trusted = host === "douyinpic.com" || host.endsWith(".douyinpic.com");
              } catch {
                trusted = false;
              }
              if (!trusted) continue;
              const response = await conversationPage.context().request.get(resourceUrl, {
                timeout: 10_000,
                headers: { Referer: "https://www.douyin.com/" },
              }).catch(() => null);
              if (!response?.ok()) continue;
              const body = await response.body().catch(() => null);
              if (!body || body.length === 0 || body.length > 8 * 1024 * 1024) continue;
              const contentType = response.headers()["content-type"]?.split(";")[0]?.trim();
              const reportedMimeType = contentType === "image/png"
                || contentType === "image/jpeg"
                || contentType === "image/webp"
                || contentType === "image/gif"
                ? contentType as SupportedImageMime
                : null;
              const metadata = inspectImageBytes(body);
              const mimeType = metadata.mimeType ?? reportedMimeType;
              if (!mimeType) continue;
              visualOriginalMimeType = mimeType;
              visualOriginalUrl = resourceUrl;
              visualWidth = metadata.width ?? visualWidth;
              visualHeight = metadata.height ?? visualHeight;
              visualAnimated = metadata.animated;
              if (mimeType === "image/gif") {
                const png = await decodeFirstFrameAsPng(conversationPage, body, mimeType);
                if (!png) continue;
                visualImageBase64 = png.data.toString("base64");
                visualMimeType = "image/png";
                visualWidth = png.width;
                visualHeight = png.height;
              } else {
                visualImageBase64 = body.toString("base64");
                visualMimeType = mimeType;
              }
              visualSource = "trusted_resource";
              break;
            }
          }
        }
        const messageWithVisual: BoundMessage = message.visual
          ? {
              ...message,
              visual: synchronizeVisualMetadata(message.visual, {
                width: visualWidth,
                height: visualHeight,
                animated: visualAnimated,
              }),
            }
          : message;
        return {
          alias: bound.alias,
          displayName: bound.displayName,
          message: messageWithVisual,
          visualCaptured: Boolean(visualImageBase64 && visualMimeType),
          visualSource,
          visualImageBase64,
          visualMimeType,
          visualOriginalMimeType,
          visualOriginalUrl,
          visualWidth,
          visualHeight,
          visualAnimated,
          originalVisual: message.visual ? {
            mimeType: visualOriginalMimeType,
            url: visualOriginalUrl,
            width: visualWidth,
            height: visualHeight,
            animated: visualAnimated,
          } : null,
          renderedVisual: visualImageBase64 && visualMimeType && visualSource ? {
            mimeType: visualMimeType,
            width: visualWidth,
            height: visualHeight,
            animated: false,
            source: visualSource,
          } : null,
          privacyFiltered: true,
        };
      };

      const browser = await this.connect();
      const existing = await this.findBoundFullscreenConversation(
        bound,
        browser.contexts()[0]?.pages() ?? [],
      );
      if (existing) return selectAndCapture(existing);
      return this.withBoundProfile(bound, async page => {
        const conversationPage = await this.openBoundConversationFullscreen(page, bound);
        return selectAndCapture(conversationPage);
      });
    });
  }
  async openMessageMediaFromBound(
    alias: string,
    messageId?: string,
    messageIndex?: number,
    markViewed = true,
  ): Promise<BoundMessageMediaOpenResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const viewingPage = await this.rolePage("codex_test", bound.profileUrl);
      await this.assertOperatorAccount(viewingPage);

      let selectedMessage: BoundMessage | null = null;
      let workUrl = "";
      let workId = "";

      const browser = await this.connect();
      const existingConversation = await this.findBoundFullscreenConversation(
        bound,
        browser.contexts()[0]?.pages() ?? [],
      );
      const selectFromConversation = async (conversationPage: Page) => {
        const messages = await this.parseBoundMessages(conversationPage, bound, 100, false);
        const message = messageId
          ? messages.find(candidate => candidate.messageId === messageId)
          : messageIndex != null
            ? messages[messageIndex]
            : messages.find(candidate => candidate.direction === "incoming" && candidate.openable)
              ?? messages.find(candidate => candidate.openable);
        if (!message) throw new Error("绑定会话中没有找到指定消息。");
        if (message.messageType !== "shared_work" || !message.openable || !message.workId) {
          throw new Error("指定消息不是可打开的抖音作品卡片。");
        }
        selectedMessage = message;
        workId = message.workId;
        workUrl = message.workUrl ?? `https://www.douyin.com/video/${message.workId}`;
      };
      if (existingConversation) {
        await selectFromConversation(existingConversation);
      } else {
        await this.withBoundProfile(bound, async profilePage => {
          const conversationPage = await this.openBoundConversationFullscreen(profilePage, bound);
          await selectFromConversation(conversationPage);
        });
      }

      const verifiedMessage = selectedMessage as BoundMessage | null;
      if (!verifiedMessage || !workId || !workUrl) {
        throw new Error("作品卡片已打开，但无法确认作品标识。");
      }
      await this.navigateToStableWork(viewingPage, workUrl, workId);
      await viewingPage.bringToFront();
      let autoplayLocked = false;
      let navigationRecoveryUsed = false;
      for (let attempt = 0; attempt < 60 && !autoplayLocked; attempt += 1) {
        try {
          autoplayLocked = await viewingPage.evaluate((expectedWorkId: string) => {
          const current = new URL(location.href);
          const pageWorkId = current.searchParams.get("modal_id")
            ?? current.searchParams.get("aweme_id")
            ?? current.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
            ?? null;
          if (pageWorkId !== expectedWorkId) return false;
          const container = document.querySelector<HTMLElement>(
            "[data-e2e='modal-video-container'],[data-e2e='video-detail']",
          );
          if (!container) return false;
          const videos = Array.from(container.querySelectorAll<HTMLVideoElement>("video"))
            .filter(video => {
              const rect = video.getBoundingClientRect();
              return rect.width > 100 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight;
            })
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
            });
          if (!videos.length) return false;
          const video = videos[0];
          video.loop = true;
          if (video.dataset.codexWorkLock !== expectedWorkId) {
            video.dataset.codexWorkLock = expectedWorkId;
            video.addEventListener("ended", event => {
              const activeUrl = new URL(location.href);
              const activeWorkId = activeUrl.searchParams.get("modal_id")
                ?? activeUrl.searchParams.get("aweme_id")
                ?? activeUrl.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
                ?? null;
              if (activeWorkId !== expectedWorkId) return;
              event.stopImmediatePropagation();
              video.currentTime = 0;
              void video.play().catch(() => undefined);
            }, true);
          }
          if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = 0;
          return video.loop && video.dataset.codexWorkLock === expectedWorkId;
          }, workId);
        } catch (error) {
          if (!navigationRecoveryUsed
            && /Execution context was destroyed|navigation/i.test(String(error))) {
            navigationRecoveryUsed = true;
            await viewingPage.waitForLoadState("domcontentloaded", { timeout: 10_000 })
              .catch(() => null);
            continue;
          }
          throw new Error(`NAVIGATION_UNSTABLE:${String(error)}`);
        }
        if (!autoplayLocked) await sleep(200);
      }
      const stableContext = await this.navigateToStableWork(
        viewingPage,
        viewingPage.url(),
        workId,
      );
      if (stableContext.workId !== workId) {
        throw new Error("NAVIGATION_UNSTABLE:作品页稳定后 work_id 再次发生变化。");
      }
      assertWorkId(workId, viewingPage.url());
      this.activePageId = this.pageId(viewingPage);
      this.latestElements.clear();
      if (markViewed) {
        await this.stateStore.markMessageAndWorkViewed(verifiedMessage.messageId, workId);
      }

      return {
        alias: bound.alias,
        displayName: bound.displayName,
        message: verifiedMessage,
        workId,
        workUrl,
        viewMode: "immersive",
        autoplayLocked,
        opened: true,
      };
    });
  }

  async listBoundMediaQueue(alias = "bound_user"): Promise<BoundMediaQueueResult> {
    const result = await this.listMessagesFromBound(alias, 100, false);
    const openedMessages = await this.stateStore.viewedMessageIds();
    const openedWorks = await this.stateStore.viewedWorkIds();
    const items = result.messages
      .filter(message => message.direction === "incoming"
        && message.messageType === "shared_work"
        && message.openable)
      .map(message => ({
        message,
        opened: openedMessages.has(message.messageId)
          || Boolean(message.workId && openedWorks.has(message.workId)),
      }));
    return {
      alias: result.alias,
      displayName: result.displayName,
      items,
      count: items.length,
      remainingCount: items.filter(item => !item.opened).length,
      privacyFiltered: true,
    };
  }

  async checkBoundUpdates(alias = "bound_user"): Promise<BoundMessageUpdatesResult> {
    const checkpoint = await this.stateStore.messageIdentityCheckpoint("server_id_v1");
    const result = await this.listMessagesFromBound(
      alias,
      500,
      false,
      checkpoint.baselineRequired ? undefined : checkpoint.knownMessageIds,
    );
    const incoming = result.messages.filter(message => message.direction === "incoming");
    const freshIds = await this.stateStore.consumeNewMessageIds(
      incoming.map(message => message.messageId),
      "server_id_v1",
    );
    const newMessages = incoming.filter(message => freshIds.has(message.messageId));
    const invitePattern = /邀请|火花|小火人|一起玩|小游戏|接受邀请|点亮/i;
    return {
      alias: result.alias,
      displayName: result.displayName,
      newMessages,
      newTextCount: newMessages.filter(message => message.messageType === "text").length,
      newShareCount: newMessages.filter(message => message.messageType === "shared_work").length,
      newVisualCount: newMessages.filter(message =>
        message.messageType === "sticker" || message.messageType === "image").length,
      newCommentShareCount: newMessages.filter(message =>
        message.messageType === "comment_share").length,
      newInviteCount: newMessages.filter(message =>
        message.messageType === "interaction_card"
        || (message.messageType === "system_card" && invitePattern.test(message.text))).length,
      unreadCount: incoming.filter(message => message.unread).length,
      newSinceLastCheckCount: newMessages.length,
      privacyFiltered: true,
    };
  }

  async listAllBoundMedia(
    alias = "bound_user",
    limit = 30,
    cursor?: string,
    unseenOnly = false,
  ): Promise<BoundMediaPageResult> {
    const result = await this.listMessagesFromBound(alias, 500, false);
    const openedMessages = await this.stateStore.viewedMessageIds();
    const openedWorks = await this.stateStore.viewedWorkIds();
    const allItems = result.messages
      .filter(message => message.direction === "incoming"
        && message.messageType === "shared_work"
        && message.openable)
      .map(message => ({
        message,
        opened: openedMessages.has(message.messageId)
          || Boolean(message.workId && openedWorks.has(message.workId)),
      }));
    const filtered = unseenOnly ? allItems.filter(item => !item.opened) : allItems;
    const cursorMatch = cursor?.match(/^media-(\d+)$/);
    if (cursor && !cursorMatch) throw new Error("媒体游标无效，请使用上一次返回的 nextCursor。");
    const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("媒体游标无效。");
    const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
    const items = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      alias: result.alias,
      displayName: result.displayName,
      items,
      count: items.length,
      totalCount: filtered.length,
      unseenCount: allItems.filter(item => !item.opened).length,
      cursor: cursor ?? null,
      nextCursor: nextOffset < filtered.length ? `media-${nextOffset}` : null,
      privacyFiltered: true,
    };
  }

  async openNextBoundMedia(alias = "bound_user"): Promise<BoundMessageMediaOpenResult> {
    const queue = await this.listBoundMediaQueue(alias);
    const next = queue.items.find(item => !item.opened);
    if (!next) {
      throw new Error(queue.count
        ? "绑定会话中暂时没有尚未打开的新作品卡片。"
        : "绑定会话中暂时没有可打开的来信作品卡片。");
    }
    return this.openMessageMediaFromBound(alias, next.message.messageId);
  }

  private async understandCurrentForQueue(): Promise<{
    contentType: string;
    author: string | null;
    coreContent: string;
    keyMoments: Array<{ timestamp: string; seconds: number; label: string }>;
    workUrl: string;
    workId: string;
    fullyRead: boolean;
    method: string;
  }> {
    const probe = await this.probeMedia();
    if (probe.galleryAvailable) {
      const gallery = await this.readCurrentGallery(Math.max(1, probe.galleryImageCount));
      return {
        contentType: "gallery",
        author: gallery.author,
        coreContent: [
          gallery.description,
          gallery.hashtags.map(tag => `#${tag}`).join(" "),
          gallery.musicTitle ? `音乐：${gallery.musicTitle}` : "",
          `已读取 ${gallery.returnedImageCount}/${gallery.totalImageCount} 张原图`,
        ].filter(Boolean).join("\n"),
        keyMoments: [],
        workUrl: gallery.url,
        workId: gallery.workId,
        fullyRead: !gallery.truncated && gallery.returnedImageCount === gallery.totalImageCount,
        method: "native-gallery",
      };
    }
    if (/\/(?:article|note)\//.test(probe.url)) {
      try {
        const article = await this.extractArticleText();
        return {
          contentType: "article",
          author: article.author,
          coreContent: article.text,
          keyMoments: [],
          workUrl: article.url,
          workId: article.workId,
          fullyRead: true,
          method: "article-extraction",
        };
      } catch (firstError) {
        if (/\/article\//.test(probe.url)) {
          await sleep(1_000);
          const article = await this.extractArticleText().catch(() => {
            throw firstError;
          });
          return {
            contentType: "article",
            author: article.author,
            coreContent: article.text,
            keyMoments: [],
            workUrl: article.url,
            workId: article.workId,
            fullyRead: true,
            method: "article-extraction",
          };
        }
        // Some /note/ URLs are video-backed cards. Fall through to video handling.
      }
    }
    if (probe.chaptersAvailable && (probe.durationSeconds ?? 0) >= 120) {
      const chapters = await this.readChapters();
      return {
        contentType: "knowledge_video",
        author: null,
        coreContent: [chapters.summary, ...chapters.chapters.map(chapter =>
          `${chapter.timestamp} ${chapter.title}：${chapter.summary}`)].filter(Boolean).join("\n"),
        keyMoments: chapters.chapters.map(chapter => ({
          timestamp: chapter.timestamp,
          seconds: chapter.seconds,
          label: chapter.title,
        })),
        workUrl: probe.url,
        workId: probe.workId,
        fullyRead: true,
        method: "native-chapters",
      };
    }
    if ((probe.durationSeconds ?? 0) > 0 && (probe.durationSeconds ?? 0) <= 15) {
      const frames = await this.videoFrames(4, 900);
      return {
        contentType: "video",
        author: null,
        coreContent: frames.visibleText,
        keyMoments: [],
        workUrl: probe.url,
        workId: probe.workId,
        fullyRead: true,
        method: "continuous-keyframes",
      };
    }
    const timeline = await this.inspectTimeline();
    return {
      contentType: "video",
      author: null,
      coreContent: timeline.visibleText,
      keyMoments: timeline.frames.map(frame => ({
        timestamp: frame.timestamp,
        seconds: frame.timeSeconds,
        label: `时间轴关键帧 ${frame.timestamp}`,
      })),
      workUrl: probe.url,
      workId: probe.workId,
      fullyRead: timeline.frames.length >= 5,
      method: "full-timeline-sampling",
    };
  }

  async checkBoundUpdatesAndWatchAll(alias = "bound_user", maxItems = 20): Promise<{
    alias: string;
    displayName: string;
    updates: BoundMessageUpdatesResult;
    watched: Array<{
      message: BoundMessage;
      understanding: Awaited<ReturnType<DouyinBrowser["understandCurrentForQueue"]>>;
    }>;
    failed: Array<{ message: BoundMessage; error: string }>;
    remaining: BoundMediaQueueItem[];
    returnedToConversation: boolean;
    privacyFiltered: true;
  }> {
    return this.serial(async () => {
      const updates = await this.checkBoundUpdates(alias);
      const unseen = await this.listAllBoundMedia(alias, 100, undefined, true);
      const watched: Array<{
        message: BoundMessage;
        understanding: Awaited<ReturnType<DouyinBrowser["understandCurrentForQueue"]>>;
      }> = [];
      const failed: Array<{ message: BoundMessage; error: string }> = [];
      for (const item of unseen.items.slice(0, Math.max(1, Math.min(50, maxItems)))) {
        try {
          const opened = await this.openMessageMediaFromBound(alias, item.message.messageId, undefined, false);
          const understanding = await this.understandCurrentForQueue();
          await this.stateStore.markMessageAndWorkViewed(opened.message.messageId, opened.workId);
          watched.push({ message: opened.message, understanding });
        } catch (error) {
          failed.push({
            message: item.message,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const remainingPage = await this.listAllBoundMedia(alias, 100, undefined, true);
      await this.openBoundConversationForViewing(alias);
      return {
        alias: updates.alias,
        displayName: updates.displayName,
        updates,
        watched,
        failed,
        remaining: remainingPage.items,
        returnedToConversation: true,
        privacyFiltered: true,
      };
    });
  }

  async replyToBoundMedia(alias: string, messageId: string, text: string): Promise<DouyinActionResult & {
    messageId: string;
    workId: string;
    referenceMode: "native_douyin_reference";
  }> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      let target: BoundMessage | undefined;
      await this.withBoundProfile(bound, async page => {
        const conversationPage = await this.openBoundConversationFullscreen(page, bound);
        const messages = await this.parseBoundMessages(conversationPage, bound, 500, false);
        target = messages.find(message => message.messageId === messageId);
        // The web client virtualizes chat rows and may renumber data-index as a
        // larger history window is loaded.  A previously returned work message
        // id therefore remains resolvable by its frozen aweme id, but only when
        // that id identifies exactly one incoming share in the conversation.
        if (!target) {
          const requestedWorkId = messageId.match(/^work-(\d{8,})-/)?.[1] ?? null;
          if (requestedWorkId) {
            const workMatches = messages.filter(message =>
              message.direction === "incoming"
              && message.messageType === "shared_work"
              && message.workId === requestedWorkId);
            if (workMatches.length === 1) target = workMatches[0];
            else if (workMatches.length > 1) {
              throw new Error(
                `BOUND_SHARED_WORK_NOT_UNIQUE:work_id=${requestedWorkId};matches=${workMatches.length}`,
              );
            }
          }
        }
      });
      if (!target
        || target.direction !== "incoming"
        || target.messageType !== "shared_work"
        || !target.workId) {
        throw new Error("指定 message_id 不是 bound_user 单人会话中的来信作品分享。");
      }
      const result = await this.replyToBound(alias, text, target.messageId);
      return {
        ...result,
        messageId: target.messageId,
        workId: target.workId,
        referenceMode: "native_douyin_reference",
      };
    });
  }

  async openBoundConversationForViewing(alias = "bound_user"): Promise<BoundConversationOpenResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const browser = await this.connect();
      const context = browser.contexts()[0];
      if (!context) throw new Error("没有可用的专用浏览器上下文。");
      const existing = await this.findBoundFullscreenConversation(bound, context.pages());
      if (existing) {
        await existing.bringToFront();
        this.activePageId = this.pageId(existing);
        this.latestElements.clear();
        return {
          alias: bound.alias,
          displayName: bound.displayName,
          url: existing.url(),
          viewMode: "fullscreen",
          opened: true,
          privacyFiltered: true,
        };
      }
      const page = await this.rolePage("codex_test", bound.profileUrl);
      await page.goto(bound.profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator("[data-e2e='user-detail']").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>("[data-e2e='user-detail'] button"))
        .some(button => (button.innerText || button.textContent || "").trim() === "私信"), undefined, { timeout: 30_000 });
      await this.assertOperatorAccount(page);
      await this.verifyBoundProfile(page, bound);
      const conversationPage = await this.openBoundConversationFullscreen(page, bound);
      await conversationPage.bringToFront();
      this.activePageId = this.pageId(conversationPage);
      this.latestElements.clear();
      return {
        alias: bound.alias,
        displayName: bound.displayName,
        url: conversationPage.url(),
        viewMode: "fullscreen",
        opened: true,
        privacyFiltered: true,
      };
    });
  }

  private async clearNativeBoundReplyComposer(page: Page): Promise<void> {
    const references = page.locator(".MsgInputReferenceref_box:visible");
    const count = await references.count();
    if (count === 0) return;
    if (count !== 1) {
      throw new Error("BOUND_NATIVE_REFERENCE_NOT_UNIQUE:existing composer references are ambiguous");
    }
    const close = references.locator(".MsgInputReferenceclose,[data-apm-action='删除引用回复']");
    if (await close.count() !== 1) {
      throw new Error("BOUND_NATIVE_REFERENCE_CLOSE_NOT_UNIQUE");
    }
    await close.click();
    await references.waitFor({ state: "detached", timeout: 5_000 }).catch(() => null);
    if (await page.locator(".MsgInputReferenceref_box:visible").count() !== 0) {
      throw new Error("BOUND_NATIVE_REFERENCE_COULD_NOT_BE_CLEARED");
    }
  }

  private async activateNativeBoundReply(
    page: Page,
    bound: BoundUser,
    target: BoundMessage,
  ): Promise<{ previewText: string }> {
    if (!/^[A-Za-z0-9_-]{1,240}$/.test(target.messageId)) {
      throw new Error("BOUND_MESSAGE_ID_INVALID_FOR_NATIVE_REPLY");
    }
    await this.clearNativeBoundReplyComposer(page);
    await page.keyboard.press("Escape").catch(() => null);

    let candidate = page.locator(
      `[data-codex-bound-message-id="${target.messageId}"]`,
    );
    if (await candidate.count() !== 1) {
      const textMatches = page.locator("[data-e2e='msg-item-content']")
        .filter({ has: page.getByText(target.text, { exact: true }) });
      const matchingIndexes: number[] = [];
      for (let index = 0; index < await textMatches.count(); index += 1) {
        const matchesKind = await textMatches.nth(index).evaluate((element, expectedSharedWork) =>
          expectedSharedWork
            ? Boolean(element.querySelector(
              ".MessageItemShareAwemecontainer,[class*='ShareAweme'][class*='container']",
            ))
            : Boolean(element.querySelector(".TextMessageTextpureText")),
        target.messageType === "shared_work");
        if (matchesKind) matchingIndexes.push(index);
      }
      if (matchingIndexes.length === 1) candidate = textMatches.nth(matchingIndexes[0]);
    }
    if (await candidate.count() !== 1 || !await candidate.isVisible().catch(() => false)) {
      throw new Error(
        `BOUND_NATIVE_REPLY_TARGET_NOT_UNIQUE:message_id=${target.messageId};work_id=${target.workId ?? "none"}`,
      );
    }

    await candidate.click({ button: "right", timeout: 5_000 });
    const popup = page.locator(".MessageOperatePopWindowisReady:visible");
    await popup.waitFor({ state: "visible", timeout: 5_000 });
    if (await popup.count() !== 1) throw new Error("BOUND_MESSAGE_ACTION_MENU_NOT_UNIQUE");
    const reply = popup.locator(".MessageOperatePopBodybuttonItem")
      .filter({ hasText: "回复" });
    if (await reply.count() !== 1) throw new Error("BOUND_NATIVE_REPLY_ACTION_NOT_UNIQUE");
    await reply.click();

    const reference = page.locator(".MsgInputReferenceref_box:visible");
    await reference.waitFor({ state: "visible", timeout: 5_000 });
    if (await reference.count() !== 1) throw new Error("BOUND_NATIVE_REFERENCE_NOT_UNIQUE");
    const previewText = (await reference.innerText()).replace(/\s+/g, " ").trim();
    if (!previewText.includes(bound.displayName)) {
      await this.clearNativeBoundReplyComposer(page).catch(() => null);
      throw new Error("BOUND_NATIVE_REFERENCE_RECIPIENT_MISMATCH");
    }
    if (target.messageType === "shared_work" && !/分享|图集|图文|视频/.test(previewText)) {
      await this.clearNativeBoundReplyComposer(page).catch(() => null);
      throw new Error("BOUND_NATIVE_MEDIA_REFERENCE_NOT_VERIFIED");
    }
    return { previewText };
  }

  private async sendBoundText(page: Page, bound: BoundUser, text: string, openedConversation?: Page): Promise<void> {
    const conversationPage = openedConversation ?? await this.openBoundConversation(page, bound);
    const candidates = conversationPage.locator("textarea:visible,input[placeholder*='消息']:visible,[contenteditable='true']:visible");
    const count = await candidates.count();
    if (count !== 1) throw new Error("无法唯一确认绑定会话的消息输入框，未发送消息。");
    const input = candidates.nth(0);
    const tag = await input.evaluate(element => element.tagName.toLowerCase());
    if (tag === "textarea" || tag === "input") await input.fill(text);
    else {
      await input.click();
      await input.press("Control+A").catch(() => null);
      await input.type(text);
    }
    const send = conversationPage.getByText("发送", { exact: true });
    const sendCount = await send.count();
    let visibleIndex = -1;
    let visibleCount = 0;
    for (let i = 0; i < sendCount; i += 1) {
      if (await send.nth(i).isVisible().catch(() => false)) {
        visibleIndex = i;
        visibleCount += 1;
      }
    }
    if (visibleCount === 1) await send.nth(visibleIndex).click();
    else await input.press("Enter");
    await sleep(CONFIG.actionDelayMs);
    const inputValue = await input.evaluate(element => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
      return element.textContent ?? "";
    });
    if (inputValue.replace(/[\u200B\uFEFF]/g, "").trim()) {
      throw new Error("发送后输入框未清空，无法确认消息是否成功，已停止重试。");
    }
  }

  async replyToBound(alias: string, text: string, replyToMessageId?: string): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const toolName = "douyin_reply_to_bound_user";
      const normalizedText = text.trim();
      if (!normalizedText || normalizedText.length > 2_000) {
        throw new Error("MESSAGE_TEXT_INVALID:消息必须是 1-2000 个字符。");
      }
      assertWriteReady();
      try {
        await enforceWritePolicy("message");
        const result = await this.withBoundProfile(bound, async page => {
          const conversationPage = await this.openBoundConversationFullscreen(page, bound);
          const before = await this.parseBoundMessages(conversationPage, bound, 100, false);
          const replyTarget = replyToMessageId
            ? before.find(message => message.messageId === replyToMessageId)
            : null;
          if (replyToMessageId) {
            if (!replyTarget) {
              throw new Error("回复目标不属于绑定会话，已停止发送。");
            }
          }
          const latestMessage = before[0] ?? null;
          const contextMessageId = replyToMessageId
            ?? latestMessage?.messageId
            ?? "empty_conversation";
          const normalizedPayload = normalizeCreatorReplyText(normalizedText);
          const beforeMatchingMessageIds = before.filter(message =>
            message.direction === "outgoing"
            && message.messageType === "text"
            && (!replyTarget || Boolean(message.nativeReference))
            && normalizeCreatorReplyText(message.text) === normalizedPayload)
            .map(message => message.messageId);
          let operation = this.socialOperationStore.prepare({
            actionKind: "message",
            actorAccount: loadActionSettings().operator.displayName,
            boundAlias: bound.alias,
            targetUid: bound.uid,
            conversationId: latestMessage?.conversationId
              ?? sha256(`${bound.secUid}:${conversationPage.url()}`),
            targetContextHash: sha256(contextMessageId),
            payloadHash: sha256(normalizedPayload),
            workId: replyTarget?.workId ?? null,
            actionKey: replyTarget ? "native_reply" : null,
            evidence: {
              identityVersion: "server_id_v1",
              beforeMatchingMessageIds,
              beforeLatestMessageId: latestMessage?.messageId ?? null,
              beforeLatestOrder: latestMessage?.orderInConversation ?? null,
              beforeLatestCreatedAt: latestMessage?.createdAt ?? null,
              nativeReferenceRequired: Boolean(replyTarget),
              targetMessageId: replyTarget?.messageId ?? null,
              targetWorkId: replyTarget?.workId ?? null,
            },
          });
          if (operation.state === "confirmed") {
            return {
              operation,
              resultingMessageId: operation.resultingMessageId,
              alreadyConfirmed: true,
            };
          }
          if (["click_started", "unknown_after_submit"].includes(operation.state)) {
            return {
              operation,
              resultingMessageId: operation.resultingMessageId,
              alreadyConfirmed: false,
            };
          }
          const nativeReference = replyTarget
            ? await this.activateNativeBoundReply(conversationPage, bound, replyTarget)
            : null;
          operation = this.socialOperationStore.claim(operation.operationId);
          try {
            await this.sendBoundText(page, bound, normalizedText, conversationPage);
          } catch (error) {
            operation = this.socialOperationStore.update(operation.operationId, {
              state: "unknown_after_submit",
              evidence: {
                ...operation.evidence,
                inputOrClickError: String(error),
                nativeReferencePreview: nativeReference?.previewText ?? null,
              },
              lastError: String(error),
            });
            return { operation, resultingMessageId: null, alreadyConfirmed: false };
          }
          const beforeIds = new Set(before.map(message => message.messageId));
          const readbackStop = latestMessage
            ? new Set([latestMessage.messageId])
            : undefined;
          let matches: BoundMessage[] = [];
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const after = await this.parseBoundMessages(
              conversationPage,
              bound,
              100,
              false,
              readbackStop,
            );
            matches = after.filter(message =>
              !beforeIds.has(message.messageId)
              && message.direction === "outgoing"
              && message.messageType === "text"
              && (!replyTarget || Boolean(message.nativeReference))
              && normalizeCreatorReplyText(message.text)
                === normalizeCreatorReplyText(normalizedText));
            if (matches.length === 1) break;
            await sleep(500);
          }
          if (matches.length === 1) {
            operation = this.socialOperationStore.update(operation.operationId, {
              state: "confirmed",
              resultingMessageId: matches[0].messageId,
              evidence: {
                ...operation.evidence,
                direction: matches[0].direction,
                exactTextHash: sha256(normalizedPayload),
                nativeReference: matches[0].nativeReference,
                targetMessageId: replyTarget?.messageId ?? null,
                targetWorkId: replyTarget?.workId ?? null,
              },
              lastError: null,
            });
            return {
              operation,
              resultingMessageId: matches[0].messageId,
              alreadyConfirmed: false,
            };
          }
          operation = this.socialOperationStore.update(operation.operationId, {
            state: "unknown_after_submit",
            evidence: {
              ...operation.evidence,
              candidateCount: matches.length,
              exactTextHash: sha256(normalizedPayload),
              nativeReferenceRequired: Boolean(replyTarget),
              targetMessageId: replyTarget?.messageId ?? null,
            },
            lastError: "message_readback_not_unique",
          });
          return { operation, resultingMessageId: null, alreadyConfirmed: false };
        });
        const confirmed = result.operation.state === "confirmed";
        if (confirmed) {
          appendActionLog(this.actionLogBase(toolName, "message", {
            recipientAlias: bound.alias,
            beforeState: result.alreadyConfirmed ? "already_confirmed" : "ready",
            afterState: "confirmed",
            success: true,
          }));
        }
        return {
          toolName,
          actionType: "message",
          changed: confirmed && !result.alreadyConfirmed,
          beforeState: result.alreadyConfirmed ? "already_confirmed" : "ready",
          afterState: result.operation.state,
          recipientAlias: bound.alias,
          operationId: result.operation.operationId,
          operationState: result.operation.state,
          resultingMessageId: result.resultingMessageId,
          uncertainAfterSubmit: result.operation.state === "unknown_after_submit",
          message: confirmed
            ? `消息已在 Operator 发送端以真实 serverId 回读确认；${bound.displayName} 手机端是否已经同步仍未知。`
            : "消息提交后尚无法唯一确认；事务已锁定，只允许只读恢复，绝不会自动重发。",
        };
      } catch (error) {
        appendActionLog(this.actionLogBase(toolName, "message", {
          recipientAlias: bound.alias, success: false,
          failureReason: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    });
  }

  async shareCurrentToBound(alias: string, note?: string): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const bound = getBoundUser(alias);
      const toolName = "douyin_share_current_to_bound_user";
      let workUrl: string | undefined;
      let author: string | undefined;
      let operationId: string | undefined;
      try {
        assertWriteReady();
        if (!bound.allowShare) throw new Error(`绑定用户 ${bound.alias} 未授权接收分享。`);
        const page = await this.currentPage();
        const context = await this.captureWorkContext(page);
        workUrl = context.url;
        author = await this.currentAuthor(page, context);
        await this.assertOperatorAccount(page);
        await enforceWritePolicy("share", workUrl);
        const marked = await this.markWorkAction(page, "share");
        const share = page.locator(`[data-codex-action-target="${marked.marker}"]`);
        await share.hover();
        await sleep(3_500);
        await this.assertWorkContext(page, context);
        const target = page.locator(`[data-userid="${bound.uid}"]`);
        if (await target.count() !== 1) throw new Error("分享面板中无法唯一匹配绑定用户的稳定 uid，未执行分享。");
        const targetRow = target.locator("xpath=ancestor::*[contains(@class,'otFjqQEX')][1]");
        const rowText = await (await targetRow.count() === 1 ? targetRow.innerText() : target.innerText());
        if (!rowText.includes(bound.displayName)) {
          throw new Error("分享面板 uid 与绑定显示名不一致，已停止分享。");
        }
        let operation = this.socialOperationStore.prepare({
          actionKind: "share",
          actorAccount: loadActionSettings().operator.displayName,
          boundAlias: bound.alias,
          targetUid: bound.uid,
          conversationId: sha256(bound.secUid),
          targetContextHash: sha256(context.workId),
          payloadHash: sha256(context.workId),
          workId: context.workId,
        });
        operationId = operation.operationId;
        if (operation.state === "confirmed") {
          return {
            toolName,
            actionType: "share",
            changed: false,
            beforeState: "already_confirmed",
            afterState: "confirmed",
            workUrl,
            author,
            recipientAlias: bound.alias,
            operationId,
            operationState: operation.state,
            message: `该作品此前已确认分享给 ${bound.displayName}，本次没有再次点击。`,
          };
        }
        if (["click_started", "unknown_after_submit"].includes(operation.state)) {
          return {
            toolName,
            actionType: "share",
            changed: false,
            beforeState: operation.state,
            afterState: operation.state,
            workUrl,
            author,
            recipientAlias: bound.alias,
            operationId,
            operationState: operation.state,
            uncertainAfterSubmit: true,
            message: "该作品的分享事务状态不明，已禁止再次点击，只允许回读。",
          };
        }
        operation = this.socialOperationStore.claim(operation.operationId);
        try {
          await target.click({ force: true });
        } catch (error) {
          operation = this.socialOperationStore.update(operation.operationId, {
            state: "unknown_after_submit",
            evidence: { targetUidVerified: true, clickError: String(error) },
            lastError: String(error),
          });
          return {
            toolName,
            actionType: "share",
            changed: false,
            beforeState: "click_started",
            afterState: operation.state,
            workUrl,
            author,
            recipientAlias: bound.alias,
            operationId,
            operationState: operation.state,
            uncertainAfterSubmit: true,
            message: "分享点击后状态不明，事务已锁定且不会自动重试。",
          };
        }
        await sleep(CONFIG.actionDelayMs);
        await this.assertWorkContext(page, context);
        const readback = await this.withBoundProfile(bound, async profilePage => {
          const conversationPage = await this.openBoundConversationFullscreen(profilePage, bound);
          const messages = await this.parseBoundMessages(conversationPage, bound, 100, false);
          return messages.filter(message =>
            message.messageType === "shared_work"
            && message.workId === context.workId
            && message.direction !== "incoming");
        }).catch(() => [] as BoundMessage[]);
        if (readback.length === 1) {
          operation = this.socialOperationStore.update(operation.operationId, {
            state: "confirmed",
            resultingMessageId: readback[0].messageId,
            evidence: {
              workId: context.workId,
              stableRecipientUidVerified: true,
              messageType: readback[0].messageType,
            },
            lastError: null,
          });
          appendActionLog(this.actionLogBase(toolName, "share", {
            workUrl, author, recipientAlias: bound.alias,
            beforeState: "ready", afterState: "confirmed", success: true,
          }));
        } else {
          operation = this.socialOperationStore.update(operation.operationId, {
            state: "unknown_after_submit",
            evidence: {
              workId: context.workId,
              stableRecipientUidVerified: true,
              readbackCandidateCount: readback.length,
            },
            lastError: "share_readback_not_unique",
          });
        }
        if (note?.trim()) {
          if (operation.state !== "confirmed") {
            return {
              toolName,
              actionType: "share",
              changed: false,
              beforeState: "click_started",
              afterState: operation.state,
              workUrl,
              author,
              recipientAlias: bound.alias,
              operationId,
              operationState: operation.state,
              uncertainAfterSubmit: true,
              message: "分享尚未确认，因此没有继续发送附言。",
            };
          }
          await this.replyToBound(bound.alias, note.trim());
        }
        return {
          toolName, actionType: "share", changed: operation.state === "confirmed", beforeState: "ready",
          afterState: operation.state, workUrl, author,
          recipientAlias: bound.alias,
          operationId,
          operationState: operation.state,
          resultingMessageId: operation.resultingMessageId,
          uncertainAfterSubmit: operation.state === "unknown_after_submit",
          message: operation.state === "confirmed"
            ? `当前作品已由绑定会话回读确认分享给 ${bound.displayName}${note?.trim() ? "，并处理附言" : ""}。`
            : "分享提交后尚无法唯一回读，事务已锁定且不会自动重试。",
        };
      } catch (error) {
        appendActionLog(this.actionLogBase(toolName, "share", {
          workUrl, author, recipientAlias: bound.alias, success: false,
          failureReason: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    });
  }

  private async markSafeSocialAction(page: Page, action: SafeSocialAction): Promise<string | null> {
    const marker = `codex-social-${action.key}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const found = await page.evaluate(({ scope, label, contextContains, completedContextContains, actionMarker }) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 8
          && rect.height > 8
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth;
      };
      const root = document.body;
      if (!root) return false;
      if (completedContextContains
        && (root.innerText || root.textContent || "").includes(completedContextContains)) {
        return false;
      }
      const contexts = scope === "bound_message"
        ? Array.from(root.querySelectorAll<HTMLElement>(
          "[data-e2e='msg-item-content'],[role='dialog'],[class*='modal'],[class*='popup'],[class*='game']",
        ))
          .filter(element => {
            const text = (element.innerText || element.textContent || "").trim();
            return visible(element) && text.includes(contextContains) && text.length <= 2_000;
          })
          .sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length)
        : Array.from(root.querySelectorAll<HTMLElement>("section,article,[role='dialog'],main,div"))
          .filter(element => {
            const text = (element.innerText || element.textContent || "").trim();
            return visible(element) && text.includes(contextContains) && text.length <= 1_000;
          })
          .sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length);
      if (contexts.length !== 1) return false;
      const context = contexts[0];
      const candidates = Array.from(context.querySelectorAll<HTMLElement>("button,[role='button'],a,.im-button,x-view,div,span,x-text"))
        .filter(element => visible(element) && (element.innerText || element.textContent || "").trim() === label)
        .filter(element => !(element instanceof HTMLAnchorElement) || !element.href || new URL(element.href, location.href).hostname.endsWith("douyin.com"));
      const preferred = candidates.find(element => element.classList.contains("im-button"))
        ?? candidates.find(element => element.matches("button,[role='button']"))
        ?? candidates[0];
      if (!preferred) return false;
      preferred.setAttribute("data-codex-action-target", actionMarker);
      return true;
    }, {
      scope: action.scope,
      label: action.label,
      contextContains: action.contextContains,
      completedContextContains: action.completedContextContains,
      actionMarker: marker,
    });
    return found ? marker : null;
  }

  async listSafeSocialActions(): Promise<SafeSocialActionStatus[]> {
    return this.serial(async () => {
      const actions = Array.from(loadSafeSocialActions().values()).filter(action => action.enabled);
      const statuses: SafeSocialActionStatus[] = actions.map(action => ({
        actionKey: action.key,
        scope: action.scope,
        alias: action.alias,
        label: action.label,
        actionType: action.actionType,
        available: false,
      }));
      const currentActions = actions.filter(action =>
        action.scope === "current_page" && Boolean(action.completedContextContains));
      if (currentActions.length) {
        const page = await this.currentPage();
        await this.assertOperatorAccount(page);
        for (const action of currentActions) {
          const marker = await this.markSafeSocialAction(page, action);
          statuses.find(status => status.actionKey === action.key)!.available = Boolean(marker);
        }
      }
      const aliases = Array.from(new Set(actions
        .filter(action => action.scope === "bound_message")
        .map(action => action.alias)
        .filter((alias): alias is string => Boolean(alias))));
      for (const alias of aliases) {
        const bound = getBoundUser(alias);
        await this.withBoundProfile(bound, async profilePage => {
          const conversationPage = await this.openBoundConversationFullscreen(profilePage, bound);
          for (const action of actions.filter(candidate =>
            candidate.scope === "bound_message"
            && candidate.alias === alias
            && Boolean(candidate.completedContextContains))) {
            let marker: string | null = null;
            for (let attempt = 0; attempt < 10 && !marker; attempt += 1) {
              marker = await this.markSafeSocialAction(conversationPage, action);
              if (!marker) await sleep(300);
            }
            statuses.find(status => status.actionKey === action.key)!.available = Boolean(marker);
          }
        });
      }
      return statuses;
    });
  }

  async clickSafeSocialAction(actionKey: string): Promise<DouyinActionResult> {
    return this.serial(async () => {
      const action = getSafeSocialAction(actionKey);
      const toolName = "douyin_click_safe_social_action";
      const beforeState = "available";
      try {
        if (!action.completedContextContains) {
          throw new Error(
            `SOCIAL_ACTION_COMPLETION_RULE_REQUIRED:action_key=${action.key};refusing_before_click`,
          );
        }
        assertWriteReady();
        await enforceWritePolicy(action.actionType);
        const execute = async (page: Page) => {
          await this.assertOperatorAccount(page);
          let marker: string | null = null;
          for (let attempt = 0; attempt < 20 && !marker; attempt += 1) {
            marker = await this.markSafeSocialAction(page, action);
            if (!marker) await sleep(500);
          }
          if (!marker) throw new Error(`当前安全范围内没有找到“${action.label}”动作。`);
          const target = page.locator(`[data-codex-action-target="${marker}"]`);
          if (await target.count() !== 1) throw new Error("安全社交动作目标不唯一，已停止操作。");
          const contextText = await target.evaluate(element => {
            const context = element.closest<HTMLElement>(
              "[data-e2e='msg-item-content'],[role='dialog'],[class*='modal'],[class*='popup'],[class*='game']",
            ) ?? element.parentElement;
            return (context?.innerText || context?.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 2_000);
          });
          const bound = action.alias ? getBoundUser(action.alias) : null;
          let operation = this.socialOperationStore.prepare({
            actionKind: "safe_social",
            actorAccount: loadActionSettings().operator.displayName,
            boundAlias: action.alias ?? "current_page",
            targetUid: bound?.uid ?? loadActionSettings().operator.uid,
            conversationId: sha256(bound?.secUid ?? page.url()),
            targetContextHash: sha256(`${action.key}:${contextText}`),
            payloadHash: sha256(action.actionType),
            actionKey: action.key,
          });
          if (operation.state === "confirmed"
            || operation.state === "click_started"
            || operation.state === "unknown_after_submit") {
            return operation;
          }
          operation = this.socialOperationStore.claim(operation.operationId);
          const targetBox = await target.boundingBox();
          const blocker = target.locator("xpath=ancestor::*[@data-e2e='msg-item-content'][1]")
            .locator(".BulletGeneralCardblockLayer");
          const blockerBox = await blocker.count() === 1 ? await blocker.boundingBox() : null;
          try {
            if (targetBox && blockerBox) {
              const x = targetBox.x + targetBox.width / 2;
              const y = targetBox.y + targetBox.height / 2;
              const inside = x >= blockerBox.x
                && x <= blockerBox.x + blockerBox.width
                && y >= blockerBox.y
                && y <= blockerBox.y + blockerBox.height;
              if (!inside) throw new Error("安全社交动作坐标不在对应卡片遮罩内，已停止操作。");
              await blocker.click({
                position: { x: x - blockerBox.x, y: y - blockerBox.y },
                force: true,
                timeout: 5_000,
              });
            } else {
              await target.click({ timeout: 5_000 });
            }
          } catch (error) {
            return this.socialOperationStore.update(operation.operationId, {
              state: "unknown_after_submit",
              evidence: { actionKey: action.key, clickError: String(error) },
              lastError: String(error),
            });
          }
          await sleep(CONFIG.actionDelayMs);
          let stillPresent: string | null = null;
          for (let attempt = 0; attempt < 12; attempt += 1) {
            stillPresent = await this.markSafeSocialAction(page, action);
            if (!stillPresent) break;
            await sleep(500);
          }
          const completedContextVisible = action.completedContextContains
            ? await page.getByText(action.completedContextContains, { exact: false })
              .count().then(async count => {
                for (let index = 0; index < count; index += 1) {
                  if (await page.getByText(action.completedContextContains!, { exact: false })
                    .nth(index).isVisible().catch(() => false)) return true;
                }
                return false;
              })
            : false;
          if (!stillPresent && completedContextVisible) {
            return this.socialOperationStore.update(operation.operationId, {
              state: "confirmed",
              evidence: {
                actionKey: action.key,
                completedContextContains: action.completedContextContains,
                targetDisappeared: true,
              },
              lastError: null,
            });
          }
          return this.socialOperationStore.update(operation.operationId, {
            state: "unknown_after_submit",
            evidence: {
              actionKey: action.key,
              targetStillPresent: Boolean(stillPresent),
              completedContextVisible,
            },
            lastError: stillPresent
              ? "action_still_present_after_click"
              : "completion_condition_not_verified",
          });
        };
        let operation;
        if (action.scope === "bound_message") {
          const bound = getBoundUser(action.alias);
          operation = await this.withBoundProfile(bound, async profilePage => {
            const conversationPage = await this.openBoundConversationFullscreen(profilePage, bound);
            return execute(conversationPage);
          });
        } else {
          operation = await execute(await this.currentPage());
        }
        const confirmed = operation.state === "confirmed";
        if (confirmed) {
          appendActionLog(this.actionLogBase(toolName, action.actionType, {
            recipientAlias: action.alias,
            beforeState,
            afterState: "confirmed",
            success: true,
          }));
        }
        return {
          toolName,
          actionType: action.actionType,
          changed: confirmed,
          beforeState,
          afterState: operation.state,
          recipientAlias: action.alias,
          operationId: operation.operationId,
          operationState: operation.state,
          uncertainAfterSubmit: operation.state === "unknown_after_submit",
          message: confirmed
            ? `已通过动作专属完成条件确认“${action.label}”。`
            : `“${action.label}”点击后未能满足动作专属完成条件，事务已锁定且不会自动重试。`,
        };
      } catch (error) {
        appendActionLog(this.actionLogBase(toolName, action.actionType, {
          recipientAlias: action.alias,
          beforeState,
          success: false,
          failureReason: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    });
  }

  private async loadComments(page: Page, limit: number): Promise<void> {
    await this.ensureVisibleCommentSurface(page);
    await page.evaluate(() => {
      const rendered = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0;
      };
      const region = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-scroll='comment'],[data-e2e='comment-list']",
      )).find(rendered) ?? null;
      const route = document.querySelector<HTMLElement>(".route-scroll-container");
      if (region) {
        region.scrollIntoView({ block: "start" });
        if (route) route.scrollTop = Math.max(route.scrollTop, region.getBoundingClientRect().top + route.scrollTop - 100);
      } else if (route) {
        route.scrollTop += Math.max(650, route.clientHeight * 0.9);
      } else {
        window.scrollBy({ top: 700 });
      }
    });
    await sleep(CONFIG.actionDelayMs);
    let previous = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const count = await page.locator(
        "[data-e2e='comment-list']:visible > [data-e2e='comment-item'],"
        + "[data-e2e='comment-list']:visible > div > [data-e2e='comment-item']",
      ).count();
      if (count >= limit || (attempt > 1 && count === previous)) break;
      previous = count;
      await page.evaluate(() => {
        const rendered = (element: HTMLElement): boolean => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0"
            && box.width > 0
            && box.height > 0;
        };
        const route = document.querySelector<HTMLElement>(".route-scroll-container");
        const comment = Array.from(document.querySelectorAll<HTMLElement>(
          "[data-scroll='comment'],[data-e2e='comment-list']",
        )).find(rendered) ?? null;
        if (route) route.scrollTop += Math.max(500, route.clientHeight * 0.8);
        else comment?.scrollBy({ top: 700 });
      });
      await sleep(500);
    }
  }

  private async parseComments(page: Page, limit: number, includeReplies: boolean, repliesPerComment: number): Promise<DouyinComment[]> {
    return page.evaluate(({ max, withReplies, replyMax }) => {
      const parse = (element: HTMLElement): any => {
        const stableId = (value: unknown): string | null => {
          const text = String(value ?? "");
          return /^\d{8,}$/.test(text) && text !== "0" ? text : null;
        };
        let reactComment: any = null;
        let cursor: HTMLElement | null = element;
        while (cursor && !reactComment) {
          const fiberKey = Object.keys(cursor).find(key => key.startsWith("__reactFiber$"));
          let fiber = fiberKey ? (cursor as any)[fiberKey] : null;
          for (let hop = 0; fiber && hop < 20; hop += 1) {
            const props = fiber.memoizedProps;
            const candidate = props?.comment ?? props?.item ?? props?.data?.comment ?? props;
            if (stableId(candidate?.cid ?? candidate?.comment_id ?? candidate?.commentId)) {
              reactComment = candidate;
              break;
            }
            fiber = fiber.return ?? null;
          }
          cursor = cursor.parentElement;
        }
        const more = element.querySelector<HTMLElement>("[data-e2e='video-comment-more']");
        const rawId = more?.querySelector<HTMLElement>("[id]")?.id
          || more?.id
          || element.getAttribute("data-comment-id")
          || "";
        const commentId = stableId(
          reactComment?.cid ?? reactComment?.comment_id ?? reactComment?.commentId,
        ) ?? rawId.match(/(\d{8,})/)?.[1] ?? "";
        const stableParentCommentId = stableId(
          reactComment?.reply_to_reply_id
          ?? reactComment?.replyToReplyId
          ?? reactComment?.reply_id
          ?? reactComment?.replyId,
        );
        const authorLink = element.querySelector<HTMLAnchorElement>(".comment-item-info-wrap a[href*='/user/'],a[href*='/user/']");
        const avatarAlt = element.querySelector<HTMLImageElement>(".comment-item-avatar img[alt]")?.alt?.replace(/头像$/, "") ?? "";
        const contentElement = element.querySelector<HTMLElement>(".FduGc_lz,[data-e2e='comment-level-1']");
        const contentClone = contentElement?.cloneNode(true) as HTMLElement | undefined;
        contentClone?.querySelectorAll(".comment-item-tag,[class*='comment-item-tag']").forEach(tag => tag.remove());
        contentClone?.querySelectorAll<HTMLImageElement>("img[alt]").forEach(image => {
          image.replaceWith(document.createTextNode(image.alt));
        });
        const content = (contentClone?.innerText || contentClone?.textContent || "").trim();
        const meta = element.querySelector<HTMLElement>(".VAQA49VP")?.innerText?.trim() ?? "";
        const metaParts = meta.split(/[·\s]+/).filter(Boolean);
        const stat = element.querySelector<HTMLElement>(".comment-item-stats-container p span,.comment-item-stats-container span");
        const tags = Array.from(element.querySelectorAll<HTMLElement>(".comment-item-tag-text"))
          .filter(tag => tag.closest("[data-e2e='comment-item']") === element)
          .map(tag => tag.innerText.trim());
        return {
          commentId,
          author: (authorLink?.innerText || authorLink?.textContent || "").trim() || avatarAlt || "未知用户",
          text: content,
          time: metaParts[0] ?? null,
          location: metaParts.slice(1).join(" ") || null,
          likeCount: stat?.innerText?.trim() || null,
          isAuthor: tags.includes("作者"),
          isPinned: tags.includes("置顶"),
          stableParentCommentId,
        };
      };
      const rendered = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0;
      };
      const list = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-e2e='comment-list']",
      )).find(rendered) ?? null;
      if (!list) return [];
      const currentUrl = new URL(location.href);
      const workId = currentUrl.searchParams.get("modal_id")
        ?? currentUrl.searchParams.get("aweme_id")
        ?? currentUrl.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
        ?? "";
      const all = Array.from(list.querySelectorAll<HTMLElement>("[data-e2e='comment-item']"));
      const top = all.filter(item => !item.closest(".replyContainer"));
      return top.slice(0, max).map(item => {
        const result = parse(item);
        result.workId = workId;
        result.parentCommentId = null;
        result.rootCommentId = result.commentId;
        result.depth = 0;
        result.threadPath = [result.commentId];
        if (withReplies) {
          const replies = Array.from(item.querySelectorAll<HTMLElement>(".replyContainer [data-e2e='comment-item']"))
            .slice(0, replyMax)
            .map(replyElement => {
              const reply = parse(replyElement);
              reply.workId = workId;
              reply.parentCommentId = reply.stableParentCommentId ?? result.commentId;
              reply.rootCommentId = result.commentId;
              reply.depth = reply.parentCommentId === result.commentId ? 1 : 2;
              reply.threadPath = reply.depth === 1
                ? [result.commentId, reply.commentId]
                : [result.commentId, reply.parentCommentId, reply.commentId];
              reply.replyCount = 0;
              delete reply.stableParentCommentId;
              return reply;
            });
          result.replies = replies;
        }
        result.replyCount = result.replies?.length
          ?? item.querySelectorAll(".replyContainer [data-e2e='comment-item']").length;
        delete result.stableParentCommentId;
        return result;
      }).filter(item => item.commentId && item.text);
    }, { max: limit, withReplies: includeReplies, replyMax: repliesPerComment });
  }

  async readComments(sort: "hot" | "latest", limit: number, includeReplies: boolean, repliesPerComment: number): Promise<CommentReadResult> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      if (sort === "latest") {
        const latest = page.getByText("最新", { exact: true });
        const count = await latest.count();
        let visibleIndex = -1;
        let visibleCount = 0;
        for (let i = 0; i < count; i += 1) {
          if (await latest.nth(i).isVisible().catch(() => false)) {
            visibleIndex = i;
            visibleCount += 1;
          }
        }
        if (visibleCount === 1) {
          await latest.nth(visibleIndex).click();
          await sleep(CONFIG.actionDelayMs);
        } else if (visibleCount > 1) {
          throw new Error("评论排序控件不唯一，已停止切换到最新排序。");
        }
      }
      await this.loadComments(page, limit);
      if (includeReplies) {
        const expand = page.locator(".comment-reply-expand-btn:visible").filter({ hasText: "展开" });
        const count = Math.min(await expand.count(), limit);
        for (let i = 0; i < count; i += 1) {
          await expand.nth(i).click({ timeout: 3_000 }).catch(() => null);
          await sleep(180);
        }
      }
      await this.assertWorkContext(page, context);
      const comments = await this.parseComments(page, limit, includeReplies, repliesPerComment);
      return {
        url: context.url,
        workId: context.workId,
        sort,
        comments,
        count: comments.length,
        privacyFiltered: true,
      };
    });
  }

  async readCommentThread(commentId: string, limit: number): Promise<CommentReadResult> {
    return this.serial(async () => {
      const page = await this.currentPage();
      const context = await this.captureWorkContext(page);
      await this.loadComments(page, 100);
      const target = page.locator(`[data-e2e='video-comment-more'] #tooltip_${commentId}`).locator("xpath=ancestor::*[@data-e2e='comment-item'][1]");
      if (await target.count() !== 1) throw new Error("当前作品已加载评论中没有找到该 comment_id。");
      const expand = target.locator(".comment-reply-expand-btn");
      if (await expand.count() === 1 && await expand.isVisible().catch(() => false)) {
        await expand.click();
        await sleep(CONFIG.actionDelayMs);
      }
      await this.assertWorkContext(page, context);
      const parsed = await target.evaluate((element, max) => {
        const item = element as HTMLElement;
        const parse = (node: HTMLElement): any => {
          const more = node.querySelector<HTMLElement>("[data-e2e='video-comment-more']");
          const rawId = more?.querySelector<HTMLElement>("[id]")?.id
            || more?.id
            || node.getAttribute("data-comment-id")
            || "";
          const authorLink = node.querySelector<HTMLAnchorElement>(".comment-item-info-wrap a[href*='/user/'],a[href*='/user/']");
          const avatarAlt = node.querySelector<HTMLImageElement>(".comment-item-avatar img[alt]")?.alt?.replace(/头像$/, "") ?? "";
          const meta = node.querySelector<HTMLElement>(".VAQA49VP")?.innerText?.trim()?.split(/[·\s]+/) ?? [];
          const contentElement = node.querySelector<HTMLElement>(".FduGc_lz,[data-e2e='comment-level-1']");
          const contentClone = contentElement?.cloneNode(true) as HTMLElement | undefined;
          contentClone?.querySelectorAll(".comment-item-tag,[class*='comment-item-tag']").forEach(tag => tag.remove());
          const tags = Array.from(node.querySelectorAll<HTMLElement>(".comment-item-tag-text"))
            .filter(tag => tag.closest("[data-e2e='comment-item']") === node)
            .map(tag => tag.innerText.trim());
          return {
            commentId: rawId.match(/(\d{8,})/)?.[1] ?? "",
            author: (authorLink?.innerText || authorLink?.textContent || "").trim() || avatarAlt || "未知用户",
            text: (contentClone?.innerText || contentClone?.textContent || "").trim(),
            time: meta[0] ?? null,
            location: meta.slice(1).join(" ") || null,
            likeCount: node.querySelector<HTMLElement>(".comment-item-stats-container p span,.comment-item-stats-container span")?.innerText?.trim() || null,
            isAuthor: tags.includes("作者"),
            isPinned: tags.includes("置顶"),
          };
        };
        const root = parse(item);
        root.replies = Array.from(item.querySelectorAll<HTMLElement>(".replyContainer [data-e2e='comment-item']"))
          .slice(0, max)
          .map(parse);
        const currentUrl = new URL(location.href);
        const workId = currentUrl.searchParams.get("modal_id")
          ?? currentUrl.searchParams.get("aweme_id")
          ?? currentUrl.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? "";
        root.workId = workId;
        root.parentCommentId = null;
        root.rootCommentId = root.commentId;
        root.depth = 0;
        root.threadPath = [root.commentId];
        root.replyCount = root.replies.length;
        root.replies = root.replies.map((reply: any) => ({
          ...reply,
          workId,
          parentCommentId: root.commentId,
          rootCommentId: root.commentId,
          depth: 1,
          threadPath: [root.commentId, reply.commentId],
          replyCount: 0,
        }));
        return root;
      }, limit);
      return {
        url: context.url,
        workId: context.workId,
        sort: "hot",
        comments: [parsed],
        count: 1,
        privacyFiltered: true,
      };
    });
  }

  private async formalOperatorPage(): Promise<Page> {
    await this.ensurePageRoles();
    const page = this.rolePages.get("operator_home");
    if (!page || page.isClosed()) {
      throw new Error("PAGE_BINDING_LOST:Operator 正式页不存在；不会改用当前活动页。");
    }
    const persisted = loadPageBindings().get("operator_home");
    if (!persisted || persisted.targetId !== await this.pageTargetId(page)) {
      throw new Error("PAGE_BINDING_LOST:Operator 正式页 target_id 不匹配。");
    }
    await this.assertOperatorAccount(page);
    return page;
  }

  private async saveCommentArtifact(
    page: Page,
    operation: string,
    details: Record<string, unknown>,
  ): Promise<{ screenshotPath: string; diagnosticsPath: string }> {
    const directory = path.join(
      CONFIG.runtimeDir,
      "comment-diagnostics",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${operation}`,
    );
    await fs.mkdir(directory, { recursive: true });
    const screenshotPath = path.join(directory, "page.png");
    const diagnosticsPath = path.join(directory, "diagnostics.json");
    await page.screenshot({ path: screenshotPath, type: "png", fullPage: false });
    await fs.writeFile(diagnosticsPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      operation,
      pageId: this.pageId(page),
      targetId: await this.pageTargetId(page),
      account: loadActionSettings().operator.displayName,
      url: page.url(),
      ...details,
    }, null, 2), "utf8");
    return { screenshotPath, diagnosticsPath };
  }

  private async ensureVisibleCommentSurface(page: Page): Promise<{
    commentTabActivated: boolean;
    visibleCommentSurfaceCount: number;
  }> {
    const visibleSurfaceCount = async (): Promise<number> => page.evaluate(() => {
      const rendered = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0;
      };
      const visible = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-e2e='comment-list'],[data-scroll='comment']",
      )).filter(rendered);
      return visible.filter(element =>
        !visible.some(other => other !== element && element.contains(other)))
        .length;
    });
    let count = await visibleSurfaceCount();
    if (count === 1) {
      return { commentTabActivated: false, visibleCommentSurfaceCount: count };
    }
    if (count > 1) {
      throw new Error(`COMMENT_SURFACE_AMBIGUOUS:可见评论区域数量=${count}。`);
    }

    const marker = `comment-tab-${randomUUID()}`;
    const marked = await page.evaluate(input => {
      const rendered = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0;
      };
      const label = /^评论(?:\(\d+\))?$/u;
      const canonicalCommentLabel = /^\u8bc4\u8bba(?:\(\d+\))?$/u;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "[role='tab'],button,[role='button'],div,span",
      )).filter(element => {
        const text = (element.innerText || element.textContent || "").trim();
        if (!rendered(element) || !canonicalCommentLabel.test(text)) return false;
        return !Array.from(element.children).some(child =>
          canonicalCommentLabel.test(((child as HTMLElement).innerText || child.textContent || "").trim()));
      });
      if (candidates.length === 1) {
        candidates[0].setAttribute("data-codex-comment-tab", input);
      }
      return candidates.length;
    }, marker);
    if (marked !== 1) {
      throw new Error(`COMMENT_SURFACE_NOT_READY:评论标签候选数量=${marked}。`);
    }
    await page.locator(`[data-codex-comment-tab="${marker}"]`).click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(100);
      count = await visibleSurfaceCount();
      if (count === 1) {
        return { commentTabActivated: true, visibleCommentSurfaceCount: count };
      }
      if (count > 1) {
        throw new Error(`COMMENT_SURFACE_AMBIGUOUS:激活后可见评论区域数量=${count}。`);
      }
    }
    throw new Error("COMMENT_SURFACE_NOT_READY:激活评论标签后仍没有可见评论区域。");
  }

  private async inspectRootCommentComposer(
    page: Page,
    workId: string,
  ): Promise<{
    commentTabActivated: boolean;
    visibleCommentSurfaceCount: number;
    selectedMarker: string | null;
    candidates: RootCommentComposerCandidate[];
    decision: ReturnType<typeof chooseRootCommentComposer>;
  }> {
    const surface = await this.ensureVisibleCommentSurface(page);
    const markerPrefix = `root-composer-${randomUUID()}`;
    const candidates = await page.evaluate(input => {
      const rendered = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0;
      };
      const domPath = (element: HTMLElement): string => {
        const parts: string[] = [];
        let current: HTMLElement | null = element;
        while (current && parts.length < 10) {
          let part = current.tagName.toLowerCase();
          if (current.id) part += `#${current.id}`;
          if (current.classList.length) {
            part += `.${Array.from(current.classList).slice(0, 3).join(".")}`;
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(" > ");
      };
      const currentWorkId = new URL(location.href).searchParams.get("modal_id")
        ?? new URL(location.href).searchParams.get("aweme_id")
        ?? location.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
        ?? null;
      const renderedLists = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-e2e='comment-list'],[data-scroll='comment']",
      )).filter(rendered);
      const visibleLists = renderedLists.filter(element =>
        !renderedLists.some(other =>
          other !== element && element.contains(other)));
      const list = visibleLists.length === 1 ? visibleLists[0] : null;
      let commentSurface = list?.closest<HTMLElement>("#merge-all-comment-container") ?? null;
      if (list && !commentSurface) {
        let ancestor = list.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (ancestor.querySelector(".comment-input-inner-container")) {
            commentSurface = ancestor;
            break;
          }
          ancestor = ancestor.parentElement;
        }
      }
      const composers = Array.from(document.querySelectorAll<HTMLElement>(
        ".comment-input-inner-container",
      ));
      return composers.map((composer, index) => {
        const box = composer.getBoundingClientRect();
        const intersectWidth = Math.max(
          0,
          Math.min(box.right, innerWidth) - Math.max(box.left, 0),
        );
        const intersectHeight = Math.max(
          0,
          Math.min(box.bottom, innerHeight) - Math.max(box.top, 0),
        );
        const area = Math.max(1, box.width * box.height);
        const placeholderElement = composer.querySelector<HTMLElement>(
          ".public-DraftEditorPlaceholder-inner,[class*='placeholder'],span",
        );
        const editor = composer.querySelector<HTMLElement>("[contenteditable='true']");
        const placeholder = (
          placeholderElement?.innerText
          || placeholderElement?.textContent
          || editor?.getAttribute("aria-placeholder")
          || ""
        ).trim();
        const rightControls = composer.querySelector<HTMLElement>(".commentInput-right-ct");
        const semanticSend = Array.from(composer.querySelectorAll<HTMLElement>(
          "button,[role='button'],[data-e2e*='send'],[aria-label]",
        )).filter(element => {
          if (!rendered(element)) return false;
          const hint = [
            element.innerText || element.textContent || "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("data-e2e") ?? "",
          ].join(" ").trim();
          return /^(发送|发布)$/u.test(hint)
            || /(?:^|[-_])(send|submit)(?:$|[-_])/iu.test(hint);
        });
        const directIcons = rightControls
          ? Array.from(rightControls.querySelectorAll<HTMLElement>(":scope > div > span"))
            .filter(element => rendered(element) && Boolean(element.querySelector("svg")))
          : [];
        const sendCandidates = semanticSend.length
          ? semanticSend
          : directIcons.length
            ? [directIcons.at(-1)!]
            : [];
        const workAncestor = composer.closest<HTMLElement>(
          "[data-aweme-id],[data-work-id],[data-work-id-str]",
        );
        const nearestWorkId = workAncestor?.getAttribute("data-aweme-id")
          ?? workAncestor?.getAttribute("data-work-id")
          ?? workAncestor?.getAttribute("data-work-id-str")
          ?? currentWorkId;
        composer.setAttribute("data-codex-root-composer-candidate", `${input}-${index}`);
        return {
          index,
          domPath: domPath(composer),
          placeholder,
          ariaLabel: editor?.getAttribute("aria-label") ?? "",
          dataE2e: editor?.getAttribute("data-e2e") ?? "",
          visible: rendered(composer),
          editable: Boolean(editor)
            || /留下你的精彩评论吧|发表评论|写评论/u.test(placeholder),
          width: box.width,
          height: box.height,
          intersectionRatio: intersectWidth * intersectHeight / area,
          inCommentSurface: Boolean(commentSurface?.contains(composer)),
          inCommentItem: Boolean(composer.closest("[data-e2e='comment-item']")),
          inReplyContainer: Boolean(composer.closest(".replyContainer")),
          nearestWorkId,
          sendCandidateCount: sendCandidates.length,
        };
      });
    }, markerPrefix);
    const decision = chooseRootCommentComposer(candidates, workId);
    const selectedMarker = decision.selectedIndex == null
      ? null
      : `${markerPrefix}-${decision.selectedIndex}`;
    return {
      ...surface,
      selectedMarker,
      candidates,
      decision,
    };
  }

  private async openVerifiedRootCommentComposer(
    page: Page,
    workId: string,
  ): Promise<{
    editor: Locator;
    send: Locator;
    diagnostics: Awaited<ReturnType<DouyinBrowser["inspectRootCommentComposer"]>>;
  }> {
    const diagnostics = await this.inspectRootCommentComposer(page, workId);
    if (!diagnostics.selectedMarker) {
      const summary = JSON.stringify({
        reason: diagnostics.decision.reason,
        eligibleIndexes: diagnostics.decision.eligibleIndexes,
        candidates: diagnostics.candidates,
      });
      throw new Error(`VALIDATION_FAILED:主评论输入框无法唯一定位。diagnostics=${summary}`);
    }
    const composer = page.locator(
      `[data-codex-root-composer-candidate="${diagnostics.selectedMarker}"]`,
    );
    if (await composer.count() !== 1 || !await composer.isVisible().catch(() => false)) {
      throw new Error("VALIDATION_FAILED:已验证的主评论 composer 在输入前失效。");
    }
    let editor = composer.locator("[contenteditable='true']");
    if (await editor.count() !== 1) {
      const placeholder = composer.getByText(
        /^(留下你的精彩评论吧|发表评论|写评论)$/u,
        { exact: true },
      );
      if (await placeholder.count() !== 1) {
        throw new Error("VALIDATION_FAILED:主评论 composer 没有唯一的可激活占位入口。");
      }
      await placeholder.click();
      editor = composer.locator("[contenteditable='true']");
      await editor.waitFor({ state: "visible", timeout: 3_000 });
    }
    if (await editor.count() !== 1 || !await editor.isVisible().catch(() => false)) {
      throw new Error("VALIDATION_FAILED:主评论编辑器激活后仍不唯一。");
    }
    const semanticSend = composer.locator(
      "button,[role='button'],[data-e2e*='send'],[aria-label]",
    ).filter({ hasText: /^(发送|发布)$/u });
    const visibleSemantic: Locator[] = [];
    for (let index = 0; index < await semanticSend.count(); index += 1) {
      if (await semanticSend.nth(index).isVisible().catch(() => false)) {
        visibleSemantic.push(semanticSend.nth(index));
      }
    }
    let send: Locator | null = visibleSemantic.length === 1 ? visibleSemantic[0] : null;
    if (!send) {
      const iconCandidates = composer.locator(
        ".commentInput-right-ct > div > span:has(svg)",
      );
      const visibleIcons: Locator[] = [];
      for (let index = 0; index < await iconCandidates.count(); index += 1) {
        if (await iconCandidates.nth(index).isVisible().catch(() => false)) {
          visibleIcons.push(iconCandidates.nth(index));
        }
      }
      if (visibleIcons.length) send = visibleIcons.at(-1)!;
    }
    if (!send || !await send.isVisible().catch(() => false)) {
      throw new Error("VALIDATION_FAILED:主评论 composer 内没有可验证的发送控件。");
    }
    return { editor, send, diagnostics };
  }

  async probeCommentComposer(options: {
    workId: string;
    scope: TargetWriteScope;
    alias?: string;
  }): Promise<{
    workId: string;
    scope: TargetWriteScope;
    pageRole: "root_comment_clean";
    pageTargetId: string;
    url: string;
    commentTabActivated: boolean;
    visibleCommentSurfaceCount: number;
    selected: boolean;
    reason: "unique" | "not_found" | "ambiguous";
    selectedIndex: number | null;
    candidates: RootCommentComposerCandidate[];
    sent: false;
  }> {
    return this.serial(async () => {
      const target = await this.createScopedRootCommentGate({
        scope: options.scope,
        workId: options.workId,
        alias: options.alias,
      });
      const inspection = await this.inspectRootCommentComposer(target.page, options.workId);
      return {
        workId: options.workId,
        scope: options.scope,
        pageRole: "root_comment_clean",
        pageTargetId: await this.pageTargetId(target.page),
        url: target.page.url(),
        commentTabActivated: inspection.commentTabActivated,
        visibleCommentSurfaceCount: inspection.visibleCommentSurfaceCount,
        selected: inspection.decision.reason === "unique",
        reason: inspection.decision.reason,
        selectedIndex: inspection.decision.selectedIndex,
        candidates: inspection.candidates,
        sent: false,
      };
    }, { restoreOnError: false });
  }

  async abortCommentOperation(options: {
    operationId: string;
    confirmUnsent: boolean;
  }): Promise<{
    operationId: string;
    operation_id: string;
    previousState: WriteOperationRecord["state"];
    state: WriteOperationRecord["state"];
    workId: string;
    scope: TargetWriteScope;
    composerTextHashMatched: boolean;
    duplicateCommentCount: number;
    submitResponsePreviouslySeen: boolean;
    clickEffectPreviouslyConfirmed: boolean;
    globalWriteReady: boolean;
    unresolvedOperationIds: string[];
    sent: false;
  }> {
    return this.serial(async () => {
      if (!options.confirmUnsent) {
        throw new Error("CONFIRMATION_REQUIRED:必须提供 confirm_unsent=true。");
      }
      const operation = this.writeOperationStore.get(options.operationId);
      if (!operation) {
        throw new Error("WRITE_OPERATION_NOT_FOUND:operation_id 不存在。");
      }
      if (operation.actionType !== "create_root_comment") {
        throw new Error("ABORT_NOT_ALLOWED:当前恢复接口只接受主评论事务。");
      }
      if (operation.state !== "click_no_effect") {
        throw new Error(`ABORT_NOT_ALLOWED:state=${operation.state}`);
      }
      if (operation.submitResponseSeenAt
        || operation.clickEffectConfirmedAt
        || operation.composerClearedAt
        || operation.resultingCommentId) {
        throw new Error(
          "ABORT_UNSAFE:事务已有可能提交的正向证据，必须保持只读回查。",
        );
      }
      const target = await this.openRootCommentCleanTarget({
        workId: operation.workId,
        workUrl: operation.gateSnapshot.verifiedUrl,
        expectedAuthor: operation.gateSnapshot.targetWorkAuthor,
      });
      await this.assertOperatorAccount(target.page);
      await this.assertWorkContext(target.page, target.context);
      const inspection = await this.inspectRootCommentComposer(
        target.page,
        operation.workId,
      );
      if (!inspection.selectedMarker) {
        throw new Error(
          `ABORT_UNSAFE:主评论 composer 无法唯一定位，reason=${inspection.decision.reason}`,
        );
      }
      const composer = target.page.locator(
        `[data-codex-root-composer-candidate="${inspection.selectedMarker}"]`,
      );
      const editor = composer.locator("[contenteditable='true']");
      if (await editor.count() !== 1 || !await editor.isVisible().catch(() => false)) {
        throw new Error("ABORT_UNSAFE:主评论 composer 中没有保留可验证的编辑器。");
      }
      const beforeText = (await editor.innerText()).trim();
      const composerTextHashMatched = sha256(beforeText) === operation.writeTextHash;
      if (!composerTextHashMatched) {
        throw new Error("ABORT_UNSAFE:composer 中的文字与冻结回复文本哈希不一致。");
      }
      await this.loadComments(target.page, 100);
      const comments = await this.parseComments(target.page, 100, true, 100);
      const duplicates = comments.flatMap(comment => [comment, ...(comment.replies ?? [])])
        .filter(comment =>
          comment.author === operation.actorAccount
          && normalizeCreatorReplyText(comment.text)
            === normalizeCreatorReplyText(operation.writeText)
          && comment.parentCommentId == null);
      if (duplicates.length > 0) {
        throw new Error(
          `ABORT_UNSAFE:评论列表中已存在 ${duplicates.length} 条相同文本，必须保持只读回查。`,
        );
      }
      const afterText = (await editor.innerText().catch(() => "")).trim();
      if (sha256(afterText) !== operation.writeTextHash) {
        throw new Error("ABORT_UNSAFE:检查评论列表后 composer 原文发生变化。");
      }
      const previousState = operation.state;
      const aborted = this.writeOperationStore.abortNoSubmit(
        operation.token,
        "operator_confirmed_unsent:composer_hash_match_no_duplicate_no_submit_response",
      );
      const unresolvedOperationIds = this.collectAllUnresolvedOperationIds();
      const globalBlockingOperationIds = this.collectGlobalBlockingUnresolvedOperationIds();
      const gate = getWriteGateState();
      const blockedReasons = gate.blockedReasons
        .filter(reason => reason !== "unresolved_reply_operations");
      if (globalBlockingOperationIds.length > 0) {
        blockedReasons.push("unresolved_reply_operations");
      }
      const canWrite = blockedReasons.length === 0
        && gate.browserConnected
        && gate.profileVerified
        && gate.accountVerified
        && gate.creatorCenterReady
        && gate.ledgerWritable;
      setWriteGateState({
        ...gate,
        mode: canWrite ? "write_ready" : startupFailureMode(blockedReasons),
        globalWriteReady: canWrite,
        unresolvedOperationIds: globalBlockingOperationIds,
        blockedReasons,
        checkedAt: new Date().toISOString(),
      });
      return {
        operationId: aborted.operationId,
        operation_id: aborted.operationId,
        previousState,
        state: aborted.state,
        workId: aborted.workId,
        scope: aborted.scope,
        composerTextHashMatched,
        duplicateCommentCount: duplicates.length,
        submitResponsePreviouslySeen: Boolean(operation.submitResponseSeenAt),
        clickEffectPreviouslyConfirmed: Boolean(operation.clickEffectConfirmedAt),
        globalWriteReady: getWriteGateState().globalWriteReady,
        unresolvedOperationIds,
        sent: false,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async pageForTargetWriteScope(
    scope: TargetWriteScope,
    workId: string,
    alias?: string,
    requireGlobalReady = true,
  ): Promise<{
    page: Page;
    context: WorkContext;
    author: string;
    title: string | null;
    pageRole: "operator_home" | "codex_test";
  }> {
    if (requireGlobalReady) assertWriteReady();
    if (scope === "own_post") {
      await this.openOwnPost(workId);
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      const author = await this.verifyOwnWorkAuthor(page, context);
      if (!workLockMatches(this.lockedWorkContexts.get("operator_home"), workId, "self")) {
        throw new Error("WORK_NOT_LOCKED:Operator 自有作品未锁定。");
      }
      return {
        page,
        context,
        author,
        title: await page.title().catch(() => null),
        pageRole: "operator_home",
      };
    }
    if (scope === "bound_user_post") {
      const boundAlias = alias ?? "bound_user";
      const opened = await this.openBoundUserPost(boundAlias, workId);
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      if (context.workId !== workId || !opened.authorVerified || !opened.loginVerified
        || !opened.workLocked || !opened.autoplayLocked) {
        throw new Error("TARGET_GATE_FAILED:绑定用户作品、作者、登录账号或页面锁定验证失败。");
      }
      return {
        page,
        context,
        author: opened.author,
        title: opened.title,
        pageRole: "operator_home",
      };
    }

    const page = await this.rolePage("codex_test", "https://www.douyin.com/jingxuan");
    await this.assertOperatorAccount(page);
    let context = await this.captureWorkContext(page).catch(() => null);
    if (context?.workId !== workId) {
      const cached = Array.from(this.feedWorkCache.values())
        .find(item => item.workId === workId);
      const locked = this.lockedWorkContexts.get("codex_test");
      const workUrl = cached?.url
        ?? (locked?.workId === workId ? locked.workUrl : null)
        ?? `https://www.douyin.com/video/${workId}`;
      context = await this.navigateToStableWork(page, workUrl, workId);
    }
    if (!context || context.workId !== workId) {
      throw new Error("WRONG_PAGE:codex_test 没有打开目标外部作品。");
    }
    const author = await this.currentAuthor(page, context);
    if (!author) throw new Error("WRONG_AUTHOR:无法读取外部作品作者。");
    const contentType = /\/note\//.test(context.url)
      ? "note" as const
      : /\/article\//.test(context.url)
        ? "article" as const
        : "video" as const;
    const autoplayLocked = await this.lockWorkAutoplay(page, workId, contentType);
    if (!autoplayLocked) {
      throw new Error("WORK_LOCK_FAILED:外部作品无法锁定，禁止建立目标写门禁。");
    }
    this.lockedWorkContexts.set("codex_test", {
      workId,
      workUrl: page.url(),
      alias: null,
      author,
      autoplayLocked,
      lockedAt: new Date().toISOString(),
    });
    await this.assertWorkContext(page, context);
    return {
      page,
      context,
      author,
      title: await page.title().catch(() => null),
      pageRole: "codex_test",
    };
  }

  private async resolvePostWriteTarget(input: {
    workId: string;
    scope: TargetWriteScope;
    alias?: string;
    requireGlobalReady?: boolean;
  }): Promise<ResolvedPostWriteTarget> {
    if (!/^\d{16,20}$/.test(input.workId)) throw new Error("work_id 格式无效。");
    const resolved = await this.pageForTargetWriteScope(
      input.scope,
      input.workId,
      input.alias,
      input.requireGlobalReady ?? true,
    );
    if (resolved.pageRole !== pageRoleForPostScope(input.scope)) {
      throw new Error("TARGET_PAGE_ROLE_MISMATCH:低风险动作目标页面角色不正确。");
    }
    await this.assertOperatorAccount(resolved.page);
    await this.assertWorkContext(resolved.page, resolved.context);
    if (resolved.context.workId !== input.workId) {
      throw new Error("TARGET_WORK_CHANGED:动作前页面 work_id 已变化。");
    }
    const lock = this.lockedWorkContexts.get(resolved.pageRole);
    if (!lock || lock.workId !== input.workId || !lock.autoplayLocked) {
      throw new Error("WORK_NOT_LOCKED:统一低风险动作目标未建立有效作品锁。");
    }
    return {
      page: resolved.page,
      pageRole: resolved.pageRole,
      context: resolved.context,
      workId: input.workId,
      author: resolved.author,
      accountVerified: true,
      autoplayLocked: true,
    };
  }

  private async openRootCommentCleanTarget(input: {
    workId: string;
    workUrl: string;
    expectedAuthor: string;
    allowLaunch?: boolean;
  }): Promise<{
    page: Page;
    context: WorkContext;
    author: string;
    title: string | null;
    pageRole: "root_comment_clean";
    profileId: string;
    browserLaunched: boolean;
  }> {
    assertDouyinWorkUrl(input.workUrl);
    const clean = await this.rootCommentPage(input.allowLaunch ?? true);
    let context = await this.captureWorkContext(clean.page).catch(() => null);
    if (context?.workId !== input.workId) {
      context = await this.navigateToStableWork(
        clean.page,
        input.workUrl,
        input.workId,
      );
    }
    await this.assertOperatorAccount(clean.page);
    await this.assertWorkContext(clean.page, context);
    const author = await this.currentAuthor(clean.page, context);
    if (!author
      || normalizeCreatorReplyText(author)
        !== normalizeCreatorReplyText(input.expectedAuthor)) {
      throw new Error(
        `ROOT_COMMENT_TARGET_AUTHOR_MISMATCH:actual=${author ?? "unknown"};`
        + `expected=${input.expectedAuthor}`,
      );
    }
    const contentType = /\/note\//.test(context.url)
      ? "note" as const
      : /\/article\//.test(context.url)
        ? "article" as const
        : "video" as const;
    if (!await this.lockWorkAutoplay(clean.page, input.workId, contentType)) {
      throw new Error(
        "ROOT_COMMENT_WORK_LOCK_FAILED:独立 profile 无法锁定指定作品。",
      );
    }
    return {
      page: clean.page,
      context,
      author,
      title: await clean.page.title().catch(() => null),
      pageRole: "root_comment_clean",
      profileId: rootCommentProfileId,
      browserLaunched: clean.launched,
    };
  }

  private async createScopedRootCommentGate(input: {
    scope: TargetWriteScope;
    workId: string;
    alias?: string;
  }): Promise<{
    gate: TargetWriteGate;
    page: Page;
    context: WorkContext;
    workAuthor: string;
    workTitle: string | null;
  }> {
    const discovered = await this.pageForTargetWriteScope(
      input.scope,
      input.workId,
      input.alias,
    );
    const clean = await this.openRootCommentCleanTarget({
      workId: input.workId,
      workUrl: discovered.context.url,
      expectedAuthor: discovered.author,
    });
    const gate = createTargetWriteGate({
      scope: input.scope,
      actionType: "create_root_comment",
      actorAccount: loadActionSettings().operator.displayName,
      pageRole: "root_comment_clean",
      pageTargetId: await this.pageTargetId(clean.page),
      targetWorkId: input.workId,
      targetWorkAuthor: clean.author,
      targetCommentId: null,
      targetTextHash: null,
      verifiedUrl: clean.context.url,
      commentVerified: true,
      alias: input.alias ?? null,
    });
    return {
      gate,
      page: clean.page,
      context: clean.context,
      workAuthor: clean.author,
      workTitle: clean.title ?? discovered.title,
    };
  }

  private async openFrozenRootCommentCleanTarget(
    operation: WriteOperationRecord,
    allowLaunch = true,
  ) {
    if (operation.actionType !== "create_root_comment") {
      throw new Error("ROOT_COMMENT_OPERATION_REQUIRED");
    }
    if (operation.pageRole !== "root_comment_clean"
      || operation.gateSnapshot.pageRole !== "root_comment_clean") {
      throw new Error(
        "LEGACY_ROOT_COMMENT_OPERATION:"
        + "旧 profile 创建的根评论事务不得继续发送，请重新 prepare。",
      );
    }
    const clean = await this.openRootCommentCleanTarget({
      workId: operation.workId,
      workUrl: operation.gateSnapshot.verifiedUrl,
      expectedAuthor: operation.gateSnapshot.targetWorkAuthor,
      allowLaunch,
    });
    const currentTargetId = await this.pageTargetId(clean.page);
    if (currentTargetId !== operation.gateSnapshot.pageTargetId) {
      throw new Error(
        "ROOT_COMMENT_TARGET_ID_CHANGED:"
        + "prepare 后独立浏览器页面已重建，请重新 prepare。",
      );
    }
    return clean;
  }

  private requireAdaptiveRootOperation(
    tokenOrOperationId: string,
    allowedStates: WriteOperationRecord["state"][],
  ): WriteOperationRecord {
    const operation = this.writeOperationStore.get(tokenOrOperationId);
    if (!operation) throw new Error("WRITE_OPERATION_NOT_FOUND:operation_id 不存在。");
    if (operation.actionType !== "create_root_comment") {
      throw new Error("ADAPTIVE_NOT_ALLOWED:仅支持作品页主评论事务。");
    }
    if (!allowedStates.includes(operation.state)) {
      throw new Error(
        `ADAPTIVE_NOT_READY:state=${operation.state};allowed=${allowedStates.join(",")}`,
      );
    }
    if (operation.actorAccount !== loadActionSettings().operator.displayName) {
      throw new Error("ACCOUNT_MISMATCH:冻结事务账号不是当前 operator。");
    }
    return operation;
  }

  private async openFrozenAdaptiveRootComposer(operation: WriteOperationRecord) {
    const target = await this.openFrozenRootCommentCleanTarget(operation);
    await this.assertOperatorAccount(target.page);
    await this.assertWorkContext(target.page, target.context);
    if (target.author !== operation.gateSnapshot.targetWorkAuthor) {
      throw new Error(
        `ADAPTIVE_TARGET_MISMATCH:author=${target.author},expected=${operation.gateSnapshot.targetWorkAuthor}`,
      );
    }
    const composer = await this.openVerifiedRootCommentComposer(
      target.page,
      operation.workId,
    );
    return { ...target, ...composer };
  }

  private async adaptiveComposerText(editor: Locator): Promise<string | null> {
    return editor.evaluate(element => {
      const node = element as HTMLElement & { value?: string };
      return typeof node.value === "string"
        ? node.value
        : node.innerText ?? node.textContent ?? "";
    }).catch(() => null);
  }

  private async fillFrozenAdaptiveComposer(
    page: Page,
    editor: Locator,
    operation: WriteOperationRecord,
    strategy: "fill" | "keyboard" | "react_events",
  ): Promise<{
    beforeText: string | null;
    afterText: string | null;
    textHashMatched: boolean;
    normalizedTextMatched: boolean;
  }> {
    const beforeText = await this.adaptiveComposerText(editor);
    await editor.scrollIntoViewIfNeeded();
    await editor.click();
    if (strategy === "keyboard") {
      await editor.press("Control+A");
      await editor.press("Backspace");
      await page.keyboard.insertText(operation.writeText);
    } else {
      if (strategy === "react_events") {
        await editor.evaluate((element, text) => {
          element.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }));
        }, operation.writeText);
      }
      await editor.fill(operation.writeText);
      if (strategy === "react_events") {
        await editor.evaluate((element, text) => {
          element.dispatchEvent(new CompositionEvent("compositionend", {
            bubbles: true,
            data: text,
          }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }, operation.writeText);
      }
    }
    await page.waitForTimeout(150);
    const afterText = await this.adaptiveComposerText(editor);
    const normalizedTextMatched = afterText != null
      && normalizeCreatorReplyText(afterText)
        === normalizeCreatorReplyText(operation.writeText);
    return {
      beforeText,
      afterText,
      textHashMatched: afterText != null && sha256(afterText) === operation.writeTextHash,
      normalizedTextMatched,
    };
  }

  private async inspectFrozenSubmitCandidate(
    send: Locator,
    editor: Locator,
  ): Promise<Record<string, unknown>> {
    return send.evaluate((element, input) => {
      const node = element as HTMLElement & { disabled?: boolean };
      const editorNode = input as HTMLElement;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const top = document.elementFromPoint(centerX, centerY) as HTMLElement | null;
      const pathFor = (item: HTMLElement | null): string | null => {
        if (!item) return null;
        const parts: string[] = [];
        let current: HTMLElement | null = item;
        while (current && parts.length < 10) {
          let part = current.tagName.toLowerCase();
          if (current.id) part += `#${current.id}`;
          if (current.classList.length) {
            part += `.${Array.from(current.classList).slice(0, 3).join(".")}`;
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(" > ");
      };
      const hint = [
        node.getAttribute("aria-busy"),
        node.getAttribute("data-loading"),
        node.getAttribute("data-state"),
        node.className,
      ].filter(Boolean).join(" ").toLowerCase();
      return {
        candidateIndex: 0,
        domPath: pathFor(node),
        role: node.getAttribute("role") ?? node.tagName.toLowerCase(),
        text: (node.innerText || node.textContent || "").trim(),
        ariaLabel: node.getAttribute("aria-label"),
        dataE2e: node.getAttribute("data-e2e"),
        disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true",
        loading: node.getAttribute("aria-busy") === "true"
          || /loading|submitting|pending/.test(hint),
        pointerEvents: style.pointerEvents,
        visible: style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && box.width > 0
          && box.height > 0,
        box: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        },
        obscured: Boolean(top
          && top !== node
          && !node.contains(top)),
        obscuredBy: top && top !== node && !node.contains(top) ? pathFor(top) : null,
        belongsToFrozenEditor: Boolean(
          node.closest(".comment-input-inner-container")
          && node.closest(".comment-input-inner-container")
            === editorNode.closest(".comment-input-inner-container"),
        ),
      };
    }, await editor.elementHandle()).catch(error => ({
      candidateIndex: 0,
      inspectionError: String(error),
    }));
  }

  private async exactRootCommentMatches(
    page: Page,
    operation: WriteOperationRecord,
  ): Promise<DouyinComment[]> {
    await this.loadComments(page, 100);
    const comments = await this.parseComments(page, 100, true, 100);
    return comments.flatMap(comment => [comment, ...(comment.replies ?? [])])
      .filter(comment =>
        comment.author === operation.actorAccount
        && comment.parentCommentId == null
        && normalizeCreatorReplyText(comment.text)
          === normalizeCreatorReplyText(operation.writeText));
  }

  private async exactRootCommentHashMatches(
    page: Page,
    operation: Pick<
      WriteOperationRecord,
      "actorAccount" | "workId" | "writeTextHash"
    >,
  ): Promise<DouyinComment[]> {
    const context = await this.captureWorkContext(page);
    if (context.workId !== operation.workId) {
      throw new Error(
        `ROOT_COMMENT_READBACK_WRONG_WORK:actual=${context.workId};`
        + `expected=${operation.workId}`,
      );
    }
    await this.loadComments(page, 100);
    const comments = await this.parseComments(page, 100, true, 100);
    return comments
      .filter(comment =>
        comment.parentCommentId == null
        && comment.workId === operation.workId
        && comment.author === operation.actorAccount
        && sha256(comment.text) === operation.writeTextHash);
  }

  async archiveUnresolvedCommentOperation(options: {
    operationId: string;
    reason: string;
    confirmArchive: boolean;
  }) {
    return this.serial(async () => {
      if (!options.confirmArchive) {
        throw new Error("CONFIRMATION_REQUIRED:confirm_archive=true");
      }
      const before = this.writeOperationStore.get(options.operationId);
      if (!before || before.actionType !== "create_root_comment") {
        throw new Error("ROOT_COMMENT_OPERATION_NOT_FOUND");
      }
      const archived = this.writeOperationStore.archiveUnresolved(
        options.operationId,
        options.reason.trim() || "operator_archived_without_success_guess",
      );
      return {
        operation_id: archived.operationId,
        previous_state: before.state,
        state: archived.state,
        resolution: archived.confirmationMethod,
        archived_at: archived.archivedAt,
        resulting_comment_id: archived.resultingCommentId,
        excluded_from_startup_recovery: true,
        retry_allowed: false,
        sent: false,
      };
    }, { persistPageState: false });
  }

  private async serverIdRootCommentMatches(
    page: Page,
    operation: Pick<
      WriteOperationRecord,
      "actorAccount" | "workId" | "resultingCommentId"
    >,
  ): Promise<DouyinComment[]> {
    if (!operation.resultingCommentId) return [];
    const context = await this.captureWorkContext(page);
    if (context.workId !== operation.workId) {
      throw new Error(
        "ROOT_COMMENT_READBACK_WRONG_WORK:actual=" + context.workId
        + ";expected=" + operation.workId,
      );
    }
    const direct = await page.evaluate(async ({ workId, commentId }) => {
      const endpoint = new URL("/aweme/v1/web/comment/list/", location.origin);
      for (const [key, value] of Object.entries({
        device_platform: "webapp",
        aid: "6383",
        channel: "channel_pc_web",
        aweme_id: workId,
        cursor: "0",
        count: "20",
        item_type: "0",
        insert_ids: commentId,
      })) endpoint.searchParams.set(key, value);
      const response = await fetch(endpoint, { credentials: "include", method: "GET" });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null) as any;
      if (!payload || Number(payload.status_code ?? -1) !== 0) return null;
      const candidate = Array.isArray(payload.comments)
        ? payload.comments.find((item: any) => String(item?.cid ?? "") === commentId)
        : null;
      if (!candidate
        || String(candidate.aweme_id ?? "") !== workId
        || !["", "0"].includes(String(candidate.reply_id ?? ""))
        || !["", "0"].includes(String(candidate.reply_to_reply_id ?? ""))) return null;
      return {
        commentId: String(candidate.cid),
        workId: String(candidate.aweme_id),
        author: String(candidate.user?.nickname ?? "").trim(),
        text: String(candidate.text ?? "").trim(),
        parentCommentId: null,
        rootCommentId: String(candidate.cid),
        depth: 0,
        threadPath: [String(candidate.cid)],
        replyCount: Number(candidate.reply_comment_total ?? 0),
        time: Number.isFinite(Number(candidate.create_time))
          ? new Date(Number(candidate.create_time) * 1_000).toISOString()
          : null,
        location: typeof candidate.ip_label === "string" ? candidate.ip_label : null,
        likeCount: String(candidate.digg_count ?? "0"),
        isAuthor: Boolean(candidate.is_author_digged),
        isPinned: Number(candidate.stick_position ?? 0) > 0,
      };
    }, {
      workId: operation.workId,
      commentId: operation.resultingCommentId,
    }).catch(() => null) as DouyinComment | null;
    if (direct
      && direct.author === operation.actorAccount
      && direct.commentId === operation.resultingCommentId) return [direct];
    await this.loadComments(page, 100);
    const comments = await this.parseComments(page, 100, true, 100);
    return comments
      .filter(comment =>
        comment.parentCommentId == null
        && comment.workId === operation.workId
        && comment.author === operation.actorAccount
        && comment.commentId === operation.resultingCommentId);
  }

  private async clearBrowserCacheForPage(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Network.enable");
      await session.send("Network.clearBrowserCache");
    } finally {
      await session.detach().catch(() => null);
    }
  }

  private async strictRootCommentReadbackUnlocked(
    operation: WriteOperationRecord,
  ): Promise<{
    confirmed: boolean;
    serverCommentId: string | null;
    cleanReloadCommentIds: string[];
    independentCommentIds: string[];
    cleanReloadVerified: boolean;
    independentSessionVerified: boolean;
    optimisticCacheBypassed: true;
    requestText: string;
    serverDisplayText: string | null;
    cleanReloadDisplayTexts: string[];
    independentDisplayTexts: string[];
    cleanTextMatch: ReturnType<typeof classifyPlatformCommentText> | null;
    independentTextMatch: ReturnType<typeof classifyPlatformCommentText> | null;
    confirmationMethod: WriteOperationRecord["confirmationMethod"];
  }> {
    const serverCommentId = operation.resultingCommentId;
    if (!serverCommentId) {
      return {
        confirmed: false,
        serverCommentId: null,
        cleanReloadCommentIds: [],
        independentCommentIds: [],
        cleanReloadVerified: false,
        independentSessionVerified: false,
        optimisticCacheBypassed: true,
        requestText: operation.requestText,
        serverDisplayText: null,
        cleanReloadDisplayTexts: [],
        independentDisplayTexts: [],
        cleanTextMatch: null,
        independentTextMatch: null,
        confirmationMethod: null,
      };
    }
    const clean = await this.openRootCommentCleanTarget({
      workId: operation.workId,
      workUrl: operation.gateSnapshot.verifiedUrl,
      expectedAuthor: operation.gateSnapshot.targetWorkAuthor,
    });
    await this.clearBrowserCacheForPage(clean.page);
    await clean.page.reload({
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await this.assertOperatorAccount(clean.page);
    const cleanMatches = await this.serverIdRootCommentMatches(
      clean.page,
      operation,
    ).catch(() => []);

    const primary = await this.connect();
    const context = primary.contexts()[0];
    if (!context) {
      throw new Error(
        "ROOT_COMMENT_READBACK_SESSION_MISSING:没有独立只读会话。",
      );
    }
    const readbackPage = await this.createAutomationPage(context, "transient:root_comment_readback");
    let independentMatches: DouyinComment[] = [];
    try {
      const url = new URL(operation.gateSnapshot.verifiedUrl);
      url.searchParams.set("codex_readback", String(Date.now()));
      await readbackPage.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      independentMatches = await this.serverIdRootCommentMatches(
        readbackPage,
        operation,
      ).catch(() => []);
    } finally {
      await readbackPage.close().catch(() => null);
    }

    const cleanIds = Array.from(new Set(
      cleanMatches.map(comment => comment.commentId).filter(Boolean),
    ));
    const independentIds = Array.from(new Set(
      independentMatches.map(comment => comment.commentId).filter(Boolean),
    ));
    const cleanReloadDisplayTexts = Array.from(new Set(cleanMatches.map(comment => comment.text)));
    const independentDisplayTexts = Array.from(new Set(independentMatches.map(comment => comment.text)));
    const cleanTextMatch = cleanReloadDisplayTexts.length === 1
      ? classifyPlatformCommentText(operation.requestText, cleanReloadDisplayTexts[0])
      : null;
    const independentTextMatch = independentDisplayTexts.length === 1
      ? classifyPlatformCommentText(operation.requestText, independentDisplayTexts[0])
      : null;
    const cleanReloadVerified = Boolean(
      serverCommentId
      && cleanIds.length === 1
      && cleanIds[0] === serverCommentId,
    );
    const independentSessionVerified = Boolean(
      serverCommentId
      && independentIds.length === 1
      && independentIds[0] === serverCommentId,
    );
    const confirmationMethod: WriteOperationRecord["confirmationMethod"] =
      cleanReloadVerified && independentSessionVerified
        && (cleanTextMatch === "platform_normalized"
          || independentTextMatch === "platform_normalized")
        ? "confirmed_with_platform_normalization"
        : cleanReloadVerified && independentSessionVerified
          ? "confirmed_by_server_id"
          : null;
    return {
      confirmed: cleanReloadVerified && independentSessionVerified,
      serverCommentId,
      cleanReloadCommentIds: cleanIds,
      independentCommentIds: independentIds,
      cleanReloadVerified,
      independentSessionVerified,
      optimisticCacheBypassed: true,
      requestText: operation.requestText,
      serverDisplayText: independentDisplayTexts[0] ?? cleanReloadDisplayTexts[0] ?? null,
      cleanReloadDisplayTexts,
      independentDisplayTexts,
      cleanTextMatch,
      independentTextMatch,
      confirmationMethod,
    };
  }

  async readbackExactRootComment(options: {
    operationId: string;
    workId: string;
    author: string;
    exactTextHash: string;
  }) {
    return this.serial(async () => {
      let operation = this.writeOperationStore.get(options.operationId);
      if (!operation || operation.actionType !== "create_root_comment") {
        throw new Error(
          "ROOT_COMMENT_OPERATION_NOT_FOUND:"
          + "operation_id 不是持久化根评论事务。",
        );
      }
      if (operation.workId !== options.workId
        || operation.actorAccount !== options.author
        || operation.writeTextHash !== options.exactTextHash) {
        throw new Error(
          "ROOT_COMMENT_READBACK_TARGET_MISMATCH:"
          + "work_id、author 或 exact_text_hash 与冻结事务不一致。",
        );
      }
      const previousState = operation.state;
      const readback = await this.strictRootCommentReadbackUnlocked(operation);
      if (readback.confirmed && readback.serverCommentId) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "confirmed",
          confirmedAt: operation.confirmedAt ?? new Date().toISOString(),
          resultingCommentId: readback.serverCommentId,
          serverDisplayText: readback.serverDisplayText,
          confirmationMethod: readback.confirmationMethod,
          lastError: null,
        });
      } else if ([
        "click_started",
        "click_attempted",
        "click_effect_confirmed",
        "unknown_after_submit",
      ].includes(operation.state)) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          lastError: readback.serverCommentId
            ? "strict_readback_not_confirmed"
            : "server_comment_id_missing",
        });
      }
      const classification: RootCommentSubmitClassification =
        operation.state === "confirmed"
          ? "confirmed"
          : "unknown_after_submit";
      const step = await this.recordAdaptiveStep(
        (await this.rootCommentPage(false)).page,
        operation,
        readback.confirmed
          ? "reconcile_confirmed_by_server_id"
          : "strict_root_comment_readback",
        null,
        classification,
        {
          ...readback,
          exactTextHash: operation.writeTextHash,
          author: operation.actorAccount,
          workId: operation.workId,
          confirmationMethod: readback.confirmationMethod,
          serverCommentId: readback.serverCommentId,
          actor: operation.actorAccount,
          requestText: operation.requestText,
          serverDisplayText: readback.serverDisplayText,
          cleanSessionEvidence: {
            verified: readback.cleanReloadVerified,
            commentIds: readback.cleanReloadCommentIds,
            displayTexts: readback.cleanReloadDisplayTexts,
            textMatch: readback.cleanTextMatch,
          },
          independentSessionEvidence: {
            verified: readback.independentSessionVerified,
            commentIds: readback.independentCommentIds,
            displayTexts: readback.independentDisplayTexts,
            textMatch: readback.independentTextMatch,
          },
          confirmedAt: operation.confirmedAt,
          previousState,
          newState: operation.state,
        },
      );
      return {
        ...this.committedPostWriteResult(operation),
        classification,
        readback,
        auditStep: step,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async recordAdaptiveStep(
    page: Page,
    operation: WriteOperationRecord,
    action: string,
    strategy: string | null,
    result: string,
    evidence: Record<string, unknown>,
  ) {
    const artifact = await this.saveCommentArtifact(
      page,
      `adaptive-${action}-${result}`,
      {
        operationId: operation.operationId,
        state: operation.state,
        strategy,
        evidence,
      },
    ).catch(() => ({ screenshotPath: null, diagnosticsPath: null }));
    return this.writeOperationStore.appendAdaptiveStep({
      operationId: operation.operationId,
      action,
      strategy,
      result,
      evidence,
      screenshotPath: artifact.screenshotPath,
      diagnosticsPath: artifact.diagnosticsPath,
    });
  }

  private async previewCommentOnPostUnlocked(
    tokenOrOperationId: string,
    strategy: "fill" | "keyboard" | "react_events" = "react_events",
  ) {
    const operation = this.requireAdaptiveRootOperation(
      tokenOrOperationId,
      ["prepared"],
    );
    const live = await this.openFrozenAdaptiveRootComposer(operation);
    const fill = await this.fillFrozenAdaptiveComposer(
      live.page,
      live.editor,
      operation,
      strategy,
    );
    if (!fill.normalizedTextMatched) {
      throw new Error(
        "PREVIEW_FILL_FAILED:冻结文案未能稳定写入唯一可见主评论 composer。",
      );
    }
    const submitCandidate = await this.inspectFrozenSubmitCandidate(
      live.send,
      live.editor,
    );
    const step = await this.recordAdaptiveStep(
      live.page,
      operation,
      "preview_fill",
      strategy,
      "verified",
      {
        fill,
        submitCandidate,
        sent: false,
      },
    );
    return {
      operationId: operation.operationId,
      operation_id: operation.operationId,
      state: operation.state,
      workId: operation.workId,
      scope: operation.scope,
      actorAccount: operation.actorAccount,
      textHash: operation.writeTextHash,
      composerFilled: true,
      composerVerified: true,
      fillStrategy: strategy,
      fill,
      submitCandidate,
      auditStep: step,
      sent: false,
    };
  }

  async previewCommentOnPost(
    tokenOrOperationId: string,
    strategy: "fill" | "keyboard" | "react_events" = "react_events",
  ) {
    return this.serial(
      () => this.previewCommentOnPostUnlocked(tokenOrOperationId, strategy),
      { restoreOnError: false, persistPageState: false },
    );
  }

  async adaptiveInspectCommentComposer(operationId: string) {
    return this.serial(async () => {
      const operation = this.requireAdaptiveRootOperation(operationId, [
        "click_no_effect",
        "click_attempted",
        "click_effect_confirmed",
        "unknown_after_submit",
        "confirmed",
      ]);
      const live = await this.openFrozenAdaptiveRootComposer(operation);
      const composerText = await this.adaptiveComposerText(live.editor);
      const submitCandidate = await this.inspectFrozenSubmitCandidate(
        live.send,
        live.editor,
      );
      const result = {
        operationId: operation.operationId,
        state: operation.state,
        workId: operation.workId,
        scope: operation.scope,
        actorAccount: operation.actorAccount,
        frozenTextHash: operation.writeTextHash,
        composerText,
        composerTextHash: composerText == null ? null : sha256(composerText),
        composerTextMatched: composerText != null
          && normalizeCreatorReplyText(composerText)
            === normalizeCreatorReplyText(operation.writeText),
        submitCandidate,
        clickAttemptCount: operation.clickAttemptCount,
        maxSubmitAttempts: ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
        adaptiveReady: operation.state === "click_no_effect"
          && !operation.clickEffectConfirmedAt
          && !operation.submitResponseSeenAt
          && !operation.composerClearedAt
          && !operation.resultingCommentId
          && operation.clickAttemptCount < ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
        sent: operation.state === "confirmed",
      };
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        "inspect_composer",
        null,
        "observed",
        result,
      );
      return { ...result, auditStep: step };
    }, { restoreOnError: false, persistPageState: false });
  }

  async adaptiveClearAndFillComment(
    operationId: string,
    strategy: "fill" | "keyboard" | "react_events",
  ) {
    return this.serial(async () => {
      const operation = this.requireAdaptiveRootOperation(
        operationId,
        ["click_no_effect"],
      );
      if (operation.clickEffectConfirmedAt
        || operation.submitResponseSeenAt
        || operation.composerClearedAt
        || operation.resultingCommentId) {
        throw new Error("ADAPTIVE_UNSAFE:已有可能提交效果，只能只读回查。");
      }
      const live = await this.openFrozenAdaptiveRootComposer(operation);
      const fill = await this.fillFrozenAdaptiveComposer(
        live.page,
        live.editor,
        operation,
        strategy,
      );
      if (!fill.normalizedTextMatched) {
        throw new Error("ADAPTIVE_FILL_FAILED:写入后冻结文案回读不一致。");
      }
      const submitCandidate = await this.inspectFrozenSubmitCandidate(
        live.send,
        live.editor,
      );
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        "clear_and_fill",
        strategy,
        "verified",
        { fill, submitCandidate, sent: false },
      );
      return {
        operationId: operation.operationId,
        state: operation.state,
        textHash: operation.writeTextHash,
        fill,
        submitCandidate,
        adaptiveReady: true,
        sent: false,
        auditStep: step,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async adaptiveInspectSubmitCandidates(operationId: string) {
    return this.serial(async () => {
      const operation = this.requireAdaptiveRootOperation(operationId, [
        "click_no_effect",
        "click_attempted",
        "click_effect_confirmed",
        "unknown_after_submit",
        "confirmed",
      ]);
      const live = await this.openFrozenAdaptiveRootComposer(operation);
      const candidate = await this.inspectFrozenSubmitCandidate(
        live.send,
        live.editor,
      );
      const composerText = await this.adaptiveComposerText(live.editor);
      const result = {
        operationId: operation.operationId,
        state: operation.state,
        candidates: [candidate],
        selectedCandidateIndex: 0,
        composerTextMatched: composerText != null
          && normalizeCreatorReplyText(composerText)
            === normalizeCreatorReplyText(operation.writeText),
        sent: operation.state === "confirmed",
      };
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        "inspect_submit_candidates",
        null,
        "observed",
        result,
      );
      return { ...result, auditStep: step };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async executeAdaptiveSubmit(
    operationId: string,
    action: "click_submit_candidate" | "press_submit_key",
    strategy: string,
    perform: (page: Page, editor: Locator, send: Locator) => Promise<void>,
  ) {
    const before = this.requireAdaptiveRootOperation(operationId, ["click_no_effect"]);
    if (before.clickEffectConfirmedAt
      || before.submitResponseSeenAt
      || before.composerClearedAt
      || before.resultingCommentId) {
      throw new Error("ADAPTIVE_UNSAFE:已有可能提交效果，只能只读回查。");
    }
    const live = await this.openFrozenAdaptiveRootComposer(before);
    const composerTextBefore = await this.adaptiveComposerText(live.editor);
    if (composerTextBefore == null
      || normalizeCreatorReplyText(composerTextBefore)
        !== normalizeCreatorReplyText(before.writeText)) {
      throw new Error(
        "ADAPTIVE_NOT_READY:composer 文案与冻结文本不一致，请先调用 clear_and_fill_comment。",
      );
    }
    const submitCandidateBefore = await this.inspectFrozenSubmitCandidate(
      live.send,
      live.editor,
    );
    if (submitCandidateBefore.belongsToFrozenEditor !== true) {
      throw new Error("ADAPTIVE_CANDIDATE_MISMATCH:发送候选不属于冻结 composer。");
    }
    const preexisting = await this.exactRootCommentHashMatches(
      live.page,
      before,
    );
    if (preexisting.length > 0) {
      const unknown = this.writeOperationStore.update(before.token, {
        state: "unknown_after_submit",
        lastError: "adaptive_precheck_exact_comment_without_server_receipt",
      });
      const step = await this.recordAdaptiveStep(
        live.page,
        unknown,
        action,
        strategy,
        "unknown_after_submit",
        {
          exactMatchCount: preexisting.length,
          interactionPerformed: false,
          reason: "same_page_match_cannot_prove_server_acceptance",
        },
      );
      return {
        ...this.committedPostWriteResult(unknown),
        strategy,
        interactionPerformed: false,
        retryAllowed: false,
        auditStep: step,
      };
    }

    let operation = this.writeOperationStore.beginAdaptiveAttempt(
      before.token,
      strategy,
      ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
    );
    const requestSignals: Array<{ path: string; seenAt: string }> = [];
    const responseTasks: Array<Promise<SanitizedRootCommentResponse>> = [];
    const isSubmitSignal = (urlValue: string, method: string): string | null => {
      try {
        const url = new URL(urlValue);
        return method.toUpperCase() === "POST"
          && /comment|reply/iu.test(url.pathname)
          ? url.pathname
          : null;
      } catch {
        return null;
      }
    };
    const onRequest = (request: { url(): string; method(): string }) => {
      const pathName = isSubmitSignal(request.url(), request.method());
      if (pathName) requestSignals.push({
        path: pathName,
        seenAt: new Date().toISOString(),
      });
    };
    const onResponse = (response: PlaywrightResponse) => {
      const pathName = isSubmitSignal(
        response.url(),
        response.request().method(),
      );
      if (!pathName) return;
      responseTasks.push((async () => {
        const body = await response.json().catch(() => null);
        return sanitizeRootCommentResponse({
          endpoint: pathName,
          httpStatus: response.status(),
          body,
        });
      })());
    };
    const beforeToasts = new Set(await live.page.locator(
      "[role='alert']:visible,[class*='toast']:visible,[class*='message']:visible",
    ).allTextContents().catch(() => []));
    live.page.on("request", onRequest);
    live.page.on("response", onResponse);
    let interactionError: string | null = null;
    try {
      await perform(live.page, live.editor, live.send);
    } catch (error) {
      interactionError = String(error);
    }

    let composerText: string | null = null;
    let composerCleared = false;
    let buttonLoading = false;
    let buttonDisabledTransition = false;
    let submitCandidateAfter: Record<string, unknown> = submitCandidateBefore;
    let exactMatches: DouyinComment[] = [];
    let newToastTexts: string[] = [];
    const settleIterations = Math.max(
      1,
      Math.ceil(ADAPTIVE_COMMENT_SETTLE_MS / 150),
    );
    for (let attempt = 0; attempt < settleIterations; attempt += 1) {
      await live.page.waitForTimeout(150);
      composerText = await this.adaptiveComposerText(live.editor);
      composerCleared = composerText != null
        && normalizeCreatorReplyText(composerText).length === 0;
      const candidate = await this.inspectFrozenSubmitCandidate(
        live.send,
        live.editor,
      );
      submitCandidateAfter = candidate;
      buttonLoading = candidate.loading === true;
      buttonDisabledTransition = submitCandidateBefore.disabled === false
        && candidate.disabled === true;
      exactMatches = await this.exactRootCommentHashMatches(live.page, before)
        .catch(() => []);
      const currentToasts = await live.page.locator(
        "[role='alert']:visible,[class*='toast']:visible,[class*='message']:visible",
      ).allTextContents().catch(() => []);
      newToastTexts = currentToasts.filter(text =>
        text.trim() && !beforeToasts.has(text));
      if (requestSignals.length
        || responseTasks.length
        || composerCleared
        || buttonLoading
        || buttonDisabledTransition
        || exactMatches.length
        || newToastTexts.length) {
        break;
      }
    }
    live.page.off("request", onRequest);
    live.page.off("response", onResponse);
    const responseSignals = await Promise.all(responseTasks);

    const textStillPresent = composerText != null
      && normalizeCreatorReplyText(composerText)
        === normalizeCreatorReplyText(before.writeText);
    const submitDecision = classifyAdaptiveSubmitEvidence({
      requestSignalCount: requestSignals.length,
      responseSignalCount: responseSignals.length,
      composerCleared,
      composerTextReadable: composerText != null,
      composerTextMatched: textStillPresent,
      buttonLoading,
      buttonDisabledTransition,
      newToastCount: newToastTexts.length,
      exactMatchCount: exactMatches.length,
    });
    const rootClassification = classifyRootCommentSubmit({
      responses: responseSignals,
      requestSeen: requestSignals.length > 0,
      composerCleared,
      composerTextReadable: composerText != null,
      composerTextMatched: textStillPresent,
      optimisticDomMatch: exactMatches.length > 0,
    });
    const evidence = {
      requestSignals,
      responseSignals,
      composerCleared,
      composerTextHash: composerText == null ? null : sha256(composerText),
      textStillPresent,
      buttonLoading,
      buttonDisabledTransition,
      submitCandidateBefore,
      submitCandidateAfter,
      newToastTexts,
      exactMatchCount: exactMatches.length,
      interactionError,
      attemptCount: operation.clickAttemptCount,
      submitDecision,
      rootClassification,
    };

    if (submitDecision === "no_effect") {
      operation = this.writeOperationStore.markClickNoEffect(
        operation.token,
        `adaptive_no_effect:${strategy}${interactionError ? `:${interactionError}` : ""}`,
      );
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        action,
        strategy,
        "click_no_effect",
        evidence,
      );
      return {
        ...this.committedPostWriteResult(operation),
        strategy,
        interactionPerformed: true,
        retryAllowed:
          operation.clickAttemptCount < ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
        maxSubmitAttempts: ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
        evidence,
        auditStep: step,
      };
    }

    if (submitDecision === "uncertain") {
      operation = this.writeOperationStore.update(operation.token, {
        state: "unknown_after_submit",
        lastError: "adaptive_interaction_composer_unverifiable",
      });
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        action,
        strategy,
        "unknown_after_submit",
        evidence,
      );
      return {
        ...this.committedPostWriteResult(operation),
        strategy,
        interactionPerformed: true,
        retryAllowed: false,
        evidence,
        auditStep: step,
      };
    }

    const responseCommentIds = Array.from(new Set(
      responseSignals.map(response => response.commentId).filter(
        (value): value is string => Boolean(value),
      ),
    ));
    const serverCommentId = responseCommentIds.length === 1
      ? responseCommentIds[0]
      : null;
    let strictReadback: Awaited<
      ReturnType<DouyinBrowser["strictRootCommentReadbackUnlocked"]>
    > | null = null;
    if (!serverCommentId) {
      operation = this.writeOperationStore.update(operation.token, {
        state: "unknown_after_submit",
        submitResponseSeenAt: responseSignals.length
          ? new Date().toISOString()
          : operation.submitResponseSeenAt,
        composerClearedAt: composerCleared
          ? new Date().toISOString()
          : operation.composerClearedAt,
        lastError: responseCommentIds.length > 1
          ? "adaptive_multiple_server_comment_ids"
          : rootClassification,
      });
    } else {
      operation = this.writeOperationStore.markClickEffectConfirmed(
        operation.token,
        {
          submitResponseSeenAt: new Date().toISOString(),
          composerClearedAt: composerCleared
            ? new Date().toISOString()
            : null,
        },
      );
      operation = this.writeOperationStore.update(operation.token, {
        resultingCommentId: serverCommentId,
        lastError: "awaiting_strict_cross_session_readback",
      });
      strictReadback = await this.strictRootCommentReadbackUnlocked(operation)
        .catch(() => null);
      if (strictReadback?.confirmed) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "confirmed",
          confirmedAt: operation.confirmedAt ?? new Date().toISOString(),
          resultingCommentId: serverCommentId,
          serverDisplayText: strictReadback.serverDisplayText,
          confirmationMethod: strictReadback.confirmationMethod,
          lastError: null,
        });
      } else {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          lastError: "adaptive_strict_readback_not_confirmed",
        });
      }
    }
    const finalEvidence = {
      ...evidence,
      exactMatchCount: exactMatches.length,
      responseCommentIds,
      serverCommentId,
      strictReadback,
      resultingCommentId: operation.resultingCommentId,
    };
    const step = await this.recordAdaptiveStep(
      live.page,
      operation,
      action,
      strategy,
      operation.state,
      finalEvidence,
    );
    return {
      ...this.committedPostWriteResult(operation),
      strategy,
      interactionPerformed: true,
      retryAllowed: false,
      maxSubmitAttempts: ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
      evidence: finalEvidence,
      auditStep: step,
    };
  }

  async adaptiveClickSubmitCandidate(options: {
    operationId: string;
    candidateIndex: number;
    method: "normal" | "coordinate";
    confirmSubmit: boolean;
  }) {
    return this.serial(async () => {
      if (!options.confirmSubmit) {
        throw new Error("CONFIRMATION_REQUIRED:必须提供 confirm_submit=true。");
      }
      if (options.candidateIndex !== 0) {
        throw new Error("ADAPTIVE_CANDIDATE_MISMATCH:仅允许唯一已验证候选 0。");
      }
      return this.executeAdaptiveSubmit(
        options.operationId,
        "click_submit_candidate",
        options.method,
        async (page, _editor, send) => {
          await send.scrollIntoViewIfNeeded();
          if (options.method === "normal") {
            await send.click({ timeout: 3_000 });
            return;
          }
          const box = await send.boundingBox();
          if (!box || box.width <= 0 || box.height <= 0) {
            throw new Error("ADAPTIVE_CLICK_FAILED:发送候选没有有效坐标。");
          }
          await page.mouse.click(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
        },
      );
    }, { restoreOnError: false, persistPageState: false });
  }

  async adaptivePressCommentSubmitKey(options: {
    operationId: string;
    key: "Enter" | "Control+Enter";
    confirmSubmit: boolean;
  }) {
    return this.serial(async () => {
      if (!options.confirmSubmit) {
        throw new Error("CONFIRMATION_REQUIRED:必须提供 confirm_submit=true。");
      }
      return this.executeAdaptiveSubmit(
        options.operationId,
        "press_submit_key",
        options.key,
        async (_page, editor) => {
          await editor.focus();
          const focused = await editor.evaluate(element =>
            document.activeElement === element || element.contains(document.activeElement));
          if (!focused) throw new Error("ADAPTIVE_KEY_REJECTED:焦点不在冻结 composer。");
          await editor.press(options.key);
        },
      );
    }, { restoreOnError: false, persistPageState: false });
  }

  async adaptiveReadbackExactRootComment(
    operationId: string,
    settleMs = 0,
  ) {
    return this.serial(async () => {
      let operation = this.requireAdaptiveRootOperation(operationId, [
        "click_no_effect",
        "click_attempted",
        "click_effect_confirmed",
        "unknown_after_submit",
        "confirmed",
      ]);
      const previousState = operation.state;
      const live = await this.openRootCommentCleanTarget({
        workId: operation.workId,
        workUrl: operation.gateSnapshot.verifiedUrl,
        expectedAuthor: operation.gateSnapshot.targetWorkAuthor,
      });
      if (settleMs > 0) await live.page.waitForTimeout(settleMs);
      const readback = await this.strictRootCommentReadbackUnlocked(operation);
      if (readback.confirmed && readback.serverCommentId) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "confirmed",
          confirmedAt: operation.confirmedAt ?? new Date().toISOString(),
          resultingCommentId: readback.serverCommentId,
          serverDisplayText: readback.serverDisplayText,
          confirmationMethod: readback.confirmationMethod,
          lastError: null,
        });
      } else if (operation.state === "click_attempted"
        || operation.state === "click_effect_confirmed"
        || operation.state === "unknown_after_submit") {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          lastError: readback.serverCommentId
            ? "adaptive_strict_readback_not_confirmed"
            : "adaptive_server_comment_id_missing",
        });
      }
      const evidence = {
        readback,
        resultingCommentId: operation.resultingCommentId,
        settleMs,
        confirmationMethod: readback.confirmationMethod,
        workId: operation.workId,
        serverCommentId: readback.serverCommentId,
        actor: operation.actorAccount,
        requestText: operation.requestText,
        serverDisplayText: readback.serverDisplayText,
        cleanSessionEvidence: {
          verified: readback.cleanReloadVerified,
          commentIds: readback.cleanReloadCommentIds,
          displayTexts: readback.cleanReloadDisplayTexts,
          textMatch: readback.cleanTextMatch,
        },
        independentSessionEvidence: {
          verified: readback.independentSessionVerified,
          commentIds: readback.independentCommentIds,
          displayTexts: readback.independentDisplayTexts,
          textMatch: readback.independentTextMatch,
        },
        confirmedAt: operation.confirmedAt,
        previousState,
        newState: operation.state,
      };
      const step = await this.recordAdaptiveStep(
        live.page,
        operation,
        readback.confirmed
          ? "reconcile_confirmed_by_server_id"
          : "readback_exact_root_comment",
        null,
        operation.state,
        evidence,
      );
      return {
        ...this.committedPostWriteResult(operation),
        exactMatchCount: readback.cleanReloadCommentIds.length,
        retryAllowed: operation.state === "click_no_effect"
          && operation.clickAttemptCount < ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
        evidence,
        auditStep: step,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async adaptiveObserveSubmitEffect(operationId: string, settleMs: number) {
    return this.adaptiveReadbackExactRootComment(operationId, settleMs);
  }

  async adaptiveGetAudit(operationId: string) {
    const operation = this.writeOperationStore.get(operationId);
    if (!operation) throw new Error("WRITE_OPERATION_NOT_FOUND:operation_id 不存在。");
    return {
      operationId: operation.operationId,
      state: operation.state,
      clickAttemptCount: operation.clickAttemptCount,
      maxSubmitAttempts: ADAPTIVE_COMMENT_MAX_SUBMIT_ATTEMPTS,
      steps: this.writeOperationStore.listAdaptiveSteps(operation.operationId),
      sent: operation.state === "confirmed",
    };
  }

  private async ensureCommentIdLoaded(
    page: Page,
    commentId: string,
    expectedRootCommentId: string | null = null,
  ): Promise<void> {
    await this.ensureVisibleCommentSurface(page);
    const selectorFor = (id: string) =>
      `[data-e2e='comment-item'][data-comment-id='${id}'],`
      + `[data-e2e='comment-item']:has([id*='${id}'])`;
    const findUnique = async (id: string): Promise<Locator | null> => {
      const locator = page.locator(selectorFor(id));
      const count = await locator.count();
      if (count !== 1) return null;
      await locator.scrollIntoViewIfNeeded().catch(() => null);
      return locator;
    };
    const scanFor = async (id: string): Promise<Locator | null> => {
      const existing = await findUnique(id);
      if (existing) return existing;
      await page.evaluate(() => {
        const rendered = (element: HTMLElement): boolean => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0"
            && box.width > 0
            && box.height > 0;
        };
        const route = document.querySelector<HTMLElement>(".route-scroll-container");
        const list = Array.from(document.querySelectorAll<HTMLElement>(
          "[data-e2e='comment-list']",
        )).find(rendered) ?? null;
        if (route && list) {
          route.scrollTop = Math.max(
            0,
            list.getBoundingClientRect().top + route.scrollTop - 100,
          );
          route.dispatchEvent(new Event("scroll", { bubbles: true }));
        } else if (list) {
          list.scrollIntoView({ block: "start" });
        }
      });
      await page.waitForTimeout(250);
      let stagnant = 0;
      let previousTop = -1;
      let previousHeight = -1;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const found = await findUnique(id);
        if (found) return found;
        const state = await page.evaluate(() => {
          const rendered = (element: HTMLElement): boolean => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0"
              && box.width > 0
              && box.height > 0;
          };
          const route = document.querySelector<HTMLElement>(".route-scroll-container");
          const list = Array.from(document.querySelectorAll<HTMLElement>(
            "[data-e2e='comment-list']",
          )).find(rendered) ?? null;
          const loading = Boolean(list && /加载中|正在加载/.test(list.innerText));
          if (route) {
            const before = route.scrollTop;
            route.scrollTop = Math.min(
              route.scrollHeight,
              before + Math.max(420, route.clientHeight * 0.72),
            );
            route.dispatchEvent(new Event("scroll", { bubbles: true }));
            return {
              before,
              after: route.scrollTop,
              height: route.scrollHeight,
              loading,
            };
          }
          if (list) {
            const before = list.scrollTop;
            list.scrollTop = Math.min(
              list.scrollHeight,
              before + Math.max(420, list.clientHeight * 0.72),
            );
            list.dispatchEvent(new Event("scroll", { bubbles: true }));
            return {
              before,
              after: list.scrollTop,
              height: list.scrollHeight,
              loading,
            };
          }
          window.scrollBy({ top: 500 });
          return {
            before: window.scrollY - 500,
            after: window.scrollY,
            height: document.documentElement.scrollHeight,
            loading,
          };
        });
        if (state.after === previousTop && state.height === previousHeight && !state.loading) {
          stagnant += 1;
        } else {
          stagnant = 0;
        }
        previousTop = state.after;
        previousHeight = state.height;
        if (stagnant >= 4) break;
        await page.waitForTimeout(state.loading ? 450 : 250);
      }
      return findUnique(id);
    };

    const rootId = expectedRootCommentId || commentId;
    const root = await scanFor(rootId);
    if (!root) {
      throw new Error(
        `TARGET_COMMENT_NOT_VERIFIED:comment_id=${commentId} 定向扫描后仍未找到根评论 ${rootId}。`,
      );
    }
    if (rootId !== commentId) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const target = await findUnique(commentId);
        if (target) return;
        const expand = root.locator(".comment-reply-expand-btn:visible");
        if (await expand.count() === 1) {
          await expand.click({ timeout: 3_000 }).catch(() => null);
        }
        await page.waitForTimeout(300);
      }
    }
    const target = await findUnique(commentId);
    if (!target) {
      throw new Error(
        `TARGET_COMMENT_NOT_VERIFIED:comment_id=${commentId} 定向扫描后仍未唯一出现。`,
      );
    }
  }

  private async createScopedTargetGate(input: {
    scope: TargetWriteScope;
    actionType: "create_root_comment" | "reply_to_comment" | "like_comment" | "unlike_comment";
    workId: string;
    commentId?: string | null;
    alias?: string;
    expectedRootCommentId?: string | null;
  }): Promise<{
    gate: TargetWriteGate;
    page: Page;
    context: WorkContext;
    workAuthor: string;
    workTitle: string | null;
    targetComment: DouyinComment | null;
    rootComment: DouyinComment | null;
  }> {
    const target = await this.pageForTargetWriteScope(
      input.scope,
      input.workId,
      input.alias,
    );
    await this.assertOperatorAccount(target.page);
    await this.assertWorkContext(target.page, target.context);
    let targetComment: DouyinComment | null = null;
    let rootComment: DouyinComment | null = null;
    if (input.commentId) {
      await this.ensureCommentIdLoaded(
        target.page,
        input.commentId,
        input.expectedRootCommentId ?? null,
      );
      const comments = await this.parseComments(target.page, 500, true, 500);
      const matches = comments
        .flatMap(comment => [comment, ...(comment.replies ?? [])])
        .filter(comment => comment.commentId === input.commentId);
      if (matches.length !== 1 || !matches[0].commentId || !matches[0].text) {
        throw new Error(
          `TARGET_COMMENT_NOT_VERIFIED:comment_id=${input.commentId} 无法由稳定 React/DOM 数据唯一互证。`,
        );
      }
      targetComment = matches[0];
      rootComment = comments.find(comment => comment.commentId === targetComment?.rootCommentId)
        ?? null;
      if (!rootComment) {
        throw new Error("TARGET_COMMENT_NOT_VERIFIED:无法恢复目标评论的根线程。");
      }
    }
    const gate = createTargetWriteGate({
      scope: input.scope,
      actionType: input.actionType,
      actorAccount: loadActionSettings().operator.displayName,
      pageRole: target.pageRole,
      pageTargetId: await this.pageTargetId(target.page),
      targetWorkId: input.workId,
      targetWorkAuthor: target.author,
      targetCommentId: targetComment?.commentId ?? null,
      parentCommentId: targetComment?.parentCommentId ?? null,
      rootCommentId: targetComment?.rootCommentId ?? null,
      targetTextHash: targetComment ? sha256(targetComment.text) : null,
      verifiedUrl: target.page.url(),
      commentVerified: input.commentId ? Boolean(targetComment) : true,
      alias: input.alias ?? null,
    });
    return {
      gate,
      page: target.page,
      context: target.context,
      workAuthor: target.author,
      workTitle: target.title,
      targetComment,
      rootComment,
    };
  }

  private preparedPostWriteResult(
    operation: WriteOperationRecord,
    workAuthor: string,
  ): PreparedPostWriteResult {
    return {
      token: operation.token,
      operationId: operation.operationId,
      operation_id: operation.operationId,
      status: operation.state === "confirmed"
        ? "already_confirmed"
        : operation.state === "prepared"
          ? "prepared"
          : "blocked",
      scope: operation.scope,
      actionType: operation.actionType,
      workId: operation.workId,
      workTitle: operation.workTitle,
      workAuthor,
      commentId: operation.commentId,
      commentAuthor: operation.targetAuthor,
      originalText: operation.targetText,
      parentCommentId: operation.parentCommentId,
      rootCommentId: operation.rootCommentId,
      threadPath: operation.threadPath,
      writeText: operation.writeText,
      exactTextHash: operation.writeTextHash,
      composerFilled: false,
      previewRequired: true,
      targetGate: operation.gateSnapshot,
      expiresAt: operation.expiresAt,
    };
  }

  private committedPostWriteResult(
    operation: WriteOperationRecord,
    alreadyConfirmed = false,
  ): CommittedPostWriteResult {
    const status: CommittedPostWriteResult["status"] =
      operation.state === "confirmed"
        ? "confirmed"
        : operation.state === "prepared"
          ? "prepared"
          : operation.state === "click_no_effect"
            ? "click_no_effect"
            : operation.state === "aborted_no_submit"
              ? "aborted_no_submit"
              : operation.state === "click_started"
                || operation.state === "click_attempted"
                || operation.state === "click_effect_confirmed"
                || operation.state === "unknown_after_submit"
            ? "unknown_after_submit"
            : "blocked";
    return {
      token: operation.token,
      operationId: operation.operationId,
      operation_id: operation.operationId,
      status,
      operationState: operation.state,
      resultCode: alreadyConfirmed && operation.state === "confirmed"
        ? "already_confirmed"
        : status,
      scope: operation.scope,
      actionType: operation.actionType,
      workId: operation.workId,
      commentId: operation.commentId,
      writeText: operation.writeText,
      sent: operation.state === "confirmed",
      deliveryConfirmed: operation.state === "confirmed"
        && Boolean(operation.resultingCommentId),
      uncertainAfterSubmit: status === "unknown_after_submit",
      clicked: Boolean(operation.clickEffectConfirmedAt),
      clickAttempted: Boolean(operation.clickAttemptedAt),
      clickEffectConfirmed: Boolean(operation.clickEffectConfirmedAt),
      clickAttemptedAt: operation.clickAttemptedAt,
      clickEffectConfirmedAt: operation.clickEffectConfirmedAt,
      submitResponseSeenAt: operation.submitResponseSeenAt,
      composerClearedAt: operation.composerClearedAt,
      resultingCommentId: operation.resultingCommentId,
      requestText: operation.requestText,
      serverDisplayText: operation.serverDisplayText,
      confirmationMethod: operation.confirmationMethod,
      archivedAt: operation.archivedAt,
      expiresAt: operation.expiresAt,
      lastError: operation.lastError,
    };
  }

  async prepareCommentOnPost(options: {
    workId: string;
    text: string;
    scope: TargetWriteScope;
    alias?: string;
  }): Promise<PreparedPostWriteResult> {
    return this.serial(async () => {
      assertWriteReady();
      const text = options.text.trim();
      if (!text || text.length > 500) throw new Error("VALIDATION_FAILED:评论必须是 1-500 个字符。");
      const target = await this.createScopedRootCommentGate({
        scope: options.scope,
        workId: options.workId,
        alias: options.alias,
      });
      await this.loadComments(target.page, 100);
      const existing = await this.parseComments(target.page, 100, true, 100);
      if (existing.flatMap(comment => [comment, ...(comment.replies ?? [])])
        .some(comment => comment.author === loadActionSettings().operator.displayName
          && normalizeCreatorReplyText(comment.text) === normalizeCreatorReplyText(text))) {
        throw new Error("DUPLICATE_COMMENT:当前作品已存在 Operator 的相同评论。");
      }
      const operation = this.writeOperationStore.create({
        scope: options.scope,
        actionType: "create_root_comment",
        actorAccount: loadActionSettings().operator.displayName,
        pageRole: target.gate.pageRole,
        workId: options.workId,
        workTitle: target.workTitle,
        writeText: text,
        gateSnapshot: target.gate,
        expiresAt: target.gate.expiresAt,
      });
      return this.preparedPostWriteResult(operation, target.workAuthor);
    }, { restoreOnError: false });
  }

  async prepareReplyToComment(options: {
    workId: string;
    commentId: string;
    text: string;
    scope: TargetWriteScope;
    alias?: string;
  }): Promise<PreparedPostWriteResult> {
    return this.serial(async () => {
      assertWriteReady();
      const text = options.text.trim();
      if (!text || text.length > 500) throw new Error("VALIDATION_FAILED:回复必须是 1-500 个字符。");
      if (options.scope === "own_post") {
        const plan = await this.prepareCreatorReply({
          workId: options.workId,
          commentId: options.commentId,
          text,
        });
        const page = await this.creatorCenterPage();
        const creatorAccount = await this.assertCreatorCenterAccount(page);
        if (creatorAccount.displayName !== plan.actorAccount) {
          throw new Error("CREATOR_ACCOUNT_MISMATCH:prepare 后创作者中心账号发生变化。");
        }
        const gate = createTargetWriteGate({
          scope: "own_post",
          actionType: "reply_to_comment",
          actorAccount: creatorAccount.displayName,
          pageRole: "creator_center",
          pageTargetId: await this.pageTargetId(page),
          targetWorkId: plan.workId,
          targetWorkAuthor: creatorAccount.displayName,
          targetCommentId: plan.targetCommentId,
          parentCommentId: plan.parentCommentId,
          rootCommentId: plan.rootCommentId,
          targetTextHash: plan.targetTextHash,
          verifiedUrl: page.url(),
          commentVerified: true,
          alias: creatorAccount.alias,
        });
        return {
          token: plan.token,
          operationId: plan.operationId,
          operation_id: plan.operationId,
          status: "prepared",
          scope: "own_post",
          actionType: "reply_to_comment",
          workId: plan.workId,
          workTitle: plan.workTitle,
          workAuthor: creatorAccount.displayName,
          commentId: plan.targetCommentId,
          commentAuthor: plan.targetAuthor,
          originalText: plan.targetText,
          parentCommentId: plan.parentCommentId,
          rootCommentId: plan.rootCommentId,
          threadPath: plan.threadPath,
          writeText: plan.replyText,
          exactTextHash: sha256(plan.replyText),
          composerFilled: false,
          previewRequired: true,
          targetGate: gate,
          expiresAt: plan.expiresAt,
        };
      }
      const target = await this.createScopedTargetGate({
        scope: options.scope,
        actionType: "reply_to_comment",
        workId: options.workId,
        commentId: options.commentId,
        alias: options.alias,
      });
      if (!target.targetComment || !target.rootComment) {
        throw new Error("TARGET_COMMENT_NOT_VERIFIED:目标评论没有稳定索引。");
      }
      const duplicates = (target.rootComment.replies ?? [])
        .filter(reply => reply.parentCommentId === target.targetComment?.commentId)
        .some(reply => reply.author === loadActionSettings().operator.displayName
          && normalizeCreatorReplyText(reply.text) === normalizeCreatorReplyText(text));
      if (duplicates) throw new Error("DUPLICATE_COMMENT:目标评论下已有相同 Operator 回复。");
      const operation = this.writeOperationStore.create({
        scope: options.scope,
        actionType: "reply_to_comment",
        actorAccount: loadActionSettings().operator.displayName,
        pageRole: target.gate.pageRole,
        workId: options.workId,
        workTitle: target.workTitle,
        commentId: target.targetComment.commentId,
        targetAuthor: target.targetComment.author,
        targetText: target.targetComment.text,
        targetTextHash: sha256(target.targetComment.text),
        parentCommentId: target.targetComment.parentCommentId,
        rootCommentId: target.targetComment.rootCommentId,
        depth: target.targetComment.depth,
        threadPath: target.targetComment.threadPath,
        writeText: text,
        gateSnapshot: target.gate,
        expiresAt: target.gate.expiresAt,
      });
      return this.preparedPostWriteResult(operation, target.workAuthor);
    }, { restoreOnError: false });
  }

  private async commitRootCommentOnClean(
    tokenOrOperationId: string,
    confirmSend: boolean,
  ): Promise<CommittedPostWriteResult & {
    classification: RootCommentSubmitClassification;
    diagnostics: Record<string, unknown>;
  }> {
    return this.serial(async () => {
      if (!confirmSend) {
        throw new Error(
          "CONFIRMATION_REQUIRED:根评论 commit 必须提供 confirm_send=true。",
        );
      }
      let operation = this.writeOperationStore.get(tokenOrOperationId);
      if (!operation || operation.actionType !== "create_root_comment") {
        throw new Error(
          "ROOT_COMMENT_OPERATION_NOT_FOUND:"
          + "token/operation_id 不是根评论事务。",
        );
      }
      if (operation.state !== "prepared") {
        return {
          ...this.committedPostWriteResult(
            operation,
            operation.state === "confirmed",
          ),
          classification: operation.state === "confirmed"
            ? "confirmed"
            : operation.state === "click_no_effect"
              ? "click_no_effect"
              : "unknown_after_submit",
          diagnostics: {
            interactionPerformed: false,
            reason: `state=${operation.state}`,
          },
        };
      }
      this.writeOperationStore.assertNoUnresolvedConflict(
        operation,
        operation.operationId,
      );
      try {
        if (resolveWriteExecutionAdapter(operation)
          !== "work_page_root_comment") {
          throw new Error("ROOT_COMMENT_ROUTE_INVARIANT_FAILED");
        }
        if (Date.parse(operation.expiresAt) <= Date.now()) {
          operation = this.writeOperationStore.update(operation.token, {
            state: "expired",
            lastError: "target_gate_expired",
          });
          return {
            ...this.committedPostWriteResult(operation),
            classification: "unknown_after_submit",
            diagnostics: {
              interactionPerformed: false,
              reason: "target_gate_expired",
            },
          };
        }
      } catch (error) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
        return {
          ...this.committedPostWriteResult(operation),
          classification: "unknown_after_submit",
          diagnostics: {
            interactionPerformed: false,
            reason: String(error),
          },
        };
      }

      let live: Awaited<
        ReturnType<DouyinBrowser["openFrozenRootCommentCleanTarget"]>
      >;
      let composer: Awaited<
        ReturnType<DouyinBrowser["openVerifiedRootCommentComposer"]>
      >;
      try {
        live = await this.openFrozenRootCommentCleanTarget(operation);
        assertTargetWriteGate(operation.gateSnapshot, {
          scope: operation.scope,
          actionType: "create_root_comment",
          workId: operation.workId,
          commentId: null,
          pageRole: "root_comment_clean",
          pageTargetId: await this.pageTargetId(live.page),
        });
        composer = await this.openVerifiedRootCommentComposer(
          live.page,
          operation.workId,
        );
        await this.fillFrozenAdaptiveComposer(
          live.page,
          composer.editor,
          operation,
          "react_events",
        );
        const filled = await this.adaptiveComposerText(composer.editor);
        if (filled == null || sha256(filled) !== operation.writeTextHash) {
          throw new Error(
            "ROOT_COMMENT_FILL_FAILED:"
            + "独立 profile 中的 composer 文本哈希与冻结事务不一致。",
          );
        }
        const preexisting = await this.exactRootCommentHashMatches(
          live.page,
          operation,
        );
        if (preexisting.length > 0) {
          throw new Error(
            "DUPLICATE_COMMENT:"
            + "发送前已读取到 Operator 的相同根评论，未点击。",
          );
        }
        await enforceWritePolicy("comment", live.context.url);
      } catch (error) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
        return {
          ...this.committedPostWriteResult(operation),
          classification: /LOGIN|账号校验/iu.test(String(error))
            ? "login_expired"
            : "unknown_after_submit",
          diagnostics: {
            interactionPerformed: false,
            profileId: rootCommentProfileId,
            reason: String(error),
          },
        };
      }

      const beforeCandidate = await this.inspectFrozenSubmitCandidate(
        composer.send,
        composer.editor,
      );
      const transition = this.writeOperationStore.markClickAttemptedIfPrepared(
        operation.token,
      );
      operation = transition.record;
      if (!transition.transitioned) {
        return {
          ...this.committedPostWriteResult(operation),
          classification: "unknown_after_submit",
          diagnostics: {
            interactionPerformed: false,
            reason: "atomic_click_transition_rejected",
          },
        };
      }

      const requestSignals: Array<{ endpoint: string; seenAt: string }> = [];
      const responseTasks: Array<Promise<SanitizedRootCommentResponse>> = [];
      const onRequest = (request: { url(): string; method(): string }) => {
        const endpoint = isRootCommentSubmitEndpoint(
          request.url(),
          request.method(),
        );
        if (endpoint) {
          requestSignals.push({
            endpoint,
            seenAt: new Date().toISOString(),
          });
        }
      };
      const onResponse = (response: PlaywrightResponse) => {
        const endpoint = isRootCommentSubmitEndpoint(
          response.url(),
          response.request().method(),
        );
        if (!endpoint) return;
        responseTasks.push((async () => {
          const body = await response.json().catch(() => null);
          return sanitizeRootCommentResponse({
            endpoint,
            httpStatus: response.status(),
            body,
          });
        })());
      };
      live.page.on("request", onRequest);
      live.page.on("response", onResponse);
      let clickError: string | null = null;
      try {
        await composer.send.click({ timeout: 3_000 });
      } catch (error) {
        clickError = String(error);
      }
      await live.page.waitForTimeout(3_000);
      live.page.off("request", onRequest);
      live.page.off("response", onResponse);
      const responses = await Promise.all(responseTasks);
      const composerText = await this.adaptiveComposerText(composer.editor);
      const composerCleared = composerText != null
        && normalizeCreatorReplyText(composerText).length === 0;
      const composerTextMatched = composerText != null
        && sha256(composerText) === operation.writeTextHash;
      const localMatches = await this.exactRootCommentHashMatches(
        live.page,
        operation,
      ).catch(() => []);
      const afterCandidate = await this.inspectFrozenSubmitCandidate(
        composer.send,
        composer.editor,
      );
      let classification = classifyRootCommentSubmit({
        responses,
        requestSeen: requestSignals.length > 0,
        composerCleared,
        composerTextReadable: composerText != null,
        composerTextMatched,
        optimisticDomMatch: localMatches.length > 0,
      });
      const responseCommentIds = Array.from(new Set(
        responses.map(response => response.commentId).filter(
          (value): value is string => Boolean(value),
        ),
      ));
      const serverCommentId = responseCommentIds.length === 1
        ? responseCommentIds[0]
        : null;
      const diagnostics: Record<string, unknown> = {
        profileId: rootCommentProfileId,
        profileDirectoryName: path.basename(rootCommentProfileDir),
        operationId: operation.operationId,
        workId: operation.workId,
        author: operation.actorAccount,
        exactTextHash: operation.writeTextHash,
        requestSignals,
        responses,
        responseCommentIds,
        serverReturnedCommentId: Boolean(serverCommentId),
        composerCleared,
        composerTextMatched,
        localOptimisticMatchCount: localMatches.length,
        localOptimisticOnly: localMatches.length > 0 && !serverCommentId,
        beforeCandidate,
        afterCandidate,
        clickError,
        interactionPerformed: true,
      };

      if (classification === "click_no_effect") {
        operation = this.writeOperationStore.markClickNoEffect(
          operation.token,
          clickError
            ? `root_comment_click_no_effect:${clickError}`
            : "root_comment_click_no_effect",
        );
        const step = await this.recordAdaptiveStep(
          live.page,
          operation,
          "diagnose_root_comment_submit",
          "standard_click",
          classification,
          diagnostics,
        );
        return {
          ...this.committedPostWriteResult(operation),
          classification,
          diagnostics: { ...diagnostics, auditStep: step },
        };
      }

      if (serverCommentId) {
        operation = this.writeOperationStore.markClickEffectConfirmed(
          operation.token,
          {
            submitResponseSeenAt: new Date().toISOString(),
            composerClearedAt: composerCleared
              ? new Date().toISOString()
              : null,
          },
        );
        operation = this.writeOperationStore.update(operation.token, {
          resultingCommentId: serverCommentId,
          lastError: "awaiting_strict_cross_session_readback",
        });
        const readback = await this.strictRootCommentReadbackUnlocked(
          operation,
        ).catch(error => ({
          confirmed: false,
          serverCommentId,
          cleanReloadCommentIds: [],
          independentCommentIds: [],
          cleanReloadVerified: false,
          independentSessionVerified: false,
          optimisticCacheBypassed: true as const,
          requestText: operation?.requestText ?? "",
          serverDisplayText: null,
          cleanReloadDisplayTexts: [],
          independentDisplayTexts: [],
          cleanTextMatch: null,
          independentTextMatch: null,
          confirmationMethod: null,
          error: String(error),
        }));
        diagnostics.strictReadback = readback;
        if (readback.confirmed) {
          classification = "confirmed";
          operation = this.writeOperationStore.update(operation.token, {
            state: "confirmed",
            confirmedAt: new Date().toISOString(),
            resultingCommentId: serverCommentId,
            serverDisplayText: readback.serverDisplayText,
            confirmationMethod: readback.confirmationMethod,
            lastError: null,
          });
        } else {
          operation = this.writeOperationStore.update(operation.token, {
            state: "unknown_after_submit",
            lastError: "server_comment_id_not_confirmed_after_reload",
          });
        }
      } else {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          submitResponseSeenAt: responses.length
            ? new Date().toISOString()
            : operation.submitResponseSeenAt,
          composerClearedAt: composerCleared
            ? new Date().toISOString()
            : operation.composerClearedAt,
          lastError: classification,
        });
      }
      const step = await this.recordAdaptiveStep(
        (await this.rootCommentPage(false)).page,
        operation,
        "diagnose_root_comment_submit",
        "standard_click",
        classification,
        diagnostics,
      );
      return {
        ...this.committedPostWriteResult(operation),
        classification,
        diagnostics: { ...diagnostics, auditStep: step },
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async diagnoseRootCommentSubmit(options: {
    operationId?: string;
    action: "inspect" | "submit";
    confirmSend: boolean;
    allowBrowserLaunch: boolean;
  }) {
    if (options.action === "submit") {
      if (!options.operationId) {
        throw new Error(
          "VALIDATION_FAILED:action=submit 必须提供 operation_id。",
        );
      }
      return this.commitRootCommentOnClean(
        options.operationId,
        options.confirmSend,
      );
    }
    return this.serial(async () => {
      const clean = await this.rootCommentPage(options.allowBrowserLaunch);
      if (clean.page.url() === "about:blank") {
        await clean.page.goto("https://www.douyin.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
      let accountVerified = false;
      let loginReason: string | null = null;
      try {
        await this.assertOperatorAccount(clean.page);
        accountVerified = true;
      } catch (error) {
        loginReason = String(error);
      }
      if (!options.operationId) {
        return {
          profileId: rootCommentProfileId,
          profileDirectoryName: path.basename(rootCommentProfileDir),
          cdpUrl: CONFIG.rootCommentCdpUrl,
          browserConnected: true,
          browserLaunched: clean.launched,
          accountVerified,
          loginExpired: !accountVerified,
          manualQrLoginRequired: !accountVerified,
          classification: accountVerified ? null : "login_expired",
          reason: loginReason,
          sent: false,
        };
      }
      const operation = this.writeOperationStore.get(options.operationId);
      if (!operation || operation.actionType !== "create_root_comment") {
        throw new Error("ROOT_COMMENT_OPERATION_NOT_FOUND");
      }
      if (!accountVerified) {
        return {
          profileId: rootCommentProfileId,
          profileDirectoryName: path.basename(rootCommentProfileDir),
          browserConnected: true,
          browserLaunched: clean.launched,
          accountVerified: false,
          loginExpired: true,
          manualQrLoginRequired: true,
          classification: "login_expired",
          operationId: operation.operationId,
          reason: loginReason,
          sent: false,
        };
      }
      const live = await this.openFrozenRootCommentCleanTarget(operation);
      const composer = await this.openVerifiedRootCommentComposer(
        live.page,
        operation.workId,
      );
      const composerText = await this.adaptiveComposerText(composer.editor);
      const submitCandidate = await this.inspectFrozenSubmitCandidate(
        composer.send,
        composer.editor,
      );
      return {
        profileId: rootCommentProfileId,
        profileDirectoryName: path.basename(rootCommentProfileDir),
        browserConnected: true,
        browserLaunched: clean.launched,
        accountVerified: true,
        loginExpired: false,
        manualQrLoginRequired: false,
        classification: operation.state === "click_no_effect"
          ? "click_no_effect"
          : null,
        operationId: operation.operationId,
        state: operation.state,
        workId: operation.workId,
        author: operation.actorAccount,
        exactTextHash: operation.writeTextHash,
        composerTextHashMatched: composerText != null
          && sha256(composerText) === operation.writeTextHash,
        submitCandidate,
        sent: operation.state === "confirmed",
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  private async commitGeneralPostWrite(
    tokenOrOperationId: string,
    confirmSend: boolean,
    expectedAction: "create_root_comment" | "reply_to_comment",
  ): Promise<CommittedPostWriteResult> {
    return this.serial(async () => {
      if (!confirmSend) throw new Error("CONFIRMATION_REQUIRED:commit 必须提供 confirm_send=true。");
      let operation = this.writeOperationStore.get(tokenOrOperationId);
      if (!operation) throw new Error("WRITE_OPERATION_NOT_FOUND:token/operation_id 不存在。");
      if (operation.actionType !== expectedAction) {
        throw new Error("WRITE_OPERATION_TYPE_MISMATCH:事务动作类型不匹配。");
      }
      if (operation.state !== "prepared") {
        return this.committedPostWriteResult(operation, operation.state === "confirmed");
      }
      this.writeOperationStore.assertNoUnresolvedConflict(
        operation,
        operation.operationId,
      );
      try {
        const adapter = resolveWriteExecutionAdapter(operation);
        const expectedAdapter = expectedAction === "create_root_comment"
          ? "work_page_root_comment"
          : "work_page_reply";
        if (adapter !== expectedAdapter) {
          throw new Error(
            `ROUTE_INVARIANT_FAILED:expected=${expectedAdapter},actual=${adapter}`,
          );
        }
      } catch (error) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
        return this.committedPostWriteResult(operation);
      }
      if (Date.parse(operation.expiresAt) <= Date.now()) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "expired",
          lastError: "target_gate_expired",
        });
        return this.committedPostWriteResult(operation);
      }

      let live: Awaited<ReturnType<DouyinBrowser["createScopedTargetGate"]>>;
      try {
        live = await this.createScopedTargetGate({
          scope: operation.scope,
          actionType: operation.actionType,
          workId: operation.workId,
          commentId: operation.commentId,
          alias: operation.gateSnapshot.alias ?? undefined,
          expectedRootCommentId: operation.rootCommentId,
        });
        assertTargetWriteGate(operation.gateSnapshot, {
          scope: operation.scope,
          actionType: operation.actionType,
          workId: operation.workId,
          commentId: operation.commentId,
          pageRole: live.gate.pageRole,
          pageTargetId: await this.pageTargetId(live.page),
        });
        if (operation.commentId && (
          !live.targetComment
          || live.targetComment.author !== operation.targetAuthor
          || sha256(live.targetComment.text) !== operation.targetTextHash
          || live.targetComment.parentCommentId !== operation.parentCommentId
          || live.targetComment.rootCommentId !== operation.rootCommentId
        )) {
          throw new Error("TARGET_COMMENT_CHANGED:作者、正文哈希或父/根关系发生变化。");
        }
      } catch (error) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
        return this.committedPostWriteResult(operation);
      }

      let send: Locator;
      let activeEditor: Locator | null = null;
      try {
        if (operation.actionType === "create_root_comment") {
            const composer = await this.openVerifiedRootCommentComposer(
              live.page,
              operation.workId,
            );
            await composer.editor.fill(operation.writeText);
            const filled = (await composer.editor.innerText().catch(() => "")).trim();
            if (normalizeCreatorReplyText(filled)
              !== normalizeCreatorReplyText(operation.writeText)) {
              throw new Error("VALIDATION_FAILED:主评论文字没有稳定写入已验证的编辑器。");
            }
            activeEditor = composer.editor;
            send = composer.send;
          /*
           * The previous page-global selector is retained temporarily as
           * nearby migration context. It is deliberately unreachable because
           * it cannot distinguish the visible work comment surface from
           * hidden templates, reply composers, or unrelated page inputs.
           *
          const inputs = live.page.locator(
            "textarea[placeholder*='评论'],input[placeholder*='评论'],"
            + "[contenteditable='true'][data-e2e*='comment'],"
            + "[contenteditable='true'][aria-label*='评论']",
          );
          const visible: Locator[] = [];
          for (let index = 0; index < await inputs.count(); index += 1) {
            if (await inputs.nth(index).isVisible().catch(() => false)) visible.push(inputs.nth(index));
          }
          if (visible.length !== 1) throw new Error("VALIDATION_FAILED:评论输入框不唯一。");
          await visible[0].fill(operation!.writeText);
          const sendButtons = live.page.getByRole("button", { name: /^(发送|发布)$/ });
          const visibleSend: Locator[] = [];
          for (let index = 0; index < await sendButtons.count(); index += 1) {
            if (await sendButtons.nth(index).isVisible().catch(() => false)) {
              visibleSend.push(sendButtons.nth(index));
            }
          }
          if (visibleSend.length !== 1) throw new Error("VALIDATION_FAILED:评论发送按钮不唯一。");
          send = visibleSend[0];
          */
        } else {
          if (!live.targetComment) throw new Error("TARGET_COMMENT_NOT_VERIFIED");
          const commentList = live.page.locator("[data-e2e='comment-list']:visible");
          if (await commentList.count() !== 1) {
            throw new Error("COMMENT_SURFACE_AMBIGUOUS:回复提交前可见评论区域不唯一。");
          }
          const target = commentList.locator(
            `[data-e2e='comment-item'][data-comment-id='${operation.commentId}'],`
            + `[data-e2e='comment-item']:has([id*='${operation.commentId}'])`,
          );
          if (await target.count() !== 1 || !await target.isVisible().catch(() => false)) {
            throw new Error("TARGET_COMMENT_NOT_VERIFIED:发送前 comment_id 容器不唯一。");
          }
          const composer = await this.openVerifiedReplyComposer(
            live.page,
            target,
            operation.commentId!,
            live.targetComment.author,
          );
          await composer.editor.fill(operation.writeText);
          activeEditor = composer.editor;
          send = await this.locateVerifiedReplySend(
            composer.composer,
            operation.commentId!,
          );
        }
        await this.assertOperatorAccount(live.page);
        await this.assertWorkContext(live.page, live.context);
        if ((await this.pageTargetId(live.page)) !== operation.gateSnapshot.pageTargetId) {
          throw new Error("TARGET_ID_CHANGED:prepare 后页面 target_id 已变化。");
        }
        await enforceWritePolicy(
          operation.actionType === "create_root_comment" ? "comment" : "comment_reply",
          live.context.url,
        );
      } catch (error) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
        return this.committedPostWriteResult(operation);
      }

      const transition = this.writeOperationStore.markClickAttemptedIfPrepared(operation.token);
      operation = transition.record;
      if (!transition.transitioned) return this.committedPostWriteResult(operation);
      const submitResponses: Array<{ url: string; seenAt: string }> = [];
      const onResponse = (response: PlaywrightResponse): void => {
        try {
          const url = new URL(response.url());
          const method = response.request().method().toUpperCase();
          if (method === "POST"
            && /(?:^|\/)(?:comment|reply)(?:\/|$)/iu.test(url.pathname)
            && /publish|create|reply|commit|comment/iu.test(url.pathname)) {
            submitResponses.push({
              url: response.url(),
              seenAt: new Date().toISOString(),
            });
          }
        } catch {
          // Non-URL responses cannot prove a submit effect.
        }
      };
      live.page.on("response", onResponse);
      let clickError: unknown = null;
      try {
        await send.click({ timeout: 3_000 });
      } catch (error) {
        clickError = error;
      }

      const attemptedOperation = operation;
      const matchingResult = async (): Promise<DouyinComment | null> => {
        const comments = await this.parseComments(live.page, 100, true, 100);
        const matches = comments.flatMap(comment => [comment, ...(comment.replies ?? [])])
          .filter(comment =>
            comment.author === attemptedOperation.actorAccount
            && normalizeCreatorReplyText(comment.text)
              === normalizeCreatorReplyText(attemptedOperation.writeText)
            && (attemptedOperation.actionType === "create_root_comment"
              ? comment.parentCommentId == null
              : comment.parentCommentId === attemptedOperation.commentId));
        return matches.length === 1 ? matches[0] : null;
      };
      const sendSubmitting = async (): Promise<boolean> => send.evaluate(element => {
        const html = element as HTMLElement & { disabled?: boolean };
        const hint = [
          html.getAttribute("aria-disabled"),
          html.getAttribute("aria-busy"),
          html.getAttribute("data-loading"),
          html.getAttribute("data-state"),
          html.getAttribute("class"),
        ].filter(Boolean).join(" ").toLowerCase();
        return html.disabled === true
          || html.getAttribute("aria-disabled") === "true"
          || html.getAttribute("aria-busy") === "true"
          || /loading|submitting|pending|disabled/.test(hint);
      }).catch(() => false);
      let composerText: string | null = null;
      let composerCleared = false;
      let buttonSubmitting = false;
      let resultingComment: DouyinComment | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await live.page.waitForTimeout(150);
        composerText = activeEditor
          ? await activeEditor.innerText().catch(() => null)
          : null;
        composerCleared = composerText == null
          || normalizeCreatorReplyText(composerText).length === 0;
        buttonSubmitting = await sendSubmitting();
        resultingComment = await matchingResult().catch(() => null);
        if (composerCleared
          || buttonSubmitting
          || submitResponses.length > 0
          || resultingComment) {
          break;
        }
      }
      live.page.off("response", onResponse);
      const textStillPresent = composerText != null
        && normalizeCreatorReplyText(composerText)
          === normalizeCreatorReplyText(attemptedOperation.writeText);
      const effectConfirmed = composerCleared
        || buttonSubmitting
        || submitResponses.length > 0
        || Boolean(resultingComment);
      if (!effectConfirmed && textStillPresent) {
        operation = this.writeOperationStore.markClickNoEffect(
          operation.token,
          clickError
            ? `click_no_effect:${String(clickError)}`
            : "click_no_effect:composer_text_unchanged_no_response_no_comment",
        );
        return this.committedPostWriteResult(operation);
      }
      if (!effectConfirmed) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          lastError: clickError
            ? `click_attempt_unknown:${String(clickError)}`
            : "click_attempt_unknown:no_positive_effect_and_composer_unverifiable",
        });
        return this.committedPostWriteResult(operation);
      }
      operation = this.writeOperationStore.markClickEffectConfirmed(operation.token, {
        submitResponseSeenAt: submitResponses[0]?.seenAt ?? null,
        composerClearedAt: composerCleared ? new Date().toISOString() : null,
      });

      const submittedOperation = operation;
      try {
        for (let attempt = 0; attempt < 20 && !resultingComment; attempt += 1) {
          await this.assertWorkContext(live.page, live.context);
          await this.loadComments(live.page, 100);
          const comments = await this.parseComments(live.page, 100, true, 100);
          const candidates = comments.flatMap(comment => [comment, ...(comment.replies ?? [])])
            .filter(comment =>
              comment.author === loadActionSettings().operator.displayName
              && normalizeCreatorReplyText(comment.text)
                === normalizeCreatorReplyText(submittedOperation.writeText)
              && (submittedOperation.actionType === "create_root_comment"
                ? comment.parentCommentId == null
                : comment.parentCommentId === submittedOperation.commentId));
          if (candidates.length === 1) resultingComment = candidates[0];
          if (!resultingComment) await sleep(500);
        }
      } catch {
        resultingComment = null;
      }
      if (!resultingComment?.commentId) {
        operation = this.writeOperationStore.update(operation.token, {
          state: "unknown_after_submit",
          lastError: "resulting_comment_id_not_uniquely_confirmed",
        });
      } else {
        operation = this.writeOperationStore.update(operation.token, {
          state: "confirmed",
          confirmedAt: new Date().toISOString(),
          resultingCommentId: resultingComment.commentId,
          lastError: null,
        });
      }
      return this.committedPostWriteResult(operation);
    }, { restoreOnError: false });
  }

  async commitCommentOnPost(
    tokenOrOperationId: string,
    confirmSend: boolean,
  ): Promise<CommittedPostWriteResult> {
    return this.commitRootCommentOnClean(
      tokenOrOperationId,
      confirmSend,
    );
  }

  async commitReplyToComment(
    tokenOrOperationId: string,
    confirmSend: boolean,
  ): Promise<CommittedPostWriteResult | CreatorReplyTransactionResult> {
    let operation = this.writeOperationStore.get(tokenOrOperationId);
    if (!operation) {
      throw new Error("WRITE_OPERATION_NOT_FOUND:token/operation_id 不存在。");
    }
    let adapter: ReturnType<typeof resolveWriteExecutionAdapter>;
    try {
      adapter = resolveWriteExecutionAdapter(operation);
    } catch (error) {
      if (operation.state === "prepared") {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: String(error),
        });
      }
      return this.committedPostWriteResult(operation);
    }
    if (adapter === "creator_center_reply") {
      return this.commitCreatorReply(tokenOrOperationId, confirmSend);
    }
    if (adapter !== "work_page_reply") {
      if (operation.state === "prepared") {
        operation = this.writeOperationStore.update(operation.token, {
          state: "failed_before_click",
          lastError: `ROUTE_INVARIANT_FAILED:reply_commit_adapter=${adapter}`,
        });
      }
      return this.committedPostWriteResult(operation);
    }
    return this.commitGeneralPostWrite(
      tokenOrOperationId,
      confirmSend,
      "reply_to_comment",
    );
  }

  async commentCurrent(options: {
    text: string;
    action?: "preview" | "send";
    confirmSend?: boolean;
    targetWorkId?: string;
    targetAlias?: string;
  }): Promise<CommentActionResult> {
    return this.serial(async () => {
      {
      const currentLock = this.lockedWorkContexts.get("operator_home");
      const scopedWorkId = options.targetWorkId ?? currentLock?.workId;
      if (!scopedWorkId) {
        throw new Error("TARGET_WORK_REQUIRED:评论必须提供或锁定精确 work_id。");
      }
      const scope: TargetWriteScope = options.targetAlias
        || (currentLock?.alias && currentLock.alias !== "self")
        ? "bound_user_post"
        : "own_post";
      const prepared = await this.prepareCommentOnPost({
        workId: scopedWorkId,
        text: options.text,
        scope,
        alias: options.targetAlias ?? (scope === "bound_user_post"
          ? currentLock?.alias ?? undefined
          : undefined),
      });
      const preparedPage = (await this.rootCommentPage(false)).page;
      if ((options.action ?? "preview") !== "send") {
        const composerPreview = await this.previewCommentOnPostUnlocked(
          prepared.operationId,
          "react_events",
        );
        const artifact = await this.saveCommentArtifact(preparedPage, "comment-transaction-preview", {
          operationId: prepared.operationId,
          targetGate: prepared.targetGate,
          composerPreview,
          sent: false,
        });
        return {
          action: "preview",
          sent: false,
          targetWorkId: prepared.workId,
          targetCommentId: null,
          commentId: null,
          text: prepared.writeText,
          account: loadActionSettings().operator.displayName,
          author: prepared.workAuthor,
          duplicateDetected: false,
          verified: true,
          contextVerified: true,
          targetAlias: options.targetAlias,
          token: prepared.token,
          operationId: prepared.operationId,
          operation_id: prepared.operationId,
          operationState: "prepared",
          resultCode: "prepared",
          composerFilled: composerPreview.composerFilled,
          composerVerified: composerPreview.composerVerified,
          composerPreview,
          targetGate: prepared.targetGate,
          ...artifact,
        };
      }
      const committed = await this.commitCommentOnPost(
        prepared.token,
        options.confirmSend === true,
      );
      const artifact = await this.saveCommentArtifact(preparedPage, "comment-transaction-commit", {
        operationId: committed.operationId,
        state: committed.operationState,
        resultingCommentId: committed.resultingCommentId,
      });
      return {
        action: "send",
        sent: committed.status === "confirmed",
        targetWorkId: committed.workId,
        targetCommentId: null,
        commentId: committed.resultingCommentId,
        text: committed.writeText,
        account: loadActionSettings().operator.displayName,
        author: prepared.workAuthor,
        duplicateDetected: committed.resultCode === "already_confirmed",
        verified: committed.status === "confirmed",
        contextVerified: true,
        targetAlias: options.targetAlias,
        token: committed.token,
        operationId: committed.operationId,
        operation_id: committed.operationId,
        operationState: committed.operationState,
        resultCode: committed.resultCode,
        targetGate: prepared.targetGate,
        ...artifact,
      };
      }

      /*
       * The legacy direct-click implementation is intentionally unreachable.
       * It remains below temporarily to keep the mature DOM diagnostics close
       * to the compatibility adapter while every send is routed through the
       * durable prepare/commit transaction above.
       */
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      if (options.targetWorkId && options.targetWorkId !== context.workId) {
        throw new Error("WRONG_PAGE:当前作品 ID 与 target_work_id 不一致。");
      }
      const lock = this.lockedWorkContexts.get("operator_home");
      if (!workLockMatches(lock, context.workId, options.targetAlias)) {
        throw new Error("WORK_NOT_LOCKED:当前作品未按 work_id/alias 锁定。");
      }
      const text = options.text.trim();
      if (!text || text.length > 500) throw new Error("评论必须是 1-500 个字符。");
      const author = options.targetAlias
        ? await this.verifyBoundWorkAuthor(page, getBoundUser(options.targetAlias), context)
        : lock?.alias === "self"
          ? await this.verifyOwnWorkAuthor(page, context)
          : await this.currentAuthor(page, context) ?? "未知作者";
      await this.loadComments(page, 100);
      const comments = await this.parseComments(page, 100, true, 50);
      const existingTexts = comments.flatMap(comment => [
        comment.text,
        ...(comment.replies ?? []).map(reply => reply.text),
      ]);
      const decision = decideCommentAction({
        action: options.action,
        confirmSend: options.confirmSend,
        text,
        existingTexts,
      });
      const duplicate = decision.duplicate;
      if (decision.errorCode === "DUPLICATE_COMMENT") {
        throw new Error("DUPLICATE_COMMENT:评论区已存在相同文字，未重复发送。");
      }
      if (decision.errorCode === "CONFIRMATION_REQUIRED") {
        throw new Error("CONFIRMATION_REQUIRED:发送评论必须同时提供 action=send 和 confirm_send=true。");
      }
      if (!decision.shouldSend) {
        const artifact = await this.saveCommentArtifact(page, "comment-preview", {
          text,
          targetWorkId: context.workId,
          author,
          duplicate,
          sent: false,
        });
        return {
          action: "preview",
          sent: false,
          targetWorkId: context.workId,
          targetCommentId: null,
          commentId: null,
          text,
          account: loadActionSettings().operator.displayName,
          author,
          duplicateDetected: duplicate,
          verified: false,
          contextVerified: true,
          targetAlias: options.targetAlias,
          ...artifact,
        };
      }
      await enforceWritePolicy("comment", context.url);
      await this.assertWorkContext(page, context);
      const input = page.locator(
        "textarea[placeholder*='评论'],input[placeholder*='评论'],[contenteditable='true'][data-e2e*='comment'],[contenteditable='true'][aria-label*='评论']",
      );
      const visibleInputs: number[] = [];
      for (let index = 0; index < await input.count(); index += 1) {
        if (await input.nth(index).isVisible().catch(() => false)) visibleInputs.push(index);
      }
      if (visibleInputs.length !== 1) throw new Error("VALIDATION_FAILED:无法唯一定位当前作品评论输入框。");
      await input.nth(visibleInputs[0]).fill(text);
      const send = page.getByRole("button", { name: /^(发送|发布)$/ });
      const visibleButtons: number[] = [];
      for (let index = 0; index < await send.count(); index += 1) {
        if (await send.nth(index).isVisible().catch(() => false)) visibleButtons.push(index);
      }
      if (visibleButtons.length !== 1) throw new Error("VALIDATION_FAILED:无法唯一定位评论发送按钮。");
      await send.nth(visibleButtons[0]).click();
      await page.waitForTimeout(CONFIG.actionDelayMs);
      await this.assertWorkContext(page, context);
      await this.loadComments(page, 100);
      const after = await this.parseComments(page, 100, true, 50);
      const created = after.flatMap(comment => [comment, ...(comment.replies ?? [])])
        .find(comment => comment.text === text && comment.commentId);
      if (!created) throw new Error("VALIDATION_FAILED:发送后重新读取评论区，没有找到相同文字的真实 comment_id。");
      const artifact = await this.saveCommentArtifact(page, "comment-send", {
        text,
        targetWorkId: context.workId,
        commentId: created!.commentId,
        verified: true,
      });
      appendActionLog(this.actionLogBase("douyin_comment_current", "comment", {
        workUrl: context.url,
        author,
        beforeState: "absent",
        afterState: created!.commentId,
        success: true,
        recipientAlias: options.targetAlias,
      }));
      return {
        action: "send",
        sent: true,
        targetWorkId: context.workId,
        targetCommentId: null,
        commentId: created!.commentId,
        text,
        account: loadActionSettings().operator.displayName,
        author,
        duplicateDetected: false,
        verified: true,
        contextVerified: true,
        targetAlias: options.targetAlias,
        ...artifact,
      };
    }, { restoreOnError: false });
  }

  async commentBoundUserPost(options: {
    alias?: string;
    workId: string;
    text: string;
    action?: "preview" | "send";
    confirmSend?: boolean;
  }): Promise<CommentActionResult> {
    return this.serial(async () => {
      const alias = options.alias ?? "bound_user";
      await this.openBoundUserPost(alias, options.workId);
      return this.commentCurrent({
        text: options.text,
        targetWorkId: options.workId,
        targetAlias: alias,
        action: options.action,
        confirmSend: options.confirmSend,
      });
    }, { restoreOnError: false });
  }

  private async openVerifiedReplyComposer(
    page: Page,
    target: Locator,
    commentId: string,
    targetAuthor: string,
  ): Promise<{ editor: Locator; composer: Locator; placeholder: string }> {
    const replyText = "回复";
    const entryMarker = `reply-entry-${commentId}-${Date.now()}`;
    const entry = await target.evaluate((root, input) => {
      const rendered = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(
        "button,[role='button'],[tabindex],div,span",
      )).filter(element =>
        rendered(element)
        && (element.innerText || element.textContent || "").trim() === input.replyText
        && element.closest("[data-e2e='comment-item']") === root);
      const interactive = candidates.filter(element =>
        element.matches("button,[role='button'],[tabindex]"));
      const outermost = candidates.filter(element =>
        !candidates.some(other => other !== element && other.contains(element)));
      const usable = interactive.length ? interactive : outermost;
      if (usable.length !== 1) {
        return {
          marked: false,
          scopedCandidateCount: candidates.length,
          interactiveCandidateCount: interactive.length,
        };
      }
      usable[0].setAttribute("data-codex-reply-entry", input.marker);
      return {
        marked: true,
        scopedCandidateCount: candidates.length,
        interactiveCandidateCount: interactive.length,
      };
    }, { replyText, marker: entryMarker });
    if (!entry.marked) {
      throw new Error(
        `VALIDATION_FAILED:目标 comment_id 的评论容器内无法唯一建立回复入口`
        + `（候选 ${entry.scopedCandidateCount}，可交互 ${entry.interactiveCandidateCount}）。`,
      );
    }
    const entryLocator = page.locator(`[data-codex-reply-entry="${entryMarker}"]`);
    if (await entryLocator.count() !== 1) {
      throw new Error("VALIDATION_FAILED:目标评论回复入口在点击前已因页面重绘失效。");
    }
    await entryLocator.scrollIntoViewIfNeeded();
    await entryLocator.click();

    await page.waitForFunction((expectedAuthor: string) => {
      const normalizedAuthor = expectedAuthor.replace(/\s+/g, "");
      const rendered = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      };
      const promptFor = (element: Element) => {
        const described = (element.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
          .join(" ");
        return [
          element.getAttribute("placeholder") ?? "",
          element.getAttribute("aria-label") ?? "",
          described,
        ].join(" ").replace(/\s+/g, "");
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "textarea,input:not([type='file']),[contenteditable='true']",
      )).filter(element => rendered(element));
      return candidates.some(element => {
        const prompt = promptFor(element);
        return element === document.activeElement
          && prompt.startsWith("回复@")
          && (prompt.includes(normalizedAuthor) || normalizedAuthor.includes(prompt.slice(3)));
      });
    }, targetAuthor, { timeout: 10_000 });

    const editorMarker = `reply-editor-${commentId}-${Date.now()}`;
    const composerMarker = `reply-composer-${commentId}-${Date.now()}`;
    const marked = await page.evaluate((input) => {
      const normalizedAuthor = input.targetAuthor.replace(/\s+/g, "");
      const rendered = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      };
      const promptFor = (element: Element) => {
        const described = (element.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .map(id => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
          .join(" ");
        return [
          element.getAttribute("placeholder") ?? "",
          element.getAttribute("aria-label") ?? "",
          described,
        ].join(" ").replace(/\s+/g, "");
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "textarea,input:not([type='file']),[contenteditable='true']",
      )).filter(element => {
        if (!rendered(element)) return false;
        const prompt = promptFor(element);
        return prompt.startsWith("回复@")
          && (prompt.includes(normalizedAuthor) || normalizedAuthor.includes(prompt.slice(3)));
      });
      const active = candidates.filter(element => element === document.activeElement);
      const usable = active.length ? active : candidates;
      if (usable.length !== 1) {
        return { marked: false, editorCount: candidates.length, sendCount: 0, placeholder: "" };
      }
      const editor = usable[0];
      const placeholder = promptFor(editor);
      const composer = editor.closest<HTMLElement>(".comment-input-inner-container");
      if (!composer) {
        return { marked: false, editorCount: candidates.length, sendCount: 0, placeholder };
      }
      editor.setAttribute("data-codex-reply-editor", input.editorMarker);
      composer.setAttribute("data-codex-reply-composer", input.composerMarker);
      return {
        marked: true,
        editorCount: candidates.length,
        sendCount: 0,
        placeholder,
      };
    }, { targetAuthor, editorMarker, composerMarker });
    if (!marked.marked) {
      throw new Error(
        `VALIDATION_FAILED:回复编辑器与目标评论关联失败`
        + `（编辑器 ${marked.editorCount}，发送控件 ${marked.sendCount}，提示 ${marked.placeholder || "无"}）。`,
      );
    }
    const editor = page.locator(`[data-codex-reply-editor="${editorMarker}"]`);
    const composer = page.locator(`[data-codex-reply-composer="${composerMarker}"]`);
    if (await editor.count() !== 1 || await composer.count() !== 1) {
      throw new Error("VALIDATION_FAILED:已验证的回复编辑器或编辑器容器在输入前失效。");
    }
    return { editor, composer, placeholder: marked.placeholder };
  }

  private async locateVerifiedReplySend(
    composer: Locator,
    commentId: string,
  ): Promise<Locator> {
    const sendMarker = `reply-send-${commentId}-${Date.now()}`;
    let diagnostics: {
      marked: boolean;
      semanticCount: number;
      structuralCount: number;
      coloredArrowCount: number;
    } = {
      marked: false,
      semanticCount: 0,
      structuralCount: 0,
      coloredArrowCount: 0,
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      diagnostics = await composer.evaluate((root, input) => {
        const rendered = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.bottom > 0 && rect.top < innerHeight;
        };
        root.querySelectorAll<HTMLElement>("[data-codex-reply-send]")
          .forEach(element => element.removeAttribute("data-codex-reply-send"));
        const rightControls = root.querySelector<HTMLElement>(".commentInput-right-ct");
        if (!rightControls) {
          return {
            marked: false,
            semanticCount: 0,
            structuralCount: 0,
            coloredArrowCount: 0,
          };
        }
        const semantic = Array.from(rightControls.querySelectorAll<HTMLElement>(
          "button,[role='button'],[data-e2e*='send'],[aria-label]",
        )).filter(element => {
          if (!rendered(element)) return false;
          const hint = [
            element.innerText || element.textContent || "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("data-e2e") ?? "",
          ].join(" ").trim();
          return /^(发送|发布)$/.test(hint)
            || /(?:^|[-_])(send|submit)(?:$|[-_])/i.test(hint);
        });
        const structural = Array.from(rightControls.querySelectorAll<HTMLElement>(
          ":scope > div > span",
        )).filter(element => {
          if (!rendered(element) || !element.querySelector("svg")) return false;
          const rect = element.getBoundingClientRect();
          return rect.width >= 28 && rect.width <= 48
            && rect.height >= 28 && rect.height <= 48;
        });
        const coloredArrows = structural.filter(element => {
          const paths = Array.from(element.querySelectorAll<SVGPathElement>("svg path"));
          const fills = paths.map(path => (path.getAttribute("fill") ?? "").toLowerCase());
          return fills.includes("#fe2c55") && fills.includes("#fff");
        });
        let candidates = semantic;
        if (!candidates.length && coloredArrows.length === 1) {
          const rightmost = structural.reduce<HTMLElement | null>((best, element) => {
            if (!best) return element;
            return element.getBoundingClientRect().x > best.getBoundingClientRect().x
              ? element : best;
          }, null);
          candidates = rightmost === coloredArrows[0] ? coloredArrows : [];
        }
        if (candidates.length !== 1) {
          return {
            marked: false,
            semanticCount: semantic.length,
            structuralCount: structural.length,
            coloredArrowCount: coloredArrows.length,
          };
        }
        candidates[0].setAttribute("data-codex-reply-send", input.sendMarker);
        return {
          marked: true,
          semanticCount: semantic.length,
          structuralCount: structural.length,
          coloredArrowCount: coloredArrows.length,
        };
      }, { sendMarker });
      if (diagnostics.marked) break;
      await composer.page().waitForTimeout(100);
    }
    if (!diagnostics.marked) {
      throw new Error(
        `VALIDATION_FAILED:填入回复后无法唯一识别红色发送箭头`
        + `（语义候选 ${diagnostics.semanticCount}，结构候选 ${diagnostics.structuralCount}，`
        + `红白箭头 ${diagnostics.coloredArrowCount}）。`,
      );
    }
    const send = composer.locator(`[data-codex-reply-send="${sendMarker}"]`);
    if (await send.count() !== 1 || !await send.isVisible().catch(() => false)) {
      throw new Error("VALIDATION_FAILED:填字后锁定的回复发送箭头在点击前失效。");
    }
    return send;
  }

  async replyComment(options: {
    commentId: string;
    text: string;
    action?: "preview" | "send";
    confirmSend?: boolean;
    targetWorkId: string;
    scope?: TargetWriteScope;
    alias?: string;
  }): Promise<CommentActionResult> {
    return this.serial(async () => {
      {
      const scope = options.scope ?? "own_post";
      const prepared = await this.prepareReplyToComment({
        workId: options.targetWorkId,
        commentId: options.commentId,
        text: options.text,
        scope,
        alias: options.alias,
      });
      const artifactPage = scope === "external_post"
        ? this.rolePages.get("codex_test")
        : scope === "own_post"
          ? this.rolePages.get("creator_center")
          : this.rolePages.get("operator_home");
      if (!artifactPage || artifactPage.isClosed()) {
        throw new Error("PAGE_BINDING_LOST:目标作用域页面不可用。");
      }
      if ((options.action ?? "preview") !== "send") {
        const artifact = await this.saveCommentArtifact(artifactPage, "reply-transaction-preview", {
          operationId: prepared.operationId,
          targetGate: prepared.targetGate,
          sent: false,
        });
        return {
          action: "preview",
          sent: false,
          targetWorkId: prepared.workId,
          targetCommentId: prepared.commentId,
          commentId: null,
          text: prepared.writeText,
          account: loadActionSettings().operator.displayName,
          author: prepared.workAuthor,
          duplicateDetected: false,
          verified: true,
          contextVerified: true,
          targetAlias: options.alias,
          targetAuthor: prepared.commentAuthor ?? undefined,
          targetText: prepared.originalText ?? undefined,
          token: prepared.token,
          operationId: prepared.operationId,
          operation_id: prepared.operationId,
          operationState: "prepared",
          resultCode: "prepared",
          targetGate: prepared.targetGate,
          ...artifact,
        };
      }
      const committed = await this.commitReplyToComment(
        prepared.token,
        options.confirmSend === true,
      );
      const isCreator = "replyCommentId" in committed;
      const resultingCommentId = isCreator
        ? committed.replyCommentId
        : committed.resultingCommentId;
      const artifact = await this.saveCommentArtifact(artifactPage, "reply-transaction-commit", {
        operationId: committed.operationId,
        state: committed.operationState,
        resultingCommentId,
      });
      return {
        action: "send",
        sent: committed.status === "confirmed",
        targetWorkId: committed.workId,
        targetCommentId: prepared.commentId,
        commentId: resultingCommentId,
        text: prepared.writeText,
        account: loadActionSettings().operator.displayName,
        author: prepared.workAuthor,
        duplicateDetected: committed.resultCode === "already_confirmed",
        verified: committed.status === "confirmed",
        contextVerified: true,
        targetAlias: options.alias,
        targetAuthor: prepared.commentAuthor ?? undefined,
        targetText: prepared.originalText ?? undefined,
        token: committed.token,
        operationId: committed.operationId,
        operation_id: committed.operationId,
        operationState: committed.operationState,
        resultCode: committed.resultCode,
        targetGate: prepared.targetGate,
        ...artifact,
      };
      }

      await this.openOwnPost(options.targetWorkId);
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      if (options.targetWorkId !== context.workId) {
        throw new Error("WRONG_PAGE:当前作品 ID 与 target_work_id 不一致。");
      }
      const lock = this.lockedWorkContexts.get("operator_home");
      if (!workLockMatches(lock, context.workId, "self")) {
        throw new Error("WORK_NOT_LOCKED:Operator 自有作品没有按 target_work_id 锁定。");
      }
      const text = options.text.trim();
      if (!text || text.length > 500) throw new Error("回复必须是 1-500 个字符。");
      const author = await this.verifyOwnWorkAuthor(page, context);
      await this.loadComments(page, 100);
      const target = page.locator(
        `[data-e2e='comment-item'][data-comment-id='${options.commentId}'],`
        + `[data-e2e='comment-item']:has([id*='${options.commentId}'])`,
      );
      if (await target.count() !== 1) throw new Error("VALIDATION_FAILED:当前作品没有唯一匹配该 comment_id 的评论。");
      const thread = await this.parseComments(page, 100, true, 100);
      const targetComment = thread.flatMap(comment => [comment, ...(comment.replies ?? [])])
        .find(comment => comment.commentId === options.commentId);
      if (!targetComment) throw new Error("VALIDATION_FAILED:解析后的当前作品评论线程不包含目标 comment_id。");
      const targetThread = thread.find(comment =>
        comment.commentId === options.commentId
        || (comment.replies ?? []).some(reply => reply.commentId === options.commentId));
      if (!targetThread) {
        throw new Error("VALIDATION_FAILED:无法把目标 comment_id 归属到唯一主评论线程。");
      }
      const decision = decideCommentAction({
        action: options.action,
        confirmSend: options.confirmSend,
        text,
        existingTexts: (targetThread!.replies ?? []).map(reply => reply.text),
      });
      const duplicate = decision.duplicate;
      if (decision.errorCode === "DUPLICATE_COMMENT") {
        throw new Error("DUPLICATE_COMMENT:该评论线程已存在相同回复，未重复发送。");
      }
      if (decision.errorCode === "CONFIRMATION_REQUIRED") {
        throw new Error("CONFIRMATION_REQUIRED:发送回复必须同时提供 action=send 和 confirm_send=true。");
      }
      if (!decision.shouldSend) {
        const artifact = await this.saveCommentArtifact(page, "reply-preview", {
          text,
          targetWorkId: context.workId,
          targetCommentId: options.commentId,
          duplicate,
        });
        return {
          action: "preview",
          sent: false,
          targetWorkId: context.workId,
          targetCommentId: options.commentId,
          commentId: null,
          text,
          account: loadActionSettings().operator.displayName,
          author,
          duplicateDetected: duplicate,
          verified: true,
          contextVerified: true,
          targetAuthor: targetComment!.author,
          targetText: targetComment!.text,
          ...artifact,
        };
      }
      await enforceWritePolicy("comment_reply", `${context.url}#${options.commentId}`);
      await this.assertOperatorAccount(page);
      await this.assertWorkContext(page, context);
      await this.verifyOwnWorkAuthor(page, context);
      const composer = await this.openVerifiedReplyComposer(
        page,
        target,
        options.commentId,
        targetComment!.author,
      );
      await composer.editor.fill(text);
      const filled = (await composer.editor.innerText().catch(() => "")).trim();
      if (filled !== text) {
        throw new Error("VALIDATION_FAILED:回复文字没有稳定写入已验证的目标评论编辑器。");
      }
      const send = await this.locateVerifiedReplySend(
        composer.composer,
        options.commentId,
      );
      await this.assertOperatorAccount(page);
      await this.assertWorkContext(page, context);
      await this.verifyOwnWorkAuthor(page, context);
      if (await target.count() !== 1) {
        throw new Error("VALIDATION_FAILED:发送前目标 comment_id 的评论容器已失效。");
      }
      await send.click();
      await page.waitForTimeout(CONFIG.actionDelayMs);
      let created: DouyinComment | undefined;
      for (let attempt = 0; attempt < 20 && !created; attempt += 1) {
        await this.assertWorkContext(page, context);
        await this.loadComments(page, 100);
        const refreshedTarget = page.locator(
          `[data-e2e='comment-item'][data-comment-id='${options.commentId}'],`
          + `[data-e2e='comment-item']:has([id*='${options.commentId}'])`,
        );
        if (await refreshedTarget.count() === 1) {
          const expand = refreshedTarget.locator(".comment-reply-expand-btn");
          if (await expand.count() === 1 && await expand.isVisible().catch(() => false)) {
            await expand.click().catch(() => null);
            await sleep(200);
          }
        }
        const updated = await this.parseComments(page, 100, true, 100);
        created = updated
          .find(item => item.commentId === targetThread!.commentId)
          ?.replies?.find(item =>
            item.commentId
            && item.author === loadActionSettings().operator.displayName
            && (item.text === text || item.text.endsWith(`：${text}`) || item.text.endsWith(`:${text}`)));
        if (!created) await sleep(500);
      }
      if (!created) {
        throw new Error("VALIDATION_FAILED:发送后没有在目标 comment_id 所属线程找到 Operator 的真实回复和 replyCommentId。");
      }
      const artifact = await this.saveCommentArtifact(page, "reply-send", {
        text,
        targetWorkId: context.workId,
        targetCommentId: options.commentId,
        commentId: created!.commentId,
      });
      appendActionLog(this.actionLogBase("douyin_reply_comment", "comment_reply", {
        workUrl: context.url,
        author,
        beforeState: options.commentId,
        afterState: created!.commentId,
        success: true,
      }));
      return {
        action: "send",
        sent: true,
        targetWorkId: context.workId,
        targetCommentId: options.commentId,
        commentId: created!.commentId,
        text,
        account: loadActionSettings().operator.displayName,
        author,
        duplicateDetected: false,
        verified: true,
        contextVerified: true,
        targetAuthor: targetComment!.author,
        targetText: targetComment!.text,
        ...artifact,
      };
    }, { restoreOnError: false });
  }

  async replyCommentOnBoundUserPost(options: {
    alias?: string;
    workId: string;
    commentId: string;
    text: string;
    action?: "preview" | "send";
    confirmSend?: boolean;
  }): Promise<CommentActionResult> {
    return this.replyComment({
      commentId: options.commentId,
      text: options.text,
      action: options.action,
      confirmSend: options.confirmSend,
      targetWorkId: options.workId,
      scope: "bound_user_post",
      alias: options.alias ?? "bound_user",
    });
  }

  private async setCreatorCenterCommentLike(
    workId: string,
    commentId: string,
    liked: boolean,
  ): Promise<CommentActionResult> {
    assertWriteReady();
    const listed = await this.listCreatorComments({
      workId,
      sort: "latest",
      status: "all",
      limit: 100,
    });
    const resolved = this.resolveCreatorReplyTarget(listed.items, commentId);
    const page = await this.creatorCenterPage();
    const creatorAccount = await this.assertCreatorCenterAccount(page);
    const gate = createTargetWriteGate({
      scope: "own_post",
      actionType: liked ? "like_comment" : "unlike_comment",
      actorAccount: creatorAccount.displayName,
      pageRole: "creator_center",
      pageTargetId: await this.pageTargetId(page),
      targetWorkId: workId,
      targetWorkAuthor: creatorAccount.displayName,
      targetCommentId: resolved.target.commentId,
      parentCommentId: resolved.target.parentCommentId,
      rootCommentId: resolved.target.rootCommentId,
      targetTextHash: sha256(resolved.target.text),
      verifiedUrl: page.url(),
      commentVerified: true,
    });
    const domTarget = await this.expandAndLocateCreatorReplyTarget(page, workId, resolved);
    const operations = domTarget.targetRecord.locator("[class*='operations-']").first();
    const like = operations.locator(":scope > [class*='item-']").nth(0);
    if (!await like.isVisible().catch(() => false)) {
      throw new Error("CAPABILITY_UNAVAILABLE:creator_center 目标评论没有可验证的行内点赞入口。");
    }
    const state = async (): Promise<boolean | null> => like.evaluate(element => {
      const hint = [
        element.getAttribute("aria-pressed"),
        element.getAttribute("data-liked"),
        element.getAttribute("data-state"),
        element.getAttribute("class"),
      ].filter(Boolean).join(" ").toLowerCase();
      if (/(?:^|\s)(?:true|liked|active|selected)(?:\s|$)/.test(hint)) return true;
      if (/(?:^|\s)(?:false|unliked|inactive)(?:\s|$)/.test(hint)) return false;
      const color = getComputedStyle(element).color.match(/\d+/g)?.map(Number) ?? [];
      if (color.length >= 3) {
        const [red, green, blue] = color;
        if (red >= 220 && green <= 100 && blue <= 130) return true;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 20) return false;
      }
      return null;
    });
    const beforeLiked = await state();
    if (beforeLiked == null) {
      throw new Error("CAPABILITY_UNAVAILABLE:creator_center 点赞按钮当前状态无法可靠判定，未点击。");
    }
    if (beforeLiked !== liked) {
      assertTargetWriteGate(gate, {
        scope: "own_post",
        actionType: liked ? "like_comment" : "unlike_comment",
        workId,
        commentId,
        pageRole: "creator_center",
        pageTargetId: await this.pageTargetId(page),
      });
      await enforceWritePolicy(liked ? "comment_like" : "comment_unlike", `${page.url()}#${commentId}`);
      await like.click();
      await page.waitForTimeout(CONFIG.actionDelayMs);
    }
    const afterLiked = await state();
    if (afterLiked !== liked) {
      throw new Error("VALIDATION_FAILED:creator_center 评论点赞状态没有按预期变化；没有重复点击。");
    }
    const artifact = await this.saveCommentArtifact(page, liked ? "creator-comment-like" : "creator-comment-unlike", {
      workId,
      commentId,
      adapter: "creator_center",
      beforeLiked,
      afterLiked,
    });
    appendActionLog(this.actionLogBase(
      liked ? "douyin_like_comment" : "douyin_unlike_comment",
      liked ? "comment_like" : "comment_unlike",
      {
        workUrl: `${page.url()}#${workId}`,
        author: resolved.target.author,
        beforeState: String(beforeLiked),
        afterState: String(afterLiked),
        success: true,
      },
    ));
    return {
      action: "send",
      sent: beforeLiked !== afterLiked,
      targetWorkId: workId,
      targetCommentId: commentId,
      commentId,
      text: "",
      account: loadActionSettings().operator.displayName,
      author: resolved.target.author,
      duplicateDetected: beforeLiked === liked,
      verified: true,
      beforeLiked,
      afterLiked,
      changed: beforeLiked !== afterLiked,
      ...artifact,
    };
  }

  async setCommentLike(
    commentId: string,
    liked: boolean,
    workId?: string,
    scope?: TargetWriteScope,
    alias?: string,
  ): Promise<CommentActionResult> {
    return this.serial(async () => {
      if (workId && (!scope || scope === "own_post")) {
        return this.setCreatorCenterCommentLike(workId, commentId, liked);
      }
      const resolvedScope: TargetWriteScope = scope
        ?? (this.lockedWorkContexts.get("operator_home")?.alias === "self"
          ? "own_post"
          : "bound_user_post");
      const targetWorkId = workId
        ?? this.lockedWorkContexts.get(resolvedScope === "external_post"
          ? "codex_test"
          : "operator_home")?.workId;
      if (!targetWorkId) throw new Error("TARGET_WORK_REQUIRED:评论点赞必须提供精确 work_id。");
      const scoped = await this.createScopedTargetGate({
        scope: resolvedScope,
        actionType: liked ? "like_comment" : "unlike_comment",
        workId: targetWorkId,
        commentId,
        alias,
      });
      const page = scoped.page;
      const context = scoped.context;
      await this.loadComments(page, 100);
      const targetCandidates = [
        page.locator(`[data-comment-id="${commentId}"]`),
        page.locator(`[data-e2e='comment-item']:has(#tooltip_${commentId})`),
        page.locator(`#tooltip_${commentId}`).locator("xpath=ancestor::*[@data-e2e='comment-item'][1]"),
      ];
      let target: Locator | null = null;
      for (const candidate of targetCandidates) {
        if (await candidate.count() === 1) {
          target = candidate;
          break;
        }
      }
      if (!target) {
        const adapter = /\/article\//.test(context.url)
          ? "article"
          : /\/note\//.test(context.url)
            ? "note"
            : "video";
        throw new Error(
          `CAPABILITY_UNAVAILABLE:${adapter} 评论没有稳定 comment_id 容器，未点击。`,
        );
      }
      const adapterSelectors: Record<string, string> = {
        video: "button[aria-label*='赞'],button[title*='赞'],[data-e2e*='comment-like'],[class*='comment-item-stats'] button",
        note: "button[aria-label*='赞'],button[title*='赞'],[data-e2e*='comment-like'],[class*='comment-item-stats'] [role='button'],[class*='comment-item-stats'] button",
        article: "button[aria-label*='赞'],button[title*='赞'],[data-e2e*='comment-like'],[class*='comment-item-stats'] [role='button'],[class*='comment-item-stats'] button",
      };
      const adapter = /\/article\//.test(context.url)
        ? "article"
        : /\/note\//.test(context.url)
          ? "note"
          : "video";
      const selector = adapterSelectors[adapter];
      if (!selector) {
        throw new Error(`CAPABILITY_UNAVAILABLE:${adapter} 评论点赞适配器不可用，未点击。`);
      }
      const semanticCandidates = target.locator(selector);
      let like = await semanticCandidates.count() === 1
        && await semanticCandidates.first().isVisible().catch(() => false)
        ? semanticCandidates.first()
        : null;
      if (!like) {
        const stats = target.locator("[class*='comment-item-stats']").first();
        const adapterFallback = stats.locator(":scope > div").first();
        if (await stats.count() === 1 && await adapterFallback.isVisible().catch(() => false)) {
          like = adapterFallback;
        }
      }
      if (!like) {
        throw new Error(
          `CAPABILITY_UNAVAILABLE:${adapter} 评论点赞入口不唯一或不可见，未点击。`,
        );
      }
      const state = async () => {
        const hint = `${await like.getAttribute("aria-pressed")} ${await like.getAttribute("data-liked")} ${await like.getAttribute("class")}`;
        if (/true|liked|active|selected/i.test(hint)) return true;
        if (/false|unliked|inactive/i.test(hint)) return false;
        return like.evaluate(element => {
          const color = getComputedStyle(element).color.match(/\d+/g)?.map(Number) ?? [];
          if (color.length < 3) return null;
          const [red, green, blue] = color;
          if (red >= 220 && green <= 100 && blue <= 130) return true;
          if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 20) return false;
          return null;
        });
      };
      const beforeLiked = await state();
      if (beforeLiked == null) {
        throw new Error(`CAPABILITY_UNAVAILABLE:${adapter} 评论点赞状态无法可靠判定，未点击。`);
      }
      if (beforeLiked !== liked) {
        assertTargetWriteGate(scoped.gate, {
          scope: resolvedScope,
          actionType: liked ? "like_comment" : "unlike_comment",
          workId: targetWorkId,
          commentId,
          pageRole: scoped.gate.pageRole,
          pageTargetId: await this.pageTargetId(page),
        });
        await enforceWritePolicy(liked ? "comment_like" : "comment_unlike", `${context.url}#${commentId}`);
        await like.click();
        await page.waitForTimeout(CONFIG.actionDelayMs);
      }
      const afterLiked = await state();
      if (afterLiked !== liked) throw new Error("VALIDATION_FAILED:评论点赞状态没有按预期变化。");
      const author = await this.currentAuthor(page, context) ?? "未知作者";
      const artifact = await this.saveCommentArtifact(page, liked ? "comment-like" : "comment-unlike", {
        commentId,
        beforeLiked,
        afterLiked,
      });
      return {
        action: "send",
        sent: beforeLiked !== afterLiked,
        targetWorkId: context.workId,
        targetCommentId: commentId,
        commentId,
        text: "",
        account: loadActionSettings().operator.displayName,
        author,
        duplicateDetected: beforeLiked === liked,
        verified: true,
        beforeLiked,
        afterLiked,
        changed: beforeLiked !== afterLiked,
        ...artifact,
      };
    }, { restoreOnError: false });
  }

  async readOwnWorkComments(limit: number): Promise<CommentReadResult> {
    return this.serial(async () => {
      const page = await this.formalOperatorPage();
      const context = await this.captureWorkContext(page);
      const author = await this.currentAuthor(page, context);
      if (author !== loadActionSettings().operator.displayName) {
        throw new Error("WRONG_PAGE:当前正式页作品作者不是 Operator。");
      }
      await this.loadComments(page, limit);
      const comments = await this.parseComments(page, limit, true, 20);
      return {
        url: context.url,
        workId: context.workId,
        sort: "latest" as const,
        comments,
        count: comments.length,
        privacyFiltered: true as const,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async listUnreadComments(limit: number): Promise<CommentReadResult & { unreadOnly: true }> {
    const result = await this.readOwnWorkComments(Math.min(100, Math.max(limit, 20)));
    const unread = result.comments.filter(comment => /未读/.test(comment.time ?? "")).slice(0, limit);
    return { ...result, comments: unread, count: unread.length, unreadOnly: true };
  }

  private async profileWorks(page: Page): Promise<Array<{ workId: string; url: string; title: string }>> {
    const operator = loadActionSettings().operator;
    const profileUrl = `https://www.douyin.com/user/${operator.secUid}`;
    if (!page.url().startsWith(profileUrl)) {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(CONFIG.actionDelayMs);
    }
    await this.assertOperatorAccount(page);
    return page.evaluate(() => {
      const seen = new Set<string>();
      const result: Array<{ workId: string; url: string; title: string }> = [];
      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>(
        "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
      ))) {
        const match = anchor.href.match(/\/(?:video|note|article)\/(\d{8,})/);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);
        result.push({
          workId: match[1],
          url: anchor.href,
          title: (anchor.innerText || anchor.textContent || anchor.getAttribute("title") || "")
            .replace(/\s+/g, " ")
            .trim(),
        });
      }
      return result;
    });
  }

  private async publishVerificationScreenshot(page: Page, name: string): Promise<string> {
    const directory = path.join(CONFIG.runtimeDir, "publish-diagnostics", "post-publish");
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`);
    await page.screenshot({ path: file, type: "png", fullPage: false });
    return file;
  }

  private async verifyPublishedText(
    result: PublishTextResult,
    expected: { title: string; text: string; hashtags: string[]; previewId: string },
  ): Promise<PublishTextResult> {
    const baseline = this.publishVerificationBaselines.get(expected.previewId);
    const page = await this.formalOperatorPage();
    const works = await this.profileWorks(page);
    const profileScreenshot = await this.publishVerificationScreenshot(page, "profile");
    const work = result.work_id
      ? works.find(item => item.workId === result.work_id)
      : works.find(item => item.title.includes(expected.title));
    if (!work) {
      return {
        ...result,
        status: "needs_user_action",
        published: false,
        errorCode: "PUBLISH_EVIDENCE_INCOMPLETE",
        errorStep: "verify_profile",
        errorMessage: "发布动作返回了 work_id，但 Operator 主页作品列表没有出现目标作品；不会误报成功或自动重试。",
        profile_work_count_before: baseline?.profileWorkCount ?? null,
        profile_work_count_after: works.length,
        screenshots: {
          publish_result: result.screenshotPath,
          profile: profileScreenshot,
          work_detail: "",
        },
      };
    }
    await page.goto(work.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(CONFIG.actionDelayMs);
    const context = await this.captureWorkContext(page);
    if (context.workId !== work.workId) throw new Error("WRONG_PAGE:作品详情 work_id 与主页条目不一致。");
    const author = await this.currentAuthor(page, context);
    const detail = await page.evaluate(({ title, text, hashtags }) => {
      const clean = (value: string | null | undefined) => (value ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const body = clean(document.body.innerText);
      const titleVerified = clean(document.title).includes(clean(title))
        || Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,[role='heading']"))
          .some(element => clean(element.innerText || element.textContent) === clean(title));
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "article,[data-e2e*='article-content'],[class*='article-content'],[class*='ArticleContent']",
      )).map(element => clean(element.innerText || element.textContent));
      const textVerified = candidates.some(candidate => candidate.includes(clean(text)));
      const actualTags = [...new Set((body.match(/#[^\s#，,、]+/g) ?? []).map(value => value.replace(/^#/, "")))];
      const hashtagsVerified = hashtags.every(tag => actualTags.some(actual => {
        const left = actual.replace(/^#/, "").trim();
        const right = tag.replace(/^#/, "").trim();
        return /^[\x00-\x7F]+$/.test(left + right)
          ? left.toLowerCase() === right.toLowerCase()
          : left === right;
      }));
      const coverVerified = Boolean(
        document.querySelector("meta[property='og:image'][content]")
        || Array.from(document.querySelectorAll<HTMLImageElement>("article img,main img"))
          .some(image => image.naturalWidth > 200 && image.naturalHeight > 120),
      );
      return {
        titleVerified,
        textVerified,
        hashtagsVerified,
        coverVerified,
        privateOrDraft: /仅自己可见|私密作品|草稿/.test(body),
        publishedAt: body.match(/\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0] ?? null,
        body,
      };
    }, { title: expected.title, text: expected.text, hashtags: expected.hashtags });
    const lockedSnapshot = result.snapshot as {
      music?: { selected?: boolean; title?: string | null; explicitNone?: boolean };
      visibility?: string;
    } | undefined;
    const musicVerified = lockedSnapshot?.music?.selected
      ? Boolean(lockedSnapshot.music.title && detail.body.includes(lockedSnapshot.music.title))
      : true;
    const authorVerified = author === loadActionSettings().operator.displayName;
    const countVerified = baseline
      ? works.length > baseline.profileWorkCount || works.some(item => item.workId === work.workId)
      : works.some(item => item.workId === work.workId);
    const workDetailScreenshot = await this.publishVerificationScreenshot(page, "work-detail");
    const allVerified = detail.titleVerified
      && detail.textVerified
      && detail.hashtagsVerified
      && detail.coverVerified
      && musicVerified
      && authorVerified
      && countVerified
      && !detail.privateOrDraft;
    if (!allVerified) {
      return {
        ...result,
        status: "needs_user_action",
        published: false,
        errorCode: "PUBLISH_EVIDENCE_INCOMPLETE",
        errorStep: "verify_work_detail",
        errorMessage: "作品已出现在主页，但标题、正文、话题、封面、音乐、作者、可见性或详情页证据未全部通过；不会误报成功。",
        profile_work_count_before: baseline?.profileWorkCount ?? null,
        profile_work_count_after: works.length,
        title_verified: detail.titleVerified,
        text_verified: detail.textVerified,
        hashtags_verified: detail.hashtagsVerified,
        cover_verified: detail.coverVerified,
        music_verified: musicVerified,
        screenshots: {
          publish_result: result.screenshotPath,
          profile: profileScreenshot,
          work_detail: workDetailScreenshot,
        },
      };
    }
    this.publishVerificationBaselines.delete(expected.previewId);
    markTextPreviewPublished(expected.previewId, {
      workId: work.workId,
      workUrl: work.url,
    });
    return {
      ...result,
      status: "published",
      published: true,
      work_id: work.workId,
      work_url: work.url,
      content_type: /\/article\//.test(work.url) ? "article" : /\/note\//.test(work.url) ? "note" : "video",
      profile_work_count_before: baseline?.profileWorkCount ?? null,
      profile_work_count_after: works.length,
      title_verified: true,
      text_verified: true,
      hashtags_verified: true,
      cover_verified: true,
      music_verified: true,
      visibility: lockedSnapshot?.visibility ?? "公开",
      published_at: detail.publishedAt ?? new Date().toISOString(),
      screenshots: {
        publish_result: result.screenshotPath,
        profile: profileScreenshot,
        work_detail: workDetailScreenshot,
      },
      errorCode: null,
      errorStep: null,
      errorMessage: null,
    };
  }

  private async publisherPage(): Promise<Page> {
    await this.ensurePageRoles();
    const page = this.rolePages.get("publisher");
    if (!page || page.isClosed()) {
      throw new Error("PAGE_BINDING_LOST:已绑定的正式发布页不存在；不会自动新建空白发布页。");
    }
    assertDouyinPublishPage(page.url());
    const persisted = loadPageBindings().get("publisher");
    const targetId = await this.pageTargetId(page);
    if (!persisted || persisted.targetId !== targetId) {
      throw new Error("PAGE_BINDING_LOST:当前 creator 标签页与持久化 target_id 不一致。");
    }
    await this.assertOperatorAccount(page);
    return page;
  }

  private async verifyPublishedPostOperation(
    operation: PostPublishOperationRecord,
  ): Promise<{
    confirmed: boolean;
    workId: string | null;
    workUrl: string | null;
    reason: string | null;
  }> {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("PUBLISH_READBACK_BROWSER_CONTEXT_MISSING");
    const page = await this.createAutomationPage(context, "transient:publish_readback");
    try {
      return await this.verifyPublishedPostOperationOnPage(page, operation);
    } finally {
      await page.close().catch(() => null);
    }
  }

  private async verifyPublishedPostOperationOnPage(
    page: Page,
    operation: PostPublishOperationRecord,
  ): Promise<{
    confirmed: boolean;
    workId: string | null;
    workUrl: string | null;
    reason: string | null;
  }> {
    const works = await this.profileWorks(page);
    const expected = operation.snapshot;
    // Douyin currently serializes paragraph breaks in image-post descriptions as
    // a literal "*" prefix ("\n*paragraph") even though the publisher draft did
    // not contain those markers.  Treat the marker as presentation syntax while
    // retaining every user-authored character for the actual comparison.
    const canonicalPublishedText = (value: string | null | undefined) => normalizeText(value)
      .replace(/(^|\n)\s*\*\s*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    const candidates = operation.resultingWorkId
      ? works.filter(item => item.workId === operation.resultingWorkId)
      : works.filter(item => {
        const title = normalizeText(item.title);
        return (
          expected.title
          && title.includes(normalizeText(expected.title))
        ) || (
          expected.caption
          && title.includes(normalizeText(expected.caption).slice(0, 30))
        );
      }).slice(0, 12);
    const fallback = candidates.length ? candidates : works.slice(0, 12);
    const matches: Array<{ workId: string; workUrl: string }> = [];
    for (const work of fallback) {
      await page.goto(work.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(CONFIG.actionDelayMs);
      const context = await this.captureWorkContext(page);
      if (context.workId !== work.workId) continue;
      const author = await this.currentAuthor(page, context);
      if (author !== expected.actorAccount) continue;
      const detail = await page.evaluate((expectedWorkId: string) => {
        const clean = (value: string | null | undefined) => (value ?? "")
          .replace(/\u200b/g, "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        let metadata: {
          description: string;
          title: string;
         imageCount: number;
         author: string;
          createTime: number | null;
        } | null = null;
        for (const script of Array.from(document.scripts)) {
          const raw = script.textContent ?? "";
          if (!raw.includes(expectedWorkId)) continue;
          let candidate: any = null;
          try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            if (String(parsed?.app?.videoDetail?.awemeId ?? "") === expectedWorkId) {
              candidate = parsed.app.videoDetail;
            }
          } catch {
            // React server-component payloads are handled next.
          }
          if (!candidate && raw.startsWith("self.__pace_f.push(")
            && raw.includes(`\\"awemeId\\":\\"${expectedWorkId}`)) {
            try {
              const outer = JSON.parse(raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")));
              const payload = outer?.[1];
              if (typeof payload === "string") {
                const inner = JSON.parse(payload.slice(payload.indexOf(":") + 1));
                const found = inner?.[3]?.aweme?.detail;
                if (String(found?.awemeId ?? "") === expectedWorkId) candidate = found;
              }
            } catch {
              candidate = null;
            }
          }
          if (!candidate) continue;
          metadata = {
            description: clean(candidate.desc ?? candidate.caption ?? ""),
            title: clean(candidate.itemTitle ?? ""),
            imageCount: Array.isArray(candidate.images) ? candidate.images.length : 0,
            author: clean(candidate.authorInfo?.nickname ?? ""),
            createTime: Number.isFinite(Number(candidate.createTime))
              ? Number(candidate.createTime)
              : null,
          };
          break;
        }
        return {
          metadata,
          body: clean(document.body.innerText),
          documentTitle: clean(document.title),
        };
      }, work.workId);
      const actualTitle = detail.metadata?.title || detail.documentTitle;
      const actualCaption = detail.metadata?.description || detail.body;
      const titleVerified = !expected.title
        || normalizeText(actualTitle).includes(normalizeText(expected.title))
        || normalizeText(detail.body).includes(normalizeText(expected.title));
      const captionVerified = !expected.caption
        || canonicalPublishedText(actualCaption).includes(canonicalPublishedText(expected.caption));
      const imageCountVerified = detail.metadata?.imageCount === expected.media.length;
      const metadataAuthorVerified = !detail.metadata?.author
        || detail.metadata.author === expected.actorAccount;
      const createdAtSeconds = Math.floor(new Date(operation.createdAt).getTime() / 1000);
      const timeWindowVerified = !detail.metadata?.createTime
        || (detail.metadata.createTime >= createdAtSeconds - 300
          && detail.metadata.createTime <= Math.floor(Date.now() / 1000) + 300);
      if (titleVerified && captionVerified && imageCountVerified
        && metadataAuthorVerified && timeWindowVerified) {
        matches.push({ workId: work.workId, workUrl: work.url });
      }
    }
    if (matches.length !== 1) {
      return {
        confirmed: false,
        workId: null,
        workUrl: null,
        reason: `PUBLISH_READBACK_NOT_UNIQUE:${matches.length}`,
      };
    }
    return {
      confirmed: true,
      workId: matches[0].workId,
      workUrl: matches[0].workUrl,
      reason: null,
    };
  }

  private async verifyPublishedV2Operation(operation: PublishV2OperationRecord) {
    const draft = publisherV2Store.requireDraft(operation.draftId);
    const snapshot = {
      draftId: draft.draftId,
      contentType: "carousel" as const,
      actorAccount: draft.actorAccount,
      title: draft.intent.title,
      caption: projectedCarouselCaption(draft.intent),
      media: draft.intent.images.map((item, order) => ({ ...item, order })),
      selectedMusic: draft.intent.music,
      coverIndex: draft.intent.images.length ? 0 : null,
      pageTargetId: draft.pageTargetId ?? "publisher-v2",
      pageUrl: draft.pageUrl ?? "https://creator.douyin.com/creator-micro/content/post/image",
      capturedAt: operation.createdAt,
    };
    const compatibleOperation: PostPublishOperationRecord = {
      operationId: operation.operationId,
      draftId: operation.draftId,
      idempotencyKey: operation.idempotencyKey,
      snapshotDigest: operation.semanticHash,
      snapshot,
      state: "publishing",
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      publishClickedAt: operation.clickedAt,
      confirmedAt: null,
      resultingWorkId: operation.resultingWorkId,
      resultingWorkUrl: operation.resultingWorkUrl,
      clickCount: operation.clickCount,
      lastError: operation.lastError,
    };
    let last = await this.verifyPublishedPostOperation(compatibleOperation);
    for (let attempt = 1; attempt < 3 && !last.confirmed; attempt += 1) {
      await sleep(2_000);
      last = await this.verifyPublishedPostOperation(compatibleOperation);
    }
    return last;
  }

  private async inspectPublishedV2Availability(operation: PublishV2OperationRecord): Promise<{
    availability: "available" | "deleted_or_unavailable" | "inconclusive";
    checkedAt: string;
    responseStatus: number | null;
    finalUrl: string | null;
    observedWorkId: string | null;
    reason: string;
  }> {
    const expectedWorkId = operation.resultingWorkId;
    const workUrl = operation.resultingWorkUrl;
    const checkedAt = new Date().toISOString();
    if (!expectedWorkId || !workUrl) {
      return {
        availability: "inconclusive", checkedAt, responseStatus: null, finalUrl: null,
        observedWorkId: null, reason: "PUBLISH_AVAILABILITY_TARGET_MISSING",
      };
    }
    assertDouyinWorkUrl(workUrl);
    const draft = publisherV2Store.requireDraft(operation.draftId);
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new Error("PUBLISH_READBACK_BROWSER_CONTEXT_MISSING");
    const page = await this.createAutomationPage(context, "transient:publish_availability");
    try {
      const response = await page.goto(workUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => null);
      await page.waitForTimeout(CONFIG.actionDelayMs);
      const finalUrl = page.url();
      const detail = await page.evaluate(({ workId, actor, title, caption }) => {
        const bodyText = document.body?.innerText ?? "";
        const url = new URL(location.href);
        const observedWorkId = url.searchParams.get("modal_id")
          ?? url.searchParams.get("aweme_id")
          ?? url.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
          ?? null;
        const normalizedBody = bodyText.replace(/\s+/g, " ").trim();
        const contentSignal = [title, caption.slice(0, 30)]
          .filter(value => value.trim().length >= 4)
          .some(value => normalizedBody.includes(value.replace(/\s+/g, " ").trim()));
        const hasWorkDetailEvidence = Boolean(
          document.querySelector(`[class*="video_${workId}"],video,[data-e2e="video-detail"]`)
          || (normalizedBody.includes(actor) && contentSignal),
        );
        return { bodyText, observedWorkId, hasWorkDetailEvidence };
      }, {
        workId: expectedWorkId,
        actor: draft.actorAccount,
        title: draft.intent.title,
        caption: draft.intent.caption,
      }).catch(() => ({
        bodyText: "", observedWorkId: null, hasWorkDetailEvidence: false,
      }));
      const availability = classifyPublishedWorkAvailability({
        expectedWorkId,
        responseStatus: response?.status() ?? null,
        finalUrl,
        bodyText: detail.bodyText,
        observedWorkId: detail.observedWorkId,
        hasWorkDetailEvidence: detail.hasWorkDetailEvidence,
      });
      return {
        availability,
        checkedAt,
        responseStatus: response?.status() ?? null,
        finalUrl,
        observedWorkId: detail.observedWorkId,
        reason: availability === "available" ? "PUBLISH_WORK_STILL_ONLINE"
          : availability === "deleted_or_unavailable" ? "PUBLISH_WORK_EXPLICITLY_UNAVAILABLE"
            : "PUBLISH_WORK_AVAILABILITY_INCONCLUSIVE",
      };
    } finally {
      await page.close().catch(() => null);
    }
  }

  private publishV2Result(
    operation: PublishV2OperationRecord,
    extra: Record<string, unknown> = {},
  ) {
    this.syncLegacyMigrationForV2(operation);
    const migration = publisherV2Store.getLegacyMigrationByV2Operation(operation.operationId);
    const draft = publisherV2Store.requireDraft(operation.draftId);
    return {
      operation_id: operation.operationId,
      draft_id: operation.draftId,
      content_hash: operation.semanticHash,
      state: operation.state,
      status: operation.state === "published" ? "published"
        : operation.state === "unknown_after_submit" ? "uncertain"
          : operation.state === "prepared" ? "preview_ready" : operation.state,
      clicked: operation.clickCount === 1,
      published: operation.state === "published",
      ever_published: operation.state === "published" || operation.state === "deleted_or_unavailable",
      currently_online: operation.state === "published",
      work_id: operation.resultingWorkId,
      work_url: operation.resultingWorkUrl,
      uncertain: operation.state === "unknown_after_submit",
      recoverable: ["unknown_after_submit", "submitted_unverified", "confirmed_unsent"].includes(operation.state),
      recovery_action: operation.state === "unknown_after_submit"
        ? "call douyin_recover_publish with action=reconcile; use confirm_not_sent only after readback proves no match"
        : null,
      click_count: operation.clickCount,
      created_at: operation.createdAt,
      updated_at: operation.updatedAt,
      last_error: operation.lastError,
      page_sync_digest: draft.pageSyncDigest,
      preview_digest: draft.previewDigest,
      intent: publishIntentSummary(draft.intent),
      legacy_migration: migration ? {
        legacy_operation_id: migration.legacyOperationId,
        legacy_draft_id: migration.legacyDraftId,
        migration_state: migration.migrationState,
      } : null,
      ...extra,
    };
  }

  async publishContentV2(input: {
    contentType: PublishContentType;
    title?: string;
    caption?: string;
    imagePaths?: string[];
    hashtags?: string[];
    music?: import("./post-draft-store.js").PostDraftMusic | null;
    visibility?: PublishVisibility;
    scheduledAt?: string | null;
    mentions?: PublishMentionInput[];
    action: PublishAction;
    confirmPublish: boolean;
    replaceExistingPageDraft: boolean;
  }): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const actor = loadActionSettings().operator.displayName;
      const intent = await buildPublishIntent(input);
      let prepared = publisherV2Store.prepare(actor, intent);
      let operation = prepared.operation;
      const route = publishRouteForContentType(intent.contentType);
      if (operation.state === "published") {
        const availability = await this.inspectPublishedV2Availability(operation);
        publisherV2Store.addEvidence(operation.operationId, "availability_reconcile", availability);
        if (availability.availability === "available") {
          return this.publishV2Result(operation, {
            status: "already_published", existing_operation: true, availability_check: availability,
          });
        }
        if (availability.availability === "inconclusive") {
          return this.publishV2Result(operation, {
            status: "existing_operation_availability_inconclusive",
            existing_operation: true,
            availability_check: availability,
          });
        }
        operation = publisherV2Store.transition(operation.operationId, "deleted_or_unavailable", {
          lastError: availability.reason,
        });
        prepared = publisherV2Store.prepare(actor, intent);
        operation = prepared.operation;
      }
      if (["click_intent_recorded", "submitted_unverified", "unknown_after_submit"].includes(operation.state)) {
        const readback = await this.verifyPublishedV2Operation(operation);
        if (readback.confirmed) {
          operation = publisherV2Store.transition(operation.operationId, "published", {
            workId: readback.workId, workUrl: readback.workUrl, lastError: null,
          });
          return this.publishV2Result(operation, { status: "already_published", existing_operation: true });
        }
        return this.publishV2Result(operation, { status: "existing_operation", existing_operation: true });
      }
      if (["validation_failed", "blocked_before_click"].includes(operation.state)) {
        if (operation.clickCount !== 0) throw new Error("PUBLISH_PRECLICK_RETRY_REQUIRES_ZERO_CLICKS");
        operation = publisherV2Store.transition(operation.operationId, "prepared", { lastError: null });
      }
      if (operation.state === "aborted") {
        return this.publishV2Result(operation, { status: "aborted", existing_operation: true });
      }
      if (route.adapter !== "carousel") {
        operation = publisherV2Store.transition(operation.operationId, "validation_failed", {
          lastError: `CONTENT_TYPE_NOT_SUPPORTED:${intent.contentType}`,
        });
        return this.publishV2Result(operation, { clicked: false, error_code: "CONTENT_TYPE_NOT_SUPPORTED" });
      }
      if (intent.images.length < 1 || intent.images.length > 35) {
        operation = publisherV2Store.transition(operation.operationId, "validation_failed", {
          lastError: "CAROUSEL_IMAGE_COUNT_INVALID",
        });
        return this.publishV2Result(operation, { clicked: false, error_code: "CAROUSEL_IMAGE_COUNT_INVALID" });
      }
      if (intent.visibility !== "public" || intent.scheduledAt) {
        operation = publisherV2Store.transition(operation.operationId, "validation_failed", {
          lastError: "PUBLISH_SETTING_NOT_SUPPORTED_IN_V2_CAROUSEL",
        });
        return this.publishV2Result(operation, { clicked: false, error_code: "PUBLISH_SETTING_NOT_SUPPORTED" });
      }

      const page = await this.publisherPage();
      let inspection;
      try {
        const existingInspection = /\/creator-micro\/content\/post\/image/.test(page.url())
          ? await inspectCarouselPage(page, { captureArtifacts: false }).catch(() => null)
          : null;
        inspection = existingInspection && carouselSemanticMatches({
          intent,
          title: existingInspection.title,
          caption: existingInspection.caption,
          hashtags: existingInspection.hashtags,
          plainHashtags: existingInspection.plainHashtags,
          imageCount: existingInspection.imageCount,
          imageOrder: existingInspection.uploadOrder,
          music: existingInspection.selectedMusic,
          mentionInspection: existingInspection,
        }) && existingInspection.publishButtonCount === 1
          ? await inspectCarouselPage(page)
          : await syncCarouselDraftToPage(
              page,
              asCarouselDraft(publisherV2Store.requireDraft(operation.draftId)),
              { confirmReplacePageDraft: input.replaceExistingPageDraft },
            );
        await dismissCarouselTransientOverlays(page);
        inspection = await inspectCarouselPage(page);
        const matches = carouselSemanticMatches({
          intent,
          title: inspection.title,
          caption: inspection.caption,
          hashtags: inspection.hashtags,
          plainHashtags: inspection.plainHashtags,
          imageCount: inspection.imageCount,
          imageOrder: inspection.uploadOrder,
          music: inspection.selectedMusic,
          mentionInspection: inspection,
        });
        if (!matches || inspection.publishButtonCount !== 1 || !inspection.readyToPublish) {
          throw new Error("PUBLISH_SEMANTIC_VALIDATION_FAILED");
        }
        operation = publisherV2Store.markPrepared(operation.operationId, {
          pageTargetId: await this.pageTargetId(page),
          pageUrl: inspection.pageUrl,
          pageSyncDigest: operation.semanticHash,
          previewDigest: operation.semanticHash,
        });
        publisherV2Store.addEvidence(operation.operationId, "semantic_preview", {
          semanticHash: operation.semanticHash,
          routedContentType: route.contentType,
          directUrl: route.directUrl,
          pageUrl: inspection.pageUrl,
          title: inspection.title,
          caption: inspection.caption,
          hashtags: inspection.hashtags,
          plainHashtags: inspection.plainHashtags,
          imageCount: inspection.imageCount,
          imageOrder: inspection.uploadOrder,
          publishButtonCount: inspection.publishButtonCount,
          nativeMentions: inspection.nativeMentions,
          plainTextMentions: inspection.plainTextMentions,
          unresolvedMentions: inspection.unresolvedMentions,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const blocked = /POST_PAGE_DRAFT_CONFLICT/.test(message);
        operation = publisherV2Store.transition(
          operation.operationId,
          blocked ? "blocked_before_click" : "validation_failed",
          { lastError: message },
        );
        return this.publishV2Result(operation, {
          clicked: false,
          error_code: blocked ? "PAGE_DRAFT_CONFLICT" : "VALIDATION_FAILED",
        });
      }

      if (input.action === "prepare") {
        return this.publishV2Result(operation, {
          screenshot_path: inspection.screenshotPath,
          page_url: inspection.pageUrl,
          page_target_id: await this.pageTargetId(page),
          ready_to_publish: true,
          existing_operation: prepared.existing,
        });
      }
      if (!input.confirmPublish) {
        return this.publishV2Result(operation, {
          clicked: false,
          status: "needs_confirmation",
          error_code: "PUBLISH_CONFIRMATION_REQUIRED",
        });
      }

      // Final semantic validation happens before the durable click-intent CAS.
      const finalInspection = await inspectCarouselPage(page);
      if (!carouselSemanticMatches({
        intent,
        title: finalInspection.title,
        caption: finalInspection.caption,
        hashtags: finalInspection.hashtags,
        plainHashtags: finalInspection.plainHashtags,
        imageCount: finalInspection.imageCount,
        imageOrder: finalInspection.uploadOrder,
        music: finalInspection.selectedMusic,
        mentionInspection: finalInspection,
      }) || finalInspection.publishButtonCount !== 1) {
        operation = publisherV2Store.transition(operation.operationId, "blocked_before_click", {
          lastError: "PUBLISH_SEMANTIC_VALIDATION_FAILED_BEFORE_CLICK",
        });
        return this.publishV2Result(operation, {
          clicked: false, error_code: "PUBLISH_SEMANTIC_VALIDATION_FAILED_BEFORE_CLICK",
        });
      }
      operation = publisherV2Store.transition(operation.operationId, "click_intent_recorded", {
        requestEvidence: {
          semanticHash: operation.semanticHash,
          pageUrl: finalInspection.pageUrl,
          pageTargetId: await this.pageTargetId(page),
          validatedAt: new Date().toISOString(),
        },
      });
      let clicked;
      try {
        clicked = await dispatchPublishCarouselOnce(page, operation.operationId, finalInspection.pageUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        operation = publisherV2Store.transition(operation.operationId, "unknown_after_submit", {
          lastError: `publish_click_dispatch_uncertain:${message}`,
        });
        return this.publishV2Result(operation, { clicked: true, error_code: "PUBLISH_CLICK_DISPATCH_UNCERTAIN" });
      }
      operation = publisherV2Store.transition(operation.operationId, "submitted_unverified", {
        responseEvidence: {
          responseSeen: clicked.responseSeen,
          responseStatus: clicked.responseStatus,
          responseCode: clicked.responseCode,
          responseMessage: clicked.responseMessage,
          possibleSubmit: clicked.possibleSubmit,
          pageUrlAfter: clicked.pageUrlAfter,
        },
        workId: clicked.resultingWorkId,
        workUrl: clicked.resultingWorkUrl,
        lastError: null,
      });
      const readback = await this.verifyPublishedV2Operation(operation);
      operation = readback.confirmed
        ? publisherV2Store.transition(operation.operationId, "published", {
            workId: readback.workId, workUrl: readback.workUrl, lastError: null,
          })
        : publisherV2Store.transition(operation.operationId, "unknown_after_submit", {
            lastError: readback.reason ?? "PUBLISH_READBACK_INCONCLUSIVE",
          });
      return this.publishV2Result(operation, {
        response_seen: clicked.responseSeen,
        response_status: clicked.responseStatus,
        response_code: clicked.responseCode,
        screenshot_path: clicked.screenshotPath,
        diagnostics_path: clicked.diagnosticsPath,
      });
    }, { restoreOnError: false });
  }

  private legacyPublishIntent(legacy: PostPublishOperationRecord): PublishContentIntent {
    return {
      contentType: "carousel",
      title: legacy.snapshot.title,
      caption: legacy.snapshot.caption,
      images: [...legacy.snapshot.media]
        .sort((left, right) => left.order - right.order)
        .map(({ order: _order, ...media }) => media),
      hashtags: [],
      music: legacy.snapshot.selectedMusic,
      visibility: "public",
      scheduledAt: null,
      mentions: [],
    };
  }

  private migrateLegacyPublishOperation(legacy: PostPublishOperationRecord): {
    operation: PublishV2OperationRecord;
    migration: ReturnType<PublisherV2Store["registerLegacyMigration"]>;
    existing: boolean;
  } {
    const existingMigration = publisherV2Store.getLegacyMigration(legacy.operationId);
    if (existingMigration) {
      return {
        operation: publisherV2Store.requireOperation(existingMigration.v2OperationId),
        migration: existingMigration,
        existing: true,
      };
    }
    const prepared = publisherV2Store.prepare(
      legacy.snapshot.actorAccount,
      this.legacyPublishIntent(legacy),
    );
    const migration = publisherV2Store.registerLegacyMigration({
      legacyOperationId: legacy.operationId,
      legacyDraftId: legacy.draftId,
      v2OperationId: prepared.operation.operationId,
      v2DraftId: prepared.draft.draftId,
      migrationState: prepared.operation.state === "published" ? "published" : "prepared",
    });
    publisherV2Store.addEvidence(prepared.operation.operationId, "legacy_migration", {
      legacyOperationId: legacy.operationId,
      legacyDraftId: legacy.draftId,
      legacyState: legacy.state,
      snapshotDigest: legacy.snapshotDigest,
      migratedAt: migration.createdAt,
    });
    return { operation: prepared.operation, migration, existing: prepared.existing };
  }

  private syncLegacyMigrationForV2(operation: PublishV2OperationRecord): void {
    const migration = publisherV2Store.getLegacyMigrationByV2Operation(operation.operationId);
    if (!migration) return;
    const nextState = operation.state === "published" ? "published" : "superseded";
    if (migration.migrationState !== nextState) {
      publisherV2Store.markLegacyMigrationState(migration.legacyOperationId, nextState);
    }
  }

  async getPublishStatusV2(operationId: string, reconcile = true): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      let operation = publisherV2Store.getOperation(operationId);
      if (!operation) {
        const legacy = postDraftStore.getOperation(operationId);
        if (!legacy) throw new Error(`PUBLISH_OPERATION_NOT_FOUND:${operationId}`);
        const migration = publisherV2Store.getLegacyMigration(operationId);
        if (migration) {
          const migratedOperation = publisherV2Store.requireOperation(migration.v2OperationId);
          return {
            ...this.publishV2Result(migratedOperation),
            legacy_operation: true,
            legacy_operation_id: operationId,
            superseded: true,
            superseded_by: migration.v2OperationId,
            migration_state: migration.migrationState,
          };
        }
        const status = await this.getPublishStatus(operationId);
        return { ...status, legacy_operation: true, recovery_tool: "douyin_recover_publish" };
      }
      let availabilityCheck: Record<string, unknown> | null = null;
      if (reconcile && operation.state === "published") {
        const availability = await this.inspectPublishedV2Availability(operation);
        availabilityCheck = availability;
        publisherV2Store.addEvidence(operation.operationId, "availability_reconcile", availability);
        if (availability.availability === "deleted_or_unavailable") {
          operation = publisherV2Store.transition(operationId, "deleted_or_unavailable", {
            lastError: availability.reason,
          });
        }
      } else if (reconcile && ["click_intent_recorded", "submitted_unverified", "unknown_after_submit"].includes(operation.state)) {
        const readback = await this.verifyPublishedV2Operation(operation);
        if (readback.confirmed) {
          operation = publisherV2Store.transition(operationId, "published", {
            workId: readback.workId, workUrl: readback.workUrl, lastError: null,
          });
        }
      }
      this.syncLegacyMigrationForV2(operation);
      return this.publishV2Result(operation, {
        reconciled: reconcile,
        availability_check: availabilityCheck,
      });
    }, { persistPageState: false });
  }

  async recoverPublishV2(
    operationId: string,
    action: "reconcile" | "confirm_not_sent" | "abort" | "resume",
    confirm: boolean,
  ): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      let operation = publisherV2Store.getOperation(operationId);
      if (!operation) {
        let legacy = postDraftStore.requireOperation(operationId);
        const existingMigration = publisherV2Store.getLegacyMigration(operationId);
        if (existingMigration) {
          const migratedOperation = publisherV2Store.requireOperation(existingMigration.v2OperationId);
          return {
            ...this.publishV2Result(migratedOperation),
            legacy_operation: true,
            legacy_operation_id: operationId,
            superseded: true,
            superseded_by: existingMigration.v2OperationId,
            migration_state: existingMigration.migrationState,
          };
        }
        if (action === "reconcile") {
          return { ...(await this.getPublishStatus(operationId)), legacy_operation: true };
        }
        if (!confirm) throw new Error("PUBLISH_RECOVERY_CONFIRMATION_REQUIRED");
        if (action === "abort") {
          if (legacy.state !== "prepared") throw new Error(`PUBLISH_ABORT_UNSAFE:${legacy.state}`);
          legacy = postDraftStore.updateOperation(operationId, {
            state: "rejected", lastError: "aborted_by_operator",
          });
          return { ...legacy, legacy_operation: true, recoverable: false };
        }

        let confirmedUnsent = ["prepared", "failed_before_click"].includes(legacy.state);
        let readbackReason: string | null = null;
        if (!confirmedUnsent) {
          if (!["publish_clicked", "publishing", "unknown_after_submit"].includes(legacy.state)) {
            throw new Error(`PUBLISH_CONFIRM_NOT_SENT_UNSAFE:${legacy.state}`);
          }
          const readback = await this.verifyPublishedPostOperation(legacy);
          if (readback.confirmed) {
            legacy = postDraftStore.updateOperation(operationId, {
              state: "confirmed",
              resultingWorkId: readback.workId,
              resultingWorkUrl: readback.workUrl,
              lastError: null,
            });
            return { ...legacy, legacy_operation: true, published: true };
          }
          readbackReason = readback.reason ?? "no_matching_work";
          const clickedAt = legacy.publishClickedAt ? new Date(legacy.publishClickedAt).getTime() : 0;
          if (!clickedAt || Date.now() - clickedAt < 15_000) {
            throw new Error("PUBLISH_CONFIRM_NOT_SENT_STABILITY_WINDOW_REQUIRED");
          }
          const page = await this.publisherPage();
          const route = new URL(page.url()).pathname;
          let editorProvesUnsent = /\/creator-micro\/content\/upload/.test(route);
          if (/\/creator-micro\/content\/post\/image/.test(route)) {
            const editor = await inspectCarouselPage(page, { captureArtifacts: false });
            const expectedOrder = legacy.snapshot.media.map(item => item.fileName);
            editorProvesUnsent = editor.title === legacy.snapshot.title
              && postCaptionEquivalent(editor.caption, legacy.snapshot.caption)
              && editor.imageCount === legacy.snapshot.media.length
              && editor.uploadOrder.length === expectedOrder.length
              && editor.uploadOrder.every((item, index) => item === expectedOrder[index]);
          }
          if (!editorProvesUnsent) {
            throw new Error("PUBLISH_CONFIRM_NOT_SENT_EDITOR_EVIDENCE_REQUIRED");
          }
          legacy = postDraftStore.updateOperation(operationId, {
            state: "failed_before_click",
            lastError: `confirmed_not_sent:${readbackReason}`,
          });
          confirmedUnsent = true;
        }

        if (action === "confirm_not_sent") {
          return {
            ...legacy,
            legacy_operation: true,
            state: "confirmed_unsent",
            recoverable: true,
            recovery_action: "resume",
          };
        }
        if (action !== "resume" || !confirmedUnsent) {
          throw new Error(`LEGACY_PUBLISH_RECOVERY_UNSUPPORTED:${action}`);
        }
        const migrated = this.migrateLegacyPublishOperation(legacy);
        publisherV2Store.markLegacyMigrationState(operationId, "superseded");
        return {
          ...this.publishV2Result(migrated.operation),
          legacy_operation: true,
          legacy_operation_id: operationId,
          superseded: true,
          superseded_by: migrated.operation.operationId,
          migration_state: "superseded",
          migrated_existing_operation: migrated.existing,
          recovery_action: "call douyin_publish_content with the returned intent to continue under V2",
          resume_intent: publishIntentSummary(this.legacyPublishIntent(legacy)),
        };
      }
      if (action === "reconcile") {
        return this.getPublishStatusV2(operationId, true);
      }
      if (!confirm) throw new Error("PUBLISH_RECOVERY_CONFIRMATION_REQUIRED");
      if (action === "abort") {
        if (!["prepared", "validation_failed", "blocked_before_click", "confirmed_unsent"].includes(operation.state)) {
          throw new Error(`PUBLISH_ABORT_UNSAFE:${operation.state}`);
        }
        operation = publisherV2Store.transition(operationId, "aborted", { lastError: "aborted_by_operator" });
        return this.publishV2Result(operation);
      }
      if (action === "resume") {
        if (operation.state !== "confirmed_unsent") throw new Error(`PUBLISH_RESUME_UNSAFE:${operation.state}`);
        operation = publisherV2Store.transition(operationId, "prepared", { lastError: null });
        return this.publishV2Result(operation, { recovery_action: "call douyin_publish_content again with the same content" });
      }
      if (!["submitted_unverified", "unknown_after_submit"].includes(operation.state)) {
        throw new Error(`PUBLISH_CONFIRM_NOT_SENT_UNSAFE:${operation.state}`);
      }
      const readback = await this.verifyPublishedV2Operation(operation);
      if (readback.confirmed) {
        operation = publisherV2Store.transition(operationId, "published", {
          workId: readback.workId, workUrl: readback.workUrl, lastError: null,
        });
        return this.publishV2Result(operation);
      }
      if (operation.resultingWorkId || operation.responseEvidence?.responseCode === 0
        || operation.responseEvidence?.responseCode === "0") {
        throw new Error("PUBLISH_CONFIRM_NOT_SENT_CONTRADICTS_SUBMIT_EVIDENCE");
      }
      const clickedAt = operation.clickedAt ? new Date(operation.clickedAt).getTime() : 0;
      if (!clickedAt || Date.now() - clickedAt < 15_000) {
        throw new Error("PUBLISH_CONFIRM_NOT_SENT_STABILITY_WINDOW_REQUIRED");
      }
      const draft = publisherV2Store.requireDraft(operation.draftId);
      const publisherPage = await this.publisherPage();
      const route = new URL(publisherPage.url()).pathname;
      let editorProvesUnsent = /\/creator-micro\/content\/upload/.test(route);
      if (/\/creator-micro\/content\/post\/image/.test(route)) {
        const editor = await inspectCarouselPage(publisherPage, { captureArtifacts: false });
        editorProvesUnsent = carouselSemanticMatches({
          intent: draft.intent,
          title: editor.title,
          caption: editor.caption,
          hashtags: editor.hashtags,
          plainHashtags: editor.plainHashtags,
          imageCount: editor.imageCount,
          imageOrder: editor.uploadOrder,
          music: editor.selectedMusic,
          mentionInspection: editor,
        });
      }
      if (!editorProvesUnsent) {
        throw new Error("PUBLISH_CONFIRM_NOT_SENT_EDITOR_EVIDENCE_REQUIRED");
      }
      operation = publisherV2Store.transition(operationId, "confirmed_unsent", {
        lastError: `confirmed_not_sent:${readback.reason ?? "no_matching_work"}`,
      });
      return this.publishV2Result(operation, { recovery_action: "resume" });
    }, { restoreOnError: false, persistPageState: false });
  }

  listPublishOperationsV2(limit: number): Record<string, unknown> {
    const bounded = Math.max(1, Math.min(100, limit));
    const v2Operations = publisherV2Store.list(bounded).map(operation => ({
      ...this.publishV2Result(operation),
      operation_type: "publish_content_v2",
      storage: "publisher_v2",
      legacy_operation: false,
    }));
    const legacyOperations = postDraftStore.listOperations(bounded).map(operation => {
      const migration = publisherV2Store.getLegacyMigration(operation.operationId);
      const superseded = Boolean(migration);
      return {
        operation_id: operation.operationId,
        draft_id: operation.draftId,
        operation_type: "publish_post",
        storage: "legacy_post_publish",
        legacy_operation: true,
        state: superseded ? "superseded" : operation.state,
        status: superseded ? "superseded"
          : operation.state === "confirmed" ? "published"
            : operation.state === "unknown_after_submit" ? "uncertain" : operation.state,
        snapshot_digest: operation.snapshotDigest,
        clicked: operation.clickCount > 0,
        click_count: operation.clickCount,
        published: operation.state === "confirmed",
        uncertain: !superseded && operation.state === "unknown_after_submit",
        recoverable: !superseded && ["prepared", "publish_clicked", "publishing", "unknown_after_submit"]
          .includes(operation.state),
        recovery_action: !superseded && operation.state === "unknown_after_submit"
          ? "call douyin_recover_publish with this operation_id"
          : null,
        superseded,
        superseded_by: migration?.v2OperationId ?? null,
        migration_state: migration?.migrationState ?? null,
        work_id: operation.resultingWorkId,
        work_url: operation.resultingWorkUrl,
        created_at: operation.createdAt,
        updated_at: migration?.updatedAt ?? operation.updatedAt,
        last_error: operation.lastError,
        intent: {
          content_type: operation.snapshot.contentType,
          title: operation.snapshot.title,
          caption: operation.snapshot.caption,
          image_count: operation.snapshot.media.length,
          music: operation.snapshot.selectedMusic,
        },
      };
    });
    const operations = [...v2Operations, ...legacyOperations]
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, bounded);
    return {
      operations,
      count: operations.length,
      v2Operations,
      v2Count: v2Operations.length,
      legacyOperations,
      legacyCount: legacyOperations.length,
    };
  }

  async createPostDraft(): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      await this.publisherPage();
      const record = postDraftStore.create(loadActionSettings().operator.displayName);
      log("create_post_draft", { draftId: record.draftId });
      return postDraftResult(record);
    }, { restoreOnError: false, persistPageState: false });
  }

  async getPostDraft(draftId: string): Promise<PostDraftResult> {
    return postDraftResult(postDraftStore.require(draftId));
  }

  async listPostDrafts(includeTerminal = false): Promise<PostDraftListResult> {
    const items = postDraftStore.list(includeTerminal).map(postDraftResult);
    return {
      items,
      count: items.length,
      includeTerminal,
      readAt: new Date().toISOString(),
    };
  }

  async addPostImages(draftId: string, imagePaths: string[]): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      const media = [...draft.media, ...imagePaths.map(buildPostDraftMedia)];
      return postDraftResult(postDraftStore.updateContent(draftId, { media }));
    }, { restoreOnError: false, persistPageState: false });
  }

  async insertPostImage(
    draftId: string,
    index: number,
    imagePath: string,
  ): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      if (index < 0 || index > draft.media.length) {
        throw new Error(`POST_DRAFT_INDEX_OUT_OF_RANGE:${index}`);
      }
      const media = [...draft.media];
      media.splice(index, 0, buildPostDraftMedia(imagePath));
      return postDraftResult(postDraftStore.updateContent(draftId, { media }));
    }, { restoreOnError: false, persistPageState: false });
  }

  async replacePostImage(
    draftId: string,
    index: number,
    imagePath: string,
  ): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      if (index < 0 || index >= draft.media.length) {
        throw new Error(`POST_DRAFT_INDEX_OUT_OF_RANGE:${index}`);
      }
      const media = [...draft.media];
      media[index] = buildPostDraftMedia(imagePath);
      return postDraftResult(postDraftStore.updateContent(draftId, { media }));
    }, { restoreOnError: false, persistPageState: false });
  }

  async removePostImage(draftId: string, index: number): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      if (index < 0 || index >= draft.media.length) {
        throw new Error(`POST_DRAFT_INDEX_OUT_OF_RANGE:${index}`);
      }
      const media = [...draft.media];
      media.splice(index, 1);
      const coverIndex = draft.coverIndex === null
        ? null
        : draft.coverIndex === index
          ? null
          : draft.coverIndex > index
            ? draft.coverIndex - 1
            : draft.coverIndex;
      return postDraftResult(postDraftStore.updateContent(draftId, {
        media,
        coverIndex,
      }));
    }, { restoreOnError: false, persistPageState: false });
  }

  async reorderPostImages(
    draftId: string,
    orderedIndexes: number[],
  ): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      const expected = draft.media.map((_, index) => index).sort((a, b) => a - b);
      const actual = [...orderedIndexes].sort((a, b) => a - b);
      if (actual.length !== expected.length
        || actual.some((value, index) => value !== expected[index])) {
        throw new Error(
          `POST_DRAFT_REORDER_INVALID:expected=${expected.join(",")}`,
        );
      }
      const media = orderedIndexes.map(index => draft.media[index]);
      const coverIndex = draft.coverIndex === null
        ? null
        : orderedIndexes.indexOf(draft.coverIndex);
      return postDraftResult(postDraftStore.updateContent(draftId, {
        media,
        coverIndex,
      }));
    }, { restoreOnError: false, persistPageState: false });
  }

  async setPostCaption(
    draftId: string,
    input: { caption?: string; title?: string },
  ): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const patch: { caption?: string; title?: string } = {};
      if (input.caption !== undefined) {
        if (input.caption.length > 1_000) throw new Error("POST_CAPTION_TOO_LONG:1000");
        patch.caption = input.caption.replace(/\r\n?/g, "\n").trim();
      }
      if (input.title !== undefined) {
        if (input.title.length > 20) throw new Error("POST_TITLE_TOO_LONG:20");
        patch.title = input.title.trim();
      }
      if (!Object.keys(patch).length) throw new Error("POST_TEXT_PATCH_REQUIRED");
      return postDraftResult(postDraftStore.updateContent(draftId, patch));
    }, { restoreOnError: false, persistPageState: false });
  }

  async setPostCoverIndex(draftId: string, index: number): Promise<PostDraftResult> {
    return this.serial(async () => {
      assertWriteReady();
      const draft = postDraftStore.require(draftId);
      if (index < 0 || index >= draft.media.length) {
        throw new Error(`POST_DRAFT_COVER_OUT_OF_RANGE:${index}`);
      }
      if (index === 0) {
        return postDraftResult(postDraftStore.updateContent(draftId, { coverIndex: 0 }));
      }
      const media = [...draft.media];
      const [cover] = media.splice(index, 1);
      media.unshift(cover);
      return postDraftResult(postDraftStore.updateContent(draftId, {
        media,
        coverIndex: 0,
      }));
    }, { restoreOnError: false, persistPageState: false });
  }

  private async bindPostDraftToPublisherPage(
    page: Page,
    draft: PostDraftRecord,
    confirmReplacePageDraft: boolean,
  ): Promise<{
    draft: PostDraftRecord;
    inspection: Awaited<ReturnType<typeof inspectCarouselPage>>;
    pageAdopted: boolean;
  }> {
    const targetId = await this.pageTargetId(page);
    const alreadySynced = draft.desiredDigest === draft.pageSyncedDigest
      && draft.pageTargetId === targetId
      && draft.pageUrl === page.url();
    if (alreadySynced) {
      return {
        draft,
        inspection: await inspectCarouselPage(page),
        pageAdopted: false,
      };
    }
    const existing = await inspectCarouselPage(page);
    if (carouselInspectionMatchesDraft(existing, draft)) {
      return {
        draft: postDraftStore.markPageSynced(draft.draftId, {
          pageTargetId: targetId,
          pageUrl: page.url(),
        }),
        inspection: existing,
        pageAdopted: true,
      };
    }
    if (!confirmReplacePageDraft) {
      throw new Error(
        "POST_PAGE_DRAFT_CONFLICT:当前 publisher 页面与指定 draft_id 的"
        + "标题、文案、图片数量或上传顺序不一致；未清空、未重新上传。"
        + ` diagnostics=${existing.screenshotPath}`,
      );
    }
    const inspection = await syncCarouselDraftToPage(page, draft, {
      confirmReplacePageDraft: true,
    });
    return {
      draft: postDraftStore.markPageSynced(draft.draftId, {
        pageTargetId: targetId,
        pageUrl: inspection.pageUrl,
      }),
      inspection,
      pageAdopted: false,
    };
  }

  async openPostMusicPicker(
    draftId: string,
    confirmReplacePageDraft = false,
  ): Promise<PostMusicResult> {
    return this.serial(async () => {
      assertWriteReady();
      const unresolved = postDraftStore.listUnresolved();
      if (unresolved.length) {
        throw new Error(
          `POST_PUBLISH_GATE_CLOSED:unresolved=${unresolved.map(item => item.operationId).join(",")}`,
        );
      }
      const page = await this.publisherPage();
      const bound = await this.bindPostDraftToPublisherPage(
        page,
        postDraftStore.require(draftId),
        confirmReplacePageDraft,
      );
      const draft = bound.draft;
      const items = await openPostMusicPicker(page);
      const diagnostics = await this.buildPostMusicPickerDebugResult(
        page,
        draft,
        true,
      );
      return {
        draftId,
        draft_id: draftId,
        items,
        selected: draft.selectedMusic,
        pickerOpen: diagnostics.pickerOpen,
        ok: true,
        code: "OK",
        publisherRole: "publisher",
        publisherPageId: "page-publisher",
        publisherUrl: page.url(),
        pageTargetId: diagnostics.pageTargetId,
        draftPageVerified: true,
        pageAdopted: bound.pageAdopted,
        appliedToDraft: false,
        diagnostics,
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false });
  }

  private async buildPostMusicPickerDebugResult(
    page: Page,
    draft: PostDraftRecord | null,
    knownDraftMatch: boolean | null = null,
    captureArtifacts = false,
  ): Promise<PostMusicPickerDebugResult> {
    const pageDiagnostic = await debugPostMusicPicker(page, { captureArtifacts });
    let draftPageVerified = knownDraftMatch;
    if (draft && draftPageVerified === null) {
      const inspection = await inspectCarouselPage(page, { captureArtifacts: false });
      draftPageVerified = carouselInspectionMatchesDraft(inspection, draft);
    }
    const code = !pageDiagnostic.routeVerified
      ? "PUBLISHER_ROUTE_MISMATCH"
      : !pageDiagnostic.editorRootDetected
        ? "PUBLISHER_EDITOR_NOT_READY"
        : !pageDiagnostic.musicEntryFound
          ? "MUSIC_ENTRY_NOT_FOUND"
          : !pageDiagnostic.pickerOpen
            ? "MUSIC_PICKER_NOT_OPEN"
            : !pageDiagnostic.candidateListDetected
              ? "MUSIC_PICKER_CANDIDATES_NOT_LOADED"
              : "OK";
    return {
      ok: code === "OK",
      code,
      draftId: draft?.draftId ?? null,
      draft_id: draft?.draftId ?? null,
      publisherRole: "publisher",
      publisherPageId: "page-publisher",
      publisherUrl: page.url(),
      pageTargetId: await this.pageTargetId(page),
      ...pageDiagnostic,
      draftPageVerified,
      readAt: new Date().toISOString(),
    };
  }

  async debugPostMusicPicker(draftId?: string): Promise<PostMusicPickerDebugResult> {
    return this.serial(async () => {
      const page = await this.publisherPage();
      const draft = draftId ? postDraftStore.require(draftId) : null;
      return this.buildPostMusicPickerDebugResult(page, draft, null, true);
    }, { restoreOnError: false, persistPageState: false });
  }

  async searchPostMusic(draftId: string, query: string): Promise<PostMusicResult> {
    return this.serial(async () => {
      const draft = postDraftStore.require(draftId);
      const page = await this.publisherPage();
      if (draft.pageTargetId !== await this.pageTargetId(page)
        || draft.desiredDigest !== draft.pageSyncedDigest) {
        throw new Error("POST_MUSIC_REQUIRES_SYNCED_DRAFT");
      }
      const items = await searchPostMusic(page, query);
      const diagnostics = await this.buildPostMusicPickerDebugResult(page, draft, true);
      return {
        draftId,
        draft_id: draftId,
        items,
        selected: draft.selectedMusic,
        pickerOpen: diagnostics.pickerOpen,
        ok: true,
        code: "OK",
        publisherRole: "publisher",
        publisherPageId: "page-publisher",
        publisherUrl: page.url(),
        pageTargetId: diagnostics.pageTargetId,
        draftPageVerified: true,
        pageAdopted: false,
        appliedToDraft: false,
        diagnostics,
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false });
  }

  async selectPostMusic(
    draftId: string,
    selector: string | PostMusicCandidateSelector,
  ): Promise<PostMusicResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const draft = postDraftStore.require(draftId);
      if (draft.pageTargetId !== await this.pageTargetId(page)
        || draft.desiredDigest !== draft.pageSyncedDigest) {
        throw new Error("POST_MUSIC_REQUIRES_SYNCED_DRAFT");
      }
      const selected = await selectPostMusicCandidate(page, selector);
      let updated = postDraftStore.updateContent(draftId, {
        selectedMusic: selected,
      });
      updated = postDraftStore.markPageSynced(draftId, {
        pageTargetId: await this.pageTargetId(page),
        pageUrl: page.url(),
      });
      await closePostMusicPicker(page);
      const pageSelected = await readSelectedPostMusic(page);
      if (!pageSelected || pageSelected.title !== updated.selectedMusic?.title) {
        throw new Error("POST_MUSIC_READBACK_MISMATCH");
      }
      return {
        draftId,
        draft_id: draftId,
        items: [],
        selected: updated.selectedMusic,
        pickerOpen: false,
        ok: true,
        code: "OK",
        publisherRole: "publisher",
        publisherPageId: "page-publisher",
        publisherUrl: page.url(),
        pageTargetId: await this.pageTargetId(page),
        draftPageVerified: true,
        pageAdopted: false,
        appliedToDraft: true,
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false });
  }

  async getSelectedPostMusic(draftId: string): Promise<PostMusicResult> {
    return this.serial(async () => {
      const draft = postDraftStore.require(draftId);
      const page = await this.publisherPage();
      if (draft.pageTargetId !== await this.pageTargetId(page)
        || draft.desiredDigest !== draft.pageSyncedDigest
        || draft.pageUrl !== page.url()) {
        throw new Error("POST_MUSIC_REQUIRES_SYNCED_DRAFT");
      }
      const selectedOnPage = await readSelectedPostMusic(page);
      if (draft.selectedMusic
        ? selectedOnPage?.title !== draft.selectedMusic.title
        : selectedOnPage !== null) {
        throw new Error("POST_MUSIC_READBACK_MISMATCH");
      }
      const pickerOpen = await isPostMusicPickerOpen(page);
      return {
        draftId,
        draft_id: draftId,
        items: pickerOpen ? await readPostMusicCandidates(page) : [],
        selected: draft.selectedMusic,
        pickerOpen,
        ok: true,
        code: "OK",
        publisherRole: "publisher",
        publisherPageId: "page-publisher",
        publisherUrl: page.url(),
        pageTargetId: await this.pageTargetId(page),
        draftPageVerified: true,
        pageAdopted: false,
        appliedToDraft: Boolean(draft.selectedMusic),
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async removePostMusic(draftId: string): Promise<PostMusicResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const draft = postDraftStore.require(draftId);
      if (draft.pageTargetId !== await this.pageTargetId(page)
        || draft.desiredDigest !== draft.pageSyncedDigest
        || draft.pageUrl !== page.url()) {
        throw new Error("POST_MUSIC_REQUIRES_SYNCED_DRAFT");
      }
      if (!draft.selectedMusic) {
        throw new Error("POST_MUSIC_NOT_SELECTED");
      }
      await removeSelectedPostMusic(page);
      postDraftStore.updateContent(draftId, { selectedMusic: null });
      const updated = postDraftStore.markPageSynced(draftId, {
        pageTargetId: await this.pageTargetId(page),
        pageUrl: page.url(),
      });
      return {
        draftId,
        draft_id: draftId,
        items: [],
        selected: null,
        pickerOpen: false,
        ok: true,
        code: "OK",
        publisherRole: "publisher",
        publisherPageId: "page-publisher",
        publisherUrl: page.url(),
        pageTargetId: await this.pageTargetId(page),
        draftPageVerified: true,
        pageAdopted: false,
        appliedToDraft: updated.selectedMusic === null,
        readAt: new Date().toISOString(),
      };
    }, { restoreOnError: false });
  }

  async previewPost(
    draftId: string,
    confirmReplacePageDraft = false,
  ): Promise<PostPreviewResult> {
    return this.serial(async () => {
      assertWriteReady();
      const unresolved = postDraftStore.listUnresolved();
      if (unresolved.length) {
        throw new Error(
          `POST_PUBLISH_GATE_CLOSED:unresolved=${unresolved.map(item => item.operationId).join(",")}`,
        );
      }
      const page = await this.publisherPage();
      let draft = postDraftStore.require(draftId);
      if (!draft.media.length) throw new Error("POST_DRAFT_MEDIA_REQUIRED");
      const bound = await this.bindPostDraftToPublisherPage(
        page,
        draft,
        confirmReplacePageDraft,
      );
      draft = bound.draft;
      const inspection = bound.inspection;
      const targetId = await this.pageTargetId(page);
      if (inspection.title !== draft.title
        || !postCaptionEquivalent(inspection.caption, draft.caption)
        || inspection.imageCount !== draft.media.length
        || inspection.imageCardCount !== draft.media.length
        || !carouselInspectionMatchesDraft(inspection, draft)) {
        throw new Error("POST_DRAFT_PAGE_READBACK_MISMATCH");
      }
      const snapshot = buildPostDraftSnapshot(
        draft,
        targetId,
        inspection,
      );
      const operation = postDraftStore.preparePublish(draftId, snapshot);
      const persisted = postDraftStore.require(draftId);
      return {
        draftId,
        draft_id: draftId,
        draft: postDraftResult(persisted),
        operationId: operation.operationId,
        operation_id: operation.operationId,
        operationState: operation.state === "confirmed" ? "confirmed" : "prepared",
        imageCount: persisted.media.length,
        imageOrder: persisted.media.map(item => item.fileName),
        caption: persisted.caption,
        title: persisted.title,
        music: persisted.selectedMusic,
        coverIndex: persisted.coverIndex,
        readyToPublish: inspection.readyToPublish,
        pageUrl: inspection.pageUrl,
        pageTargetId: snapshot.pageTargetId,
        screenshotPath: inspection.screenshotPath,
        screenshotBase64: inspection.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async publishPost(
    operationId: string,
    confirmPublish: boolean,
  ): Promise<PostPublishResult> {
    return this.serial(async () => {
      assertWriteReady();
      if (!confirmPublish) throw new Error("POST_PUBLISH_CONFIRMATION_REQUIRED");
      const page = await this.publisherPage();
      const current = postDraftStore.requireOperation(operationId);
      const otherUnresolved = postDraftStore.listUnresolved()
        .filter(item => item.operationId !== operationId);
      if (otherUnresolved.length) {
        throw new Error(
          `POST_PUBLISH_GATE_CLOSED:unresolved=${otherUnresolved.map(item => item.operationId).join(",")}`,
        );
      }
      if (current.state === "confirmed") {
        return {
          operationId,
          operation_id: operationId,
          draftId: current.draftId,
          draft_id: current.draftId,
          state: "confirmed",
          published: true,
          clicked: false,
          clickCount: current.clickCount,
          possibleSubmit: true,
          responseSeen: false,
          responseStatus: null,
          responseCode: null,
          responseMessage: null,
          resultingWorkId: current.resultingWorkId,
          resultingWorkUrl: current.resultingWorkUrl,
          pageUrlAfter: null,
          screenshotPath: null,
          screenshotBase64: null,
          diagnosticsPath: null,
          lastError: current.lastError,
        };
      }
      if (current.state !== "prepared") {
        return {
          operationId,
          operation_id: operationId,
          draftId: current.draftId,
          draft_id: current.draftId,
          state: current.state,
          published: false,
          clicked: false,
          clickCount: current.clickCount,
          possibleSubmit: ["publish_clicked", "publishing", "unknown_after_submit"]
            .includes(current.state),
          responseSeen: false,
          responseStatus: null,
          responseCode: null,
          responseMessage: null,
          resultingWorkId: current.resultingWorkId,
          resultingWorkUrl: current.resultingWorkUrl,
          pageUrlAfter: null,
          screenshotPath: null,
          screenshotBase64: null,
          diagnosticsPath: null,
          lastError: current.lastError,
        };
      }
      if (current.snapshot.pageTargetId !== await this.pageTargetId(page)
        || current.snapshot.pageUrl !== page.url()) {
        throw new Error("POST_PUBLISH_PAGE_BINDING_MISMATCH");
      }
      const claimed = postDraftStore.claimPublish(operationId);
      if (!claimed.transitioned) {
        throw new Error(`POST_PUBLISH_ALREADY_CLAIMED:${claimed.operation.state}`);
      }
      let clicked;
      try {
        clicked = await clickPublishCarouselOnce(page, claimed.operation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        postDraftStore.updateOperation(operationId, {
          state: "unknown_after_submit",
          lastError: `publish_click_or_observation_failed:${message}`,
        });
        throw error;
      }
      postDraftStore.updateOperation(operationId, {
        state: clicked.possibleSubmit ? "publishing" : "unknown_after_submit",
        resultingWorkId: clicked.resultingWorkId,
        resultingWorkUrl: clicked.resultingWorkUrl,
        lastError: clicked.possibleSubmit ? null : "publish_click_no_confirmable_signal",
      });
      const operation = postDraftStore.requireOperation(operationId);
      const readback = await this.verifyPublishedPostOperation(operation);
      const final = readback.confirmed
        ? postDraftStore.updateOperation(operationId, {
          state: "confirmed",
          resultingWorkId: readback.workId,
          resultingWorkUrl: readback.workUrl,
          lastError: null,
        })
        : postDraftStore.updateOperation(operationId, {
          state: "unknown_after_submit",
          resultingWorkId: clicked.resultingWorkId,
          resultingWorkUrl: clicked.resultingWorkUrl,
          lastError: readback.reason,
        });
      return {
        operationId,
        operation_id: operationId,
        draftId: final.draftId,
        draft_id: final.draftId,
        state: final.state,
        published: final.state === "confirmed",
        clicked: clicked.clickIssued,
        clickCount: final.clickCount,
        possibleSubmit: clicked.possibleSubmit,
        responseSeen: clicked.responseSeen,
        responseStatus: clicked.responseStatus,
        responseCode: clicked.responseCode,
        responseMessage: clicked.responseMessage,
        resultingWorkId: final.resultingWorkId,
        resultingWorkUrl: final.resultingWorkUrl,
        pageUrlAfter: clicked.pageUrlAfter,
        screenshotPath: clicked.screenshotPath,
        screenshotBase64: clicked.screenshotBase64,
        diagnosticsPath: clicked.diagnosticsPath,
        lastError: final.lastError,
      };
    }, { restoreOnError: false });
  }

  async getPublishStatus(operationId: string): Promise<PostPublishStatusResult> {
    return this.serial(async () => {
      let operation = postDraftStore.requireOperation(operationId);
      let readbackAttempted = false;
      let readbackConfirmed = operation.state === "confirmed";
      if (["publish_clicked", "publishing", "unknown_after_submit"].includes(operation.state)) {
        readbackAttempted = true;
        const readback = await this.verifyPublishedPostOperation(operation);
        if (readback.confirmed) {
          operation = postDraftStore.updateOperation(operationId, {
            state: "confirmed",
            resultingWorkId: readback.workId,
            resultingWorkUrl: readback.workUrl,
            lastError: null,
          });
          readbackConfirmed = true;
        } else if (operation.state !== "unknown_after_submit") {
          operation = postDraftStore.updateOperation(operationId, {
            state: "unknown_after_submit",
            lastError: readback.reason,
          });
        }
      }
      return {
        operationId,
        operation_id: operationId,
        draftId: operation.draftId,
        draft_id: operation.draftId,
        state: operation.state,
        published: operation.state === "confirmed",
        clickCount: operation.clickCount,
        resultingWorkId: operation.resultingWorkId,
        resultingWorkUrl: operation.resultingWorkUrl,
        lastError: operation.lastError,
        readbackAttempted,
        readbackConfirmed,
        checkedAt: new Date().toISOString(),
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async publishText(options: {
    text: string;
    title?: string;
    hashtags?: string[];
    action?: "preview" | "publish";
    confirmPublish?: boolean;
    coverPath?: string;
    previewId?: string;
    musicQuery?: string;
    musicId?: string;
    musicRequired?: boolean;
    workflowStep?: "fill_text" | "preview";
    resumeOnly?: boolean;
  }): Promise<PublishTextResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      let result = await prepareTextPublication(page, {
        ...options,
        loginConfirmed: true,
        binding: {
          pageId: this.pageId(page),
          targetId: await this.pageTargetId(page),
          account: loadActionSettings().operator.displayName,
        },
      });
      if (result.status === "preview_ready" && result.previewId) {
        try {
          const homePage = await this.formalOperatorPage();
          const works = await this.profileWorks(homePage);
          this.publishVerificationBaselines.set(result.previewId, {
            profileWorkCount: works.length,
            title: result.title ?? "",
            text: result.text,
            hashtags: result.hashtags,
          });
          result.profile_work_count_before = works.length;
        } catch (error) {
          result = {
            ...result,
            status: "blocked",
            published: false,
            errorCode: "PAGE_BINDING_LOST",
            errorStep: "capture_profile_baseline",
            errorMessage: error instanceof Error ? error.message : String(error),
            missing: [...new Set([...(result.missing ?? []), "PAGE_BINDING_LOST"])],
          };
        }
      } else if (result.status === "publishing" && result.previewId) {
        result = await this.verifyPublishedText(result, {
          title: result.title ?? "",
          text: result.text,
          hashtags: result.hashtags,
          previewId: result.previewId,
        });
        if (!result.published) result.uncertain = true;
      }
      log("publish_text", {
        status: result.status,
        action: result.requestedAction,
        published: result.published,
        textCharacters: result.text.length,
        titleCharacters: result.title?.length ?? 0,
        hashtagCount: result.hashtags.length,
        pageUrl: result.pageUrl,
        diagnosticsPath: result.diagnosticsPath,
      });
      return result;
    }, { restoreOnError: false });
  }

  async fillTextDraft(options: {
    text: string;
    title?: string;
    hashtags?: string[];
  }): Promise<PublishTextResult> {
    return this.publishText({
      ...options,
      action: "preview",
      workflowStep: "fill_text",
    });
  }

  async previewTextDraft(options: {
    text: string;
    title?: string;
    hashtags?: string[];
    musicRequired?: boolean;
  }): Promise<PublishTextResult> {
    return this.publishText({
      ...options,
      action: "preview",
      workflowStep: "preview",
      resumeOnly: true,
    });
  }

  async verifyTextPublish(previewId: string): Promise<PublishTextResult> {
    return this.serial(async () => {
      const record = getTextPreviewRecord(previewId);
      if (!record) throw new Error("SNAPSHOT_REQUIRED");
      const snapshot = record.snapshot;
      const result: PublishTextResult = {
        status: record.published ? "published" : "publishing",
        requestedAction: "publish",
        published: record.published,
        text: snapshot.text,
        title: snapshot.title,
        hashtags: snapshot.hashtags,
        entryFound: true,
        editorFound: true,
        contentFilled: true,
        previewReached: true,
        verifiedText: true,
        verifiedTitle: true,
        pageUrl: snapshot.pageUrl,
        pageTitle: "抖音创作者中心",
        detectedEntry: "已绑定的发布文章编辑器",
        screenshotPath: "",
        diagnosticsPath: "",
        screenshotBase64: "",
        errorCode: null,
        errorStep: null,
        errorMessage: null,
        previewId,
        pageId: snapshot.pageId,
        pageTargetId: snapshot.pageTargetId,
        snapshot: snapshot as unknown as Record<string, unknown>,
        work_id: record.workId,
        work_url: record.workUrl,
        uncertain: !record.published,
      };
      if (record.published) return result;
      const verified = await this.verifyPublishedText(result, {
        title: snapshot.title,
        text: snapshot.text,
        hashtags: snapshot.hashtags,
        previewId,
      });
      if (!verified.published) verified.uncertain = true;
      return verified;
    }, { restoreOnError: false, persistPageState: false });
  }

  async publishCarousel(options: {
    imagePaths: string[];
    caption?: string;
    title?: string;
    hashtags?: string[];
    action?: "preview" | "publish";
    confirmPublish?: boolean;
  }): Promise<PublishCarouselResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const result = await prepareCarouselPublication(page, options);
      log("publish_carousel", {
        status: result.status,
        action: result.requestedAction,
        published: result.published,
        imageCount: result.imagePaths.length,
        orderVerified: result.orderVerified,
        pageUrl: result.pageUrl,
        diagnosticsPath: result.diagnosticsPath,
      });
      return result;
    }, { restoreOnError: false });
  }

  async uploadArticleCover(imagePath: string): Promise<ArticleCoverResult> {
    return this.serial(async () => {
      assertWriteReady();
      return uploadArticleCover(await this.publisherPage(), imagePath);
    }, { restoreOnError: false });
  }

  async verifyArticleCover(): Promise<ArticleCoverResult> {
    return this.serial(async () => verifyArticleCover(await this.publisherPage()), { restoreOnError: false });
  }

  async removeArticleCover(): Promise<ArticleCoverResult> {
    return this.serial(async () => {
      assertWriteReady();
      return removeArticleCover(await this.publisherPage());
    }, { restoreOnError: false });
  }

  async inspectCurrentDraft(): Promise<DraftInspectionResult> {
    return this.serial(async () => inspectCurrentDraft(await this.publisherPage()), {
      restoreOnError: false,
      persistPageState: false,
    });
  }

  async resetCurrentDraft(confirmReset: boolean): Promise<DraftInspectionResult> {
    return this.serial(async () => {
      assertWriteReady();
      return resetCurrentDraft(await this.publisherPage(), confirmReset);
    }, { restoreOnError: false });
  }

  async listRecommendedMusic(): Promise<MusicActionResult> {
    return this.serial(async () => {
      const page = await this.publisherPage();
      if (!await isPostMusicPickerOpen(page)) {
        throw new Error("MUSIC_PICKER_NOT_OPEN");
      }
      const items = await readPostMusicCandidates(page);
      if (!items.length) throw new Error("MUSIC_PICKER_CANDIDATES_NOT_LOADED");
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items,
        selected: diagnostics.selected
          ? { ...diagnostics.selected, selected: true }
          : null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, {
      restoreOnError: false,
      persistPageState: false,
    });
  }

  async openMusicPicker(): Promise<MusicActionResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const items = await openPostMusicPicker(page);
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items,
        selected: diagnostics.selected
          ? { ...diagnostics.selected, selected: true }
          : null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async closeMusicPicker(): Promise<{ closed: boolean; selected: MusicActionResult["selected"] }> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const selected = await readSelectedPostMusic(page);
      const closed = await closePostMusicPicker(page);
      return {
        closed,
        selected: selected ? { ...selected, selected: true } : null,
      };
    }, { restoreOnError: false });
  }

  async searchMusic(query: string): Promise<MusicActionResult> {
    return this.serial(async () => {
      const page = await this.publisherPage();
      const items = await searchPostMusic(page, query);
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items,
        selected: diagnostics.selected
          ? { ...diagnostics.selected, selected: true }
          : null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async previewMusic(musicId: string): Promise<MusicActionResult> {
    return this.serial(async () => {
      const page = await this.publisherPage();
      if (!await isPostMusicPickerOpen(page)) throw new Error("MUSIC_PICKER_NOT_OPEN");
      const items = await readPostMusicCandidates(page);
      const index = items.findIndex(item => item.id === musicId);
      if (index < 0 || items.filter(item => item.id === musicId).length !== 1) {
        throw new Error("VALIDATION_FAILED:没有唯一匹配该 music_id 的音乐。");
      }
      const rows = await locatePostMusicCandidateRows(page);
      const visibleRows: number[] = [];
      for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
        if (await rows.nth(rowIndex).isVisible().catch(() => false)) {
          visibleRows.push(rowIndex);
        }
      }
      if (visibleRows.length !== items.length) {
        throw new Error("POST_MUSIC_ROW_COUNT_MISMATCH");
      }
      const cover = rows.nth(visibleRows[index]).locator("[class*='cover-container-']");
      if (await cover.count() !== 1) {
        throw new Error("VALIDATION_FAILED:没有唯一的音乐试听封面。");
      }
      await cover.click({ timeout: 5_000 });
      await page.waitForTimeout(350);
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items: await readPostMusicCandidates(page),
        selected: diagnostics.selected
          ? { ...diagnostics.selected, selected: true }
          : null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async selectMusic(selector: string | PostMusicCandidateSelector): Promise<MusicActionResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      const selected = await selectPostMusicCandidate(page, selector);
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items: [],
        selected: { ...selected, selected: true },
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async verifyMusic(): Promise<MusicActionResult> {
    return this.serial(async () => {
      const page = await this.publisherPage();
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items: diagnostics.pickerOpen ? await readPostMusicCandidates(page) : [],
        selected: diagnostics.selected
          ? { ...diagnostics.selected, selected: true }
          : null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false, persistPageState: false });
  }

  async removeMusic(): Promise<MusicActionResult> {
    return this.serial(async () => {
      assertWriteReady();
      const page = await this.publisherPage();
      await removeSelectedPostMusic(page);
      const diagnostics = await debugPostMusicPicker(page);
      return {
        items: [],
        selected: null,
        screenshotPath: diagnostics.screenshotPath,
        screenshotBase64: diagnostics.screenshotBase64,
      };
    }, { restoreOnError: false });
  }

  async health(): Promise<{ connected: boolean; url?: string; title?: string; message: string }> {
    try {
      const page = await this.currentPage();
      return {
        connected: true,
        url: page.url(),
        title: await page.title(),
        message: "浏览器已连接，当前页面可由受控工具查看和执行白名单动作。",
      };
    } catch (error) {
      return { connected: false, message: String(error) };
    }
  }

  private async observeBoundPageFastUnlocked(
    page: Page,
    ownerId: string,
    note?: string,
  ): Promise<Omit<Observation, "screenshotBase64"> & {
    screenshotIncluded: false;
    elapsedMs: number;
  }> {
    const startedAt = Date.now();
    if (page.isClosed()) throw new Error("PAGE_BINDING_LOST: bound page is closed");
    const url = page.url();
    assertAllowedUrl(url);
    const title = await page.title();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const [elements, viewportDiagnostics] = await Promise.all([
      this.collectElements(page, 36),
      this.viewportDiagnostics(page),
    ]);
    const capturedAt = new Date().toISOString();
    const snapshot = await this.createObservationSnapshot(
      page,
      ownerId,
      elements,
      capturedAt,
    );
    return {
      ...snapshot,
      url,
      title,
      pageKind: this.pageKind(url, title),
      viewport,
      viewportDiagnostics,
      elements,
      capturedAt,
      screenshotIncluded: false,
      elapsedMs: Date.now() - startedAt,
      note,
    };
  }

  private async observeBoundPageUnlocked(
    page: Page,
    ownerId: string,
    note?: string,
  ): Promise<Observation> {
    if (page.isClosed()) throw new Error("PAGE_BINDING_LOST: bound page is closed");
    const url = page.url();
    assertAllowedUrl(url);
    const title = await page.title();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const [elements, screenshotBase64, viewportDiagnostics] = await Promise.all([
      this.collectElements(page),
      this.screenshot(page),
      this.viewportDiagnostics(page),
    ]);
    const capturedAt = new Date().toISOString();
    const snapshot = await this.createObservationSnapshot(
      page,
      ownerId,
      elements,
      capturedAt,
      { base64: screenshotBase64, viewport },
    );
    return {
      ...snapshot,
      url,
      title,
      pageKind: this.pageKind(url, title),
      viewport,
      viewportDiagnostics,
      elements,
      screenshotBase64,
      capturedAt,
      note,
    };
  }

  private async observeUnlocked(note?: string): Promise<Observation> {
    const page = await this.currentPage();
    const url = page.url();
    assertAllowedUrl(url);
    const title = await page.title();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const [elements, screenshotBase64, viewportDiagnostics] = await Promise.all([
      this.collectElements(page),
      this.screenshot(page),
      this.viewportDiagnostics(page),
    ]);
    return {
      url,
      title,
      pageKind: this.pageKind(url, title),
      viewport,
      viewportDiagnostics,
      elements,
      screenshotBase64,
      capturedAt: new Date().toISOString(),
      note,
    };
  }
}
