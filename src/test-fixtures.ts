import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ARTICLE_PRIVACY_ERROR,
  WORK_CONTEXT_CHANGED_ERROR,
  assertWorkId,
  filterPrivateUiText,
  parseDouyinMetaDescription,
  parseNativeChapters,
  selectTrustedArticleCandidate,
  timelineSampleTimes,
  workIdFromUrl,
} from "./content.js";
import { getBoundUser, loadActionSettings, RESERVED_DISABLED_MESSAGE } from "./action-config.js";
import {
  assertAllowedUrl,
  assertCreatorCommentManagerPage,
  assertSafeElement,
} from "./safety.js";
import { loadSafeSocialActions } from "./social-config.js";
import {
  INCIDENT_REGRESSION,
  PublishSnapshotStore,
  assertPublishTransition,
  evaluatePreflight,
  hashtagsEqual,
  publisherTextEquivalent,
  type PublishSnapshot,
} from "./publish-workflow.js";
import { decideCommentAction } from "./comment-workflow.js";
import {
  chooseRootCommentComposer,
  type RootCommentComposerCandidate,
} from "./comment-composer.js";
import {
  buildTranscriptInitialPrompt,
  parsePublicShareHtml,
  withTranscriptTemporaryDirectory,
} from "./transcript.js";
import { assertBoundPostTab, decideLikeTransition, workLockMatches } from "./bound-post-workflow.js";
import {
  creatorReplyIdempotencyKey,
  frozenCreatorTargetMatches,
  sha256,
} from "./creator-reply-store.js";
import { resolveWriteExecutionAdapter } from "./write-operation-store.js";
import {
  creatorCommentFieldMatchScore,
  creatorCommentMatchesQuery,
  normalizeCreatorReplyText,
} from "./creator-comment-match.js";
import {
  CAPABILITY_PACKS,
  CORE_TOOL_NAMES,
  expandCapabilityPacks,
  packsForTool,
} from "./capability-packs.js";
import { resetCapabilityPackRuntimeForTests } from "./capability-runtime.js";
import { createMcpServer } from "./server.js";
import { classifyAdaptiveSubmitEvidence } from "./adaptive-comment-policy.js";
import {
  classifyRootCommentSubmit,
  isRootCommentSubmitEndpoint,
  sanitizeRootCommentResponse,
} from "./root-comment-submit-policy.js";
import {
  postCaptionEquivalent,
  postMusicCandidateStableId,
  publisherMusicEditorKind,
  resolvePostMusicCandidate,
  resolvePostMusicCandidateId,
} from "./post-draft-publisher.js";
import { creatorLoginConfirmed } from "./publisher.js";
import { AppError, asAppError } from "./app/errors.js";
import { mergeMessageIdentityState } from "./state-store.js";
import { resolveObservationOwner } from "./mcp-session-policy.js";
import { CONFIG } from "./config.js";
import {
  classifyMessagePayload,
  extractImageResource,
  findWorkId,
  messageMetadata,
  parseBoundMessageCandidate,
  primitiveText,
} from "./features/messages/message-parsing.js";
import {
  inspectImageBytes,
  sniffImageMime,
  synchronizeVisualMetadata,
} from "./features/messages/image-content.js";
import {
  canonicalizeNotificationCandidate,
  classifyNotification,
  dedupeNotifications,
  freezeNotificationReplyTarget,
  notificationExtractionFailureCode,
  parseNotificationCandidate,
} from "./features/notifications/notification-parsing.js";
import {
  chooseExactNativeMentionCandidate,
  inspectNativeMentionDomFixture,
  nativeMentionsMatch,
  resolveNativeMentions,
} from "./features/publisher/native-mention.js";
import {
  classifyPlatformCommentText,
  normalizePlatformCommentText,
} from "./comment-text-normalization.js";
import {
  classifyManualNetworkSignal,
  classifyManualTarget,
  decideManualRetry,
  pointInsideBox,
} from "./features/manual-control/manual-control-policy.js";
import {
  canonicalPageRoleReference,
  disposableDuplicatePageKey,
  pageReferenceAliases,
  rootCommentPagePreference,
  rootCommentWorkIdFromUrl,
} from "./browser-page-policy.js";
import {
  LOW_RISK_MAX_CLICK_ATTEMPTS,
  businessCodeSucceeded,
  classifyLowRiskVerification,
  inspectLowRiskMutationRequest,
  pageRoleForPostScope,
  responseBusinessCode,
  verificationIsSuccess,
} from "./low-risk-post-action.js";

function testBrowserPagePolicy(): void {
  assert.equal(canonicalPageRoleReference("publisher"), "publisher");
  assert.equal(canonicalPageRoleReference("page-publisher"), "publisher");
  assert.equal(canonicalPageRoleReference(["echo", "lens"].join("")), null);
  assert.deepEqual(pageReferenceAliases("publisher", "TARGET-1"), [
    "publisher", "page-publisher", "TARGET-1",
  ]);
  assert.equal(
    rootCommentWorkIdFromUrl("https://www.douyin.com/user/example?vid=7664226610828914255"),
    "7664226610828914255",
  );
  assert.equal(
    rootCommentWorkIdFromUrl("https://www.douyin.com/note/7664226610828914255"),
    "7664226610828914255",
  );
  assert.ok(
    rootCommentPagePreference("https://www.douyin.com/note/7664226610828914255")
      > rootCommentPagePreference("https://www.douyin.com/user/example?vid=7664226610828914255"),
  );
  assert.equal(
    disposableDuplicatePageKey("https://www.douyin.com/user/example?from_tab_name=main"),
    disposableDuplicatePageKey("https://www.douyin.com/user/example?from_tab_name=video"),
  );
  assert.notEqual(
    disposableDuplicatePageKey("https://www.douyin.com/user/example?vid=7664226610828914255"),
    disposableDuplicatePageKey("https://www.douyin.com/user/example?vid=7664226610828914256"),
  );
  assert.equal(disposableDuplicatePageKey("https://creator.douyin.com/creator-micro/content/manage"), null);
}

function testPostCaptionReadbackNormalization(): void {
  const persisted = "第一段。\n\n第二段。\n\n#话题";
  const editorReadback = "第一段。\n第二段。\n#话题";
  assert.equal(postCaptionEquivalent(editorReadback, persisted), true);
  assert.equal(
    postCaptionEquivalent("第一段。\n另一段。\n#话题", persisted),
    false,
  );
}

function testGenericClickNavigationAllowlist(): void {
  const base = {
    id: "e1",
    tag: "button",
    role: "button",
    href: null,
    box: { x: 0, y: 0, width: 40, height: 40 },
  } as const;
  assert.throws(
    () => assertSafeElement({ ...base, label: "❤", kind: "button" }),
    /GENERIC_CLICK_NOT_NAVIGATION/,
  );
  assert.throws(
    () => assertSafeElement({ ...base, label: "继续", kind: "button" }),
    /GENERIC_CLICK_NOT_NAVIGATION/,
  );
  assert.throws(
    () => assertSafeElement({ ...base, label: "接受邀请", kind: "button" }),
    /GENERIC_CLICK_NOT_NAVIGATION/,
  );
  assert.doesNotThrow(() => assertSafeElement({
    ...base,
    tag: "a",
    role: "link",
    label: "打开作品",
    href: "https://www.douyin.com/video/7000000000000000001",
    kind: "link",
  }));
  assert.doesNotThrow(
    () => assertSafeElement({ ...base, label: "展开", kind: "button" }),
  );
}

function testArticlePrivacyFixture(): void {
  const raw = [
    "OmbreBrain优化教程3:让记忆库从仓库变成活物",
    "这是可信文章正文，只讨论记忆库和工程实现。",
    "推荐视频",
    "消息",
    "群聊",
    "private@example.com",
    "京ICP备16016397号-3",
  ].join("\n");
  const result = filterPrivateUiText(raw, 20_000);
  assert.match(result.text, /OmbreBrain/);
  assert.match(result.text, /可信文章正文/);
  assert.doesNotMatch(result.text, /private@example\.com/);
  assert.doesNotMatch(result.text, /京ICP备/);
  assert.doesNotMatch(result.text, /^消息$/m);
  assert.equal(ARTICLE_PRIVACY_ERROR, "未找到可信文章正文区域，已停止提取以避免读取推荐内容或私人页面信息。");
}

function testPublicVideoResolverFixture(): void {
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      "video_(id)/page": {
        videoInfoRes: {
          item_list: [{
            aweme_id: "7656758010710707700",
            desc: "解析测试视频",
            author: { nickname: "测试作者" },
            video: {
              duration: 53_400,
              play_addr: {
                url_list: [
                  "https://v3-web.douyinvod.com/video/tos/test/playwm/?mime_type=video_mp4",
                ],
              },
              cover: {
                url_list: ["https://p3-sign.douyinpic.com/test-cover.jpeg"],
              },
            },
          }],
        },
      },
    },
  })}</script>`;
  const result = parsePublicShareHtml(html, "7656758010710707700");
  assert.equal(result.workId, "7656758010710707700");
  assert.equal(result.durationSeconds, 53.4);
  assert.equal(result.author, "测试作者");
  assert.match(result.videoUrl, /\/play\//);
  assert.doesNotMatch(result.videoUrl, /playwm/);
  assert.equal(result.coverUrl, "https://p3-sign.douyinpic.com/test-cover.jpeg");
}

function testRootCommentComposerSelectionFixture(): void {
  const base: RootCommentComposerCandidate = {
    index: 0,
    domPath: "body > main > comment-surface > composer",
    placeholder: "留下你的精彩评论吧",
    ariaLabel: "",
    dataE2e: "",
    visible: true,
    editable: true,
    width: 320,
    height: 44,
    intersectionRatio: 1,
    inCommentSurface: true,
    inCommentItem: false,
    inReplyContainer: false,
    nearestWorkId: "7664226610828914255",
    sendCandidateCount: 1,
  };
  const hiddenTemplate: RootCommentComposerCandidate = {
    ...base,
    index: 1,
    domPath: "body > hidden-template > composer",
    visible: false,
    width: 0,
    height: 0,
    intersectionRatio: 0,
    inCommentSurface: false,
  };
  const pageSearch: RootCommentComposerCandidate = {
    ...base,
    index: 2,
    domPath: "body > header > search",
    placeholder: "搜索",
    inCommentSurface: false,
  };
  const nestedReply: RootCommentComposerCandidate = {
    ...base,
    index: 3,
    domPath: "body > comment-surface > comment-item > reply",
    placeholder: "回复@测试用户",
    inCommentItem: true,
    inReplyContainer: true,
  };
  assert.deepEqual(
    chooseRootCommentComposer(
      [hiddenTemplate, pageSearch, nestedReply, base],
      "7664226610828914255",
    ),
    {
      selectedIndex: 0,
      eligibleIndexes: [0],
      reason: "unique",
    },
  );
  assert.equal(
    chooseRootCommentComposer(
      [base, { ...base, index: 4, domPath: "body > second-comment-surface > composer" }],
      "7664226610828914255",
    ).reason,
    "ambiguous",
  );
  assert.equal(
    chooseRootCommentComposer(
      [{ ...base, nearestWorkId: "7000000000000000000" }],
      "7664226610828914255",
    ).reason,
    "not_found",
  );
  assert.equal(
    chooseRootCommentComposer(
      [{ ...base, intersectionRatio: 0 }],
      "7664226610828914255",
    ).reason,
    "unique",
    "已渲染且属于唯一评论面板的 composer 可在视口外，提交前会由 Playwright 定位",
  );
  assert.equal(
    chooseRootCommentComposer(
      [{
        ...base,
        placeholder: "冻结评论正文已经显示在 Draft.js 编辑器中",
      }],
      "7664226610828914255",
    ).reason,
    "unique",
    "composer 写入正文后占位提示会消失，仍应依靠结构和作品归属保持唯一定位",
  );
  for (const contentType of ["video", "note", "article"] as const) {
    assert.equal(
      chooseRootCommentComposer(
        [{
          ...base,
          domPath: `body > ${contentType}-detail > comment-surface > composer`,
          placeholder: "冻结正文",
        }],
        "7664226610828914255",
      ).reason,
      "unique",
      `${contentType} 详情页的唯一可见冻结 composer 应保持可定位`,
    );
  }
}

function testAdaptiveSubmitEvidenceFixture(): void {
  const noEffect = {
    requestSignalCount: 0,
    responseSignalCount: 0,
    composerCleared: false,
    composerTextReadable: true,
    composerTextMatched: true,
    buttonLoading: false,
    buttonDisabledTransition: false,
    newToastCount: 0,
    exactMatchCount: 0,
  };
  assert.equal(classifyAdaptiveSubmitEvidence(noEffect), "no_effect");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    requestSignalCount: 1,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    buttonLoading: true,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    composerCleared: true,
    composerTextMatched: false,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    exactMatchCount: 1,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    exactMatchCount: 2,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    newToastCount: 1,
  }), "possible_submit");
  assert.equal(classifyAdaptiveSubmitEvidence({
    ...noEffect,
    composerTextReadable: false,
    composerTextMatched: false,
  }), "uncertain");
}

function testRootCommentSubmitPolicyFixture(): void {
  assert.equal(
    isRootCommentSubmitEndpoint(
      "https://www.douyin.com/aweme/v1/web/comment/publish/?device=web",
      "POST",
    ),
    "/aweme/v1/web/comment/publish/",
  );
  assert.equal(
    isRootCommentSubmitEndpoint(
      "https://www.douyin.com/aweme/v1/web/comment/list/",
      "GET",
    ),
    null,
  );
  const accepted = sanitizeRootCommentResponse({
    endpoint: "/aweme/v1/web/comment/publish/",
    httpStatus: 200,
    body: {
      status_code: 0,
      status_msg: "success",
      comment: { cid: "7664999999999999999", text: "private text omitted" },
      token: "must_not_escape",
    },
  });
  assert.deepEqual(accepted, {
    endpoint: "/aweme/v1/web/comment/publish/",
    httpStatus: 200,
    code: 0,
    message: "success",
    commentId: "7664999999999999999",
  });
  const unchanged = {
    responses: [],
    requestSeen: false,
    composerCleared: false,
    composerTextReadable: true,
    composerTextMatched: true,
    optimisticDomMatch: false,
  };
  assert.equal(
    classifyRootCommentSubmit(unchanged),
    "click_no_effect",
  );
  assert.equal(
    classifyRootCommentSubmit({
      ...unchanged,
      responses: [accepted],
      composerTextMatched: false,
    }),
    "possible_submit",
  );
  assert.equal(
    classifyRootCommentSubmit({
      ...unchanged,
      responses: [{
        ...accepted,
        commentId: null,
        code: 1009,
        message: "请完成安全验证，操作过于频繁",
      }],
    }),
    "risk_controlled",
  );
  assert.equal(
    classifyRootCommentSubmit({
      ...unchanged,
      responses: [{
        ...accepted,
        httpStatus: 401,
        commentId: null,
        message: "login session expired",
      }],
    }),
    "login_expired",
  );
  assert.equal(
    classifyRootCommentSubmit({
      ...unchanged,
      responses: [{
        ...accepted,
        commentId: null,
        message: "网页版暂不支持发布评论",
      }],
    }),
    "desktop_web_root_comment_restricted",
  );
  assert.equal(
    JSON.stringify(accepted).includes("must_not_escape"),
    false,
  );
}

function testBoundPostWorkflowFixture(): void {
  assert.doesNotThrow(() => assertBoundPostTab({
    postSelected: true,
    recommendSelected: false,
    likeSelected: false,
    videoSelected: true,
  }));
  assert.throws(() => assertBoundPostTab({
    postSelected: false,
    recommendSelected: true,
    likeSelected: false,
    videoSelected: false,
  }), /WRONG_PROFILE_TAB/);

  const lock = { workId: "7664226610828914255", alias: "bound_user" };
  assert.equal(workLockMatches(lock, "7664226610828914255", "bound_user"), true);
  assert.equal(workLockMatches(lock, "7000000000000000001", "fixture_alias"), false);
  assert.equal(workLockMatches(lock, "7664226610828914255", "other"), false);

  assert.deepEqual(decideLikeTransition(false, "like"), { targetLiked: true, changed: true });
  assert.deepEqual(decideLikeTransition(true, "like"), { targetLiked: true, changed: false });
  assert.deepEqual(decideLikeTransition(false, "unlike"), { targetLiked: false, changed: false });

  assert.equal(decideCommentAction({
    action: "preview",
    confirmSend: false,
    text: "只预览",
    existingTexts: [],
  }).shouldSend, false);
  assert.equal(decideCommentAction({
    action: "send",
    confirmSend: false,
    text: "缺少确认",
    existingTexts: [],
  }).errorCode, "CONFIRMATION_REQUIRED");
  assert.equal(decideCommentAction({
    action: "send",
    confirmSend: true,
    text: "确认发送",
    existingTexts: [],
  }).shouldSend, true);
}

function testArticleRecommendationOnlyFixture(): void {
  const recommendationOnly = {
    text: [
      "推荐视频",
      "04:52 播放中 停止高位接盘 AI 科技股",
      "作者甲 获赞3.7万",
      "03:18 播放中 AI 模型行情复盘",
      "作者乙 点赞2.1万",
    ].join("\n"),
    sourceSelector: "title-linked-article-root > div.recommend-list",
    headingMatched: true,
    sameArticleRoot: true,
    titlePrecedesCandidate: true,
    paragraphCount: 5,
    naturalParagraphCount: 4,
    paragraphTextRatio: 0.9,
    forbiddenAncestorCount: 0,
    excludedRegionCount: 1,
    recommendationDurationCount: 2,
    recommendationPlaybackCount: 2,
    depth: 3,
  };
  assert.equal(
    selectTrustedArticleCandidate([recommendationOnly]),
    null,
    "正文缺失时不得把推荐视频列表当作文章正文",
  );

  const realBody = {
    ...recommendationOnly,
    text: [
      "Ombre Brain记忆库来自红薯：P0lar1s 老师，本篇文章只是个人在老师原版基础上的修改。",
      "第一篇讲省 token，第二篇讲安全。这一篇继续讲记忆库的工程实现。",
      "一、一键开机：把三次调用并成一次。",
      "二、信箱：窗口和窗口之间的接力棒。",
      "三、感受回声：让旧日感受重新浮现。",
      "四、心境共鸣：按当前情绪坐标检索过去一起扛过难事的记录，让记忆第一次拥有感同身受的维度。",
      "五、前瞻记忆：为记忆桶增加触发日期，到正确的日子自动出现在开机返回中，不再依赖随机检索。",
      "六、自动消化与自动关联：定期整理低重要度旧桶，并为新桶自动建立语义关联，同时继续排除封存桶。",
      "这些功能合在一起，让记忆库从静态仓库变成会传递留言、整理关系并在正确时间浮现内容的系统。",
    ].join("\n"),
    sourceSelector: "title-linked-article-root > div.article-body",
    paragraphCount: 9,
    naturalParagraphCount: 9,
    paragraphTextRatio: 0.96,
    excludedRegionCount: 2,
    recommendationDurationCount: 0,
    recommendationPlaybackCount: 0,
  };
  assert.equal(selectTrustedArticleCandidate([recommendationOnly, realBody]), realBody);
}

function testWorkContextFixture(): void {
  const source = "https://www.douyin.com/note/7663747731316096127";
  assert.equal(workIdFromUrl(source), "7663747731316096127");
  assert.equal(
    workIdFromUrl("https://www.douyin.com/user/self?modal_id=7663747731316096127&showTab=like"),
    "7663747731316096127",
  );
  assert.doesNotThrow(() => assertWorkId("7663747731316096127", source));
  assert.throws(
    () => assertWorkId("7663747731316096127", "https://www.douyin.com/video/7663579807103464369"),
    error => error instanceof Error && error.message === WORK_CONTEXT_CHANGED_ERROR,
  );
}

function testNativeChaptersFixture(): void {
  const raw = [
    "章节要点",
    "如何通过贴图技巧为纸片人增加真实感。",
    "00:01 引言",
    "00:09 毛孔",
    "准备不同大小圆点，调整颜色和透明度，贴回底图。",
    "00:24 高光",
    "准备圆，贴底图，液化并点缀。",
    "00:41 血管",
    "准备三角形，不规则排列并连接。",
    "00:50 细化",
    "根据风格改变颜色并添加雀斑和绒毛。",
    "内容由AI生成",
  ].join("\n");
  const parsed = parseNativeChapters(raw);
  assert.equal(parsed.chapters.length, 5);
  assert.deepEqual(parsed.chapters.map(chapter => chapter.title), ["引言", "毛孔", "高光", "血管", "细化"]);
  assert.equal(parsed.chapters[4].seconds, 50);
}

function testTimelineFixture(): void {
  const long = timelineSampleTimes(100);
  assert.deepEqual(long, [0, 15, 35, 55, 75, 90, 98]);
  const short = timelineSampleTimes(10);
  assert.equal(short.at(-1), 9);
  assert.ok(short.some(value => value > 5));
}

function testMetaFixture(): void {
  const parsed = parseDouyinMetaDescription(
    "OmbreBrain优化教程3 - 澄心亭看雪于20260716发布在抖音，已经收获了3.6万个喜欢",
  );
  assert.deepEqual(parsed, { author: "澄心亭看雪", publishedAt: "2026-07-16" });
}

function testActionConfigurationFixture(): void {
  const bound = getBoundUser("bound_user");
  assert.equal(bound.displayName, "FixtureBoundUser");
  assert.equal(bound.profileUrl, `https://www.douyin.com/user/${bound.secUid}`);
  assert.equal(bound.allowShare, true);
  assert.equal(bound.allowMessage, true);

  const settings = loadActionSettings();
  assert.equal(settings.operator.displayName, "FixtureOperator");
  assert.equal(settings.features.publicComment, true);
  assert.equal(settings.features.commentReply, true);
  assert.equal(settings.features.publishVideo, false);
  assert.equal(settings.features.publishArticle, true);
  assert.equal(RESERVED_DISABLED_MESSAGE, "该能力已预留，但当前配置未启用。");
}

function testSafetyHostFixture(): void {
  assert.doesNotThrow(() => assertAllowedUrl("https://www.douyin.com/video/7631799920605234752"));
  assert.doesNotThrow(() =>
    assertCreatorCommentManagerPage("https://creator.douyin.com/creator-micro/interactive/comment"));
  assert.doesNotThrow(() =>
    assertCreatorCommentManagerPage("https://creator.douyin.com/creator-micro/data/following/comment"));
  assert.throws(() =>
    assertCreatorCommentManagerPage("https://creator.douyin.com/creator-micro/content/post/article"));
  assert.throws(() => assertAllowedUrl("https://live.douyin.com/123"));
  assert.throws(() => assertAllowedUrl("https://www.douyin.com/im"));
  assert.throws(() => assertAllowedUrl("https://evil.example/user/123"));
  assert.deepEqual([...CONFIG.allowedHosts].sort(), [
    "creator.douyin.com",
    "douyin.com",
    "www.douyin.com",
  ]);
}

function testSafeSocialActionFixture(): void {
  const actions = loadSafeSocialActions();
  const streak = actions.get("accept_fixture_streak");
  assert.equal(streak?.scope, "bound_message");
  assert.equal(streak?.alias, "bound_user");
  assert.equal(streak?.label, "FIXTURE_ACCEPT");
  assert.equal(streak?.contextContains, "FIXTURE_CONTEXT");
  assert.equal(streak?.completedContextContains, "FIXTURE_DONE");
}

function publishSnapshot(overrides: Partial<PublishSnapshot> = {}): PublishSnapshot {
  return {
    title: "安全发布回归",
    text: "第一段\n第二段",
    textLength: 9,
    paragraphCount: 2,
    hashtags: ["ChatGPT", "AI日常", "人机恋", "AI陪伴"],
    cover: { selected: true, source: "fixture.jpg", thumbnailCount: 1 },
    music: {
      selected: true,
      id: "music-fixture",
      title: "Fixture",
      author: "Tester",
      version: "原版",
      duration: "01:00",
      explicitNone: false,
    },
    visibility: "公开",
    publishTime: "立即发布",
    account: "FixtureOperator",
    pageId: "page-publisher",
    pageTargetId: "target-fixture",
    pageUrl: "https://creator.douyin.com/creator-micro/content/post/article",
    errorPrompts: [],
    preflightPassed: false,
    capturedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function testPublishingStateMachineFixture(): void {
  assert.doesNotThrow(() => assertPublishTransition("draft", "preparing"));
  assert.doesNotThrow(() => assertPublishTransition("preparing", "preview_ready"));
  assert.doesNotThrow(() => assertPublishTransition("preview_ready", "publishing"));
  assert.doesNotThrow(() => assertPublishTransition("publishing", "published"));
  assert.throws(() => assertPublishTransition("draft", "published"));

  const snapshot = publishSnapshot();
  const preflight = evaluatePreflight(snapshot, {
    account: "FixtureOperator",
    pageId: "page-publisher",
    pageTargetId: "target-fixture",
    title: snapshot.title,
    text: snapshot.text,
    hashtags: snapshot.hashtags,
    coverRequired: true,
  });
  assert.equal(preflight.passed, true);
  assert.equal(preflight.status, "preview_ready");
  const optionalMusic = evaluatePreflight(publishSnapshot({
    music: {
      selected: false,
      id: null,
      title: null,
      author: null,
      version: null,
      duration: null,
      explicitNone: false,
    },
  }), {
    account: "FixtureOperator",
    pageId: "page-publisher",
    pageTargetId: "target-fixture",
    title: snapshot.title,
    text: snapshot.text,
    hashtags: snapshot.hashtags,
    coverRequired: true,
    musicRequired: false,
  });
  assert.equal(optionalMusic.passed, true, "音乐可选时未选择音乐不得阻断预览");
  assert.equal(publisherTextEquivalent("第一段\n\n\n\n\n第二段", "第一段\n\n第二段"), true);
}

function testPublisherMusicRouteFixture(): void {
  assert.equal(publisherMusicEditorKind(
    "https://creator.douyin.com/creator-micro/content/post/image?type=new",
  ), "carousel");
  assert.equal(publisherMusicEditorKind(
    "https://creator.douyin.com/creator-micro/content/post/article?media_type=article&type=new",
  ), "article");
  assert.equal(publisherMusicEditorKind(
    "https://creator.douyin.com/creator-micro/content/manage",
  ), null);
  const items = [{
    id: "music-1",
    pageId: "music-1",
    idSource: "page" as const,
    title: "唯一歌曲",
    author: "作者",
    version: null,
    duration: "00:30",
    index: 0,
    selected: false,
  }];
  assert.equal(resolvePostMusicCandidateId(items, { musicId: "music-1" }), "music-1");
  assert.equal(resolvePostMusicCandidateId(items, { musicQuery: "唯一歌曲" }), "music-1");
  assert.throws(
    () => resolvePostMusicCandidateId(items, { musicQuery: "不存在" }),
    /POST_MUSIC_QUERY_NOT_UNIQUE:0/,
  );
}

function testMusicCandidateIdentityFixture(): void {
  const sharedPageId = "page-music-id-shared-by-all-rows";
  const firstId = postMusicCandidateStableId({
    pageId: sharedPageId,
    title: "给你给我",
    author: "毛不易",
    version: null,
    duration: "00:32",
  });
  const secondId = postMusicCandidateStableId({
    pageId: sharedPageId,
    title: "另一首歌",
    author: "另一位歌手",
    version: null,
    duration: "00:32",
  });
  assert.notEqual(firstId, secondId, "共享页面 music_id 的不同行必须得到不同候选 ID");
  const base = {
    idSource: "derived" as const,
    pageId: sharedPageId,
    version: null,
    selected: false,
  };
  const candidates = [{
    ...base,
    id: firstId,
    title: "给你给我",
    author: "毛不易",
    duration: "00:32",
    index: 0,
  }, {
    ...base,
    id: secondId,
    title: "另一首歌",
    author: "另一位歌手",
    duration: "00:32",
    index: 1,
  }];
  assert.equal(resolvePostMusicCandidate(candidates, firstId).title, "给你给我");
  assert.equal(resolvePostMusicCandidate(candidates, {
    index: 0,
    title: "给你给我",
    author: "毛不易",
    duration: "00:32",
  }).id, firstId);
  assert.throws(
    () => resolvePostMusicCandidate(candidates, sharedPageId),
    /POST_MUSIC_CANDIDATE_NOT_UNIQUE:2/,
  );
}

function testCreatorLoginSignalsFixture(): void {
  const base = {
    url: "https://creator.douyin.com/creator-micro/content/manage",
    accountVerified: false,
    explicitLoginPrompt: false,
    accountAvatar: false,
    highDefinitionPublish: false,
    workList: false,
  };
  assert.equal(creatorLoginConfirmed(base), false);
  assert.equal(creatorLoginConfirmed({ ...base, accountVerified: true }), true);
  assert.equal(creatorLoginConfirmed({ ...base, accountAvatar: true }), true);
  assert.equal(creatorLoginConfirmed({ ...base, highDefinitionPublish: true }), true);
  assert.equal(creatorLoginConfirmed({ ...base, workList: true }), true);
  assert.equal(creatorLoginConfirmed({
    ...base,
    explicitLoginPrompt: true,
    highDefinitionPublish: true,
  }), true);
  assert.equal(creatorLoginConfirmed({ ...base, explicitLoginPrompt: true }), false);
  assert.equal(creatorLoginConfirmed({
    ...base,
    url: "https://creator.douyin.com/passport/login",
    accountVerified: true,
  }), false);
}

function testMissingCoverIncidentRegressionFixture(): void {
  assert.equal(INCIDENT_REGRESSION.hashtags.length, 4);
  assert.equal(INCIDENT_REGRESSION.expected.neverTreatButtonClickAsSuccess, true);
  const snapshot = publishSnapshot({
    cover: { selected: false, source: null, thumbnailCount: 0 },
  });
  const result = evaluatePreflight(snapshot, {
    account: "FixtureOperator",
    pageId: "page-publisher",
    pageTargetId: "target-fixture",
    title: snapshot.title,
    text: snapshot.text,
    hashtags: snapshot.hashtags,
    coverRequired: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.errorCode, "MISSING_COVER");
  assert.equal(result.status, "needs_user_action");
}

function testHashtagRegressionFixture(): void {
  assert.equal(hashtagsEqual("#ChatGPT", "chatgpt"), true);
  assert.equal(hashtagsEqual("AI日常", "#AI日常"), true);
  assert.equal(hashtagsEqual("人机恋", "人机恋"), true);
  assert.equal(hashtagsEqual("#AI陪伴", "AI陪伴"), true);
  assert.equal(hashtagsEqual("AI日常", "AI日常2"), false);
}

function testLockedSnapshotFixture(): void {
  const store = new PublishSnapshotStore();
  const snapshot = publishSnapshot();
  const locked = store.lock(snapshot);
  assert.doesNotThrow(() => store.verify(locked.previewId, snapshot));
  assert.throws(
    () => store.verify(locked.previewId, publishSnapshot({ text: "内容被修改" })),
    /SNAPSHOT_MISMATCH/,
  );
  const submitted = store.lock(snapshot);
  store.markSubmitAttempted(submitted.previewId);
  assert.throws(
    () => store.verify(submitted.previewId, snapshot),
    /DUPLICATE_PUBLISH/,
    "点击状态不明后必须禁止盲目重复发布",
  );
  store.markPublished(locked.previewId);
  assert.throws(() => store.verify(locked.previewId, snapshot), /DUPLICATE_PUBLISH/);
}

function testCommentConfirmationFixture(): void {
  assert.deepEqual(decideCommentAction({
    text: "只预览",
    existingTexts: [],
  }), {
    mode: "preview",
    shouldSend: false,
    duplicate: false,
    errorCode: null,
  });
  assert.equal(decideCommentAction({
    action: "send",
    confirmSend: false,
    text: "未确认",
    existingTexts: [],
  }).errorCode, "CONFIRMATION_REQUIRED");
  assert.equal(decideCommentAction({
    action: "send",
    confirmSend: true,
    text: "重复",
    existingTexts: ["重复"],
  }).errorCode, "DUPLICATE_COMMENT");
  assert.equal(decideCommentAction({
    action: "send",
    confirmSend: true,
    text: "唯一",
    existingTexts: [],
  }).shouldSend, true);
}

function testCreatorReplyTransactionRegressionFixture(): void {
  const workId = "7000000000000000001";
  const correctCommentId = "7664257227188519717";
  const staleCommentId = "7664259636198949681";
  const targetText = "真的有一瞬间感觉突破次元了[流泪]";
  const plan = {
    workId,
    targetCommentId: correctCommentId,
    targetAuthor: "用户4285235093944",
    targetText,
    targetTextHash: sha256(targetText),
    parentCommentId: null,
    rootCommentId: correctCommentId,
    depth: 0,
    threadPath: [correctCommentId],
  };
  assert.equal(frozenCreatorTargetMatches(plan, {
    workId,
    commentId: correctCommentId,
    author: plan.targetAuthor,
    text: targetText,
    parentCommentId: null,
    rootCommentId: correctCommentId,
    depth: 0,
    threadPath: [correctCommentId],
  }), true);
  assert.equal(frozenCreatorTargetMatches(plan, {
    workId,
    commentId: staleCommentId,
    author: plan.targetAuthor,
    text: targetText,
    parentCommentId: null,
    rootCommentId: staleCommentId,
    depth: 0,
    threadPath: [staleCommentId],
  }), false, "旧 comment_id 缓存绝不能通过冻结目标复核");

  const replyHash = sha256("事务幂等测试");
  assert.equal(
    creatorReplyIdempotencyKey(workId, correctCommentId, replyHash),
    creatorReplyIdempotencyKey(workId, correctCommentId, replyHash),
  );
  assert.notEqual(
    creatorReplyIdempotencyKey(workId, correctCommentId, replyHash),
    creatorReplyIdempotencyKey(workId, staleCommentId, replyHash),
  );

  const nestedPlan = {
    ...plan,
    targetCommentId: "7664265038488159035",
    targetAuthor: "不萌且很坏",
    targetText: "楼中楼测试",
    targetTextHash: sha256("楼中楼测试"),
    parentCommentId: "7664264909454574346",
    rootCommentId: "7664264909454574346",
    depth: 1,
    threadPath: ["7664264909454574346", "7664265038488159035"],
  };
  assert.equal(frozenCreatorTargetMatches(nestedPlan, {
    workId,
    commentId: nestedPlan.targetCommentId,
    author: nestedPlan.targetAuthor,
    text: nestedPlan.targetText,
    parentCommentId: nestedPlan.parentCommentId,
    rootCommentId: nestedPlan.rootCommentId,
    depth: 1,
    threadPath: nestedPlan.threadPath,
  }), true);
}

function testCreatorCommentMatchingFixture(): void {
  assert.equal(
    creatorCommentMatchesQuery("Eatwoody", "eatwoody", "exact").matched,
    true,
  );
  assert.equal(
    creatorCommentMatchesQuery("你是真的AI吗？我有点好奇", "你是真的ai吗", "fuzzy").matched,
    true,
  );
  assert.ok(
    creatorCommentFieldMatchScore("Eatwoody", "Eatwood", "fuzzy") >= 0.6,
    "昵称轻微缺字应能被模糊发现",
  );
  assert.equal(
    creatorCommentMatchesQuery("T", "Eatwoody", "fuzzy").matched,
    false,
    "短昵称不能仅因单字符包含关系误命中长查询",
  );
  assert.equal(
    normalizeCreatorReplyText("这目前没有足够证据。\n但反过来"),
    normalizeCreatorReplyText("这目前没有足够证据。但反过来"),
    "发送后平台折叠换行时仍应按完整规范化文本确认",
  );
}

function testEveryToolDeclaresOutputSchema(): void {
  const server = createMcpServer() as any;
  const tools = Object.entries(server._registeredTools ?? {}) as Array<
    [string, {
      inputSchema?: {
        def?: {
          shape?: Record<string, unknown>;
        };
      };
      outputSchema?: unknown;
      enabled?: boolean;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
    }]
  >;
  assert.ok(tools.length >= 125, "应注册完整的抖音 MCP 工具集与功能包入口");
  const missing = tools
    .filter(([, tool]) => !tool.outputSchema)
    .map(([name]) => name);
  assert.deepEqual(missing, [], `以下工具缺少 outputSchema：${missing.join(", ")}`);
  const names = new Set(tools.map(([name]) => name));
  assert.equal(names.has("douyin_creator_open_comment_by_id"), true);
  assert.equal(names.has("douyin_creator_prepare_reply_from_match"), true);
  assert.equal(names.has("douyin_creator_commit_reply"), true);
  assert.equal(names.has("douyin_creator_comment_on_own_post"), true);
  assert.equal(names.has("douyin_creator_prepare_delete_comment"), true);
  assert.equal(names.has("douyin_creator_commit_delete_comment"), true);
  assert.equal(names.has("douyin_creator_get_delete_comment_status"), true);
  const registered = new Map(tools);
  const inputShape = (name: string): Record<string, unknown> =>
    registered.get(name)?.inputSchema?.def?.shape ?? {};
  assert.equal(
    "confirm_send" in inputShape("douyin_creator_commit_reply"),
    true,
    "评论提交工具必须保留 confirm_send 事务门禁",
  );
  assert.equal(
    "confirm_delete" in inputShape("douyin_creator_commit_delete_comment"),
    true,
    "评论删除工具必须保留 confirm_delete 事务门禁",
  );
  assert.equal(
    "confirm_publish" in inputShape("douyin_publish_content"),
    true,
    "发布工具必须保留 confirm_publish 事务门禁",
  );
  assert.equal(
    registered.get("douyin_creator_commit_delete_comment")?.annotations?.destructiveHint,
    true,
    "评论删除工具必须继续声明 destructiveHint",
  );
  assert.equal(names.has("douyin_list_capability_packs"), true);
  assert.equal(names.has("douyin_load_capability_pack"), true);
  assert.equal(names.has("douyin_invoke_capability"), true);
  assert.equal(names.has("douyin_call_capability_tool"), true);
  assert.equal(names.has("douyin_call_write_capability_tool"), true);
  assert.equal(names.has("douyin_preview_comment_on_post"), true);
  assert.equal(names.has("douyin_adaptive_inspect_comment_composer"), true);
  assert.equal(names.has("douyin_adaptive_clear_and_fill_comment"), true);
  assert.equal(names.has("douyin_adaptive_click_submit_candidate"), true);
  assert.equal(names.has("douyin_adaptive_press_comment_submit_key"), true);
  assert.equal(names.has("douyin_adaptive_readback_exact_root_comment"), true);
  assert.equal(names.has("douyin_diagnose_root_comment_submit"), true);
  assert.equal(names.has("douyin_readback_exact_root_comment"), true);
  assert.equal(names.has("douyin_create_post_draft"), true);
  assert.equal(names.has("douyin_add_post_images"), true);
  assert.equal(names.has("douyin_open_music_picker"), true);
  assert.equal(names.has("douyin_close_music_picker"), true);
  assert.equal(names.has("douyin_debug_music_picker"), true);
  assert.equal(names.has("douyin_preview_post"), true);
  assert.equal(names.has("douyin_publish_post"), true);
  assert.equal(names.has("douyin_get_publish_status"), true);
  assert.equal(names.has("douyin_probe_visual_point"), true);
  assert.equal(names.has("douyin_click_visual_interface"), true);
  assert.equal(names.has("douyin_fill_text_draft"), true);
  assert.equal(names.has("douyin_preview_text_draft"), true);
  assert.equal(names.has("douyin_publish_text_draft"), true);
  assert.equal(names.has("douyin_verify_text_publish"), true);
  assert.equal(names.has("douyin_list_notifications"), true);
  assert.equal(names.has("douyin_prepare_reply_from_notification"), true);
  assert.equal(names.has("douyin_like_post"), true);
  assert.equal(names.has("douyin_favorite_post"), true);
  assert.equal(names.has("douyin_follow_post_author"), true);
  assert.equal(names.has("douyin_transcribe_link_local"), true);
  assert.equal(
    [...names].some(name => name.toLowerCase().includes(["echo", "lens"].join(""))),
    false,
    "registry 不得保留已下线的第三方转录工具",
  );
  const toolMap = new Map(tools);
  assert.equal(
    toolMap.get("douyin_creator_commit_delete_comment")?.annotations?.destructiveHint,
    true,
  );
  assert.equal(
    toolMap.get("douyin_load_capability_pack")?.annotations?.readOnlyHint,
    false,
  );
  assert.equal(
    toolMap.get("douyin_call_capability_tool")?.annotations?.readOnlyHint,
    true,
  );
  assert.equal(
    toolMap.get("douyin_call_write_capability_tool")?.annotations?.destructiveHint,
    true,
  );
  assert.equal(
    toolMap.get("douyin_click_visual_interface")?.annotations?.readOnlyHint,
    false,
    "视觉点击必须暴露为写工具，不能再通过只读网关调用",
  );
  const initiallyEnabled = tools
    .filter(([, tool]) => tool.enabled)
    .map(([name]) => name)
    .sort();
  assert.equal(
    initiallyEnabled.length,
    tools.length,
    "全部处理器应保持可调用，由自定义 tools/list 单独控制 schema 可见性",
  );
  const social = expandCapabilityPacks(["public_social"]);
  assert.equal(social.has("public_social"), true);
  assert.equal(social.has("browse"), true);
  assert.equal(
    packsForTool("douyin_comment_bound_user_post").includes("public_social"),
    true,
  );
  assert.equal(
    toolMap.get("douyin_list_notifications")?.annotations?.readOnlyHint,
    true,
  );
  assert.equal(
    toolMap.get("douyin_ack_notification_checkpoint")?.annotations?.readOnlyHint,
    false,
  );
  assert.equal(
    toolMap.get("douyin_prepare_reply_from_notification")?.annotations?.destructiveHint,
    false,
  );
  const notifications = expandCapabilityPacks(["notifications"]);
  assert.equal(notifications.has("notifications"), true);
  assert.equal(notifications.has("browse"), true);
  assert.deepEqual(CAPABILITY_PACKS.notifications.tools, [
    "douyin_list_notifications",
    "douyin_check_notification_updates",
    "douyin_ack_notification_checkpoint",
    "douyin_get_notification",
    "douyin_open_notification_target",
    "douyin_prepare_reply_from_notification",
  ]);
  assert.deepEqual(
    packsForTool("douyin_list_notifications"),
    ["notifications", "maintenance"],
  );
  assert.deepEqual(
    packsForTool("douyin_prepare_reply_from_notification"),
    ["notifications"],
  );
  assert.deepEqual(CAPABILITY_PACKS.publisher.tools, [
    "douyin_publish_content",
    "douyin_get_publish_status",
    "douyin_recover_publish",
    "douyin_list_publish_operations",
    "douyin_probe_visual_point",
    "douyin_click_visual_interface",
  ]);
  assert.equal(CAPABILITY_PACKS.publisher.tools.includes("douyin_publish_text"), false);
  assert.equal(CAPABILITY_PACKS.publisher.tools.includes("douyin_publish_post"), false);
  assert.equal(CAPABILITY_PACKS.publisher.tools.includes("douyin_debug_music_picker"), false);
  const manual = expandCapabilityPacks(["manual_control"]);
  assert.equal(manual.has("manual_control"), true);
  assert.equal(manual.has("browse"), true);
  assert.deepEqual(
    CAPABILITY_PACKS.manual_control.tools,
    ["douyin_probe_visual_point", "douyin_click_visual_interface"],
  );
  assert.equal(
    CAPABILITY_PACKS.browse.tools.includes("douyin_probe_visual_point"),
    false,
  );
  assert.equal(
    CAPABILITY_PACKS.browse.tools.includes("douyin_click_visual_interface"),
    false,
  );
  assert.equal(
    packsForTool("douyin_click_visual_interface").includes("manual_control"),
    true,
  );
  assert.equal(
    packsForTool("douyin_click_visual_interface").includes("publisher"),
    true,
  );
  assert.equal(
    CAPABILITY_PACKS.creator_comments.tools.includes(
      "douyin_creator_prepare_delete_comment",
    ),
    true,
  );
  const adaptive = expandCapabilityPacks(["adaptive_comment"]);
  assert.equal(adaptive.has("adaptive_comment"), true);
  assert.equal(adaptive.has("public_social"), true);
  assert.equal(adaptive.has("browse"), true);
  assert.equal(
    CAPABILITY_PACKS.adaptive_comment.tools.includes(
      "douyin_adaptive_observe_submit_effect",
    ),
    true,
  );
}

async function testCapabilityManifestCompatibility(): Promise<void> {
  resetCapabilityPackRuntimeForTests();
  let stableRuntimeInstanceId: string | undefined;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({
    name: "capability-manifest-fixture",
    version: "1.0.0",
  });
  let listChangedCount = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChangedCount += 1;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const initial = await client.listTools();
    assert.deepEqual(
      initial.tools.map(tool => tool.name).sort(),
      [...CORE_TOOL_NAMES].sort(),
      "全新 MCP 会话的 tools/list 必须只返回固定核心入口",
    );
    for (const toolName of [
      "douyin_load_capability_pack",
      "douyin_unload_capability_pack",
      "douyin_call_capability_tool",
      "douyin_call_write_capability_tool",
      "douyin_load_capability_pack_v1_9_1",
      "douyin_unload_capability_pack_v1_9_1",
      "douyin_call_capability_tool_v1_9_1",
      "douyin_call_write_capability_tool_v1_9_1",
      "douyin_load_capability_pack_v1_10_0",
      "douyin_unload_capability_pack_v1_10_0",
      "douyin_call_capability_tool_v1_10_0",
      "douyin_call_write_capability_tool_v1_10_0",
    ]) {
      const schema = initial.tools.find(tool => tool.name === toolName)?.inputSchema as any;
      const packEnum = schema?.properties?.packs?.items?.enum ?? schema?.properties?.pack?.enum ?? [];
      assert.equal(
        packEnum.includes("manual_control"),
        true,
        `manual_control 必须出现在 ${toolName} 的功能包枚举中`,
      );
      assert.equal(
        packEnum.includes("notifications"),
        true,
        `notifications must appear in the public core schema for ${toolName}`,
      );
    }

    const cachedDirectCall = await client.callTool({
      name: "douyin_read_action_log",
      arguments: { limit: 1 },
    }) as any;
    assert.equal(cachedDirectCall.isError, true);
    assert.equal(
      cachedDirectCall.structuredContent?.code,
      "TOOL_EXECUTION_FAILED",
      "隐藏工具直接调用必须失败关闭，不得隐式加载功能包",
    );
    assert.equal(listChangedCount, 0, "拒绝隐藏工具调用时不得修改当前连接目录");
    const hiddenWriteCall = await client.callTool({
      name: "douyin_publish_post",
      arguments: {
        operation_id: "00000000-0000-4000-8000-000000000001",
        confirm_publish: true,
      },
    }) as any;
    assert.equal(hiddenWriteCall.isError, true);
    assert.equal(
      hiddenWriteCall.structuredContent?.code,
      "CAPABILITY_UNAVAILABLE",
      "已退出公开契约的旧发布工具必须不可调用。",
    );
    assert.equal(listChangedCount, 0);
    const afterCachedCall = await client.listTools();
    assert.equal(
      afterCachedCall.tools.some(tool => tool.name === "douyin_read_action_log"),
      false,
    );
    assert.equal(
      afterCachedCall.tools.some(tool => tool.name === "douyin_publish_text"),
      false,
      "不相关发布包不得被顺带披露",
    );
    const publisherLoad = await client.callTool({
      name: "douyin_load_capability_pack",
      arguments: { packs: ["publisher"] },
    }) as any;
    stableRuntimeInstanceId = publisherLoad.structuredContent?.runtimeInstanceId;
    const publisherManifest = await client.listTools();
    for (const name of [
      "douyin_publish_content",
      "douyin_get_publish_status",
      "douyin_recover_publish",
      "douyin_list_publish_operations",
    ]) {
      assert.equal(publisherManifest.tools.some(tool => tool.name === name), true);
    }
    for (const retired of [
      "douyin_publish_text",
      "douyin_publish_carousel",
      "douyin_publish_post",
      "douyin_create_post_draft",
      "douyin_debug_music_picker",
    ]) {
      assert.equal(
        publisherManifest.tools.some(tool => tool.name === retired),
        false,
        `旧发布工具不得再出现在 AI manifest：${retired}`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }

  const [gatewayClientTransport, gatewayServerTransport] =
    InMemoryTransport.createLinkedPair();
  const gatewayServer = createMcpServer();
  const gatewayClient = new Client({
    name: "capability-gateway-fixture",
    version: "1.0.0",
  });
  await gatewayServer.connect(gatewayServerTransport);
  await gatewayClient.connect(gatewayClientTransport);
  try {
    const persistedStatus = await gatewayClient.callTool({
      name: "douyin_capability_pack_status",
      arguments: {},
    }) as any;
    assert.equal(
      persistedStatus.structuredContent?.selectedPacks?.includes("publisher"),
      true,
      "功能包选择必须跨 MCP connection 按浏览器配置恢复",
    );
    assert.equal(
      persistedStatus.structuredContent?.activePacks?.includes("browse"),
      true,
      "publisher 的 browse 依赖必须跨连接恢复",
    );
    assert.ok(
      Number.isInteger(persistedStatus.structuredContent?.stateRevision),
      "功能包状态必须返回可审计的 stateRevision",
    );
    assert.equal(
      typeof persistedStatus.structuredContent?.registryRevision,
      "string",
    );
    assert.equal(
      persistedStatus.structuredContent?.stateScope,
      "browser_profile",
    );
    assert.equal(
      persistedStatus.structuredContent?.runtimeInstanceId,
      stableRuntimeInstanceId,
      "同一服务进程的新连接必须共享稳定 runtimeInstanceId",
    );
    const gatewayResult = await gatewayClient.callTool({
      name: "douyin_call_capability_tool",
      arguments: {
        pack: "maintenance",
        tool: "douyin_read_action_log",
        arguments: { limit: 1 },
      },
    }) as any;
    assert.equal(gatewayResult.isError, undefined);
    assert.equal(gatewayResult.structuredContent?.capabilityGateway, true);
    assert.equal(gatewayResult.structuredContent?.activePacks?.includes("maintenance"), true);
    assert.equal(gatewayResult.structuredContent?.activePacks?.includes("publisher"), true);
    assert.equal(gatewayResult.structuredContent?.activePacks?.includes("browse"), true);
    assert.equal(
      gatewayResult.structuredContent?.sessionId,
      null,
      "in-memory fixture does not expose an HTTP MCP session id",
    );
    assert.equal(
      typeof gatewayResult.structuredContent?.connectionId,
      "string",
    );
  } finally {
    await gatewayClient.close();
    await gatewayServer.close();
    resetCapabilityPackRuntimeForTests();
  }

  const [freshWriteClientTransport, freshWriteServerTransport] =
    InMemoryTransport.createLinkedPair();
  const freshWriteServer = createMcpServer();
  const freshWriteClient = new Client({
    name: "capability-write-gateway-fixture",
    version: "1.0.0",
  });
  await freshWriteServer.connect(freshWriteServerTransport);
  await freshWriteClient.connect(freshWriteClientTransport);
  try {
    const writeResult = await freshWriteClient.callTool({
      name: "douyin_call_write_capability_tool",
      arguments: {
        pack: "messages",
        tool: "douyin_reply_to_bound_user_media",
        arguments: {},
        confirm_gateway_write: true,
      },
    }) as any;
    assert.equal(
      writeResult.isError,
      true,
      "fixture intentionally omits the message id and text so no write callback can run",
    );
    assert.equal(writeResult.structuredContent?.capabilityGateway, "write");
    assert.equal(writeResult.structuredContent?.requestedPack, "messages");
    assert.equal(writeResult.structuredContent?.autoLoadedPack, true);
    assert.equal(writeResult.structuredContent?.selectedPacks?.includes("messages"), true);
    assert.equal(writeResult.structuredContent?.activePacks?.includes("messages"), true);
    assert.equal(writeResult.structuredContent?.activePacks?.includes("browse"), true);
    assert.equal(
      String(writeResult.content?.[0]?.text ?? "").includes("capability_pack_not_loaded"),
      false,
      "a fresh connection must auto-load the explicitly selected write pack in the same call",
    );

    await freshWriteClient.callTool({
      name: "douyin_unload_capability_pack",
      arguments: { packs: ["messages"] },
    });
    const noAutoLoadServer = createMcpServer();
    const [noAutoLoadClientTransport, noAutoLoadServerTransport] =
      InMemoryTransport.createLinkedPair();
    const noAutoLoadClient = new Client({
      name: "capability-write-gateway-no-auto-load-fixture",
      version: "1.0.0",
    });
    await noAutoLoadServer.connect(noAutoLoadServerTransport);
    await noAutoLoadClient.connect(noAutoLoadClientTransport);
    try {
      const rejected = await noAutoLoadClient.callTool({
        name: "douyin_call_write_capability_tool",
        arguments: {
          pack: "messages",
          tool: "douyin_reply_to_bound_user_media",
          arguments: {},
          auto_load: false,
          confirm_gateway_write: true,
        },
      }) as any;
      assert.equal(rejected.isError, true);
      assert.equal(
        String(rejected.content?.[0]?.text ?? "").includes("capability_pack_not_loaded: messages"),
        true,
      );
    } finally {
      await noAutoLoadClient.close();
      await noAutoLoadServer.close();
    }
  } finally {
    await freshWriteClient.close();
    await freshWriteServer.close();
  }
}

function testObservationOwnerPolicyFixture(): void {
  assert.equal(resolveObservationOwner({
    sessionId: "session-a",
    connectionId: "connection-a",
    compatibilityGateway: false,
    accessTokenFingerprint: "fingerprint-a",
  }), "session-a");
  assert.equal(resolveObservationOwner({
    connectionId: "connection-a",
    compatibilityGateway: false,
    accessTokenFingerprint: "fingerprint-a",
  }), "connection-a");
  assert.equal(resolveObservationOwner({
    sessionId: "short-session-a",
    connectionId: "connection-a",
    compatibilityGateway: true,
    accessTokenFingerprint: "fingerprint-a",
  }), "authenticated-gateway:fingerprint-a");
  assert.equal(resolveObservationOwner({
    sessionId: "short-session-b",
    connectionId: "connection-b",
    compatibilityGateway: true,
    accessTokenFingerprint: "fingerprint-a",
  }), "authenticated-gateway:fingerprint-a");
  assert.equal(resolveObservationOwner({
    sessionId: "local-session",
    connectionId: "local-connection",
    compatibilityGateway: true,
    accessTokenFingerprint: null,
  }), "local-session");
}

function testStructuredAppErrorFixture(): void {
  const explicit = new AppError({
    code: "manual_target_stale",
    message: "目标已经变化。",
    retryable: true,
    sideEffectStage: "before_click",
    safeDetails: { pageRole: "codex_test" },
  });
  assert.equal(explicit.code, "MANUAL_TARGET_STALE");
  assert.equal(explicit.retryable, true);
  assert.equal(asAppError(explicit), explicit);
  assert.equal(asAppError(new Error("STALE_OBSERVATION:expired")).code, "STALE_OBSERVATION");
}

function testMessageIdentityMigrationFixture(): void {
  const baseline = mergeMessageIdentityState({
    knownMessageIds: ["legacy-work-1", "legacy-work-2"],
    viewedMessageIds: ["legacy-work-1"],
    currentIdentityVersion: null,
    nextIdentityVersion: "server_id_v1",
    incomingMessageIds: ["7665000000000000001", "7665000000000000002"],
  });
  assert.equal(baseline.baselineCreated, true);
  assert.deepEqual(baseline.freshMessageIds, []);
  assert.deepEqual(baseline.knownMessageIds, [
    "7665000000000000001",
    "7665000000000000002",
  ]);
  assert.deepEqual(baseline.viewedMessageIds, []);

  const incremental = mergeMessageIdentityState({
    knownMessageIds: baseline.knownMessageIds,
    viewedMessageIds: ["7665000000000000001"],
    currentIdentityVersion: "server_id_v1",
    nextIdentityVersion: "server_id_v1",
    incomingMessageIds: ["7665000000000000001", "7665000000000000003"],
  });
  assert.equal(incremental.baselineCreated, false);
  assert.deepEqual(incremental.freshMessageIds, ["7665000000000000003"]);
  assert.deepEqual(incremental.viewedMessageIds, ["7665000000000000001"]);
}

function testMessageParsingSafetyFixture(): void {
  const image = Object.create(null) as Record<string, unknown>;
  image.uri = "sticker-fixture";
  image.url_list = ["https://p3-sign.douyinpic.com/sticker.webp"];
  image.width = 194;
  image.height = 207;
  const sticker = Object.create(null) as Record<string, unknown>;
  sticker.aweType = 501;
  sticker.url = image;
  assert.equal(findWorkId(sticker), null);
  assert.equal(extractImageResource(image)?.imageId, "sticker-fixture");
  assert.equal(classifyMessagePayload(sticker).kind, "sticker");

  const shared = { aweType: 800, itemId: "7662799695576157674", cover_url: image };
  assert.equal(findWorkId(shared), "7662799695576157674");
  assert.equal(classifyMessagePayload(shared).kind, "shared_work");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(findWorkId(cyclic), null);
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error("blocked"); },
    get() { throw new Error("blocked"); },
  });
  assert.equal(findWorkId(hostile), null);
  assert.equal(primitiveText(Number.MAX_SAFE_INTEGER + 1), null);

  const message = Object.create({
    serverId: "7665012534433564206",
    sender: "10000000002",
    conversationId: "conversation-fixture",
    orderInConversation: "188",
    createdAt: "2026-07-21T16:03:28.712Z",
    type: 8,
  });
  assert.equal(messageMetadata(message).serverId, "7665012534433564206");
  assert.equal(messageMetadata(message).senderId, "10000000002");

  const baseCandidate = {
    domId: null,
    historyIndex: 0,
    className: "incoming other left",
    text: "",
    hrefs: [],
    attributeValues: [],
    cardDom: false,
    cover: false,
    systemCardDom: false,
    textDom: false,
    mediaKey: "/sticker.webp",
    time: null,
    unread: false,
    nativeReferenceText: "",
    nativeReferenceMedia: false,
    parsedContent: sticker,
    serverId: "7665012534433564206",
    senderId: "10000000002",
    conversationId: "conversation-fixture",
    orderInConversation: "188",
    createdAt: "2026-07-21T16:03:28.712Z",
    sdkType: 8,
  };
  const parsedSticker = parseBoundMessageCandidate(baseCandidate, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(parsedSticker.messageId, "7665012534433564206");
  assert.equal(parsedSticker.identitySource, "server_id");
  assert.equal(parsedSticker.direction, "incoming");
  assert.equal(parsedSticker.messageType, "sticker");
  assert.equal(parsedSticker.text, "[表情包]");

  const ordinaryText700 = parseBoundMessageCandidate({
    ...baseCandidate,
    serverId: "7665012534433564208",
    text: "普通文字也可能使用 aweType 700",
    textDom: true,
    mediaKey: "",
    parsedContent: {
      aweType: 700,
      text: "普通文字也可能使用 aweType 700",
      share_id: "10000000002_1784649793487_7662799695576157674",
    },
  }, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(ordinaryText700.messageType, "text");
  assert.equal(ordinaryText700.visual, null);
  assert.equal(ordinaryText700.workId, null);
  assert.equal(findWorkId({
    aweType: 700,
    share_id: "10000000002_1784649793487_7662799695576157674",
  }), null);

  const imageSticker700 = classifyMessagePayload({
    aweType: 700,
    url: image,
  });
  assert.equal(imageSticker700.kind, "sticker");

  const commentShare = parseBoundMessageCandidate({
    ...baseCandidate,
    serverId: "7665012534433564207",
    text: "分享了一条评论",
    cardDom: true,
    parsedContent: {
      aweType: 10500,
      itemId: "7662799695576157674",
      comment_id: "7664000000000000001",
    },
  }, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(commentShare.messageType, "comment_share");
  assert.equal(commentShare.workId, "7662799695576157674");
  assert.equal(commentShare.commentShare?.commentId, "7664000000000000001");

  const spriteText = parseBoundMessageCandidate({
    ...baseCandidate,
    serverId: "7665012534433564210",
    text: "小火人精灵聊天状态更新",
    textDom: true,
    parsedContent: {
      aweType: 716,
      senderId: "3798190085666864",
      userId: "3798190085666864",
      conversationId: "3798190085666864",
      share_id: "3798190085666864",
      uid: "3798190085666864",
      data: { objectId: "3798190085666864" },
    },
  }, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(spriteText.messageType, "system_card");
  assert.equal(spriteText.workId, null);
  assert.equal(spriteText.openable, false);
  assert.equal(findWorkId({
    senderId: "3798190085666864",
    userId: "3798190085666864",
    conversationId: "3798190085666864",
    share_id: "3798190085666864",
    uid: "3798190085666864",
  }), null);

  const trueSharedWork = parseBoundMessageCandidate({
    ...baseCandidate,
    serverId: "7665012534433564211",
    text: "分享了一个作品",
    cardDom: true,
    cover: true,
    parsedContent: { aweType: 800, aweme_id: "7662799695576157674" },
  }, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(trueSharedWork.messageType, "shared_work");
  assert.equal(trueSharedWork.openable, true);
  assert.equal(trueSharedWork.availability, "available");

  const deletedWork = parseBoundMessageCandidate({
    ...baseCandidate,
    serverId: "7665012534433564212",
    text: "作品已删除，无法查看",
    cardDom: true,
    parsedContent: { aweType: 800, item_id: "7662799695576157675" },
  }, {
    operatorUid: "operator-fixture",
    boundUid: "10000000002",
  });
  assert.equal(deletedWork.messageType, "shared_work");
  assert.equal(deletedWork.workId, "7662799695576157675");
  assert.equal(deletedWork.openable, false);
  assert.equal(deletedWork.availability, "unavailable");
  assert.equal(deletedWork.unavailableReason, "deleted");
}

function testLowRiskPostActionFixture(): void {
  const workId = "7664226610828914255";
  assert.equal(pageRoleForPostScope("own_post"), "operator_home");
  assert.equal(pageRoleForPostScope("bound_user_post"), "operator_home");
  assert.equal(pageRoleForPostScope("external_post"), "codex_test");
  assert.equal(LOW_RISK_MAX_CLICK_ATTEMPTS, 1);

  assert.deepEqual(inspectLowRiskMutationRequest({
    kind: "like",
    url: "https://www.douyin.com/aweme/v1/web/commit/item/digg/",
    postData: `aweme_id=${workId}&type=1`,
    workId,
  }), { relevant: true, targetMatched: true });
  assert.deepEqual(inspectLowRiskMutationRequest({
    kind: "like",
    url: "https://www.douyin.com/aweme/v1/web/commit/item/digg/",
    postData: "aweme_id=7664226610828914999&type=1",
    workId,
  }), { relevant: true, targetMatched: false });
  const responseCode = responseBusinessCode({ status_code: 0, data: {} });
  assert.equal(responseCode, 0);
  assert.equal(businessCodeSucceeded(responseCode), true);

  const optimisticOnly = classifyLowRiskVerification({
    network: {
      requestSeen: true,
      responseSeen: false,
      responseStatus: null,
      responseCode: null,
      businessSucceeded: false,
      targetMismatch: false,
    },
    optimisticTargetState: true,
    reloadCompleted: true,
    persistedAfterReload: false,
  });
  assert.equal(optimisticOnly.level, "optimistic_only");
  assert.equal(verificationIsSuccess(optimisticOnly), false);

  const serverConfirmed = classifyLowRiskVerification({
    network: {
      requestSeen: true,
      responseSeen: true,
      responseStatus: 200,
      responseCode: 0,
      businessSucceeded: true,
      targetMismatch: false,
    },
    optimisticTargetState: false,
    reloadCompleted: false,
    persistedAfterReload: false,
  });
  assert.equal(serverConfirmed.level, "server_confirmed");
  assert.equal(verificationIsSuccess(serverConfirmed), true);

  const acknowledgedButRolledBack = classifyLowRiskVerification({
    network: {
      requestSeen: true,
      responseSeen: true,
      responseStatus: 200,
      responseCode: 0,
      businessSucceeded: true,
      targetMismatch: false,
    },
    optimisticTargetState: true,
    reloadCompleted: true,
    persistedAfterReload: false,
  });
  assert.equal(acknowledgedButRolledBack.level, "optimistic_only");
  assert.equal(verificationIsSuccess(acknowledgedButRolledBack), false);

  const reloadConfirmed = classifyLowRiskVerification({
    network: {
      requestSeen: false,
      responseSeen: false,
      responseStatus: null,
      responseCode: null,
      businessSucceeded: false,
      targetMismatch: false,
    },
    optimisticTargetState: true,
    reloadCompleted: true,
    persistedAfterReload: true,
  });
  assert.equal(reloadConfirmed.level, "reload_confirmed");
  assert.equal(verificationIsSuccess(reloadConfirmed), true);

  const failedResponse = classifyLowRiskVerification({
    network: {
      requestSeen: true,
      responseSeen: true,
      responseStatus: 200,
      responseCode: 1,
      businessSucceeded: false,
      targetMismatch: false,
    },
    optimisticTargetState: true,
    reloadCompleted: true,
    persistedAfterReload: true,
  });
  assert.equal(failedResponse.level, "failed");
  assert.equal(verificationIsSuccess(failedResponse), false);
}

function testLocalTranscriptPromptFixture(): void {
  const prompt = buildTranscriptInitialPrompt({
    title: "用 #ActionScript 和 Canvas 做动画",
    author: "测试作者",
    visibleText: "#OpenAI #Claude",
  });
  assert.match(prompt, /作品标题：/);
  assert.match(prompt, /作者：测试作者/);
  assert.match(prompt, /#OpenAI/);
  assert.match(prompt, /ActionScript/);
  assert.match(prompt, /Hugging Face/);
  assert.match(prompt, /Codex/);
}

async function testTranscriptTemporaryCleanupFixture(): Promise<void> {
  let temporaryDirectory = "";
  await assert.rejects(withTranscriptTemporaryDirectory("fixture-download-failure", async directory => {
    temporaryDirectory = directory;
    await fs.promises.writeFile(`${directory}/partial.mp4`, "partial", "utf8");
    throw new Error("fixture download failed");
  }), /fixture download failed/);
  assert.equal(fs.existsSync(temporaryDirectory), false, "下载失败后不得保留临时媒体目录");
}

function testMessageImageFormatsFixture(): void {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(sniffImageMime(png), "image/png");
  assert.deepEqual(inspectImageBytes(png), {
    mimeType: "image/png",
    width: 1,
    height: 1,
    animated: false,
    frameCount: 1,
  });

  const gif = Buffer.from([
    ...Buffer.from("GIF89a", "ascii"),
    1, 0, 1, 0, 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
    0x3b,
  ]);
  assert.deepEqual(inspectImageBytes(gif), {
    mimeType: "image/gif",
    width: 1,
    height: 1,
    animated: true,
    frameCount: 2,
  });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[20] = 0x02;
  webp[24] = 1;
  webp[27] = 2;
  assert.deepEqual(inspectImageBytes(webp), {
    mimeType: "image/webp",
    width: 2,
    height: 3,
    animated: true,
    frameCount: null,
  });

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
  ]);
  assert.deepEqual(inspectImageBytes(jpeg), {
    mimeType: "image/jpeg",
    width: 3,
    height: 2,
    animated: false,
    frameCount: 1,
  });
}

function testPlatformCommentNormalizationFixture(): void {
  assert.equal(
    normalizePlatformCommentText("ＡＩ\uFE0F \n  评论"),
    "AI 评论",
  );
  assert.equal(
    classifyPlatformCommentText(
      "刚才还在门外转圈，现在终于能认真说句话了。😉",
      "刚才还在门外转圈，现在终于能认真说句话了。",
    ),
    "platform_normalized",
  );
  assert.equal(
    classifyPlatformCommentText("完全不同的原文", "另一条评论"),
    "server_id_only",
  );
}

function testManualControlPolicyFixture(): void {
  assert.equal(classifyManualTarget({
    label: "关闭",
    role: "button",
    kind: "button",
    href: null,
    pageUrl: "https://www.douyin.com/video/1",
  }).risk, "interface");
  assert.equal(classifyManualTarget({
    label: "高清发布",
    role: "button",
    kind: "button",
    href: null,
    pageUrl: "https://creator.douyin.com/creator-micro/content/manage",
  }).risk, "interface");
  assert.equal(classifyManualTarget({
    label: "发布图文",
    role: "menuitem",
    kind: "button",
    href: null,
    pageUrl: "https://creator.douyin.com/creator-micro/content/upload",
  }).risk, "interface");
  assert.equal(classifyManualTarget({
    label: "发布",
    role: "button",
    kind: "button",
    href: null,
    pageUrl: "https://creator.douyin.com/creator-micro/content/publish",
  }).risk, "account");
  assert.equal(classifyManualTarget({
    label: "接受邀请",
    role: "button",
    kind: "button",
    href: null,
    pageUrl: "https://www.douyin.com/chat",
  }).risk, "account");
  assert.equal(classifyManualTarget({
    label: "删除作品",
    role: "button",
    kind: "button",
    href: null,
    pageUrl: "https://creator.douyin.com/creator-micro/content/manage",
  }).requiresDedicatedWorkflow, true);
  assert.deepEqual(pointInsideBox({
    box: { x: 100, y: 50, width: 200, height: 100 },
    offsetX: 2,
    offsetY: -1,
  }), { x: 290, y: 55, offsetX: 0.95, offsetY: 0.05 });
  assert.equal(classifyManualNetworkSignal({
    method: "GET",
    url: "https://creator.douyin.com/api/list",
  }), "read");
  assert.equal(classifyManualNetworkSignal({
    method: "POST",
    url: "https://creator.douyin.com/api/config/query",
  }), "background");
  assert.equal(classifyManualNetworkSignal({
    method: "POST",
    url: "https://creator.douyin.com/api/publish/commit",
  }), "mutation");
  assert.equal(classifyManualNetworkSignal({
    method: "POST",
    url: "https://creator.douyin.com/api/opaque-endpoint",
  }), "mutation");
  const baseEvidence = {
    requestSignalCount: 0,
    responseSignalCount: 0,
    toastCount: 0,
    urlChanged: false,
    domChanged: false,
    composerCleared: false,
    loadingTransition: false,
    disabledTransition: false,
    targetStillPresent: true,
  };
  assert.equal(decideManualRetry(baseEvidence).retryAllowed, true);
  assert.equal(decideManualRetry({ ...baseEvidence, requestSignalCount: 1 }).retryAllowed, false);
}
function testOwnPostReplyFallbackAdapterFixture(): void {
  assert.equal(resolveWriteExecutionAdapter({
    scope: "own_post",
    actionType: "reply_to_comment",
    pageRole: "creator_center",
  }), "creator_center_reply");
  assert.equal(resolveWriteExecutionAdapter({
    scope: "own_post",
    actionType: "reply_to_comment",
    pageRole: "operator_home",
  }), "work_page_reply");
}

function testNotificationParsingFixtures(): void {
  const rawCommentReactShape = {
    awemeId: "7664665666477133107",
    noticeId: "7665983569164452879",
    noticeType: 31,
    createTime: 1_721_234_567,
    noticeLogInfo: { interact_type: "comment", private_callback: () => null },
    noticeInfo: {
      content: "comment notification display content",
      comment: {
        cid: "7665983526496879397",
        text: "我想知道是女方登号替你发的还是你在间接操控这个号[发呆]",
        aweme_id: "7664665666477133107",
        user: { uid: "22222222222", sec_uid: "MS4w.fixture-commenter", nickname: "fixture" },
      },
      aweme: {
        aweme_id: "7664665666477133107",
        desc: "fixture work",
        author: { uid: "11111111111", sec_uid: "MS4w.fixture-owner" },
      },
      private_callback: () => null,
    },
    private_callback: () => null,
  };
  const canonicalComment = canonicalizeNotificationCandidate(rawCommentReactShape);
  assert.equal(canonicalComment?.notice_id, "7665983569164452879");
  assert.equal(canonicalComment?.notice_type, "31");
  assert.equal(canonicalComment?.aweme_id, "7664665666477133107");
  assert.equal(canonicalComment?.content, "comment notification display content");
  assert.equal("noticeInfo" in (canonicalComment ?? {}), false);
  assert.equal("private_callback" in (canonicalComment ?? {}), false);
  const realComment = parseNotificationCandidate(rawCommentReactShape);
  assert.equal(realComment.item?.noticeId, "7665983569164452879");
  assert.equal(realComment.item?.filterType, "comments");
  assert.equal(realComment.item?.targetKind, "comment");
  assert.equal(realComment.item?.work.workId, "7664665666477133107");
  assert.equal(realComment.item?.comment.commentId, "7665983526496879397");
  assert.equal(realComment.item?.openable, true);
  assert.equal(realComment.item?.replyable, true);
  assert.equal(realComment.item?.displayContent, "comment notification display content");

  const realWorkMention = parseNotificationCandidate({
    awemeId: "7665220794474205620",
    noticeId: "7665220941693584424",
    noticeType: 45,
    createTime: "1721234568",
    noticeLogInfo: { interact_type: "at" },
    noticeInfo: {
      content: "FixtureBoundUser mentioned you while publishing",
      schema_url: "https://www.douyin.com/note/7665220794474205620",
      from_user: { uid: "10000000002", sec_uid: "MS4w.fixture-mention", nickname: "FixtureBoundUser" },
      aweme: {
        aweme_id: "7665220794474205620",
        author: { uid: "10000000002", sec_uid: "MS4w.fixture-mention", nickname: "FixtureBoundUser" },
      },
    },
  });
  assert.equal(realWorkMention.item?.filterType, "mentions");
  assert.equal(realWorkMention.item?.targetKind, "work_mention");
  assert.equal(realWorkMention.item?.work.workId, "7665220794474205620");
  assert.equal(realWorkMention.item?.openable, true);

  const realFollow = parseNotificationCandidate({
    noticeId: "7665983569164452884",
    noticeType: 51,
    noticeLogInfo: { interact_type: "follow" },
    noticeInfo: {
      content: "followed you",
      from_user: { uid: "44444444444", sec_uid: "MS4w.fixture-follower", nickname: "follower" },
    },
  });
  assert.equal(realFollow.item?.filterType, "followers");
  assert.equal(realFollow.item?.targetKind, "follower");
  assert.equal(realFollow.item?.work.workId, null);
  assert.equal(realFollow.item?.openable, false);

  const realLike = parseNotificationCandidate({
    awemeId: "7664665666477133111",
    noticeId: "7665983569164452885",
    noticeType: 41,
    noticeLogInfo: { interact_type: "like_single" },
    noticeInfo: {
      from_user: { uid: "55555555555", sec_uid: "MS4w.fixture-liker", nickname: "liker" },
      aweme: { aweme_id: "7664665666477133111" },
    },
  });
  assert.equal(realLike.item?.filterType, "likes");
  assert.equal(realLike.item?.targetKind, "like");
  assert.equal(realLike.item?.work.workId, "7664665666477133111");

  const visibleRowsDiagnostics = {
    visibleNotificationRowCount: 2,
    camelCaseNoticeIdCount: 1,
    snakeCaseNoticeIdCount: 0,
    panelOpen: true,
    emptyStateConfirmed: false,
    pageTargetId: "fixture-notification-target",
  };
  assert.equal(
    notificationExtractionFailureCode(visibleRowsDiagnostics, 0),
    "NOTIFICATION_EXTRACTION_EMPTY_WITH_VISIBLE_ROWS",
  );
  assert.equal(notificationExtractionFailureCode({
    ...visibleRowsDiagnostics,
    visibleNotificationRowCount: 0,
  }, 0), "NOTIFICATION_REACT_SHAPE_UNSUPPORTED");
  assert.equal(notificationExtractionFailureCode({
    ...visibleRowsDiagnostics,
    visibleNotificationRowCount: 0,
    camelCaseNoticeIdCount: 0,
    panelOpen: true,
    emptyStateConfirmed: true,
  }, 0), null);

  const browserSource = fs.readFileSync(new URL("../src/browser.ts", import.meta.url), "utf8");
  const notificationScanSource = browserSource.slice(
    browserSource.indexOf("private async notificationCenterPage"),
    browserSource.indexOf("private async scrollNotificationList"),
  );
  assert.ok(notificationScanSource.length > 0);
  assert.equal(
    notificationScanSource.includes(".bringToFront("),
    false,
    "notification read-only scanning must never steal desktop foreground focus",
  );
  const managedCleanupSource = browserSource.slice(
    browserSource.indexOf("private async cleanupDuplicateUnassignedProfilePages"),
    browserSource.indexOf("private pageId("),
  );
  assert.ok(
    managedCleanupSource.includes("!this.automationCreatedPages.has(page)"),
    "automatic duplicate cleanup must be limited to pages created by this MCP process",
  );
  const notificationTargetSource = browserSource.slice(
    browserSource.indexOf("async openNotificationTarget"),
    browserSource.indexOf("private notificationWriteScope"),
  );
  assert.ok(
    notificationTargetSource.includes("pageWorkId(page) !== item.work.workId")
      && notificationTargetSource.includes("!isManagedNotificationTarget(page)"),
    "an existing user page must not be adopted for later cross-work navigation",
  );
  assert.ok(
    notificationTargetSource.includes("closeSupersededAutomationPages")
      && notificationTargetSource.includes('"role:notification_target"'),
    "notification target browsing must reuse one managed page and retire managed duplicates",
  );

  const workMention = parseNotificationCandidate({
    props: {
      data: {
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
          desc: "FixtureBoundUser 在作品发布时 @你",
          author: {
            nickname: "FixtureBoundUser",
            uid: "10000000002",
            sec_uid: "MS4wLjABAAAA_TEST_BOUND_USER_0000000000000000000000",
          },
        },
      },
    },
  });
  assert.equal(workMention.error, null);
  assert.equal(workMention.item?.filterType, "mentions");
  assert.equal(workMention.item?.targetKind, "work_mention");
  assert.equal(workMention.item?.openable, true);
  assert.equal(workMention.item?.replyable, true);
  assert.equal(workMention.item?.comment.commentId, null);

  const comment = parseNotificationCandidate({
    payload: {
      notice_id: "7665983569164452879",
      notice_type: "31",
      notice_log_info: { interact_type: "comment" },
      item_info: {
        item_id: "7664665666477133107",
        author: { uid: "11111111111", sec_uid: "MS4w.fixture-owner" },
      },
      comment_info: {
        cid: "7665983526496879397",
        text: "我想知道是女方登号替你发的还是你在间接操控这个号[发呆]",
        user: { uid: "22222222222", sec_uid: "MS4w.fixture-commenter", nickname: "fixture" },
      },
    },
  });
  assert.equal(comment.item?.filterType, "comments");
  assert.equal(comment.item?.targetKind, "comment");
  assert.equal(comment.item?.comment.commentId, "7665983526496879397");
  assert.equal(comment.item?.replyable, true);
  const frozenComment = freezeNotificationReplyTarget(comment.item!);
  assert.deepEqual({
    noticeId: frozenComment.noticeId,
    workId: frozenComment.workId,
    commentId: frozenComment.commentId,
    targetKind: frozenComment.targetKind,
  }, {
    noticeId: "7665983569164452879",
    workId: "7664665666477133107",
    commentId: "7665983526496879397",
    targetKind: "comment",
  });

  const deletedWork = parseNotificationCandidate({
    notice_id: "7665983569164452880",
    notice_type: "45",
    noticeLogInfo: { interact_type: "at" },
    aweme: { aweme_id: "7664665666477133108", is_delete: 1 },
  });
  assert.equal(deletedWork.item?.work.availability, "unavailable");
  assert.equal(deletedWork.item?.openable, false);

  const deletedComment = parseNotificationCandidate({
    notice_id: "7665983569164452881",
    notice_type: "31",
    noticeLogInfo: { interact_type: "comment" },
    aweme_id: "7664665666477133109",
    comment: { cid: "7665983526496879398", is_deleted: true },
  });
  assert.equal(deletedComment.item?.comment.availability, "unavailable");
  assert.equal(deletedComment.item?.replyable, false);

  const missingWork = parseNotificationCandidate({
    notice_id: "7665983569164452882",
    notice_type: "45",
    noticeLogInfo: { interact_type: "at" },
    text: "@我的作品 7664665666477133999",
  });
  assert.equal(missingWork.item?.work.workId, null);
  assert.equal(missingWork.item?.openable, false);
  const missingComment = parseNotificationCandidate({
    notice_id: "7665983569164452883",
    notice_type: "31",
    noticeLogInfo: { interact_type: "comment" },
    aweme_id: "7664665666477133110",
  });
  assert.equal(missingComment.item?.targetKind, "unknown");
  assert.equal(missingComment.item?.replyable, false);
  assert.throws(
    () => freezeNotificationReplyTarget(missingComment.item!),
    /NOTIFICATION_NOT_REPLYABLE/,
  );

  assert.deepEqual(classifyNotification({
    noticeType: "1", interactType: "digg", hasWorkId: true, hasCommentId: false,
  }), { filterType: "likes", targetKind: "like" });
  assert.deepEqual(classifyNotification({
    noticeType: "2", interactType: "follow", hasWorkId: false, hasCommentId: false,
  }), { filterType: "followers", targetKind: "follower" });
  assert.deepEqual(classifyNotification({
    noticeType: "3", interactType: "recommend", hasWorkId: true, hasCommentId: false,
  }), { filterType: "recommendations", targetKind: "recommendation" });
  assert.deepEqual(classifyNotification({
    noticeType: "999", interactType: "mystery", hasWorkId: false, hasCommentId: false,
  }), { filterType: "all", targetKind: "unknown" });
  assert.equal(parseNotificationCandidate({ innerText: "FixtureBoundUser 评论了 7665983526496879397" }).item, null);
  assert.equal(dedupeNotifications([
    workMention.item!,
    workMention.item!,
    comment.item!,
  ]).length, 2);
}

function testNativeMentionFixtures(): void {
  const [mention] = resolveNativeMentions([{ alias: "bound_user", placement: "caption_end" }]);
  const exact = chooseExactNativeMentionCandidate([
    {
      displayName: "FixtureBoundUser",
      uid: "00000000000",
      secUid: "wrong-sec-uid",
      href: "https://www.douyin.com/user/wrong-sec-uid",
      selectorToken: "duplicate-nickname",
    },
    {
      displayName: "FixtureBoundUser",
      uid: mention.uid,
      secUid: mention.secUid,
      href: `https://www.douyin.com/user/${mention.secUid}`,
      selectorToken: "exact-bound-user",
    },
  ], mention);
  assert.equal(exact.selectorToken, "exact-bound-user");
  assert.throws(() => chooseExactNativeMentionCandidate([
    { ...exact, selectorToken: "one" },
    { ...exact, selectorToken: "two" },
  ], mention), /NATIVE_MENTION_CANDIDATE_NOT_UNIQUE:2/);
  assert.throws(() => chooseExactNativeMentionCandidate([{
    ...exact,
    uid: mention.uid,
    secUid: "wrong-sec-uid",
    href: "https://www.douyin.com/user/wrong-sec-uid",
  }], mention), /NATIVE_MENTION_CANDIDATE_NOT_UNIQUE:0/);

  const nativeDom = inspectNativeMentionDomFixture({
    text: "测试文案 @FixtureBoundUser",
    nodes: [{
      native: true,
      displayName: "FixtureBoundUser",
      uid: mention.uid,
      secUid: mention.secUid,
      placement: "caption_end",
      domPath: "div.editor > span.native-mention",
    }],
  });
  assert.equal(nativeMentionsMatch([mention], nativeDom), true);
  const plainOnly = inspectNativeMentionDomFixture({
    text: "测试文案 @FixtureBoundUser",
    nodes: [],
  });
  assert.equal(nativeMentionsMatch([mention], plainOnly), false);
  assert.deepEqual(plainOnly.plainTextMentions, ["FixtureBoundUser"]);
}

function testGifNestedMetadataConsistencyFixture(): void {
  const synchronized = synchronizeVisualMetadata({
    kind: "sticker" as const,
    width: null,
    height: null,
    animated: false,
  }, {
    width: 194,
    height: 207,
    animated: true,
  });
  assert.deepEqual(synchronized, {
    kind: "sticker",
    width: 194,
    height: 207,
    animated: true,
  });
}

testOwnPostReplyFallbackAdapterFixture();
testNotificationParsingFixtures();
testNativeMentionFixtures();
testGifNestedMetadataConsistencyFixture();
testObservationOwnerPolicyFixture();
testStructuredAppErrorFixture();
testMessageIdentityMigrationFixture();
testMessageParsingSafetyFixture();
testMessageImageFormatsFixture();
testPlatformCommentNormalizationFixture();
testManualControlPolicyFixture();
testArticlePrivacyFixture();
testArticleRecommendationOnlyFixture();
testWorkContextFixture();
testNativeChaptersFixture();
testTimelineFixture();
testMetaFixture();
testActionConfigurationFixture();
testSafetyHostFixture();
testSafeSocialActionFixture();
testPublishingStateMachineFixture();
testPublisherMusicRouteFixture();
testMusicCandidateIdentityFixture();
testCreatorLoginSignalsFixture();
testMissingCoverIncidentRegressionFixture();
testHashtagRegressionFixture();
testLockedSnapshotFixture();
testCommentConfirmationFixture();
testPublicVideoResolverFixture();
testBoundPostWorkflowFixture();
testCreatorReplyTransactionRegressionFixture();
testCreatorCommentMatchingFixture();
testRootCommentComposerSelectionFixture();
testAdaptiveSubmitEvidenceFixture();
testRootCommentSubmitPolicyFixture();
testPostCaptionReadbackNormalization();
testBrowserPagePolicy();
testLowRiskPostActionFixture();
testLocalTranscriptPromptFixture();
await testTranscriptTemporaryCleanupFixture();
testGenericClickNavigationAllowlist();
testEveryToolDeclaresOutputSchema();
await testCapabilityManifestCompatibility();

console.log("FIXTURE_TESTS=PASS");
