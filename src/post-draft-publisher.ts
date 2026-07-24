import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Page, Response } from "playwright-core";
import { CONFIG } from "./config.js";
import { assertDouyinPublishPage } from "./safety.js";
import type {
  PostDraftMusic,
  PostDraftRecord,
  PostDraftSnapshot,
  PostPublishOperationRecord,
} from "./post-draft-store.js";
import {
  chooseExactNativeMentionCandidate,
  nativeMentionsMatch,
  projectCaptionWithMentions,
  type FrozenNativeMention,
  type NativeMentionCandidate,
  type NativeMentionEvidence,
  type NativeMentionInspection,
} from "./features/publisher/native-mention.js";

export type CarouselPageInspection = {
  pageUrl: string;
  pageTitle: string;
  title: string;
  caption: string;
  hashtags: string[];
  plainHashtags: string[];
  nativeMentions: NativeMentionEvidence[];
  plainTextMentions: string[];
  unresolvedMentions: NativeMentionInspection["unresolvedMentions"];
  imageCount: number;
  imageCardCount: number;
  uploadOrder: string[];
  orderVerified: boolean;
  selectedMusic: PostDraftMusic | null;
  publishButtonCount: number;
  readyToPublish: boolean;
  screenshotPath: string;
  screenshotBase64: string;
  capturedAt: string;
};

export type PostMusicCandidate = PostDraftMusic & {
  index: number;
  selected: boolean;
};

export type PostMusicCandidateSelector = {
  id?: string;
  index?: number;
  title?: string;
  author?: string;
  duration?: string;
};

export type CarouselPublishClickResult = {
  operationId: string;
  clickIssued: boolean;
  responseSeen: boolean;
  responseStatus: number | null;
  responseCode: string | number | null;
  responseMessage: string | null;
  resultingWorkId: string | null;
  resultingWorkUrl: string | null;
  pageUrlAfter: string;
  publishButtonVisibleAfter: boolean;
  toastText: string | null;
  possibleSubmit: boolean;
  diagnosticsPath: string;
  screenshotPath: string;
  screenshotBase64: string;
};

type RawMusicCandidate = {
  pageId: string | null;
  title: string;
  author: string | null;
  version: string | null;
  duration: string | null;
  cover: string | null;
  selected: boolean;
};

export type MusicPickerElementDiagnostic = {
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

export type MusicPickerPageDiagnostic = {
  routeVerified: boolean;
  editorRootDetected: boolean;
  extensionExpanded: boolean;
  musicEntryFound: boolean;
  pickerOpen: boolean;
  dialogDetected: boolean;
  searchInputDetected: boolean;
  candidateListDetected: boolean;
  candidateCount: number;
  selected: PostDraftMusic | null;
  musicEntryCandidates: MusicPickerElementDiagnostic[];
  dialogCandidates: MusicPickerElementDiagnostic[];
  searchInputCandidates: MusicPickerElementDiagnostic[];
  screenshotPath: string;
  screenshotBase64: string;
  diagnosticsPath: string;
};

function cleanText(value: string): string {
  return value
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function publisherMusicEditorKind(rawUrl: string): "carousel" | "article" | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== "creator.douyin.com") return null;
    if (url.pathname === "/creator-micro/content/post/image") return "carousel";
    if (url.pathname === "/creator-micro/content/post/article") return "article";
    return null;
  } catch {
    return null;
  }
}

export function resolvePostMusicCandidateId(
  items: PostMusicCandidate[],
  options: { musicId?: string; musicQuery?: string },
): string {
  if (options.musicId) {
    const matches = items.filter(item =>
      item.id === options.musicId || item.pageId === options.musicId);
    if (matches.length !== 1) {
      throw new Error(`POST_MUSIC_CANDIDATE_NOT_UNIQUE:${matches.length}`);
    }
    return matches[0].id;
  }
  const query = cleanText(options.musicQuery ?? "").toLocaleLowerCase();
  if (!query) throw new Error("POST_MUSIC_QUERY_OR_ID_REQUIRED");
  const matches = items.filter(item => cleanText(item.title).toLocaleLowerCase() === query);
  if (matches.length !== 1) {
    throw new Error(`POST_MUSIC_QUERY_NOT_UNIQUE:${matches.length}`);
  }
  return matches[0].id;
}

function canonicalCarouselPageCaption(value: string): string {
  return cleanText(value)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizedDraftHashtags(draft: PostDraftRecord): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of draft.hashtags ?? []) {
    const tag = cleanText(value).replace(/^#+/, "").replace(/\s+/g, "");
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function projectedDraftCaption(draft: PostDraftRecord): string {
  const body = projectCaptionWithMentions(
    canonicalCarouselPageCaption(draft.caption),
    draft.nativeMentions ?? [],
  );
  const tags = normalizedDraftHashtags(draft).map(tag => `#${tag}`).join(" ");
  return [body, tags].filter(Boolean).join(" ");
}

export function postCaptionEquivalent(actual: string, expected: string): boolean {
  return canonicalCarouselPageCaption(actual) === canonicalCarouselPageCaption(expected);
}

export function postMusicCandidateStableId(
  item: Pick<RawMusicCandidate, "pageId" | "title" | "author" | "version" | "duration">,
  occurrence = 1,
): string {
  return `music-candidate-${createHash("sha256")
    .update([
      item.pageId ?? "",
      item.title,
      item.author ?? "",
      item.version ?? "",
      item.duration ?? "",
    ].join("\n"))
    .digest("hex")
    .slice(0, 20)}-${Math.max(1, Math.round(occurrence))}`;
}

export function resolvePostMusicCandidate(
  items: PostMusicCandidate[],
  selector: string | PostMusicCandidateSelector,
): PostMusicCandidate {
  const normalized = typeof selector === "string" ? { id: selector } : selector;
  if (normalized.index == null
    && !normalized.id
    && !normalized.title
    && !normalized.author
    && !normalized.duration) {
    throw new Error("POST_MUSIC_CANDIDATE_SELECTOR_REQUIRED");
  }
  const cleanComparable = (value: string | null | undefined) =>
    cleanText(value ?? "").toLocaleLowerCase();
  const matches = items.filter(item => {
    if (normalized.id
      && item.id !== normalized.id
      && item.pageId !== normalized.id) return false;
    if (normalized.index != null && item.index !== normalized.index) return false;
    if (normalized.title
      && cleanComparable(item.title) !== cleanComparable(normalized.title)) return false;
    if (normalized.author
      && cleanComparable(item.author) !== cleanComparable(normalized.author)) return false;
    if (normalized.duration
      && cleanComparable(item.duration) !== cleanComparable(normalized.duration)) return false;
    return true;
  });
  if (matches.length !== 1) {
    throw new Error(`POST_MUSIC_CANDIDATE_NOT_UNIQUE:${matches.length}`);
  }
  return matches[0];
}

async function capture(page: Page, name: string, details: Record<string, unknown>) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(CONFIG.runtimeDir, "post-drafts", `${stamp}-${name}`);
  await fs.mkdir(directory, { recursive: true });
  const screenshotPath = path.join(directory, "page.png");
  const diagnosticsPath = path.join(directory, "diagnostics.json");
  let screenshotBase64 = "";
  let screenshotError: string | null = null;
  try {
    const screenshot = await page.screenshot({
      path: screenshotPath,
      type: "png",
      fullPage: false,
      animations: "disabled",
      timeout: 12_000,
    });
    screenshotBase64 = screenshot.toString("base64");
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }
  await fs.writeFile(diagnosticsPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshotCaptured: Boolean(screenshotBase64),
    screenshotError,
    ...details,
  }, null, 2), "utf8");
  return {
    screenshotPath,
    diagnosticsPath,
    screenshotBase64,
  };
}

async function visibleExactText(page: Page, text: string) {
  const locator = page.getByText(text, { exact: true });
  const matches: Array<{
    candidate: ReturnType<Page["getByText"]>;
    inMenu: boolean;
  }> = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const inMenu = await candidate.evaluate(element =>
      Boolean(element.closest("[role='menuitem'],[role='menu']"))).catch(() => false);
    matches.push({ candidate, inMenu });
  }
  return matches;
}

async function imageCards(page: Page): Promise<Array<{
  background: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[draggable='true']"))
    .map(element => {
      const rect = element.getBoundingClientRect();
      return {
        background: element.style.backgroundImage || getComputedStyle(element).backgroundImage || "",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    })
    .filter(item =>
      item.width >= 50
      && item.height >= 50
      && /creator-media-private\.douyin\.com/.test(item.background))
    .sort((left, right) => left.y - right.y || left.x - right.x));
}

async function draftPageText(page: Page): Promise<{ title: string; caption: string }> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const title = Array.from(document.querySelectorAll<HTMLInputElement>(
      "input[placeholder*='作品标题'],input[placeholder*='标题']",
    )).find(visible)?.value ?? "";
    const editors = Array.from(document.querySelectorAll<HTMLElement>(
      "[contenteditable='true'],textarea",
    )).filter(visible).map(element => ({
      element,
      value: element instanceof HTMLTextAreaElement
        ? element.value
        : element.innerText || element.textContent || "",
      score: (
        element.className.includes("zone-container") ? 100 : 0
      ) + element.getBoundingClientRect().width,
    })).sort((left, right) => right.score - left.score);
    return { title, caption: editors[0]?.value ?? "" };
  }).then(value => ({
    title: cleanText(value.title),
    caption: cleanText(value.caption),
  }));
}

async function currentUploadOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem("__douyinPostDraftUploadOrder") ?? "[]",
      ) as unknown;
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });
}

async function platformDraftHasContent(page: Page): Promise<boolean> {
  if (!/\/creator-micro\/content\/post\/image/.test(new URL(page.url()).pathname)) return false;
  const text = await draftPageText(page);
  return Boolean(text.title || text.caption || (await imageCards(page)).length);
}

async function resetCarouselEditor(page: Page): Promise<void> {
  const clear = page.getByText("清空并重新上传", { exact: true });
  if (await clear.count() !== 1 || !await clear.isVisible().catch(() => false)) {
    throw new Error("POST_PAGE_DRAFT_CONFLICT:找不到唯一的“清空并重新上传”入口。");
  }
  await clear.click({ timeout: 5_000 });
  const confirm = page.getByText("重新上传", { exact: true });
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  if (await confirm.count() !== 1) {
    throw new Error("POST_PAGE_DRAFT_CONFLICT:重新上传确认按钮不唯一。");
  }
  await confirm.click({ timeout: 5_000 });
  await page.waitForURL(/\/creator-micro\/content\/upload/, { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(500);
}

async function openCarouselUpload(page: Page, confirmReplacePageDraft: boolean): Promise<void> {
  assertDouyinPublishPage(page.url());
  if (/\/creator-micro\/content\/post\/image/.test(new URL(page.url()).pathname)) {
    if (await platformDraftHasContent(page)) {
      if (!confirmReplacePageDraft) {
        throw new Error(
          "POST_PAGE_DRAFT_CONFLICT:当前发布页存在未绑定到本次 draft_id 的内容；"
          + "未覆盖。确认后请以 confirm_replace_page_draft=true 重新预览。",
        );
      }
      await resetCarouselEditor(page);
    }
  }
  if (!/\/creator-micro\/content\/upload/.test(new URL(page.url()).pathname)) {
    await page.goto(
      "https://creator.douyin.com/creator-micro/content/upload",
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
  }
  await page.waitForFunction(() =>
    /发布图文|扫码登录|验证码登录|登录抖音/.test(document.body.innerText || ""),
  undefined, { timeout: 15_000 });
  const entries = await visibleExactText(page, "发布图文");
  const tabs = entries.filter(item => !item.inMenu);
  if (tabs.length !== 1) {
    throw new Error(`CAROUSEL_ENTRY_NOT_UNIQUE:visible=${entries.length},tabs=${tabs.length}`);
  }
  await tabs[0].candidate.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  const resume = page.getByText("继续编辑", { exact: true });
  const discard = page.getByText("放弃", { exact: true });
  if (await resume.isVisible().catch(() => false)) {
    if (!confirmReplacePageDraft) {
      throw new Error(
        "POST_PAGE_DRAFT_CONFLICT:平台检测到上次未发布的图文；未选择继续或放弃。",
      );
    }
    if (await discard.count() !== 1 || !await discard.isVisible().catch(() => false)) {
      throw new Error("POST_PAGE_DRAFT_CONFLICT:无法唯一定位“放弃”旧平台草稿按钮。");
    }
    await discard.click({ timeout: 5_000 });
  }
}

async function locateCaptionEditor(page: Page) {
  const candidates = page.locator("[contenteditable='true'],textarea");
  const indexes: Array<{ index: number; score: number }> = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const data = await candidate.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hint = [
        element.className,
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.parentElement?.innerText,
      ].filter(Boolean).join(" ");
      return {
        score: (/zone-container|作品描述|描述/.test(hint) ? 1000 : 0)
          + Math.min(800, rect.width)
          + Math.min(300, rect.height),
      };
    });
    indexes.push({ index, score: data.score });
  }
  indexes.sort((left, right) => right.score - left.score);
  if (!indexes.length) throw new Error("CAROUSEL_CAPTION_EDITOR_NOT_FOUND");
  if (indexes.length > 1 && indexes[0].score === indexes[1].score) {
    throw new Error("CAROUSEL_CAPTION_EDITOR_NOT_UNIQUE");
  }
  return candidates.nth(indexes[0].index);
}

async function readCarouselTopics(page: Page): Promise<{
  hashtags: string[];
  plainHashtags: string[];
}> {
  const editor = await locateCaptionEditor(page);
  return editor.evaluate(element => {
    const normalize = (value: string | null | undefined) => (value ?? "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, "")
      .replace(/^#+/, "")
      .trim();
    const mentionNodes = Array.from(element.querySelectorAll<HTMLElement>('[data-mention="#"]'));
    const hashtags = mentionNodes
      .map(node => normalize(node.textContent))
      .filter(Boolean);
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-mention="#"]').forEach(node => node.remove());
    const plainText = (clone.textContent ?? "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ");
    const plainHashtags = Array.from(plainText.matchAll(/(?:^|\s)#([^\s#]+)/g))
      .map(match => normalize(match[1]))
      .filter(Boolean);
    return { hashtags, plainHashtags };
  });
}

export async function readCarouselNativeMentions(page: Page): Promise<NativeMentionInspection> {
  const editor = await locateCaptionEditor(page);
  return editor.evaluate(element => {
    const visible = (candidate: Element): boolean => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const stable = (value: unknown, pattern: RegExp): string | null => (
      typeof value === "string" && pattern.test(value.trim()) ? value.trim() : null
    );
    const reactIdentity = (node: Element): { uid: string | null; secUid: string | null } => {
      const seen = new Set<object>();
      const queue: Array<{ value: unknown; depth: number }> = [];
      for (const key of Object.getOwnPropertyNames(node)) {
        if (/^__react(?:Props|Fiber)\$/.test(key)) {
          queue.push({ value: (node as unknown as Record<string, unknown>)[key], depth: 0 });
        }
      }
      while (queue.length) {
        const current = queue.shift()!;
        if (!current.value || typeof current.value !== "object" || current.depth > 7) continue;
        if (seen.has(current.value as object)) continue;
        seen.add(current.value as object);
        if (Array.isArray(current.value)) {
          for (const item of current.value.slice(0, 80)) queue.push({ value: item, depth: current.depth + 1 });
          continue;
        }
        const object = current.value as Record<string, unknown>;
        const uid = stable(object.uid ?? object.user_id, /^\d{5,24}$/);
        const secUid = stable(object.sec_uid ?? object.secUid, /^.{10,180}$/);
        if (uid || secUid) return { uid, secUid };
        for (const child of Object.values(object).slice(0, 80)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
      return { uid: null, secUid: null };
    };
    const domPath = (node: Element): string => {
      const segments: string[] = [];
      let current: Element | null = node;
      while (current && current !== element && segments.length < 6) {
        const parent: Element | null = current.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1;
        segments.unshift(`${current.tagName.toLocaleLowerCase()}:nth-child(${index})`);
        current = parent;
      }
      return segments.join(" > ");
    };
    const selector = [
      '[data-mention="@"]',
      '[data-mention-type="user"]',
      'a[href*="/user/"]',
      '[contenteditable="false"]',
    ].join(",");
    const nodes = Array.from(element.querySelectorAll<HTMLElement>(selector))
      .filter(visible)
      .filter(node => /@/.test(node.textContent ?? ""));
    const nativeMentions: Array<{
      alias: "bound_user";
      displayName: string;
      uid: string;
      secUid: string;
      placement: "caption_start" | "caption_end";
      domPath: string;
      stableNodeEvidence: string;
    }> = [];
    const unresolvedMentions: Array<{
      displayName: string;
      uid: string | null;
      secUid: string | null;
      reason: string;
    }> = [];
    for (const node of nodes) {
      const displayName = (node.textContent ?? "").replace(/^@/, "").trim();
      const href = node.closest("a")?.getAttribute("href") ?? node.getAttribute("href");
      const identity = reactIdentity(node);
      const hrefSecUid = href?.match(/\/user\/([^?/#]+)/)?.[1] ?? null;
      const uid = node.getAttribute("data-uid") ?? identity.uid;
      const secUid = node.getAttribute("data-sec-uid")
        ?? node.getAttribute("data-secuid")
        ?? identity.secUid
        ?? hrefSecUid;
      const prefix = (element.textContent ?? "").slice(0, Math.max(0, (element.textContent ?? "").indexOf(node.textContent ?? "")));
      const placement = prefix.trim() ? "caption_end" : "caption_start";
      if (!displayName || !uid || !secUid) {
        unresolvedMentions.push({
          displayName,
          uid,
          secUid,
          reason: "native_mention_stable_identity_missing",
        });
        continue;
      }
      nativeMentions.push({
        alias: "bound_user",
        displayName,
        uid,
        secUid,
        placement,
        domPath: domPath(node),
        stableNodeEvidence: href ? `href:${href}` : "react_or_data_identity",
      });
    }
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(selector).forEach(node => node.remove());
    clone.querySelectorAll('[data-mention="#"]').forEach(node => node.remove());
    const plainTextMentions = Array.from((clone.textContent ?? "").matchAll(/(?:^|\s)@([^\s@#]+)/g))
      .map(match => match[1].trim())
      .filter(Boolean);
    return { nativeMentions, plainTextMentions, unresolvedMentions };
  });
}

async function nativeMentionCandidates(
  page: Page,
  expected: FrozenNativeMention,
): Promise<NativeMentionCandidate[]> {
  return page.evaluate(expectedMention => {
    const visible = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const identity = (node: HTMLElement): { uid: string | null; secUid: string | null } => {
      const queue: Array<{ value: unknown; depth: number }> = [];
      const seen = new Set<object>();
      for (const key of Object.getOwnPropertyNames(node)) {
        if (/^__react(?:Props|Fiber)\$/.test(key)) {
          queue.push({ value: (node as unknown as Record<string, unknown>)[key], depth: 0 });
        }
      }
      while (queue.length) {
        const { value, depth } = queue.shift()!;
        if (!value || typeof value !== "object" || depth > 7 || seen.has(value as object)) continue;
        seen.add(value as object);
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 80)) queue.push({ value: item, depth: depth + 1 });
          continue;
        }
        const object = value as Record<string, unknown>;
        const uid = typeof (object.uid ?? object.user_id) === "string"
          ? String(object.uid ?? object.user_id) : null;
        const secUid = typeof (object.sec_uid ?? object.secUid) === "string"
          ? String(object.sec_uid ?? object.secUid) : null;
        if (uid || secUid) return { uid, secUid };
        for (const child of Object.values(object).slice(0, 80)) queue.push({ value: child, depth: depth + 1 });
      }
      return { uid: null, secUid: null };
    };
    const all = Array.from(document.querySelectorAll<HTMLElement>("[role='option'],[role='listitem'],li,div"))
      .filter(visible)
      .filter(element => (element.innerText || element.textContent || "").trim().includes(expectedMention.displayName))
      .slice(0, 80);
    const results: Array<{
      displayName: string;
      uid: string | null;
      secUid: string | null;
      href: string | null;
      selectorToken: string;
    }> = [];
    for (const element of all) {
      const stableElement = element.closest<HTMLElement>("[role='option'],[role='listitem'],li") ?? element;
      const href = stableElement.querySelector("a[href*='/user/']")?.getAttribute("href")
        ?? stableElement.closest("a")?.getAttribute("href")
        ?? null;
      const react = identity(stableElement);
      const secUid = stableElement.getAttribute("data-sec-uid")
        ?? react.secUid
        ?? href?.match(/\/user\/([^?/#]+)/)?.[1]
        ?? null;
      const uid = stableElement.getAttribute("data-uid") ?? react.uid;
      if (!uid && !secUid && !href) continue;
      const displayName = (stableElement.getAttribute("data-nickname")
        ?? stableElement.getAttribute("data-display-name")
        ?? (stableElement.innerText || stableElement.textContent || "")
          .split(/\r?\n/)
          .map(value => value.replace(/^@/, "").trim())
          .find(value => value === expectedMention.displayName)
        ?? "").trim();
      const token = `mention-${results.length}-${Date.now()}`;
      stableElement.setAttribute("data-codex-native-mention-candidate", token);
      results.push({
        displayName,
        uid,
        secUid,
        href,
        selectorToken: token,
      });
    }
    return results;
  }, expected);
}

async function insertNativeMention(page: Page, mention: FrozenNativeMention): Promise<void> {
  const editor = await locateCaptionEditor(page);
  await editor.focus();
  await page.keyboard.press(mention.placement === "caption_start" ? "Home" : "End");
  await page.keyboard.insertText(
    mention.placement === "caption_start" ? `@${mention.displayName} ` : ` @${mention.displayName}`,
  );
  await page.waitForTimeout(300);
  const candidates = await nativeMentionCandidates(page, mention);
  const exact = chooseExactNativeMentionCandidate(candidates, mention);
  const locator = page.locator(
    `[data-codex-native-mention-candidate="${exact.selectorToken}"]`,
  );
  if (await locator.count() !== 1 || !await locator.isVisible().catch(() => false)) {
    throw new Error("NATIVE_MENTION_CANDIDATE_NOT_STABLE");
  }
  await locator.click({ timeout: 5_000 });
  await page.waitForTimeout(200);
}

async function fillCarouselText(page: Page, draft: PostDraftRecord): Promise<void> {
  const title = page.locator(
    "input[placeholder*='作品标题'],input[placeholder*='标题']",
  );
  const visibleTitles: number[] = [];
  for (let index = 0; index < await title.count(); index += 1) {
    if (await title.nth(index).isVisible().catch(() => false)) visibleTitles.push(index);
  }
  if (visibleTitles.length !== 1) {
    throw new Error(`CAROUSEL_TITLE_INPUT_NOT_UNIQUE:${visibleTitles.length}`);
  }
  await title.nth(visibleTitles[0]).fill(draft.title);
  const editor = await locateCaptionEditor(page);
  const captionBody = canonicalCarouselPageCaption(draft.caption);
  const expectedHashtags = normalizedDraftHashtags(draft);
  await editor.fill(captionBody);
  for (const mention of draft.nativeMentions ?? []) {
    await insertNativeMention(page, mention);
  }
  for (let index = 0; index < expectedHashtags.length; index += 1) {
    const tag = expectedHashtags[index];
    await editor.focus();
    await page.keyboard.press("End");
    await page.keyboard.insertText(` #${tag}`);
    await page.waitForTimeout(120);
    const trigger = page.getByText("#添加话题", { exact: true });
    if (await trigger.count() !== 1 || !await trigger.isVisible().catch(() => false)) {
      throw new Error("CAROUSEL_TOPIC_TRIGGER_NOT_UNIQUE");
    }
    await trigger.click({ timeout: 5_000 });
    const expectedPrefix = expectedHashtags.slice(0, index + 1);
    const deadline = Date.now() + 4_000;
    let topics = await readCarouselTopics(page);
    while (Date.now() < deadline && (
      topics.plainHashtags.length
      || topics.hashtags.length !== expectedPrefix.length
      || !topics.hashtags.every((item, topicIndex) => item === expectedPrefix[topicIndex])
    )) {
      await page.waitForTimeout(100);
      topics = await readCarouselTopics(page);
    }
    if (topics.plainHashtags.length
      || topics.hashtags.length !== expectedPrefix.length
      || !topics.hashtags.every((item, topicIndex) => item === expectedPrefix[topicIndex])) {
      throw new Error(`CAROUSEL_TOPIC_INSERT_FAILED:${tag}`);
    }
  }
  const actual = await draftPageText(page);
  const topics = await readCarouselTopics(page);
  const mentions = await readCarouselNativeMentions(page);
  if (actual.title !== cleanText(draft.title)
    || !postCaptionEquivalent(actual.caption, projectedDraftCaption(draft))
    || topics.plainHashtags.length
    || topics.hashtags.length !== expectedHashtags.length
    || !topics.hashtags.every((item, index) => item === expectedHashtags[index])
    || !nativeMentionsMatch(draft.nativeMentions ?? [], mentions)) {
    throw new Error("CAROUSEL_TEXT_READBACK_MISMATCH");
  }
}

async function uploadCarouselFiles(page: Page, draft: PostDraftRecord): Promise<void> {
  const files = draft.media.map(item => item.path);
  if (!files.length) throw new Error("POST_DRAFT_MEDIA_REQUIRED");
  const expectedNames = draft.media.map(item => item.fileName);
  const inputs = page.locator("input[type='file'][accept*='image']");
  await inputs.first().waitFor({ state: "attached", timeout: 10_000 });
  const attached: number[] = [];
  for (let index = 0; index < await inputs.count(); index += 1) {
    const input = inputs.nth(index);
    const multiple = await input.getAttribute("multiple");
    const accept = await input.getAttribute("accept") ?? "";
    if (multiple !== null && /image/i.test(accept)) attached.push(index);
  }
  if (attached.length !== 1) {
    throw new Error(`CAROUSEL_FILE_INPUT_NOT_UNIQUE:${attached.length}`);
  }
  const input = inputs.nth(attached[0]);
  await input.evaluate(element => {
    element.addEventListener("change", event => {
      const target = event.currentTarget as HTMLInputElement;
      sessionStorage.setItem(
        "__douyinPostDraftUploadOrder",
        JSON.stringify(Array.from(target.files ?? []).map(file => file.name)),
      );
    }, { capture: true, once: true });
  });
  await input.setInputFiles(files, { timeout: 30_000 });
  await page.waitForURL(/\/creator-micro\/content\/post\/image/, { timeout: 30_000 });
  await page.waitForFunction(expected => {
    const body = document.body.innerText || "";
    const count = Number(body.match(/已添加\s*(\d+)\s*张图片/)?.[1] ?? 0);
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[draggable='true']"))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const background = element.style.backgroundImage || getComputedStyle(element).backgroundImage || "";
        return rect.width >= 50 && rect.height >= 50
          && /creator-media-private\.douyin\.com/.test(background);
      }).length;
    return count === expected && cards === expected;
  }, files.length, { timeout: 90_000 });
  const inputOrder = await page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("__douyinPostDraftUploadOrder") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  if (inputOrder.join("\n") !== expectedNames.join("\n")) {
    throw new Error(`CAROUSEL_UPLOAD_ORDER_MISMATCH:${inputOrder.join("|")}`);
  }
}

export async function inspectCarouselPage(
  page: Page,
  options: { captureArtifacts?: boolean } = {},
): Promise<CarouselPageInspection> {
  assertDouyinPublishPage(page.url());
  const text = await draftPageText(page);
  const topics = await readCarouselTopics(page);
  const mentions = await readCarouselNativeMentions(page);
  const cards = await imageCards(page);
  const body = await page.locator("body").innerText().catch(() => "");
  const imageCount = Number(body.match(/已添加\s*(\d+)\s*张图片/)?.[1] ?? cards.length);
  const uploadOrder = await currentUploadOrder(page);
  const selectedMusic = await readSelectedPostMusic(page);
  const publish = page.getByRole("button", { name: "发布", exact: true });
  let publishButtonCount = 0;
  for (let index = 0; index < await publish.count(); index += 1) {
    if (await publish.nth(index).isVisible().catch(() => false)) publishButtonCount += 1;
  }
  const artifact = options.captureArtifacts === false
    ? { screenshotPath: "", screenshotBase64: "" }
    : await capture(page, "preview", {
        title: text.title,
        caption: text.caption,
        hashtags: topics.hashtags,
        plainHashtags: topics.plainHashtags,
        nativeMentions: mentions.nativeMentions,
        plainTextMentions: mentions.plainTextMentions,
        unresolvedMentions: mentions.unresolvedMentions,
        imageCount,
        imageCardCount: cards.length,
        uploadOrder,
        selectedMusic,
        publishButtonCount,
      });
  return {
    pageUrl: page.url(),
    pageTitle: await page.title(),
    title: text.title,
    caption: text.caption,
    hashtags: topics.hashtags,
    plainHashtags: topics.plainHashtags,
    nativeMentions: mentions.nativeMentions,
    plainTextMentions: mentions.plainTextMentions,
    unresolvedMentions: mentions.unresolvedMentions,
    imageCount,
    imageCardCount: cards.length,
    uploadOrder,
    orderVerified: uploadOrder.length === cards.length,
    selectedMusic,
    publishButtonCount,
    readyToPublish: imageCount > 0
      && imageCount === cards.length
      && publishButtonCount === 1,
    screenshotPath: artifact.screenshotPath,
    screenshotBase64: artifact.screenshotBase64,
    capturedAt: new Date().toISOString(),
  };
}

export function carouselInspectionMatchesDraft(
  inspection: CarouselPageInspection,
  draft: PostDraftRecord,
): boolean {
  const expectedOrder = draft.media.map(item => item.fileName);
  const orderMatches = inspection.uploadOrder.length === expectedOrder.length
    && inspection.uploadOrder.every((item, index) => item === expectedOrder[index]);
  const musicMatches = draft.selectedMusic
    ? Boolean(
        inspection.selectedMusic
        && inspection.selectedMusic.title === draft.selectedMusic.title
        && (
          !draft.selectedMusic.duration
          || inspection.selectedMusic.duration === draft.selectedMusic.duration
        ),
      )
    : inspection.selectedMusic === null;
  const expectedHashtags = normalizedDraftHashtags(draft);
  const hashtagsMatch = inspection.hashtags.length === expectedHashtags.length
    && inspection.hashtags.every((item, index) => item === expectedHashtags[index]);
  return inspection.title === cleanText(draft.title)
    && postCaptionEquivalent(inspection.caption, projectedDraftCaption(draft))
    && hashtagsMatch
    && inspection.plainHashtags.length === 0
    && nativeMentionsMatch(draft.nativeMentions ?? [], inspection)
    && inspection.imageCount === draft.media.length
    && inspection.imageCardCount === draft.media.length
    && orderMatches
    && musicMatches;
}

function isVisibleRect(rect: { width: number; height: number } | null): boolean {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

async function locatorDiagnostics(
  locator: ReturnType<Page["locator"]>,
): Promise<MusicPickerElementDiagnostic[]> {
  const results: MusicPickerElementDiagnostic[] = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    const rect = await candidate.boundingBox().catch(() => null);
    const details = await candidate.evaluate(element => {
      const path: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 7; depth += 1) {
        const className = typeof current.className === "string"
          ? current.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
          : [];
        path.push([
          current.tagName.toLowerCase(),
          current.id ? `#${current.id}` : "",
          className.length ? `.${className.join(".")}` : "",
        ].join(""));
        current = current.parentElement;
      }
      const control = element as HTMLButtonElement | HTMLInputElement;
      return {
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        disabled: Boolean(control.disabled || element.getAttribute("aria-disabled") === "true"),
        domPath: path.join(" <- "),
      };
    }).catch(() => ({
      text: "",
      tag: "",
      className: "",
      disabled: false,
      domPath: "",
    }));
    results.push({
      ...details,
      visible: isVisibleRect(rect)
        && await candidate.isVisible().catch(() => false),
      rect: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
    });
  }
  return results;
}

async function visibleCount(locator: ReturnType<Page["locator"]>): Promise<number> {
  let count = 0;
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
  }
  return count;
}

export async function locatePostMusicCandidateRows(
  page: Page,
): Promise<ReturnType<Page["locator"]>> {
  // The picker renders an outer wrapper and an inner container for each song.
  // Selecting their union duplicates every logical candidate.
  const primary = page.locator(
    "[role='sidesheet'] [class*='card-container-tmocjc'],"
    + ".semi-sidesheet [class*='card-container-tmocjc']",
  );
  if (await primary.count() > 0) return primary;
  return page.locator(
    "[role='sidesheet'] [class*='card-wrapper-'],"
    + ".semi-sidesheet [class*='card-wrapper-']",
  );
}

export async function isPostMusicPickerOpen(page: Page): Promise<boolean> {
  const sheets = page.locator("[role='sidesheet'],.semi-sidesheet");
  const searches = page.locator("input[placeholder='搜索音乐']");
  return (await visibleCount(sheets)) > 0 && (await visibleCount(searches)) === 1;
}

async function waitForPostMusicPicker(page: Page): Promise<PostMusicCandidate[]> {
  const search = page.locator("input[placeholder='搜索音乐']");
  await search.waitFor({ state: "visible", timeout: 10_000 });
  const rows = await locatePostMusicCandidateRows(page);
  await rows.first().waitFor({ state: "visible", timeout: 12_000 });
  const items = await readPostMusicCandidates(page);
  if (!items.length) throw new Error("MUSIC_PICKER_CANDIDATES_NOT_LOADED");
  return items;
}

export async function debugPostMusicPicker(
  page: Page,
  options: { captureArtifacts?: boolean } = {},
): Promise<MusicPickerPageDiagnostic> {
  const routeVerified = publisherMusicEditorKind(page.url()) !== null;
  const titleInputs = page.locator(
    "input[placeholder*='作品标题'],input[placeholder*='标题']",
  );
  const editors = page.locator("[contenteditable='true'],textarea");
  const triggers = page.getByText(/^(选择音乐|修改音乐)$/);
  const sheets = page.locator("[role='sidesheet'],.semi-sidesheet");
  const searches = page.locator("input[placeholder='搜索音乐']");
  const musicEntryCandidates = await locatorDiagnostics(triggers);
  const dialogCandidates = await locatorDiagnostics(sheets);
  const searchInputCandidates = await locatorDiagnostics(searches);
  const items = await readPostMusicCandidates(page);
  const selected = await readSelectedPostMusic(page);
  const editorRootDetected = (await visibleCount(titleInputs)) === 1
    && (await visibleCount(editors)) >= 1;
  const musicEntryFound = musicEntryCandidates.some(item => item.visible);
  const dialogDetected = dialogCandidates.some(item => item.visible);
  const searchInputDetected = searchInputCandidates.filter(item => item.visible).length === 1;
  const pickerOpen = dialogDetected && searchInputDetected;
  const details = {
    routeVerified,
    editorRootDetected,
    extensionExpanded: musicEntryFound,
    musicEntryFound,
    pickerOpen,
    dialogDetected,
    searchInputDetected,
    candidateListDetected: items.length > 0,
    candidateCount: items.length,
    selected,
    musicEntryCandidates,
    dialogCandidates,
    searchInputCandidates,
  };
  const artifact = options.captureArtifacts === false
    ? { screenshotPath: "", screenshotBase64: "", diagnosticsPath: "" }
    : await capture(page, "music-picker-debug", details);
  return {
    ...details,
    screenshotPath: artifact.screenshotPath,
    screenshotBase64: artifact.screenshotBase64,
    diagnosticsPath: artifact.diagnosticsPath,
  };
}

export async function syncCarouselDraftToPage(
  page: Page,
  draft: PostDraftRecord,
  options: { confirmReplacePageDraft: boolean },
): Promise<CarouselPageInspection> {
  await openCarouselUpload(page, options.confirmReplacePageDraft);
  await uploadCarouselFiles(page, draft);
  await fillCarouselText(page, draft);
  if (draft.selectedMusic) {
    await openPostMusicPicker(page);
    const search = page.locator("input[placeholder='搜索音乐']");
    if (await search.count() === 1 && await search.isVisible().catch(() => false)) {
      await search.fill(draft.selectedMusic.title);
      await page.waitForTimeout(800);
    }
    const candidates = await readPostMusicCandidates(page);
    const exact = candidates.filter(item =>
      item.id === draft.selectedMusic?.id
      || (
        item.title === draft.selectedMusic?.title
        && item.author === draft.selectedMusic?.author
        && item.duration === draft.selectedMusic?.duration
      ));
    if (exact.length !== 1) {
      await closePostMusicPicker(page);
      throw new Error(`POST_MUSIC_NOT_UNIQUE_AFTER_RESYNC:${exact.length}`);
    }
    await selectPostMusicCandidate(page, exact[0].id);
  }
  const inspection = await inspectCarouselPage(page);
  const expectedHashtags = normalizedDraftHashtags(draft);
  if (inspection.title !== cleanText(draft.title)
    || !postCaptionEquivalent(inspection.caption, projectedDraftCaption(draft))
    || inspection.plainHashtags.length
    || inspection.hashtags.length !== expectedHashtags.length
    || !inspection.hashtags.every((item, index) => item === expectedHashtags[index])
    || !nativeMentionsMatch(draft.nativeMentions ?? [], inspection)
    || inspection.imageCount !== draft.media.length
    || inspection.imageCardCount !== draft.media.length) {
    throw new Error("POST_DRAFT_PAGE_READBACK_MISMATCH");
  }
  if (draft.selectedMusic
    && (
      !inspection.selectedMusic
      || inspection.selectedMusic.title !== draft.selectedMusic.title
    )) {
    throw new Error("POST_DRAFT_MUSIC_READBACK_MISMATCH");
  }
  return inspection;
}

export async function dismissCarouselTransientOverlays(page: Page): Promise<boolean> {
  const topicOverlayVisible = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    return Array.from(document.querySelectorAll(
      "[role='listbox'],[class*='popover'],[class*='suggest'],[class*='topic']",
    )).some(element => visible(element) && /#|话题/.test(element.textContent ?? ""));
  }).catch(() => false);
  if (!topicOverlayVisible) return false;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  return true;
}

export async function openPostMusicPicker(page: Page): Promise<PostMusicCandidate[]> {
  if (!publisherMusicEditorKind(page.url())) {
    throw new Error("POST_MUSIC_REQUIRES_SUPPORTED_EDITOR");
  }
  if (await isPostMusicPickerOpen(page)) return waitForPostMusicPicker(page);
  let triggers = page.getByText(/^(选择音乐|修改音乐)$/);
  const visible: number[] = [];
  for (let index = 0; index < await triggers.count(); index += 1) {
    if (!await triggers.nth(index).isVisible().catch(() => false)) continue;
    const action = await triggers.nth(index).evaluate(element =>
      /container-right|action-/.test(element.parentElement?.className ?? "")
      || /action-/.test(element.className)).catch(() => false);
    if (action) visible.push(index);
  }
  if (visible.length === 0) {
    const extension = page.getByText("扩展信息", { exact: true });
    const visibleExtensions: number[] = [];
    for (let index = 0; index < await extension.count(); index += 1) {
      if (await extension.nth(index).isVisible().catch(() => false)) {
        visibleExtensions.push(index);
      }
    }
    if (visibleExtensions.length === 1) {
      await extension.nth(visibleExtensions[0]).scrollIntoViewIfNeeded();
      await extension.nth(visibleExtensions[0]).click({ timeout: 5_000 });
      await page.waitForTimeout(350);
      triggers = page.getByText(/^(选择音乐|修改音乐)$/);
      for (let index = 0; index < await triggers.count(); index += 1) {
        if (!await triggers.nth(index).isVisible().catch(() => false)) continue;
        const action = await triggers.nth(index).evaluate(element =>
          /container-right|action-/.test(element.parentElement?.className ?? "")
          || /action-/.test(element.className)).catch(() => false);
        if (action) visible.push(index);
      }
    }
  }
  if (visible.length !== 1) {
    throw new Error(`POST_MUSIC_TRIGGER_NOT_UNIQUE:${visible.length}`);
  }
  await triggers.nth(visible[0]).scrollIntoViewIfNeeded();
  await triggers.nth(visible[0]).click({ timeout: 5_000 });
  return waitForPostMusicPicker(page);
}

export async function closePostMusicPicker(page: Page): Promise<boolean> {
  if (!await isPostMusicPickerOpen(page)) return true;
  const close = page.locator("button.semi-sidesheet-close");
  if (await close.count() === 1 && await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 4_000 });
  }
  const closed = await page.waitForFunction(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    return !Array.from(document.querySelectorAll("[role='sidesheet'],.semi-sidesheet"))
      .some(visible);
  }, undefined, { timeout: 5_000 }).then(() => true).catch(() => false);
  if (!closed) throw new Error("POST_MUSIC_PICKER_CLOSE_NOT_CONFIRMED");
  return true;
}

async function rawMusicCandidates(page: Page): Promise<RawMusicCandidate[]> {
  const rows = await locatePostMusicCandidateRows(page);
  const items: RawMusicCandidate[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const rect = await row.boundingBox().catch(() => null);
    if (!rect || rect.width <= 200 || rect.height <= 40
      || !await row.isVisible().catch(() => false)) {
      continue;
    }
    const title = (
      await row.locator("[class*='song-name-']").first().innerText().catch(() => "")
    ).trim();
    if (!title) continue;
    const author = (
      await row.locator("[class*='song-author']").first().innerText().catch(() => "")
    ).trim() || null;
    const duration = (
      await row.locator("[class*='song-duration']").first().innerText().catch(() => "")
    ).trim() || null;
    const image = row.locator("img").first();
    const cover = await image.getAttribute("src").catch(() => null);
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const className = await row.getAttribute("class") ?? "";
    const pageId = await row.evaluate(element => {
      const normalize = (value: unknown): string | null => {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const text = String(value).trim();
        return text.length >= 4 && text.length <= 160 ? text : null;
      };
      const nodes = [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))];
      for (const node of nodes) {
        for (const name of ["data-music-id", "data-song-id", "data-item-id", "music-id"]) {
          const found = normalize(node.getAttribute(name));
          if (found) return found;
        }
      }
      const visited = new WeakSet<object>();
      const preferredKeys = /^(music_?id|musicId|song_?id|songId|audio_?id|audioId|item_?id|itemId)$/i;
      const walk = (value: unknown, depth: number): string | null => {
        if (!value || typeof value !== "object" || depth > 5 || visited.has(value as object)) return null;
        visited.add(value as object);
        const record = value as Record<string, unknown>;
        for (const [key, child] of Object.entries(record)) {
          if (preferredKeys.test(key)) {
            const found = normalize(child);
            if (found) return found;
          }
        }
        const looksLikeMusic = Object.keys(record).some(key => /music|song|audio|duration|author|artist/i.test(key));
        if (looksLikeMusic) {
          for (const key of ["id", "uniqueId", "unique_id"]) {
            const found = normalize(record[key]);
            if (found) return found;
          }
        }
        for (const child of Object.values(record)) {
          const found = walk(child, depth + 1);
          if (found) return found;
        }
        return null;
      };
      for (const node of nodes.slice(0, 12)) {
        for (const key of Object.keys(node)) {
          if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$")) continue;
          const found = walk((node as unknown as Record<string, unknown>)[key], 0);
          if (found) return found;
        }
      }
      return null;
    }).catch(() => null);
    items.push({
      pageId,
      title,
      author,
      version: null,
      duration,
      cover,
      selected: /已使用|已选择|取消使用/.test(text)
        || /selected|active/.test(className),
    });
  }
  return items;
}

export async function readPostMusicCandidates(page: Page): Promise<PostMusicCandidate[]> {
  const raw = await rawMusicCandidates(page);
  const occurrences = new Map<string, number>();
  return raw.map((item, index) => {
    const base = postMusicCandidateStableId(item, 1).replace(/-1$/, "");
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      id: postMusicCandidateStableId(item, occurrence),
      pageId: item.pageId,
      idSource: "derived",
      title: item.title,
      author: item.author,
      version: item.version,
      duration: item.duration,
      index,
      selected: item.selected,
    };
  });
}

export async function searchPostMusic(page: Page, query: string): Promise<PostMusicCandidate[]> {
  const value = cleanText(query);
  if (!value) throw new Error("POST_MUSIC_QUERY_REQUIRED");
  await openPostMusicPicker(page);
  const search = page.locator("input[placeholder='搜索音乐']");
  if (await search.count() !== 1 || !await search.isVisible().catch(() => false)) {
    throw new Error("POST_MUSIC_SEARCH_NOT_UNIQUE");
  }
  await search.fill("");
  await page.waitForTimeout(120);
  await search.fill(value);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(
      "[role='sidesheet'],.semi-sidesheet",
    ));
    const scrollables = sheets.flatMap(sheet => Array.from(sheet.querySelectorAll<HTMLElement>("*")))
      .filter(element => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 40
          && /(auto|scroll)/.test(style.overflowY)
          && Boolean(element.querySelector("[class*='song-name-']"));
      })
      .sort((a, b) => b.clientHeight - a.clientHeight);
    if (scrollables[0]) scrollables[0].scrollTop = 0;
  }).catch(() => null);
  await page.waitForTimeout(180);
  const deadline = Date.now() + 8_000;
  let previousSignature = "";
  let stableReads = 0;
  do {
    await page.waitForTimeout(350);
    const items = await readPostMusicCandidates(page);
    const signature = items.map(item => item.id).join("|");
    if (items.length && signature === previousSignature) stableReads += 1;
    else stableReads = items.length ? 1 : 0;
    previousSignature = signature;
    if (items.length && stableReads >= 2) return items;
  } while (Date.now() < deadline);
  return [];
}

export async function selectPostMusicCandidate(
  page: Page,
  selector: string | PostMusicCandidateSelector,
): Promise<PostDraftMusic> {
  const selectedBeforeOpen = await readSelectedPostMusic(page);
  const requestedId = typeof selector === "string" ? selector : selector.id;
  if (selectedBeforeOpen
    && requestedId
    && (selectedBeforeOpen.id === requestedId || selectedBeforeOpen.pageId === requestedId)) {
    return selectedBeforeOpen;
  }
  await openPostMusicPicker(page);
  const candidates = await readPostMusicCandidates(page);
  const selected = resolvePostMusicCandidate(candidates, selector);
  const candidateIndex = candidates.indexOf(selected);
  const expected = {
    id: selected.id,
    pageId: selected.pageId,
    idSource: selected.idSource,
    title: selected.title,
    author: selected.author,
    version: selected.version,
    duration: selected.duration,
  };
  const alreadySelected = await readSelectedPostMusic(page);
  if (selected.selected
    || alreadySelected?.id === expected.id
    || (alreadySelected?.title === expected.title
    && (!expected.duration || !alreadySelected.duration || alreadySelected.duration === expected.duration))) {
    await closePostMusicPicker(page);
    return expected;
  }
  const rows = await locatePostMusicCandidateRows(page);
  const visibleRows: number[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    if (await rows.nth(index).isVisible().catch(() => false)) visibleRows.push(index);
  }
  if (visibleRows.length !== candidates.length) {
    throw new Error(
      `POST_MUSIC_ROW_COUNT_MISMATCH:${visibleRows.length}/${candidates.length}`,
    );
  }
  const row = rows.nth(visibleRows[candidateIndex]);
  await row.hover({ timeout: 5_000 });
  const rowButtons = row.locator("button");
  const useIndexes: number[] = [];
  for (let index = 0; index < await rowButtons.count(); index += 1) {
    const button = rowButtons.nth(index);
    if ((await button.innerText().catch(() => "")).trim() === "使用"
      && await button.isVisible().catch(() => false)) {
      useIndexes.push(index);
    }
  }
  if (useIndexes.length !== 1) {
    throw new Error("POST_MUSIC_USE_BUTTON_NOT_UNIQUE");
  }
  await rowButtons.nth(useIndexes[0]).click({ timeout: 5_000 });
  const closedAfterUse = await page.waitForFunction(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0.01;
    };
    return !Array.from(document.querySelectorAll(
      "[role='sidesheet'],.semi-sidesheet",
    )).some(visible);
  }, undefined, { timeout: 2_500 }).then(() => true).catch(() => false);
  const sheetsAfterUse = page.locator("[role='sidesheet'],.semi-sidesheet");
  let sheetStillVisible = !closedAfterUse;
  if (!closedAfterUse) {
    sheetStillVisible = false;
    for (let index = 0; index < await sheetsAfterUse.count(); index += 1) {
      if (await sheetsAfterUse.nth(index).isVisible().catch(() => false)) {
        sheetStillVisible = true;
        break;
      }
    }
  }
  if (sheetStillVisible) {
    const confirmButtons = page.locator("button");
    const confirmIndexes: number[] = [];
    for (let index = 0; index < await confirmButtons.count(); index += 1) {
      const button = confirmButtons.nth(index);
      if ((await button.innerText().catch(() => "")).trim() === "确定"
        && await button.isVisible().catch(() => false)
        && !await button.isDisabled().catch(() => true)) {
        confirmIndexes.push(index);
      }
    }
    if (confirmIndexes.length !== 1) {
      throw new Error("POST_MUSIC_CONFIRM_NOT_READY");
    }
    await confirmButtons.nth(confirmIndexes[0]).click({ timeout: 5_000 });
  }
  const sheets = page.locator("[role='sidesheet'],.semi-sidesheet");
  for (let index = 0; index < await sheets.count(); index += 1) {
    await sheets.nth(index).waitFor({ state: "hidden", timeout: 8_000 }).catch(() => null);
  }
  const readback = await readSelectedPostMusic(page);
  if (!readback
    || readback.title !== expected.title
    || (
      expected.duration
      && readback.duration
      && readback.duration !== expected.duration
    )) {
    throw new Error("POST_MUSIC_READBACK_MISMATCH");
  }
  return expected;
}

export async function readSelectedPostMusic(page: Page): Promise<PostDraftMusic | null> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const root = Array.from(document.querySelectorAll<HTMLElement>(
      "[class*='container-del-']",
    )).find(element =>
      visible(element)
      && Boolean(element.querySelector("[class*='sub-desc-title-']")));
    if (!root) return null;
    const title = (
      root.querySelector<HTMLElement>("[class*='sub-desc-title-']")?.innerText
      || ""
    ).replace(/\s+/g, " ").trim();
    const duration = (
      root.querySelector<HTMLElement>("[class*='sub-desc-duration-']")?.innerText
      || ""
    ).replace(/\s+/g, " ").trim() || null;
    if (!title) return null;
    const normalize = (value: unknown): string | null => {
      if (typeof value !== "string" && typeof value !== "number") return null;
      const text = String(value).trim();
      return text.length >= 4 && text.length <= 160 ? text : null;
    };
    let pageId: string | null = null;
    for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      for (const name of ["data-music-id", "data-song-id", "data-item-id", "music-id"]) {
        pageId = normalize(node.getAttribute(name));
        if (pageId) break;
      }
      if (pageId) break;
    }
    return {
      id: pageId ?? "",
      pageId,
      idSource: pageId ? "page" as const : "derived" as const,
      title,
      author: null,
      version: null,
      duration,
    };
  }).then(item => {
    if (!item?.title) return null;
    return {
      ...item,
      id: item.id || `selected-${createHash("sha256").update(item.title).digest("hex").slice(0, 20)}`,
    };
  });
}

export async function removeSelectedPostMusic(page: Page): Promise<void> {
  if (!publisherMusicEditorKind(page.url())) {
    throw new Error("POST_MUSIC_REQUIRES_SUPPORTED_EDITOR");
  }
  const roots = page.locator("[class*='container-del-']")
    .filter({ has: page.locator("[class*='sub-desc-title-']") });
  const visibleRoots: number[] = [];
  for (let index = 0; index < await roots.count(); index += 1) {
    if (await roots.nth(index).isVisible().catch(() => false)) {
      visibleRoots.push(index);
    }
  }
  if (visibleRoots.length !== 1) {
    throw new Error(`POST_MUSIC_SELECTED_ROOT_NOT_UNIQUE:${visibleRoots.length}`);
  }
  const root = roots.nth(visibleRoots[0]);
  const remove = root.locator("[class*='del-'],.icon-del");
  const visibleRemove: number[] = [];
  for (let index = 0; index < await remove.count(); index += 1) {
    if (await remove.nth(index).isVisible().catch(() => false)) {
      visibleRemove.push(index);
    }
  }
  if (!visibleRemove.length) throw new Error("POST_MUSIC_REMOVE_CONTROL_NOT_FOUND");
  await remove.nth(visibleRemove[0]).click({ timeout: 5_000 });
  await root.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => null);
  if (await readSelectedPostMusic(page)) {
    throw new Error("POST_MUSIC_REMOVE_READBACK_MISMATCH");
  }
}

function findWorkId(value: unknown): string | null {
  if (typeof value === "string" && /^\d{8,}$/.test(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(aweme_id|item_id|work_id|group_id)$/.test(key)) {
      const found = findWorkId(item);
      if (found) return found;
    }
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findWorkId(item);
    if (found) return found;
  }
  return null;
}

function responseCode(value: unknown): string | number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["status_code", "statusCode", "code"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") {
      return record[key] as string | number;
    }
  }
  return null;
}

function responseMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["status_msg", "statusMessage", "message", "msg"]) {
    if (typeof record[key] === "string") return record[key].slice(0, 500);
  }
  return null;
}

function possiblePublishResponse(response: Response): boolean {
  const url = response.url();
  if (!/creator\.douyin\.com|douyin\.com/.test(url)) return false;
  return /publish|post|aweme|item|content/i.test(url)
    && response.request().method() !== "GET";
}

export async function clickPublishCarouselOnce(
  page: Page,
  operation: PostPublishOperationRecord,
): Promise<CarouselPublishClickResult> {
  const snapshot = operation.snapshot;
  const before = await inspectCarouselPage(page);
  if (before.pageUrl !== snapshot.pageUrl
    || before.title !== cleanText(snapshot.title)
    || !postCaptionEquivalent(before.caption, snapshot.caption)
    || before.imageCount !== snapshot.media.length
    || before.imageCardCount !== snapshot.media.length
    || before.publishButtonCount !== 1) {
    throw new Error("POST_PUBLISH_SNAPSHOT_MISMATCH");
  }
  return dispatchPublishCarouselOnce(page, operation.operationId, snapshot.pageUrl);
}

/**
 * The V2 orchestrator performs semantic validation before recording click intent.
 * This function consequently does one thing only: dispatch at most one click and
 * capture submit evidence. It deliberately does not compare transient DOM state.
 */
export async function dispatchPublishCarouselOnce(
  page: Page,
  operationId: string,
  pageUrlBefore: string,
): Promise<CarouselPublishClickResult> {
  const responses: Response[] = [];
  const listener = (response: Response) => {
    if (possiblePublishResponse(response)) responses.push(response);
  };
  page.on("response", listener);
  let clickIssued = false;
  try {
    const button = page.getByRole("button", { name: "发布", exact: true });
    await button.click({ timeout: 5_000 });
    clickIssued = true;
    await page.waitForTimeout(8_000);
  } finally {
    page.off("response", listener);
  }
  const parsed: Array<{
    url: string;
    status: number;
    code: string | number | null;
    message: string | null;
    workId: string | null;
  }> = [];
  for (const response of responses.slice(-12)) {
    const json = await response.json().catch(() => null);
    parsed.push({
      url: response.url().replace(/[?#].*$/, ""),
      status: response.status(),
      code: responseCode(json),
      message: responseMessage(json),
      workId: findWorkId(json),
    });
  }
  const strongest = [...parsed].reverse().find(item =>
    item.workId || item.code === 0 || item.code === "0") ?? parsed.at(-1) ?? null;
  const resultingWorkId = strongest?.workId ?? null;
  const resultingWorkUrl = resultingWorkId
    ? `https://www.douyin.com/note/${resultingWorkId}`
    : null;
  const publishButton = page.getByRole("button", { name: "发布", exact: true });
  const publishButtonVisibleAfter = await publishButton.isVisible().catch(() => false);
  const toastText = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll<HTMLElement>(
      "[role='alert'],[class*='toast'],[class*='Toast'],[class*='message']",
    )).filter(visible).map(element => (
      element.innerText || element.textContent || ""
    ).replace(/\s+/g, " ").trim()).find(text =>
      /发布|成功|审核|处理中|失败/.test(text)) ?? null;
  });
  const possibleSubmit = Boolean(
    responses.length
    || resultingWorkId
    || toastText
    || !publishButtonVisibleAfter
    || page.url() !== pageUrlBefore,
  );
  const artifact = await capture(page, "publish-click", {
    operationId,
    clickIssued,
    possibleSubmit,
    pageUrlBefore,
    pageUrlAfter: page.url(),
    publishButtonVisibleAfter,
    toastText,
    responses: parsed,
  });
  return {
    operationId,
    clickIssued,
    responseSeen: responses.length > 0,
    responseStatus: strongest?.status ?? null,
    responseCode: strongest?.code ?? null,
    responseMessage: strongest?.message ?? null,
    resultingWorkId,
    resultingWorkUrl,
    pageUrlAfter: page.url(),
    publishButtonVisibleAfter,
    toastText,
    possibleSubmit,
    diagnosticsPath: artifact.diagnosticsPath,
    screenshotPath: artifact.screenshotPath,
    screenshotBase64: artifact.screenshotBase64,
  };
}

export function buildPostDraftSnapshot(
  draft: PostDraftRecord,
  pageTargetId: string,
  inspection: CarouselPageInspection,
): PostDraftSnapshot {
  return {
    draftId: draft.draftId,
    contentType: draft.contentType,
    actorAccount: draft.actorAccount,
    title: draft.title,
    caption: draft.caption,
    media: draft.media.map((item, index) => ({ ...item, order: index })),
    selectedMusic: draft.selectedMusic,
    coverIndex: draft.coverIndex,
    pageTargetId,
    pageUrl: inspection.pageUrl,
    capturedAt: inspection.capturedAt,
  };
}
