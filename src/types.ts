export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InteractiveElement = {
  id: string;
  tag: string;
  role: string;
  label: string;
  href: string | null;
  box: Box;
  kind: "link" | "button" | "tab" | "video" | "input" | "other";
};

export type ViewportDiagnostics = {
  playwright: { width: number; height: number };
  css: { width: number; height: number };
  outer: { width: number; height: number };
  devicePixelRatio: number;
  widthRatio: number;
  heightRatio: number;
  mismatch: boolean;
};

export type Observation = {
  observationId?: string;
  pageId?: string;
  pageTargetId?: string;
  snapshotHash?: string;
  expiresAt?: string;
  url: string;
  title: string;
  pageKind: string;
  viewport: { width: number; height: number };
  viewportDiagnostics?: ViewportDiagnostics;
  elements: InteractiveElement[];
  screenshotBase64: string;
  capturedAt: string;
  note?: string;
};

export type LightweightScrollResult = {
  url: string;
  title: string;
  pageKind: string;
  direction: "down" | "up";
  requestedPixels: number;
  movedPixels: number;
  target: "inner" | "window";
  targetName: string;
  elapsedMs: number;
  screenshotIncluded: false;
  capturedAt: string;
  note: string;
};

export type ArticleTextResult = {
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  workId: string;
  text: string;
  characterCount: number;
  sourceSelector: string;
  sourceType: "title-linked-article-root";
  headingMatched: true;
  excludedRegionCount: number;
  paragraphCount: number;
  privacyFiltered: true;
};

export type MediaProbe = {
  url: string;
  title: string;
  workId: string;
  durationSeconds: number | null;
  currentTimeSeconds: number | null;
  paused: boolean | null;
  mediaCandidates: string[];
  visibleText: string;
  textSource: string;
  characterCount: number;
  truncated: boolean;
  chaptersAvailable: boolean;
  chapterCount: number;
  galleryAvailable: boolean;
  galleryImageCount: number;
};

export type WorkContext = {
  url: string;
  workId: string;
  title: string;
  activeContainerSource: string;
};

export type AllowedTab = {
  pageId: string;
  targetId: string;
  role:
    | "operator_home"
    | "bound_messages"
    | "codex_test"
    | "publisher"
    | "creator_center"
    | "notifications"
    | "notification_target"
    | null;
  title: string;
  url: string;
  host: string;
};

export type Chapter = {
  timestamp: string;
  seconds: number;
  title: string;
  summary: string;
};

export type ChapterResult = {
  url: string;
  workId: string;
  summary: string;
  chapters: Chapter[];
  chapterCount: number;
  source: "douyin-native-chapters";
  privacyFiltered: true;
};

export type TimelineFrame = {
  timeSeconds: number;
  timestamp: string;
  imageBase64: string;
};

export type TimelineInspectionResult = {
  url: string;
  title: string;
  workId: string;
  duration: number;
  sampledTimes: number[];
  frames: TimelineFrame[];
  restoredState: {
    currentTime: number;
    paused: boolean;
    muted: boolean;
  };
  visibleText: string;
  textSource: string;
  characterCount: number;
  truncated: boolean;
};

export type CarouselRenderResult = {
  outputDir: string;
  sourceHtmlPath: string;
  imagePaths: string[];
  pages: Array<{
    index: number;
    path: string;
    width: number;
    height: number;
    overflow: boolean;
    blank: boolean;
  }>;
  pageCount: number;
  width: number;
  height: number;
  deviceScaleFactor: number;
  warnings: string[];
  previewContactSheetPath: string;
  diagnosticsPath: string;
};

export type PublishStatus =
  | "draft"
  | "preparing"
  | "preview_ready"
  | "needs_user_action"
  | "publishing"
  | "published"
  | "blocked"
  | "failed";

export type PublishTextResult = {
  status: PublishStatus;
  requestedAction: "preview" | "publish";
  published: boolean;
  text: string;
  title: string | null;
  hashtags: string[];
  entryFound: boolean;
  editorFound: boolean;
  contentFilled: boolean;
  previewReached: boolean;
  previewClicked?: boolean;
  verifiedText: boolean;
  verifiedTitle: boolean;
  pageUrl: string;
  pageTitle: string;
  detectedEntry: string | null;
  screenshotPath: string;
  diagnosticsPath: string;
  screenshotBase64: string;
  errorCode: string | null;
  errorStep: string | null;
  errorMessage: string | null;
  previewId?: string | null;
  pageId?: string;
  pageTargetId?: string;
  missing?: string[];
  snapshot?: Record<string, unknown>;
  work_id?: string | null;
  work_url?: string | null;
  uncertain?: boolean;
  musicSelectionStatus?: "not_requested" | "already_selected" | "candidates_returned" | "selected" | "skipped_optional";
  musicCandidates?: MusicItem[];
  musicError?: string | null;
  content_type?: string | null;
  profile_work_count_before?: number | null;
  profile_work_count_after?: number | null;
  title_verified?: boolean;
  text_verified?: boolean;
  hashtags_verified?: boolean;
  cover_verified?: boolean;
  music_verified?: boolean;
  visibility?: string | null;
  published_at?: string | null;
  screenshots?: {
    publish_result: string;
    profile: string;
    work_detail: string;
  };
};

export type PublishCarouselResult = {
  status: PublishStatus;
  requestedAction: "preview" | "publish";
  published: boolean;
  imagePaths: string[];
  uploads: Array<{
    index: number;
    path: string;
    fileName: string;
    uploaded: boolean;
    pageOrder: number | null;
    error: string | null;
  }>;
  finalOrder: string[];
  expectedCount: number;
  pageImageCount: number;
  addedCountText: number | null;
  thumbnailCount: number;
  verificationSignals: string[];
  orderVerified: boolean;
  caption: string | null;
  title: string | null;
  hashtags: string[];
  pageUrl: string;
  pageTitle: string;
  screenshotPath: string;
  diagnosticsPath: string;
  screenshotBase64: string;
  errorCode: string | null;
  errorStep: string | null;
  errorMessage: string | null;
};

export type PostDraftMediaItem = {
  mediaId: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  contentHash: string;
  order: number;
};

export type PostDraftMusicItem = {
  id: string;
  pageId?: string | null;
  idSource?: "page" | "derived";
  title: string;
  author: string | null;
  version: string | null;
  duration: string | null;
};

export type PostDraftResult = {
  draftId: string;
  draft_id: string;
  contentType: "carousel";
  actorAccount: string;
  state: string;
  title: string;
  caption: string;
  media: PostDraftMediaItem[];
  imageCount: number;
  selectedMusic: PostDraftMusicItem | null;
  coverIndex: number | null;
  pageSynced: boolean;
  previewReady: boolean;
  pageTargetId: string | null;
  pageUrl: string | null;
  publishedWorkId: string | null;
  publishedWorkUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

export type PostDraftListResult = {
  items: PostDraftResult[];
  count: number;
  includeTerminal: boolean;
  readAt: string;
};

export type PostMusicCandidate = PostDraftMusicItem & {
  index: number;
  selected: boolean;
};

export type PostMusicResult = {
  draftId: string;
  draft_id: string;
  items: PostMusicCandidate[];
  selected: PostDraftMusicItem | null;
  pickerOpen: boolean;
  ok?: boolean;
  code?: string;
  publisherRole?: "publisher";
  publisherPageId?: "page-publisher";
  publisherUrl?: string;
  pageTargetId?: string;
  draftPageVerified?: boolean;
  pageAdopted?: boolean;
  appliedToDraft?: boolean;
  diagnostics?: PostMusicPickerDebugResult;
  readAt: string;
};

export type PostMusicPickerElementDiagnostic = {
  text: string;
  tag: string;
  className: string;
  visible: boolean;
  disabled: boolean;
  domPath: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

export type PostMusicPickerDebugResult = {
  ok: boolean;
  code: string;
  draftId: string | null;
  draft_id: string | null;
  publisherRole: "publisher";
  publisherPageId: "page-publisher";
  publisherUrl: string;
  pageTargetId: string;
  routeVerified: boolean;
  editorRootDetected: boolean;
  extensionExpanded: boolean;
  musicEntryFound: boolean;
  pickerOpen: boolean;
  dialogDetected: boolean;
  searchInputDetected: boolean;
  candidateListDetected: boolean;
  candidateCount: number;
  selected: PostDraftMusicItem | null;
  draftPageVerified: boolean | null;
  musicEntryCandidates: PostMusicPickerElementDiagnostic[];
  dialogCandidates: PostMusicPickerElementDiagnostic[];
  searchInputCandidates: PostMusicPickerElementDiagnostic[];
  screenshotPath: string;
  screenshotBase64: string;
  diagnosticsPath: string;
  readAt: string;
};

export type PostPreviewResult = {
  draftId: string;
  draft_id: string;
  draft: PostDraftResult;
  operationId: string;
  operation_id: string;
  operationState: "prepared" | "confirmed";
  imageCount: number;
  imageOrder: string[];
  caption: string;
  title: string;
  music: PostDraftMusicItem | null;
  coverIndex: number | null;
  readyToPublish: boolean;
  pageUrl: string;
  pageTargetId: string;
  screenshotPath: string;
  screenshotBase64: string;
};

export type PostPublishResult = {
  operationId: string;
  operation_id: string;
  draftId: string;
  draft_id: string;
  state:
    | "prepared"
    | "publish_clicked"
    | "publishing"
    | "confirmed"
    | "failed_before_click"
    | "unknown_after_submit"
    | "rejected";
  published: boolean;
  clicked: boolean;
  clickCount: number;
  possibleSubmit: boolean;
  responseSeen: boolean;
  responseStatus: number | null;
  responseCode: string | number | null;
  responseMessage: string | null;
  resultingWorkId: string | null;
  resultingWorkUrl: string | null;
  pageUrlAfter: string | null;
  screenshotPath: string | null;
  screenshotBase64: string | null;
  diagnosticsPath: string | null;
  lastError: string | null;
};

export type PostPublishStatusResult = {
  operationId: string;
  operation_id: string;
  draftId: string;
  draft_id: string;
  state: PostPublishResult["state"];
  published: boolean;
  clickCount: number;
  resultingWorkId: string | null;
  resultingWorkUrl: string | null;
  lastError: string | null;
  readbackAttempted: boolean;
  readbackConfirmed: boolean;
  checkedAt: string;
};

export type TranscriptSegment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

export type TranscriptRecord = {
  transcriptId: string;
  workId: string;
  sourceUrl: string;
  title: string;
  author?: string | null;
  model: string;
  method: "local-faster-whisper";
  cacheHit?: boolean;
  language: string | null;
  durationSeconds: number | null;
  createdAt: string;
  text: string;
  segments: TranscriptSegment[];
};

export type DouyinActionResult = {
  toolName: string;
  actionType: string;
  success?: boolean;
  changed: boolean;
  beforeState: string;
  afterState: string;
  workId?: string;
  workUrl?: string;
  author?: string;
  targetAlias?: string;
  beforeLiked?: boolean;
  afterLiked?: boolean;
  verified?: boolean;
  dryRun?: boolean;
  recipientAlias?: string;
  operationId?: string;
  operationState?: string;
  resultingMessageId?: string | null;
  uncertainAfterSubmit?: boolean;
  verification?: {
    level:
      | "server_confirmed"
      | "reload_confirmed"
      | "optimistic_only"
      | "unknown_after_submit"
      | "failed";
    requestSeen: boolean;
    responseSeen: boolean;
    responseStatus: number | null;
    responseCode: string | number | null;
    persistedAfterReload: boolean;
  };
  message: string;
};

export type BoundUserPublic = {
  alias: string;
  displayName: string;
  profileUrl: string;
  mutualFollow: boolean;
  allowShare: boolean;
  allowMessage: boolean;
  verifiedAt: string;
};

export type DouyinComment = {
  commentId: string;
  workId: string;
  author: string;
  text: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  threadPath: string[];
  replyCount: number;
  time: string | null;
  location: string | null;
  likeCount: string | null;
  isAuthor: boolean;
  isPinned: boolean;
  replies?: DouyinComment[];
};

export type CommentReadResult = {
  url: string;
  workId: string;
  sort: "hot" | "latest";
  comments: DouyinComment[];
  count: number;
  privacyFiltered: true;
};

export type BoundMessage = {
  messageId: string;
  serverId: string | null;
  identitySource: "server_id" | "dom_id" | "fingerprint";
  senderId: string | null;
  conversationId: string | null;
  orderInConversation: string | null;
  createdAt: string | null;
  direction: "incoming" | "outgoing" | "unknown";
  messageType:
    | "text"
    | "sticker"
    | "image"
    | "shared_work"
    | "comment_share"
    | "interaction_card"
    | "system_card"
    | "unknown";
  aweType: number | null;
  mediaKind: "video" | "gallery" | "article" | "product_card" | "live_card" | "mini_game_card" | "unknown" | null;
  openable: boolean;
  availability: "available" | "unavailable" | "not_applicable";
  unavailableReason: "deleted" | "private" | "invalid" | "unavailable" | null;
  workId: string | null;
  workUrl: string | null;
  identificationSignals: Array<"aweme_id" | "href" | "card_dom" | "cover">;
  historyIndex: number | null;
  text: string;
  visual: {
    kind: "sticker" | "image";
    imageId: string | null;
    urls: string[];
    width: number | null;
    height: number | null;
    animated: boolean;
  } | null;
  interaction: {
    kind: "streak_invite" | "streak_started" | "pet_invite" | "pet_started";
    status: "pending" | "completed";
  } | null;
  commentShare: { commentId: string | null } | null;
  nativeReference: {
    previewText: string;
    mediaReference: boolean;
  } | null;
  time: string | null;
  unread: boolean;
};

export type BoundMessageOpenResult = {
  alias: string;
  displayName: string;
  message: BoundMessage;
  visualCaptured: boolean;
  visualSource: "dom_screenshot" | "dom_first_frame" | "trusted_resource" | null;
  visualImageBase64: string | null;
  visualMimeType: "image/png" | "image/jpeg" | "image/webp" | null;
  visualOriginalMimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null;
  visualOriginalUrl: string | null;
  visualWidth: number | null;
  visualHeight: number | null;
  visualAnimated: boolean | null;
  originalVisual: {
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null;
    url: string | null;
    width: number | null;
    height: number | null;
    animated: boolean | null;
  } | null;
  renderedVisual: {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    width: number | null;
    height: number | null;
    animated: false;
    source: "dom_screenshot" | "dom_first_frame" | "trusted_resource";
  } | null;
  privacyFiltered: true;
};

export type BoundMessageListResult = {
  alias: string;
  displayName: string;
  messages: BoundMessage[];
  count: number;
  unreadOnly: boolean;
  privacyFiltered: true;
};

export type BoundMessageMediaOpenResult = {
  alias: string;
  displayName: string;
  message: BoundMessage;
  workId: string;
  workUrl: string;
  viewMode: "immersive";
  autoplayLocked: boolean;
  opened: true;
};

export type BoundMediaQueueItem = {
  message: BoundMessage;
  opened: boolean;
};

export type BoundMediaQueueResult = {
  alias: string;
  displayName: string;
  items: BoundMediaQueueItem[];
  count: number;
  remainingCount: number;
  privacyFiltered: true;
};

export type BoundMessageUpdatesResult = {
  alias: string;
  displayName: string;
  newMessages: BoundMessage[];
  newTextCount: number;
  newShareCount: number;
  newVisualCount: number;
  newCommentShareCount: number;
  newInviteCount: number;
  unreadCount: number;
  newSinceLastCheckCount: number;
  privacyFiltered: true;
};

export type BoundMediaPageResult = {
  alias: string;
  displayName: string;
  items: BoundMediaQueueItem[];
  count: number;
  totalCount: number;
  unseenCount: number;
  cursor: string | null;
  nextCursor: string | null;
  privacyFiltered: true;
};

export type BoundConversationOpenResult = {
  alias: string;
  displayName: string;
  url: string;
  viewMode: "fullscreen";
  opened: true;
  privacyFiltered: true;
};

export type ProfileRecommendation = {
  safeId: string;
  workId: string;
  url: string;
  title: string;
  author: string;
  contentType: "video" | "note" | "article";
  publishedAt: string | null;
  stats: {
    diggCount: number | null;
    commentCount: number | null;
    collectCount: number | null;
    shareCount: number | null;
  };
  viewed: boolean;
};

export type ProfileRecommendationPage = {
  alias: string;
  displayName: string;
  items: ProfileRecommendation[];
  count: number;
  cursor: string | null;
  nextCursor: string | null;
  unseenOnly: boolean;
  privacyFiltered: true;
};

export type ProfileRecommendationOpenResult = {
  alias: string;
  displayName: string;
  item: ProfileRecommendation;
  opened: true;
  pageId: string;
};

export type BoundUserPost = {
  safeId: string;
  workId: string;
  url: string;
  title: string | null;
  author: string;
  contentType: "video" | "note" | "article" | "unknown";
  publishedAt: string | null;
  stats: {
    diggCount: number | null;
    commentCount: number | null;
  };
  viewed: boolean;
};

export type BoundUserPostPage = {
  alias: string;
  displayName: string;
  items: BoundUserPost[];
  count: number;
  cursor: string | null;
  nextCursor: string | null;
  unseenOnly: boolean;
  profileTab: "post";
  profileSubTab: "video";
  privacyFiltered: true;
};

export type BoundUserPostOpenResult = {
  opened: true;
  pageRole: "operator_home";
  pageId: string;
  alias: string;
  workId: string;
  workUrl: string;
  title: string | null;
  author: string;
  authorVerified: true;
  loginVerified: true;
  workLocked: true;
  autoplayLocked: boolean;
  contentType: "video" | "note" | "article" | "unknown";
};

export type OwnPost = {
  safeId: string;
  workId: string;
  url: string;
  title: string | null;
  contentType: "video" | "note" | "article" | "unknown";
  publishedAt: string | null;
  stats: {
    playCount: number | null;
    diggCount: number | null;
    commentCount: number | null;
  };
  viewed: boolean;
};

export type OwnPostPage = {
  items: OwnPost[];
  count: number;
  cursor: string | null;
  nextCursor: string | null;
  unseenOnly: boolean;
  pageRole: "operator_home";
  profileTab: "post";
  profileSubTab: "video";
};

export type OwnPostOpenResult = {
  opened: true;
  pageRole: "operator_home";
  pageId: string;
  workId: string;
  workUrl: string;
  title: string | null;
  author: string;
  authorVerified: true;
  loginVerified: true;
  workLocked: true;
  autoplayLocked: boolean;
  contentType: "video" | "note" | "article" | "unknown";
};

export type OwnCommentUpdate = {
  workId: string;
  workTitle: string | null;
  commentId: string;
  parentCommentId: string | null;
  author: string;
  text: string;
  time: string | null;
  isReply: boolean;
};

export type OwnCommentUpdatesResult = {
  items: OwnCommentUpdate[];
  newCount: number;
  scannedWorkCount: number;
  checkedAt: string;
};

export type CreatorCommentManagerOpenResult = {
  opened: boolean;
  pageRole: "creator_center";
  accountVerified: boolean;
  workId: string | null;
  workTitle: string | null;
  commentManagerReady: boolean;
};

export type CreatorCommentItem = {
  workId: string;
  workTitle: string | null;
  commentId: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  threadPath: string[];
  author: string;
  text: string;
  time: string | null;
  likeCount: number | null;
  replyCount: number;
  isReply: boolean;
  hasReplied: boolean;
  ownReplyText: string | null;
};

export type CreatorCommentListResult = {
  items: CreatorCommentItem[];
  count: number;
  total: number;
  cursor: string | null;
  nextCursor: string | null;
  workId: string | null;
  workTitle: string | null;
  sort: "latest" | "hot";
  status: "all" | "unreplied" | "replied";
  pageRole: "creator_center";
  accountVerified: true;
  privacyFiltered: true;
};

export type CreatorCurrentFilteredComment = {
  commentId: string;
  author: string;
  text: string;
  workId: string;
  hasReplied: boolean;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  time: string | null;
  likeCount: number | null;
  replyCount: number;
};

export type CreatorCurrentFilteredCommentsResult = {
  items: CreatorCurrentFilteredComment[];
  count: number;
  unique: boolean;
  keyword: string;
  workId: string;
  workTitle: string | null;
  pageRole: "creator_center";
  accountVerified: true;
  source: "verified_react_filter_state";
  filterStatePreserved: true;
  readAt: string;
};

export type CreatorReplyPreviewResult = {
  preview: true;
  sent: false;
  workId: string;
  workTitle: string | null;
  targetCommentId: string;
  targetAuthor: string;
  targetText: string;
  replyText: string;
  alreadyReplied: boolean;
  verified: true;
  screenshotPath: string;
  diagnosticsPath: string;
};

export type CreatorReplySendResult = {
  preview: false;
  sent: boolean;
  success: boolean;
  status: "sent" | "unknown_after_submit";
  workId: string;
  workTitle: string | null;
  targetCommentId: string;
  replyCommentId: string | null;
  creatorReplyRecordId: string | null;
  text: string;
  verifiedInCreatorCenter: boolean;
  screenshotPath: string;
  diagnosticsPath: string;
};

export type CreatorReplyResult = CreatorReplyPreviewResult | CreatorReplySendResult;

export type CreatorCompactComment = {
  commentId: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  author: string;
  text: string;
  time: string | null;
  likeCount: number | null;
  hasReplied: boolean;
  replyCount: number;
};

export type CreatorCommentScanResult = {
  snapshotId: string;
  workId: string;
  workTitle: string | null;
  items: Array<CreatorCompactComment | CreatorCommentItem>;
  count: number;
  totalMatched: number;
  cursor: string | null;
  nextCursor: string | null;
  status: "all" | "unreplied" | "replied";
  scope: "all" | "new";
  rootOnly: boolean;
  questionOnly: boolean;
  query: string[];
  responseMode: "compact" | "full";
  threadContext?: Array<{
    rootCommentId: string;
    items: CreatorCompactComment[];
  }>;
  pageRole: "creator_center";
  accountVerified: true;
  privacyFiltered: true;
};

export type CreatorCommentFindItem = {
  commentId: string;
  author: string;
  text: string;
  workId: string;
  parentCommentId: string | null;
  rootCommentId: string;
  hasReplied: boolean;
  time: string | null;
  matchScore: number;
  matchToken: string;
  matchTokenExpiresAt: string;
};

export type CreatorCommentFindResult = {
  items: CreatorCommentFindItem[];
  count: number;
  totalMatched: number;
  scannedRootCount: number;
  scannedCommentCount: number;
  workId: string;
  authorQuery: string | null;
  textQuery: string | null;
  status: "all" | "unreplied" | "replied";
  rootOnly: boolean;
  matchMode: "exact" | "fuzzy";
  complete: true;
  source: "creator_api_complete_scan";
  pageStatePreserved: true;
  readAt: string;
};

export type CreatorCommentOpenByIdResult = {
  workId: string;
  commentId: string;
  author: string;
  text: string;
  parentCommentId: string | null;
  rootCommentId: string;
  searchKeyword: string;
  targetVisible: true;
  threadExpanded: boolean;
  accountVerified: true;
  apiVerified: true;
  domVerified: true;
  sent: false;
};

export type CreatorPrepareReplyFromMatchResult =
  | ({
      matchStatus: "prepared";
      candidates: CreatorCommentFindItem[];
    } & CreatorReplyPlanResult)
  | {
      matchStatus: "not_found" | "ambiguous" | "low_confidence";
      candidates: CreatorCommentFindItem[];
      candidateCount: number;
      sent: false;
      workId: string;
      replyText: string;
    };

export type CreatorReplyPlanResult = {
  replyPlanId: string;
  transactionId: string;
  token: string;
  operationId: string;
  operation_id: string;
  status: "prepared";
  actorAccount: string;
  workId: string;
  workTitle: string | null;
  targetCommentId: string;
  targetAuthor: string;
  targetText: string;
  targetTextHash: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  threadPath: string[];
  alreadyReplied: false;
  replyText: string;
  replyTextHash: string;
  snapshotId: string;
  expiresAt: string;
  verified: true;
};

export type CreatorReplyTransactionResult = {
  replyPlanId: string;
  transactionId: string;
  token: string;
  operationId: string;
  operation_id: string;
  status: "prepared" | "blocked" | "unknown_after_submit" | "confirmed";
  operationState:
    | "prepared"
    | "click_started"
    | "confirmed"
    | "rejected"
    | "expired"
    | "unknown_after_submit"
    | "failed_before_click";
  resultCode:
    | "prepared"
    | "already_confirmed"
    | "blocked"
    | "unknown_after_submit"
    | "confirmed";
  actorAccount: string;
  workId: string;
  targetCommentId: string;
  targetAuthor: string;
  targetText: string;
  parentCommentId: string | null;
  rootCommentId: string;
  replyText: string;
  clicked: boolean;
  replyCommentId: string | null;
  verifiedInCreatorCenter: boolean;
  blockedReason: string | null;
  expiresAt: string;
};

export type CreatorReplyReconcileItem = {
  operationId: string;
  previousState:
    | CreatorReplyTransactionResult["operationState"]
    | CommittedPostWriteResult["operationState"];
  state:
    | CreatorReplyTransactionResult["operationState"]
    | CommittedPostWriteResult["operationState"];
  result:
    | "left_prepared"
    | "expired"
    | "confirmed"
    | "still_unknown";
  replyCommentId: string | null;
  error: string | null;
};

export type PostPublishReconcileItem = {
  operationId: string;
  previousState: PostPublishResult["state"];
  state: PostPublishResult["state"];
  result: "confirmed" | "still_unknown";
  resultingWorkId: string | null;
  error: string | null;
  operationType: "publish_post";
};

export type CreatorCommentDeleteReconcileItem = {
  operationId: string;
  previousState: "delete_started" | "unknown_after_submit";
  state: "confirmed" | "unknown_after_submit";
  result: "confirmed" | "still_unknown";
  commentId: string;
  error: string | null;
  operationType: "delete_creator_comment";
};

export type SocialOperationReconcileItem = {
  operationId: string;
  previousState: "click_started" | "unknown_after_submit";
  state: "confirmed" | "unknown_after_submit";
  result: "confirmed" | "still_unknown";
  resultingMessageId: string | null;
  error: string | null;
  operationType: "social_message" | "social_share" | "safe_social";
};

export type CreatorReplyReconcileResult = {
  checkedAt: string;
  operations: Array<
    CreatorReplyReconcileItem
    | PostPublishReconcileItem
    | CreatorCommentDeleteReconcileItem
    | SocialOperationReconcileItem
  >;
  unresolvedOperationIds: string[];
  sent: false;
};

export type DouyinStartupSelfCheckResult = {
  browserConnected: boolean;
  accountVerified: boolean;
  creatorCenterReady: boolean;
  workVerified: boolean;
  globalWriteReady: boolean;
  requestedWorkId: string | null;
  browserLaunched: boolean;
  browserProfileId: string | null;
  bindingsRecovered: Array<{
    role: string;
    pageId: string;
    aliases: string[];
    targetId: string;
    url: string;
    source: "persisted_target" | "unique_candidate" | "opened";
  }>;
  pendingOperations: string[];
  pendingOperationsBlockGlobalWrites: boolean;
  rootCommentLockMode: "same_text_only";
  reconciledOperations: Array<
    CreatorReplyReconcileItem
    | PostPublishReconcileItem
    | CreatorCommentDeleteReconcileItem
    | SocialOperationReconcileItem
  >;
  commentDedupeCount: number;
  writeReady: boolean;
  mode: "read_only" | "write_ready" | "degraded" | "binding_conflict" | "account_mismatch";
  blockedReasons: string[];
  checkedAt: string;
};

export type TargetWriteGateSnapshot = {
  gateId: string;
  gate_id: string;
  scope: "own_post" | "bound_user_post" | "external_post";
  actionType:
    | "create_root_comment"
    | "reply_to_comment"
    | "like_comment"
    | "unlike_comment"
    | "delete_comment";
  action_type:
    | "create_root_comment"
    | "reply_to_comment"
    | "like_comment"
    | "unlike_comment"
    | "delete_comment";
  actorAccount: string;
  actor_account: string;
  pageRole:
    | "operator_home"
    | "creator_center"
    | "codex_test"
    | "root_comment_clean";
  page_role:
    | "operator_home"
    | "creator_center"
    | "codex_test"
    | "root_comment_clean";
  pageTargetId: string;
  targetWorkId: string;
  target_work_id: string;
  targetWorkAuthor: string;
  target_work_author: string;
  targetCommentId: string | null;
  target_comment_id: string | null;
  parentCommentId: string | null;
  parent_comment_id: string | null;
  rootCommentId: string | null;
  root_comment_id: string | null;
  targetTextHash: string | null;
  target_text_hash: string | null;
  verifiedUrl: string;
  verified_url: string;
  verifiedAt: string;
  verified_at: string;
  expiresAt: string;
  expires_at: string;
  accountVerified: true;
  account_verified: true;
  workVerified: true;
  work_verified: true;
  commentVerified: boolean;
  comment_verified: boolean;
  pageLocked: true;
  page_locked: true;
  alias: string | null;
};

export type PreparedPostWriteResult = {
  token: string;
  operationId: string;
  operation_id: string;
  status: "prepared" | "already_confirmed" | "blocked";
  scope: "own_post" | "bound_user_post" | "external_post";
  actionType: "create_root_comment" | "reply_to_comment";
  workId: string;
  workTitle: string | null;
  workAuthor: string;
  commentId: string | null;
  commentAuthor: string | null;
  originalText: string | null;
  parentCommentId: string | null;
  rootCommentId: string | null;
  threadPath: string[];
  writeText: string;
  exactTextHash: string;
  composerFilled: false;
  previewRequired: true;
  targetGate: TargetWriteGateSnapshot;
  expiresAt: string;
};

export type CommittedPostWriteResult = {
  token: string;
  operationId: string;
  operation_id: string;
  status:
    | "prepared"
    | "blocked"
    | "click_no_effect"
    | "aborted_no_submit"
    | "unknown_after_submit"
    | "confirmed";
  operationState:
    | "prepared"
    | "click_started"
    | "click_attempted"
    | "click_no_effect"
    | "click_effect_confirmed"
    | "confirmed"
    | "rejected"
    | "expired"
    | "failed_before_click"
    | "unknown_after_submit"
    | "aborted_no_submit";
  resultCode:
    | "prepared"
    | "blocked"
    | "click_no_effect"
    | "aborted_no_submit"
    | "unknown_after_submit"
    | "confirmed"
    | "already_confirmed";
  scope: "own_post" | "bound_user_post" | "external_post";
  actionType: "create_root_comment" | "reply_to_comment";
  workId: string;
  commentId: string | null;
  writeText: string;
  sent: boolean;
  deliveryConfirmed: boolean;
  uncertainAfterSubmit: boolean;
  clicked: boolean;
  clickAttempted: boolean;
  clickEffectConfirmed: boolean;
  clickAttemptedAt: string | null;
  clickEffectConfirmedAt: string | null;
  submitResponseSeenAt: string | null;
  composerClearedAt: string | null;
  resultingCommentId: string | null;
  requestText: string;
  serverDisplayText: string | null;
  confirmationMethod:
    | "confirmed_by_server_id"
    | "confirmed_with_platform_normalization"
    | "archived_unresolved"
    | null;
  archivedAt: string | null;
  expiresAt: string;
  lastError: string | null;
};

export type DouyinHealthcheckResult = {
  version: string;
  checkedAt: string;
  pages: Array<{
    role: string;
    pageId: string;
    targetId: string | null;
    url: string | null;
    ready: boolean;
    accountVerified: boolean | null;
    bindingFresh: boolean;
    viewportDiagnostics: ViewportDiagnostics | null;
    warnings: string[];
    reason: string | null;
  }>;
  workLocks: Array<{
    pageRole: string;
    workId: string;
    author: string | null;
    lockedAt: string;
  }>;
  capabilities: Record<string, {
    status: "ready" | "unavailable";
    reason: string | null;
  }>;
};

export type CreatorCommentUpdatesResult = {
  items: Array<{
    workId: string;
    workTitle: string | null;
    commentId: string;
    parentCommentId: string | null;
    author: string;
    text: string;
    time: string | null;
    hasReplied: boolean;
  }>;
  newCount: number;
  checkedAt: string;
};

export type CurrentWorkContextResult = {
  pageRole: "operator_home" | "codex_test";
  loggedInAccount: string | null;
  workId: string | null;
  workUrl: string | null;
  authorName: string | null;
  authorMatchesAlias: boolean | null;
  isOwnWork: boolean | null;
  contentType: "video" | "note" | "article" | "unknown" | null;
  workLocked: boolean;
  autoplayLocked: boolean;
  commentPanelOpen: boolean;
};

export type DouyinGalleryImage = {
  index: number;
  width: number | null;
  height: number | null;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  imageBase64: string;
};

export type DouyinGalleryResult = {
  url: string;
  title: string;
  workId: string;
  author: string;
  description: string;
  hashtags: string[];
  publishedAt: string | null;
  musicTitle: string | null;
  stats: {
    diggCount: number;
    commentCount: number;
    collectCount: number;
    shareCount: number;
  };
  totalImageCount: number;
  returnedImageCount: number;
  truncated: boolean;
  images: DouyinGalleryImage[];
  source: "douyin-native-gallery";
  privacyFiltered: true;
};

export type SafeSocialActionStatus = {
  actionKey: string;
  scope: "bound_message" | "current_page";
  alias?: string;
  label: string;
  actionType: string;
  available: boolean;
};

export type CommentActionResult = {
  action: "preview" | "send";
  sent: boolean;
  targetWorkId: string;
  targetCommentId: string | null;
  commentId: string | null;
  text: string;
  account: string;
  author: string;
  duplicateDetected: boolean;
  verified: boolean;
  contextVerified?: boolean;
  targetAlias?: string;
  targetAuthor?: string;
  targetText?: string;
  token?: string;
  operationId?: string;
  operation_id?: string;
  operationState?: string;
  resultCode?: string;
  targetGate?: TargetWriteGateSnapshot;
  beforeLiked?: boolean;
  afterLiked?: boolean;
  changed?: boolean;
  screenshotPath: string;
  diagnosticsPath: string;
};

export type ArticleCoverResult = {
  selected: boolean;
  source: string | null;
  thumbnailCount: number;
  screenshotPath: string;
  screenshotBase64: string;
};

export type MusicItem = {
  id: string;
  pageId?: string | null;
  idSource?: "page" | "derived";
  title: string;
  author: string | null;
  version: string | null;
  duration: string | null;
  selected: boolean;
};

export type MusicActionResult = {
  items: MusicItem[];
  selected: MusicItem | null;
  screenshotPath: string;
  screenshotBase64: string;
};

export type DraftInspectionResult = {
  title: string;
  text: string;
  titleComplete: boolean;
  textComplete: boolean;
  imageCount: number;
  coverCount: number;
  hashtags: string[];
  musicSelected: boolean;
  currentMusic: MusicItem | null;
  hasPopup: boolean;
  previewReached: boolean;
  published: boolean;
  uncertain: boolean;
  workId: string | null;
  workUrl: string | null;
  pageUrl: string;
  visibility: string;
  publishTime: string;
  contaminated: boolean;
  warnings: string[];
  screenshotPath: string;
  screenshotBase64: string;
};
