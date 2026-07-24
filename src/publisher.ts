import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { CONFIG } from "./config.js";
import { assertDouyinPublishPage } from "./safety.js";
import type { PublishCarouselResult, PublishTextResult } from "./types.js";
import {
  PublishSnapshotStore,
  evaluatePreflight,
  hashtagsEqual,
} from "./publish-workflow.js";
import {
  inspectArticleEditor,
  uploadArticleCover,
} from "./publisher-tools.js";
import {
  closePostMusicPicker,
  openPostMusicPicker,
  readSelectedPostMusic,
  resolvePostMusicCandidateId,
  searchPostMusic,
  selectPostMusicCandidate,
} from "./post-draft-publisher.js";

const textSnapshots = new PublishSnapshotStore();

type Artifact = {
  screenshotPath: string;
  diagnosticsPath: string;
  screenshotBase64: string;
};

function normalizeHashtags(values: string[]): string[] {
  const tags = [...new Set(values.map(value => value.replace(/^#+/, "").trim()).filter(Boolean))];
  if (tags.length > 5) throw new Error("抖音发布页最多添加 5 个话题。");
  if (tags.some(tag => tag.length > 50 || /[\r\n]/.test(tag))) {
    throw new Error("话题必须是 1-50 个字符且不能包含换行。");
  }
  return tags;
}

function canonicalEditorText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

export function creatorLoginConfirmed(evidence: {
  url: string;
  accountVerified: boolean;
  explicitLoginPrompt: boolean;
  accountAvatar: boolean;
  highDefinitionPublish: boolean;
  workList: boolean;
}): boolean {
  if (/passport|login|sso/i.test(evidence.url)) return false;
  if (evidence.accountVerified
    || evidence.accountAvatar
    || evidence.highDefinitionPublish
    || evidence.workList) {
    return true;
  }
  if (evidence.explicitLoginPrompt) return false;
  return false;
}

async function loggedIn(page: Page, accountVerified = false): Promise<boolean> {
  const evidence = await page.evaluate(() => {
    const body = document.body?.innerText ?? "";
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const accountAvatar = Array.from(document.querySelectorAll<HTMLElement>(
      "[class*='avatar' i],img[alt*='头像'],img[alt='author avatar']",
    )).some(element => {
      if (!visible(element)) return false;
      const imageSource = element instanceof HTMLImageElement ? element.currentSrc || element.src : "";
      return Boolean(imageSource || getComputedStyle(element).backgroundImage !== "none"
        || element.querySelector("img,[style*='background-image']"));
    });
    const highDefinitionPublish = Array.from(document.querySelectorAll<HTMLElement>(
      "#douyin-creator-master-side-upload,button,[role='button']",
    )).some(element => visible(element)
      && (element.innerText || element.textContent || "").trim() === "高清发布");
    const workList = location.pathname === "/creator-micro/content/manage"
      && (/共\s*\d+\s*个作品/.test(body)
        || /没有更多作品/.test(body)
        || (/作品管理/.test(body) && /已发布/.test(body) && /编辑作品|设置权限/.test(body)));
    return {
      explicitLoginPrompt: /扫码登录|验证码登录|登录抖音/.test(body),
      accountAvatar,
      highDefinitionPublish,
      workList,
    };
  }).catch(() => ({
    explicitLoginPrompt: false,
    accountAvatar: false,
    highDefinitionPublish: false,
    workList: false,
  }));
  return creatorLoginConfirmed({
    url: page.url(),
    accountVerified,
    ...evidence,
  });
}

async function closeTips(page: Page): Promise<void> {
  for (const label of ["我知道了", "知道了"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.count() > 0 && await button.first().isVisible().catch(() => false)) {
      await button.first().click({ timeout: 2_000 }).catch(() => null);
    }
  }
}

async function saveArtifact(
  page: Page,
  operation: string,
  details: Record<string, unknown>,
): Promise<Artifact> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(CONFIG.runtimeDir, "publish-diagnostics", `${stamp}-${operation}`);
  await fs.mkdir(directory, { recursive: true });
  const screenshotPath = path.join(directory, "page.png");
  const diagnosticsPath = path.join(directory, "diagnostics.json");
  let screenshotBase64 = "";
  let screenshotError: string | null = null;
  const session = await page.context().newCDPSession(page).catch(() => null);
  try {
    const captured = session
      ? await Promise.race([
          session.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          }),
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error("CDP_SCREENSHOT_TIMEOUT")),
            2_500,
          )),
        ]) as { data?: string }
      : null;
    if (!captured?.data) throw new Error("CDP_SCREENSHOT_EMPTY");
    screenshotBase64 = captured.data;
    await fs.writeFile(screenshotPath, Buffer.from(captured.data, "base64"));
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
    try {
      const screenshot = await page.screenshot({
        path: screenshotPath,
        type: "png",
        fullPage: false,
        animations: "disabled",
        timeout: 5_000,
      });
      screenshotBase64 = screenshot.toString("base64");
      screenshotError = null;
    } catch (fallbackError) {
      screenshotError += `; Playwright fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
    }
  } finally {
    void session?.detach().catch(() => null);
  }
  const visibleText = await page.locator("body").innerText().catch(() => "");
  await fs.writeFile(diagnosticsPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    operation,
    url: page.url(),
    title: await page.title().catch(() => ""),
    visibleText: visibleText.slice(0, 20_000),
    screenshotError,
    ...details,
  }, null, 2), "utf8");
  return {
    screenshotPath: screenshotBase64 ? screenshotPath : "",
    diagnosticsPath,
    screenshotBase64,
  };
}

async function addTopics(page: Page, hashtags: string[]): Promise<void> {
  if (hashtags.length === 0) return;
  const open = page.getByText("点击添加话题", { exact: true });
  if (await open.count() !== 1 || !await open.isVisible().catch(() => false)) {
    throw new Error("发布页没有找到唯一的“点击添加话题”入口。");
  }
  await open.click({ timeout: 4_000 });
  const search = page.getByPlaceholder("搜索或输入你想添加的话题");
  await search.waitFor({ state: "visible", timeout: 5_000 });
  for (const tag of hashtags) {
    const requested = tag.replace(/^#+/, "").trim();
    await search.fill(requested);
    const candidates = page.locator(
      "[role='option'],[data-e2e*='topic'],[class*='dropdownItem'],"
      + "[class*='topicName'],[class*='topic-item'],[class*='TopicItem']",
    );
    let result = null as ReturnType<Page["locator"]> | null;
    const returned: string[] = [];
    const deadline = Date.now() + 5_000;
    while (!result && Date.now() < deadline) {
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const label = (await candidate.innerText().catch(() => "")).trim();
        if (label) returned.push(label.slice(0, 120));
        const candidateTag = label.match(/#([^\s#，,、]+)/)?.[1] ?? label.split(/\s+/)[0];
        if (hashtagsEqual(candidateTag, requested)) {
          result = candidate;
          break;
        }
      }
      if (!result) {
        const textMatches = page.getByText(new RegExp(`^#?${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
        for (let index = 0; index < await textMatches.count(); index += 1) {
          if (await textMatches.nth(index).isVisible().catch(() => false)) {
            result = textMatches.nth(index);
            break;
          }
        }
      }
      if (!result) await page.waitForTimeout(250);
    }
    if (!result) {
      throw new Error(`HASHTAG_NOT_CONFIRMED:没有精确匹配 #${requested}。候选：${returned.join("；") || "无"}`);
    }
    await result.click({ timeout: 4_000 });
    const selected = await page.locator(
      "[data-e2e*='selected-topic'],[class*='selectedTopic'],[class*='topicItem'],[class*='TopicItem']",
    ).allInnerTexts();
    if (!selected.some(value => {
      const found = value.match(/#([^\s#，,、]+)/)?.[1] ?? value.trim();
      return hashtagsEqual(found, requested);
    })) {
      throw new Error(`HASHTAG_NOT_CONFIRMED:点击后没有出现 #${requested} 话题胶囊。`);
    }
  }
  const confirm = page.getByText(/确认添加/).last();
  if (!await confirm.isVisible().catch(() => false)) throw new Error("话题弹窗没有找到“确认添加”。");
  await confirm.click({ timeout: 4_000 });
  const finalTags = (await page.locator(
    "[data-e2e*='topic'],[class*='topic'],[class*='Topic'],[class*='hashtag']",
  ).allInnerTexts()).flatMap(value => value.match(/#[^\s#，,、]+/g) ?? []);
  if (hashtags.some(tag => !finalTags.some(actual => hashtagsEqual(actual, tag)))) {
    throw new Error(`HASHTAG_NOT_CONFIRMED:确认添加后话题数量或内容不一致。`);
  }
}

async function reachTextPreview(page: Page): Promise<{
  reached: boolean;
  clicked: boolean;
  articleRoute: boolean;
  livePreview: boolean;
  finalPublishButton: boolean;
}> {
  await closePostMusicPicker(page).catch(() => false);
  const controls = page.locator("button,[role='button'],[role='tab']");
  const previewIndexes: number[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false)) continue;
    const text = (await control.innerText().catch(() => "")).replace(/\s+/g, "").trim();
    if (/^预览(?:首页推荐|双列封面|文章)?$/.test(text)) previewIndexes.push(index);
  }
  let clicked = false;
  if (previewIndexes.length > 0) {
    const control = controls.nth(previewIndexes[0]);
    const selected = await control.getAttribute("aria-selected") === "true"
      || /active|selected/.test(await control.getAttribute("class") ?? "");
    if (!selected) {
      await control.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      clicked = true;
    }
  }
  const evidence = await page.evaluate(() => {
    const body = document.body.innerText || "";
    const publishButtons = Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
      .filter(element => (element.innerText || element.textContent || "").trim() === "发布")
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length;
    return {
      articleRoute: /\/creator-micro\/content\/post\/article/.test(location.pathname),
      livePreview: /预览首页推荐|预览双列封面|阅读文章/.test(body),
      finalPublishButton: publishButtons === 1,
    };
  });
  return {
    ...evidence,
    clicked,
    reached: evidence.articleRoute && evidence.livePreview && evidence.finalPublishButton,
  };
}

export function getTextPreviewRecord(previewId: string) {
  return textSnapshots.read(previewId);
}

export function markTextPreviewPublished(
  previewId: string,
  evidence: { workId?: string; workUrl?: string } = {},
): void {
  textSnapshots.markPublished(previewId, evidence);
}

export async function verifyTextPreviewSnapshot(
  page: Page,
  previewId: string,
  binding: { pageId: string; targetId: string; account: string },
) {
  const current = await inspectArticleEditor(page, binding);
  textSnapshots.verify(previewId, current);
  return current;
}

export function markTextPreviewSubmitAttempted(previewId: string): void {
  textSnapshots.markSubmitAttempted(previewId);
}

export async function lockCurrentTextPreview(
  page: Page,
  binding: { pageId: string; targetId: string; account: string },
) {
  const current = await inspectArticleEditor(page, binding);
  const preflight = evaluatePreflight(current, {
    account: binding.account,
    pageId: binding.pageId,
    pageTargetId: binding.targetId,
    title: current.title,
    text: current.text,
    hashtags: current.hashtags,
    coverRequired: true,
    musicRequired: false,
  });
  current.preflightPassed = preflight.passed;
  if (!preflight.passed) {
    throw new Error(`TEXT_PREVIEW_PREFLIGHT_FAILED:${preflight.missing.join(",")}`);
  }
  return textSnapshots.lock(current);
}

async function finalizeTextPublication(page: Page, options: {
  text: string;
  title: string;
  hashtags: string[];
  confirmPublish?: boolean;
  previewId?: string;
  binding: { pageId: string; targetId: string; account: string };
}): Promise<Omit<PublishTextResult, keyof Artifact>> {
  const base = {
    requestedAction: "publish" as const,
    published: false,
    text: options.text,
    title: options.title,
    hashtags: options.hashtags,
    entryFound: true,
    editorFound: true,
    contentFilled: true,
    previewReached: true,
    verifiedText: false,
    verifiedTitle: false,
    pageUrl: page.url(),
    pageTitle: await page.title(),
    detectedEntry: "已绑定的发布文章编辑器",
    previewId: options.previewId ?? null,
    pageId: options.binding.pageId,
    pageTargetId: options.binding.targetId,
    work_id: null,
    work_url: null,
  };
  if (options.confirmPublish !== true) {
    return {
      ...base,
      status: "needs_user_action",
      errorCode: "VALIDATION_FAILED",
      errorStep: "final_confirmation",
      errorMessage: "action=publish 还需要 confirm_publish=true；未点击发布。",
      missing: ["VALIDATION_FAILED"],
    };
  }
  if (!options.previewId) {
    return {
      ...base,
      status: "blocked",
      errorCode: "SNAPSHOT_REQUIRED",
      errorStep: "verify_locked_snapshot",
      errorMessage: "正式发布必须提供 preview 阶段返回的 preview_id。",
      missing: ["SNAPSHOT_REQUIRED"],
    };
  }
  const current = await inspectArticleEditor(page, options.binding);
  const preflight = evaluatePreflight(current, {
    account: options.binding.account,
    pageId: options.binding.pageId,
    pageTargetId: options.binding.targetId,
    title: options.title,
    text: options.text,
    hashtags: options.hashtags,
    coverRequired: true,
  });
  current.preflightPassed = preflight.passed;
  if (!preflight.passed) {
    return {
      ...base,
      status: preflight.status,
      errorCode: preflight.errorCode,
      errorStep: "preflight",
      errorMessage: `发布前预检失败：${preflight.missing.join(", ")}`,
      missing: preflight.missing,
      snapshot: current as unknown as Record<string, unknown>,
    };
  }
  try {
    textSnapshots.verify(options.previewId, current);
  } catch (error) {
    const code = error instanceof Error ? error.message : "SNAPSHOT_MISMATCH";
    return {
      ...base,
      status: "blocked",
      errorCode: code,
      errorStep: "verify_locked_snapshot",
      errorMessage: code === "DUPLICATE_PUBLISH"
        ? "该 preview_id 已完成过发布，已阻止重复点击。"
        : "当前编辑器内容与锁定快照不一致，未点击发布。",
      missing: [code],
      snapshot: current as unknown as Record<string, unknown>,
    };
  }
  const publish = page.getByRole("button", { name: "发布", exact: true });
  if (await publish.count() !== 1 || !await publish.isVisible().catch(() => false)) {
    return {
      ...base,
      status: "blocked",
      errorCode: "VALIDATION_FAILED",
      errorStep: "click_final_publish",
      errorMessage: "没有唯一找到最终“发布”按钮，未点击。",
      missing: ["VALIDATION_FAILED"],
      snapshot: current as unknown as Record<string, unknown>,
    };
  }
  textSnapshots.markSubmitAttempted(options.previewId);
  await publish.click({ timeout: 5_000 });
  await page.waitForTimeout(2_000);
  const evidence = await page.evaluate(() => {
    const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const blocker = text.match(/没有选择封面|请选择封面|标题不能为空|正文不能为空|话题[^。]*失败/)?.[0] ?? null;
    const explicitSuccess = /发布成功|作品已发布|提交成功|审核中/.test(text);
    const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>(
      "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
    )).map(anchor => anchor.href);
    candidates.unshift(location.href);
    const workUrl = candidates.find(value => /\/(?:video|note|article)\/\d{8,}/.test(value)) ?? null;
    const workId = workUrl?.match(/\/(?:video|note|article)\/(\d{8,})/)?.[1] ?? null;
    return { blocker, explicitSuccess, workUrl, workId, url: location.href };
  });
  if (evidence.blocker) {
    return {
      ...base,
      pageUrl: page.url(),
      status: "needs_user_action",
      errorCode: /封面/.test(evidence.blocker) ? "MISSING_COVER" : "VALIDATION_FAILED",
      errorStep: "publish_blocked_by_page",
      errorMessage: evidence.blocker,
      missing: [/封面/.test(evidence.blocker) ? "MISSING_COVER" : "VALIDATION_FAILED"],
      snapshot: current as unknown as Record<string, unknown>,
    };
  }
  if (!evidence.explicitSuccess || !evidence.workId || !evidence.workUrl) {
    return {
      ...base,
      pageUrl: page.url(),
      status: "publishing",
      errorCode: null,
      errorStep: null,
      errorMessage: null,
      missing: [],
      uncertain: true,
      snapshot: current as unknown as Record<string, unknown>,
    };
  }
  return {
    ...base,
    pageUrl: page.url(),
    status: "publishing",
    errorCode: null,
    errorStep: null,
    errorMessage: null,
    missing: [],
    snapshot: current as unknown as Record<string, unknown>,
    work_id: evidence.workId,
    work_url: evidence.workUrl,
    uncertain: false,
  };
}

export async function prepareTextPublication(page: Page, options: {
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
  loginConfirmed?: boolean;
  binding: { pageId: string; targetId: string; account: string };
}): Promise<PublishTextResult> {
  const text = options.text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("文字作品正文不能为空。");
  if (text.length > 8_000) throw new Error("文字作品正文不能超过 8000 个字符。");
  const action = options.action ?? "preview";
  const hashtags = normalizeHashtags(options.hashtags ?? []);
  const requestedTitle = options.title?.trim() || null;
  if (requestedTitle && requestedTitle.length > 30) throw new Error("文章标题不能超过 30 个字符。");
  const firstLine = text.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  const effectiveRequestedTitle = requestedTitle ?? firstLine.slice(0, 30);
  if (action === "publish") {
    const state = await finalizeTextPublication(page, {
      text,
      title: effectiveRequestedTitle,
      hashtags,
      confirmPublish: options.confirmPublish,
      previewId: options.previewId,
      binding: options.binding,
    });
    const artifact = await saveArtifact(page, "publish-text", state);
    return { ...state, ...artifact };
  }
  let entryFound = false;
  let editorFound = false;
  let contentFilled = false;
  let previewReached = false;
  let previewClicked = false;
  let musicSelectionStatus: PublishTextResult["musicSelectionStatus"] = "not_requested";
  let musicCandidates: NonNullable<PublishTextResult["musicCandidates"]> = [];
  let musicError: string | null = null;
  let currentStep = "open_creator_page";
  let currentErrorCode = "UNEXPECTED_ERROR";
  let state: Omit<PublishTextResult, keyof Artifact>;
  try {
    currentStep = "check_publish_page";
    currentErrorCode = "INVALID_PUBLISH_PAGE";
    assertDouyinPublishPage(page.url());
    await page.waitForFunction(() => {
      const body = document.body.innerText || "";
      return /高清发布|内容管理|作品管理|发布视频|发布图文|发布文章|基础信息|扫码登录|验证码登录|登录抖音/.test(body);
    }, undefined, { timeout: 15_000 }).catch(() => null);
    if (!await loggedIn(page, options.loginConfirmed === true)) {
      state = {
        status: "blocked", requestedAction: action, published: false, text,
        title: requestedTitle, hashtags, entryFound, editorFound, contentFilled, previewReached,
        verifiedText: false, verifiedTitle: false,
        pageUrl: page.url(), pageTitle: await page.title(), detectedEntry: null,
        errorCode: "LOGIN_REQUIRED",
        errorStep: "check_login", errorMessage: "抖音创作者中心当前未登录。",
      };
    } else {
      await closeTips(page);
      currentStep = "find_native_text_entry";
      currentErrorCode = "NATIVE_TEXT_ENTRY_NOT_FOUND";
      const entry = page.getByRole("menuitem", { name: "发布文章", exact: true }).first();
      const existingEditor = page.locator('[contenteditable="true"][role="textbox"]').first();
      const editorAlreadyOpen = /\/creator-micro\/content\/post\/article/.test(new URL(page.url()).pathname)
        && await existingEditor.isVisible().catch(() => false);
      let entryVisible = await entry.isVisible().catch(() => false);
      if (!editorAlreadyOpen && !entryVisible) {
        const highDefinitionPublish = page.getByText("高清发布", { exact: true }).first();
        if (await highDefinitionPublish.isVisible().catch(() => false)) {
          await highDefinitionPublish.hover({ timeout: 5_000 });
          await entry.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);
          entryVisible = await entry.isVisible().catch(() => false);
        }
      }
      if (!editorAlreadyOpen && !entryVisible) {
        state = {
          status: "failed", requestedAction: action, published: false, text,
          title: requestedTitle, hashtags, entryFound, editorFound, contentFilled, previewReached,
          verifiedText: false, verifiedTitle: false,
          pageUrl: page.url(), pageTitle: await page.title(), detectedEntry: null,
          errorCode: "NATIVE_TEXT_ENTRY_NOT_FOUND",
          errorStep: "find_native_text_entry",
          errorMessage: "当前网页版没有检测到“发布文章”原生文字入口，未改用图片作品。",
        };
      } else {
        entryFound = true;
        if (!editorAlreadyOpen) {
          await entry.click({ timeout: 5_000 });
          await page.waitForTimeout(600);
        }
        currentStep = "open_native_text_editor";
        currentErrorCode = "NATIVE_TEXT_EDITOR_NOT_FOUND";
        const write = page.getByText("我要发文", { exact: true });
        if (!editorAlreadyOpen && await write.count() > 0 && await write.first().isVisible().catch(() => false)) {
          await write.first().click({ timeout: 5_000 });
        }
        const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
        await editor.waitFor({ state: "visible", timeout: 15_000 });
        editorFound = true;
        await closeTips(page);
        assertDouyinPublishPage(page.url());
        const titleInput = page.getByPlaceholder(/请输入文章标题/).first();
        const hasTitle = await titleInput.count() === 1 && await titleInput.isVisible().catch(() => false);
        const effectiveTitle = hasTitle ? (requestedTitle ?? firstLine.slice(0, 30)) : null;
        if (hasTitle && !effectiveTitle) throw new Error("发布页要求独立标题，但正文没有可用首行。");
        let topicsAlreadyConfirmed = false;
        let contentAlreadyConfirmed = false;
        if (editorAlreadyOpen) {
          const existingSnapshot = await inspectArticleEditor(page, options.binding);
          const existingText = (await editor.innerText()).replace(/\r\n?/g, "\n").trim();
          const existingTitle = hasTitle ? (await titleInput.inputValue()).trim() : "";
          const titleMismatch = Boolean(existingTitle && effectiveTitle && existingTitle !== effectiveTitle);
          const textMismatch = Boolean(existingText
            && canonicalEditorText(existingText) !== canonicalEditorText(text));
          const topicMismatch = existingSnapshot.hashtags.length > 0 && (
            existingSnapshot.hashtags.length !== hashtags.length
            || hashtags.some(tag => !existingSnapshot.hashtags.some(actual => hashtagsEqual(actual, tag)))
          );
          topicsAlreadyConfirmed = existingSnapshot.hashtags.length === hashtags.length
            && hashtags.every(tag => existingSnapshot.hashtags.some(actual => hashtagsEqual(actual, tag)));
          if (titleMismatch || textMismatch || topicMismatch) {
            currentErrorCode = "VALIDATION_FAILED";
            currentStep = "inspect_existing_draft";
            throw new Error("VALIDATION_FAILED:当前绑定编辑器存在与本次输入不一致的旧草稿；未覆盖。请先调用 douyin_inspect_current_draft，确认后再重置。");
          }
          contentAlreadyConfirmed = Boolean(existingTitle && existingText)
            && !titleMismatch && !textMismatch && topicsAlreadyConfirmed;
        }
        currentStep = "fill_native_text";
        currentErrorCode = "TEXT_FILL_FAILED";
        if (options.resumeOnly && !contentAlreadyConfirmed) {
          throw new Error("VALIDATION_FAILED:当前草稿尚未完整匹配预期内容；resume_only 不会重新填写。");
        }
        if (!contentAlreadyConfirmed) {
          if (effectiveTitle) await titleInput.fill(effectiveTitle);
          await editor.fill(text);
          if (!topicsAlreadyConfirmed) await addTopics(page, hashtags);
        }
        const actualText = canonicalEditorText(await editor.innerText());
        const actualTitle = hasTitle ? (await titleInput.inputValue()).trim() : null;
        const verifiedText = actualText === canonicalEditorText(text);
        const verifiedTitle = effectiveTitle === actualTitle;
        contentFilled = verifiedText && verifiedTitle;
        if (!verifiedText || !verifiedTitle) {
          currentErrorCode = "TEXT_FILL_VERIFICATION_FAILED";
          throw new Error(`发布页内容校验失败：正文一致=${verifiedText}，标题一致=${verifiedTitle}。`);
        }
        if (options.workflowStep === "fill_text") {
          const snapshot = await inspectArticleEditor(page, options.binding);
          const partialState: Omit<PublishTextResult, keyof Artifact> = {
            status: "draft",
            requestedAction: action,
            published: false,
            text,
            title: effectiveTitle,
            hashtags,
            entryFound,
            editorFound,
            contentFilled,
            previewReached: false,
            previewClicked: false,
            verifiedText,
            verifiedTitle,
            pageUrl: page.url(),
            pageTitle: await page.title(),
            detectedEntry: "发布文章 > 我要发文",
            errorCode: null,
            errorStep: null,
            errorMessage: null,
            snapshot: snapshot as unknown as Record<string, unknown>,
            musicSelectionStatus,
            musicCandidates,
            musicError,
          };
          const artifact = await saveArtifact(page, "fill-text", partialState);
          return { ...partialState, ...artifact };
        }
        if (options.musicQuery || options.musicId) {
          currentStep = "select_music";
          currentErrorCode = "MUSIC_SELECTION_FAILED";
          const currentMusic = await readSelectedPostMusic(page);
          const queryMatchesCurrent = Boolean(options.musicQuery && currentMusic
            && currentMusic.title.localeCompare(options.musicQuery.trim(), undefined, { sensitivity: "accent" }) === 0);
          const idMatchesCurrent = Boolean(options.musicId && currentMusic
            && (currentMusic.id === options.musicId || currentMusic.pageId === options.musicId));
          if (queryMatchesCurrent || idMatchesCurrent) {
            musicSelectionStatus = "already_selected";
          } else {
            try {
              const musicItems = options.musicQuery
                ? await searchPostMusic(page, options.musicQuery)
                : await openPostMusicPicker(page);
              musicCandidates = musicItems;
              if (musicItems.length === 0) {
                musicError = "MUSIC_SEARCH_NO_RESULTS";
                await closePostMusicPicker(page);
                if (options.musicRequired === true) throw new Error(musicError);
                musicSelectionStatus = "skipped_optional";
              } else if (!options.musicId) {
                musicSelectionStatus = "candidates_returned";
                await closePostMusicPicker(page);
              } else {
                const candidateId = resolvePostMusicCandidateId(musicItems, {
                  musicId: options.musicId,
                });
                await selectPostMusicCandidate(page, candidateId);
                musicSelectionStatus = "selected";
              }
            } catch (error) {
              musicError = error instanceof Error ? error.message : String(error);
              await closePostMusicPicker(page).catch(() => false);
              if (options.musicRequired === true) throw error;
              musicSelectionStatus = "skipped_optional";
            }
          }
        }
        currentStep = "verify_text_preview";
        currentErrorCode = "TEXT_PREVIEW_NOT_REACHED";
        const previewEvidence = await reachTextPreview(page);
        previewReached = previewEvidence.reached;
        previewClicked = previewEvidence.clicked;
        if (!previewReached) {
          throw new Error(
            `未到达可核验的文字预览状态：文章路由=${previewEvidence.articleRoute}，`
            + `预览区域=${previewEvidence.livePreview}，发布按钮=${previewEvidence.finalPublishButton}。`,
          );
        }
        if (options.coverPath) await uploadArticleCover(page, options.coverPath);
        const snapshot = await inspectArticleEditor(page, options.binding);
        const preflight = evaluatePreflight(snapshot, {
          account: options.binding.account,
          pageId: options.binding.pageId,
          pageTargetId: options.binding.targetId,
          title: effectiveTitle ?? "",
          text,
          hashtags,
          coverRequired: true,
          musicRequired: options.musicRequired === true,
        });
        snapshot.preflightPassed = preflight.passed;
        const locked = preflight.passed ? textSnapshots.lock(snapshot) : null;
        const status: PublishTextResult["status"] = preflight.status;
        const published = false;
        const errorCode: string | null = preflight.errorCode;
        const errorStep: string | null = preflight.passed ? null : "preflight";
        const errorMessage: string | null = preflight.passed
          ? null
          : `发布前预检失败：${preflight.missing.join(", ")}`;
        state = {
          status, requestedAction: action, published, text, title: effectiveTitle, hashtags,
          entryFound, editorFound, contentFilled, previewReached, previewClicked, verifiedText, verifiedTitle,
          pageUrl: page.url(), pageTitle: await page.title(),
          detectedEntry: "发布文章 > 我要发文", errorCode, errorStep, errorMessage,
          previewId: locked?.previewId ?? null,
          pageId: options.binding.pageId,
          pageTargetId: options.binding.targetId,
          missing: preflight.missing,
          snapshot: snapshot as unknown as Record<string, unknown>,
          musicSelectionStatus,
          musicCandidates,
          musicError,
        };
      }
    }
  } catch (error) {
    state = {
      status: "failed", requestedAction: action, published: false, text, title: requestedTitle,
      hashtags, entryFound, editorFound, contentFilled, previewReached,
      previewClicked,
      verifiedText: contentFilled, verifiedTitle: contentFilled, pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      detectedEntry: entryFound ? "发布文章 > 我要发文" : null,
      errorCode: currentErrorCode,
      errorStep: currentStep,
      errorMessage: error instanceof Error ? error.message : String(error),
      musicSelectionStatus,
      musicCandidates,
      musicError,
    };
  }
  const artifact = await saveArtifact(page, "publish-text", state);
  return { ...state, ...artifact };
}

async function validateImages(values: string[]): Promise<string[]> {
  if (values.length < 1 || values.length > 35) throw new Error("图片图集必须包含 1-35 张图片。");
  const supported = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
  const resolved: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (!path.isAbsolute(values[index])) throw new Error(`image_paths[${index}] 必须是绝对路径。`);
    const file = path.resolve(values[index]);
    if (!supported.has(path.extname(file).toLowerCase())) {
      throw new Error(`image_paths[${index}] 格式不受支持：${path.extname(file)}`);
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`image_paths[${index}] 不存在或不可读：${file}`);
    if (stat.size > 50 * 1024 * 1024) throw new Error(`image_paths[${index}] 超过 50MB。`);
    resolved.push(file);
  }
  return resolved;
}

export async function prepareCarouselPublication(page: Page, options: {
  imagePaths: string[];
  caption?: string;
  title?: string;
  hashtags?: string[];
  action?: "preview" | "publish";
  confirmPublish?: boolean;
}): Promise<PublishCarouselResult> {
  const imagePaths = await validateImages(options.imagePaths);
  const expectedNames = imagePaths.map(file => path.basename(file));
  const action = options.action ?? "preview";
  const hashtags = normalizeHashtags(options.hashtags ?? []);
  const caption = options.caption?.trim() || null;
  const title = options.title?.trim() || null;
  let currentStep = "open_creator_page";
  let currentErrorCode = "UNEXPECTED_ERROR";
  let addedCountText: number | null = null;
  let thumbnailCount = 0;
  let verificationSignals: string[] = [];
  let state: Omit<PublishCarouselResult, keyof Artifact>;
  try {
    currentStep = "check_publish_page";
    currentErrorCode = "INVALID_PUBLISH_PAGE";
    assertDouyinPublishPage(page.url());
    await page.waitForFunction(() => {
      const body = document.body.innerText || "";
      return /高清发布|内容管理|作品管理|发布视频|发布图文|发布文章|基础信息|扫码登录|验证码登录|登录抖音/.test(body);
    }, undefined, { timeout: 15_000 }).catch(() => null);
    if (!await loggedIn(page)) {
      currentStep = "check_login";
      currentErrorCode = "LOGIN_REQUIRED";
      throw new Error("抖音创作者中心当前未登录。");
    }
    await closeTips(page);
    currentStep = "find_carousel_entry";
    currentErrorCode = "CAROUSEL_ENTRY_NOT_FOUND";
    const entry = page.getByText("发布图文", { exact: true });
    if (await entry.count() !== 1 || !await entry.isVisible().catch(() => false)) {
      throw new Error("当前网页版没有找到“发布图文”入口。");
    }
    await entry.click({ timeout: 5_000 });
    currentStep = "find_carousel_file_input";
    currentErrorCode = "CAROUSEL_FILE_INPUT_NOT_FOUND";
    const input = page.locator('input[type="file"][accept*="image"]').first();
    await input.waitFor({ state: "attached", timeout: 8_000 });
    await input.evaluate(element => {
      element.addEventListener("change", event => {
        const target = event.currentTarget as HTMLInputElement;
        sessionStorage.setItem(
          "__douyinPublishUploadOrder",
          JSON.stringify(Array.from(target.files ?? []).map(file => file.name)),
        );
      }, { capture: true, once: true });
    });
    currentStep = "upload_carousel_files";
    currentErrorCode = "CAROUSEL_UPLOAD_FAILED";
    await input.setInputFiles(imagePaths, { timeout: 20_000 });
    await page.waitForURL(/\/creator-micro\/content\/post\/image/, { timeout: 30_000 }).catch(() => null);
    const inputOrder = await page.evaluate(() => {
      try {
        return JSON.parse(sessionStorage.getItem("__douyinPublishUploadOrder") ?? "[]") as string[];
      } catch {
        return [];
      }
    });
    if (inputOrder.length > 0 && inputOrder.join("\n") !== expectedNames.join("\n")) {
      throw new Error(`文件选择顺序校验失败：${inputOrder.join(", ")}`);
    }
    currentStep = "wait_for_carousel_upload";
    currentErrorCode = "CAROUSEL_UPLOAD_NOT_CONFIRMED";
    await page.waitForFunction(expected => {
      const body = document.body.innerText || "";
      const editors = document.querySelectorAll('textarea,[contenteditable="true"],input[placeholder*="标题"]').length;
      const countMatch = body.match(/已添加\s*(\d+)\s*张图片/);
      const addedCount = countMatch ? Number(countMatch[1]) : 0;
      const thumbnails = Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'))
        .filter(element => /creator-media-private\.douyin\.com/.test(
          element.style.backgroundImage || getComputedStyle(element).backgroundImage || "",
        )).length;
      return editors > 0 && /作品描述|作品标题|添加话题|发布设置|发布/.test(body)
        && addedCount >= expected && thumbnails >= expected;
    }, imagePaths.length, { timeout: 90_000 });
    await closeTips(page);
    const titleInput = page.locator('input[placeholder*="标题"]').first();
    if (title && await titleInput.count() === 1 && await titleInput.isVisible().catch(() => false)) {
      await titleInput.fill(title);
    }
    const composed = [caption, ...hashtags.map(tag => `#${tag}`)].filter(Boolean).join(" ");
    if (composed) {
      const textarea = page.locator('textarea[placeholder*="描述"],textarea[placeholder*="作品"],textarea').first();
      const editable = page.locator('[contenteditable="true"][role="textbox"],[contenteditable="true"]').first();
      if (await textarea.count() > 0 && await textarea.isVisible().catch(() => false)) {
        await textarea.fill(composed);
      } else if (await editable.count() > 0 && await editable.isVisible().catch(() => false)) {
        await editable.fill(composed);
      } else {
        throw new Error("上传完成后没有找到作品描述输入框。");
      }
    }
    currentStep = "verify_carousel_upload";
    currentErrorCode = "CAROUSEL_UPLOAD_VERIFICATION_FAILED";
    const evidence = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const countMatch = body.match(/已添加\s*(\d+)\s*张图片/);
      const addedCount = countMatch ? Number(countMatch[1]) : null;
      const thumbnails = Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'))
        .filter(element => {
          const rect = element.getBoundingClientRect();
          const background = element.style.backgroundImage || getComputedStyle(element).backgroundImage || "";
          return rect.width >= 60 && rect.height >= 60
            && /creator-media-private\.douyin\.com/.test(background);
        });
      return {
        addedCount,
        thumbnailCount: thumbnails.length,
        hasContinueAdd: Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
          .some(element => (element.innerText || element.textContent || "").trim() === "继续添加"),
      };
    });
    addedCountText = evidence.addedCount;
    thumbnailCount = evidence.thumbnailCount;
    verificationSignals = [
      addedCountText !== null ? `已添加${addedCountText}张图片` : "未找到已添加数量文本",
      `上传缩略图卡片${thumbnailCount}张`,
      evidence.hasContinueAdd ? "找到继续添加入口" : "未找到继续添加入口",
      `文件输入顺序${inputOrder.length}张`,
    ];
    const pageImageCount = addedCountText ?? thumbnailCount;
    const orderVerified = inputOrder.length === imagePaths.length
      && inputOrder.join("\n") === expectedNames.join("\n")
      && addedCountText === imagePaths.length
      && thumbnailCount === imagePaths.length;
    if (!orderVerified) {
      throw new Error(
        `上传后数量或顺序无法验证：文件选择 ${inputOrder.length} 张，`
        + `页面文字 ${addedCountText ?? "未识别"} 张，缩略图卡片 ${thumbnailCount} 张，`
        + `期望 ${imagePaths.length} 张。`,
      );
    }
    currentStep = "verify_carousel_preview";
    currentErrorCode = "CAROUSEL_PREVIEW_NOT_REACHED";
    const previewReached = /\/creator-micro\/content\/post\/image/.test(new URL(page.url()).pathname)
      && await page.getByRole("button", { name: "发布", exact: true }).isVisible().catch(() => false);
    if (!previewReached) throw new Error("图片已上传，但没有到达可核验的发布预览状态。");
    let status: PublishCarouselResult["status"] = "preview_ready";
    let published = false;
    let errorCode: string | null = null;
    let errorStep: string | null = null;
    let errorMessage: string | null = null;
    if (action === "publish") {
      status = "blocked";
      errorCode = "SNAPSHOT_REQUIRED";
      errorStep = "locked_snapshot";
      errorMessage = options.confirmPublish === true
        ? "图片图集尚未提供锁定快照 ID；未点击发布。"
        : "公开发布还需要 confirm_publish=true 和锁定快照 ID；未点击发布。";
    }
    state = {
      status, requestedAction: action, published, imagePaths,
      uploads: imagePaths.map((file, index) => ({
        index: index + 1, path: file, fileName: path.basename(file),
        uploaded: true, pageOrder: index + 1, error: null,
      })),
      finalOrder: expectedNames, expectedCount: imagePaths.length, pageImageCount,
      addedCountText, thumbnailCount, verificationSignals, orderVerified,
      caption, title, hashtags, pageUrl: page.url(),
      pageTitle: await page.title(), errorCode, errorStep, errorMessage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const loginRequired = !await loggedIn(page).catch(() => false);
    state = {
      status: loginRequired ? "blocked" : "failed",
      requestedAction: action, published: false, imagePaths,
      uploads: imagePaths.map((file, index) => ({
        index: index + 1, path: file, fileName: path.basename(file),
        uploaded: false, pageOrder: null, error: message,
      })),
      finalOrder: [], expectedCount: imagePaths.length,
      pageImageCount: addedCountText ?? thumbnailCount,
      addedCountText, thumbnailCount, verificationSignals,
      orderVerified: false, caption, title, hashtags, pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ""),
      errorCode: loginRequired ? "LOGIN_REQUIRED" : currentErrorCode,
      errorStep: loginRequired ? "check_login" : currentStep,
      errorMessage: message,
    };
  }
  const artifact = await saveArtifact(page, "publish-carousel", state);
  return { ...state, ...artifact };
}
