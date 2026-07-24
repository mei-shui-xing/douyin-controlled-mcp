import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { CONFIG } from "./config.js";
import type {
  ArticleCoverResult,
  DraftInspectionResult,
  MusicActionResult,
  MusicItem,
} from "./types.js";
import type { PublishSnapshot } from "./publish-workflow.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function artifact(page: Page, operation: string): Promise<{
  screenshotPath: string;
  screenshotBase64: string;
}> {
  const directory = path.join(
    CONFIG.runtimeDir,
    "publish-diagnostics",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${operation}`,
  );
  await fs.mkdir(directory, { recursive: true });
  let screenshotPath = path.join(directory, "page.png");
  let screenshotBase64 = "";
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
  } catch {
    try {
      const image = await page.screenshot({
        path: screenshotPath,
        type: "png",
        fullPage: false,
        animations: "disabled",
        timeout: 5_000,
      });
      screenshotBase64 = image.toString("base64");
    } catch {
      screenshotPath = "";
    }
  } finally {
    void session?.detach().catch(() => null);
  }
  return { screenshotPath, screenshotBase64 };
}

async function validateImage(imagePath: string): Promise<string> {
  if (!path.isAbsolute(imagePath)) throw new Error("cover_path 必须是本地绝对路径。");
  const resolved = path.resolve(imagePath);
  if (!imageExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error("封面仅支持 PNG、JPG、JPEG 或 WEBP。");
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error(`封面文件不存在或不可读：${resolved}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error("封面文件不能超过 20MB。");
  return resolved;
}

export async function inspectArticleEditor(
  page: Page,
  binding: { pageId: string; targetId: string; account: string },
): Promise<PublishSnapshot> {
  const state = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const title = Array.from(document.querySelectorAll<HTMLInputElement>("input,textarea"))
      .find(element => visible(element) && /文章标题|请输入标题|标题/.test(
        `${element.placeholder} ${element.getAttribute("aria-label") ?? ""}`,
      ))?.value?.trim() ?? "";
    const editors = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'],textarea"))
      .filter(visible)
      .map(element => ({
        element,
        text: element instanceof HTMLTextAreaElement ? element.value : (element.innerText || element.textContent || ""),
      }))
      .sort((a, b) => b.text.length - a.text.length);
    const text = editors[0]?.text.replace(/\r\n?/g, "\n").trim() ?? "";
    const hashtagTexts = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-e2e*='topic'],[class*='topic'],[class*='Topic'],[class*='hashtag'],[class*='Hashtag']",
    ))
      .filter(visible)
      .flatMap(element => clean(element.innerText || element.textContent).match(/#[^\s#，,、]+/g) ?? [])
      .map(value => value.replace(/^#/, ""));
    const coverRoots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-e2e*='cover'],[class*='cover'],[class*='Cover']",
    )).filter(visible);
    const coverImages = coverRoots.flatMap(root => Array.from(root.querySelectorAll<HTMLImageElement>("img")))
      .filter(image => visible(image) && image.naturalWidth > 40 && image.naturalHeight > 40);
    const musicRoots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-e2e*='music'],[class*='music'],[class*='Music'],[class*='container-del-']",
    )).filter(visible);
    const selectedMusic = musicRoots.find(root => {
      const hint = `${root.getAttribute("aria-selected")} ${root.getAttribute("data-selected")} ${root.className}`;
      return /true|selected|active|checked/i.test(hint)
        || Boolean(root.querySelector("[class*='sub-desc-title-']"));
    });
    const body = clean(document.body.innerText);
    const visibility = body.match(/(?:谁可以看|可见范围)[：:\s]*(公开|朋友可见|好友可见|仅自己可见|仅自己)/)?.[1]
      ?? body.match(/(?:^|\s)(公开|朋友可见|好友可见|仅自己可见)(?:\s|$)/)?.[1]
      ?? "";
    const publishTime = body.match(/(?:发布时间|发布方式)[：:\s]*(立即发布|定时发布[^，。\n]*)/)?.[1]
      ?? (body.includes("立即发布") ? "立即发布" : "");
    const errorPrompts = Array.from(document.querySelectorAll<HTMLElement>(
      "[role='alert'],[aria-live='assertive'],[class*='error'],[class*='Error']",
    ))
      .filter(visible)
      .map(element => clean(element.innerText || element.textContent))
      .filter(text => text && /封面|标题|正文|话题|音乐|失败|错误|请选择|没有选择/.test(text))
      .slice(0, 20);
    if (/没有选择封面|请选择封面/.test(body)) errorPrompts.push("没有选择封面");
    const explicitNoMusic = /不使用音乐|无音乐|关闭配乐/.test(body);
    const musicTitle = clean(
      selectedMusic?.querySelector<HTMLElement>("[class*='sub-desc-title-']")?.innerText
      || selectedMusic?.innerText
      || selectedMusic?.textContent,
    );
    const musicDuration = clean(
      selectedMusic?.querySelector<HTMLElement>("[class*='sub-desc-duration-']")?.innerText,
    ) || null;
    return {
      title,
      text,
      hashtags: [...new Set(hashtagTexts)],
      cover: {
        selected: coverImages.length > 0,
        source: coverImages[0]?.currentSrc || coverImages[0]?.src || null,
        thumbnailCount: coverImages.length,
      },
      music: {
        selected: Boolean(selectedMusic && musicTitle),
        id: selectedMusic?.getAttribute("data-music-id") ?? selectedMusic?.getAttribute("data-id") ?? null,
        title: musicTitle || null,
        author: null,
        version: null,
        duration: musicDuration ?? musicTitle.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? null,
        explicitNone: explicitNoMusic,
      },
      visibility,
      publishTime,
      errorPrompts: [...new Set(errorPrompts)],
    };
  });
  return {
    ...state,
    textLength: state.text.length,
    paragraphCount: state.text ? state.text.split(/\n\s*\n|\n/).filter(Boolean).length : 0,
    account: binding.account,
    pageId: binding.pageId,
    pageTargetId: binding.targetId,
    pageUrl: page.url(),
    preflightPassed: false,
    capturedAt: new Date().toISOString(),
  };
}

export async function uploadArticleCover(page: Page, imagePath: string): Promise<ArticleCoverResult> {
  const file = await validateImage(imagePath);
  const inputs = page.locator('input[type="file"][accept*="image"]');
  const count = await inputs.count();
  let selected = -1;
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const context = await input.evaluate(element => {
      const root = element.closest<HTMLElement>(
        "[data-e2e*='cover'],[class*='cover'],[class*='Cover']",
      );
      return (root?.innerText || root?.textContent || "").trim();
    }).catch(() => "");
    if (/封面|cover/i.test(context)) {
      selected = index;
      break;
    }
  }
  if (selected < 0) {
    if (count !== 1) throw new Error("VALIDATION_FAILED:无法唯一定位文章封面上传控件。");
    selected = 0;
  }
  await inputs.nth(selected).setInputFiles(file);
  await page.waitForFunction(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-e2e*='cover'],[class*='cover'],[class*='Cover']",
    ));
    return roots.some(root => Array.from(root.querySelectorAll("img"))
      .some(image => image.naturalWidth > 40 && image.naturalHeight > 40));
  }, undefined, { timeout: 20_000 });
  return verifyArticleCover(page, file);
}

export async function verifyArticleCover(page: Page, source: string | null = null): Promise<ArticleCoverResult> {
  const cover = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-e2e*='cover'],[class*='cover'],[class*='Cover']",
    )).filter(visible);
    const images = roots.flatMap(root => Array.from(root.querySelectorAll<HTMLImageElement>("img")))
      .filter(image => visible(image) && image.naturalWidth > 40 && image.naturalHeight > 40);
    return {
      selected: images.length > 0,
      source: images[0]?.currentSrc || images[0]?.src || null,
      thumbnailCount: images.length,
    };
  });
  return { ...cover, source: source ?? cover.source, ...await artifact(page, "article-cover") };
}

export async function removeArticleCover(page: Page): Promise<ArticleCoverResult> {
  const button = page.locator(
    "[data-e2e*='cover'] button,[class*='cover'] button,[class*='Cover'] button",
  ).filter({ hasText: /删除|移除|更换|取消/ });
  const visible: number[] = [];
  for (let index = 0; index < await button.count(); index += 1) {
    if (await button.nth(index).isVisible().catch(() => false)) visible.push(index);
  }
  if (visible.length !== 1) throw new Error("VALIDATION_FAILED:无法唯一定位封面删除按钮。");
  await button.nth(visible[0]).click();
  await page.waitForTimeout(500);
  const result = await verifyArticleCover(page);
  if (result.selected) throw new Error("VALIDATION_FAILED:封面删除后仍显示缩略图。");
  return result;
}

export async function inspectCurrentDraft(page: Page): Promise<DraftInspectionResult> {
  const binding = { pageId: "inspection", targetId: "inspection", account: "" };
  const snapshot = await inspectArticleEditor(page, binding);
  const imageCount = await page.locator(
    "[data-e2e*='image'] img,[class*='upload'] img,[class*='material'] img",
  ).count();
  const warnings: string[] = [];
  if (snapshot.title || snapshot.text || imageCount || snapshot.hashtags.length || snapshot.cover.selected) {
    warnings.push("当前编辑器不是空草稿。");
  }
  if (/测试|验证器复测|codex_test/i.test(`${snapshot.title}\n${snapshot.text}`)) {
    warnings.push("检测到旧测试文案。");
  }
  const pageState = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const body = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const hasPopup = Array.from(document.querySelectorAll(
      "[role='dialog'],[role='sidesheet'],.semi-sidesheet,.semi-modal",
    )).some(visible);
    const previewControl = Array.from(document.querySelectorAll<HTMLElement>(
      "button,[role='button'],[role='tab']",
    )).find(element => visible(element)
      && /^预览(?:首页推荐|双列封面|文章)?$/.test((element.innerText || element.textContent || "").trim()));
    const previewReached = /\/creator-micro\/content\/post\/article/.test(location.pathname)
      && (/预览首页推荐|预览双列封面|阅读文章/.test(body)
        || Boolean(previewControl && (
          previewControl.getAttribute("aria-selected") === "true"
          || /active|selected/.test(String(previewControl.className))
        )));
    const successNotices = Array.from(document.querySelectorAll<HTMLElement>(
      "[role='alert'],[aria-live='assertive'],[class*='toast'],[class*='Toast'],[class*='message']",
    )).filter(visible).map(element => (
      element.innerText || element.textContent || ""
    ).replace(/\s+/g, " ").trim());
    const explicitSuccess = successNotices.some(text => /发布成功|作品已发布|提交成功|进入审核/.test(text));
    const currentWorkUrl = /\/(?:video|note|article)\/\d{8,}/.test(location.href)
      ? location.href
      : null;
    const successWorkUrl = explicitSuccess
      ? Array.from(document.querySelectorAll<HTMLAnchorElement>(
          "a[href*='/video/'],a[href*='/note/'],a[href*='/article/']",
        )).map(anchor => anchor.href)
        .find(value => /\/(?:video|note|article)\/\d{8,}/.test(value)) ?? null
      : null;
    const workUrl = currentWorkUrl ?? successWorkUrl;
    const workId = workUrl?.match(/\/(?:video|note|article)\/(\d{8,})/)?.[1] ?? null;
    return {
      hasPopup,
      previewReached,
      published: Boolean(currentWorkUrl) || (explicitSuccess && Boolean(workId && workUrl)),
      uncertain: explicitSuccess && !Boolean(workId && workUrl),
      workId,
      workUrl,
    };
  });
  return {
    title: snapshot.title,
    text: snapshot.text,
    titleComplete: Boolean(snapshot.title.trim()),
    textComplete: Boolean(snapshot.text.trim()),
    imageCount,
    coverCount: snapshot.cover.thumbnailCount,
    hashtags: snapshot.hashtags,
    musicSelected: snapshot.music.selected,
    currentMusic: snapshot.music.selected && snapshot.music.title
      ? {
          id: snapshot.music.id ?? `selected-${snapshot.music.title}`,
          pageId: snapshot.music.id,
          idSource: snapshot.music.id ? "page" : "derived",
          title: snapshot.music.title,
          author: snapshot.music.author,
          version: snapshot.music.version,
          duration: snapshot.music.duration,
          selected: true,
        }
      : null,
    ...pageState,
    pageUrl: page.url(),
    visibility: snapshot.visibility,
    publishTime: snapshot.publishTime,
    contaminated: warnings.length > 0,
    warnings,
    ...await artifact(page, "inspect-draft"),
  };
}

export async function resetCurrentDraft(page: Page, confirmReset: boolean): Promise<DraftInspectionResult> {
  if (!confirmReset) throw new Error("重置当前草稿必须提供 confirm_reset=true。");
  const beforeUrl = page.url();
  const titleInputs = page.locator("input,textarea").filter({ has: page.locator("xpath=..") });
  for (let index = 0; index < await titleInputs.count(); index += 1) {
    const input = titleInputs.nth(index);
    const hint = `${await input.getAttribute("placeholder")} ${await input.getAttribute("aria-label")}`;
    if (/标题/.test(hint) && await input.isVisible().catch(() => false)) await input.fill("");
  }
  const editors = page.locator("[contenteditable='true']");
  for (let index = 0; index < await editors.count(); index += 1) {
    if (await editors.nth(index).isVisible().catch(() => false)) await editors.nth(index).fill("");
  }
  const removers = page.getByRole("button", { name: /删除|移除|清除|取消选择/ });
  const count = await removers.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = removers.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const context = await candidate.evaluate(element => (
      element.closest("[data-e2e*='cover'],[data-e2e*='topic'],[data-e2e*='music'],[class*='cover'],[class*='topic'],[class*='music'],[class*='upload']")
        ?.textContent ?? ""
    )).catch(() => "");
    if (context) await candidate.click().catch(() => null);
  }
  if (page.url() !== beforeUrl) throw new Error("WRONG_PAGE:重置草稿过程中页面发生跳转。");
  const result = await inspectCurrentDraft(page);
  if (result.title || result.text || result.imageCount || result.coverCount || result.hashtags.length || result.musicSelected) {
    throw new Error("VALIDATION_FAILED:草稿重置后仍有项目未清空。");
  }
  return result;
}

async function readMusicItems(page: Page): Promise<MusicItem[]> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 80 && rect.height > 20;
    };
    const rows = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-music-id],[data-e2e*='music-item'],[class*='music-item'],[class*='MusicItem']",
    )).filter(visible);
    return rows.map((row, index) => {
      const text = (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
      const duration = text.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? null;
      const parts = text.replace(duration ?? "", "").split(/[-–—|]/).map(value => value.trim()).filter(Boolean);
      const hint = `${row.getAttribute("aria-selected")} ${row.getAttribute("data-selected")} ${row.className}`;
      return {
        id: row.getAttribute("data-music-id") ?? row.getAttribute("data-id") ?? `dom-${index}`,
        title: parts[0] ?? text,
        author: parts[1] ?? null,
        version: parts[2] ?? null,
        duration,
        selected: /true|selected|active|checked/i.test(hint),
      };
    }).filter(item => item.title);
  });
}

export async function listRecommendedMusic(page: Page): Promise<MusicActionResult> {
  const items = await readMusicItems(page);
  return { items, selected: items.find(item => item.selected) ?? null, ...await artifact(page, "music-list") };
}

export async function searchMusic(page: Page, query: string): Promise<MusicActionResult> {
  const value = query.trim();
  if (!value) throw new Error("音乐搜索词不能为空。");
  const input = page.locator("input").filter({ has: page.locator("xpath=..") });
  let target = null as ReturnType<Page["locator"]> | null;
  for (let index = 0; index < await input.count(); index += 1) {
    const candidate = input.nth(index);
    const hint = `${await candidate.getAttribute("placeholder")} ${await candidate.getAttribute("aria-label")}`;
    if (/音乐|歌曲|配乐|搜索/.test(hint) && await candidate.isVisible().catch(() => false)) {
      target = candidate;
      break;
    }
  }
  if (!target) throw new Error("VALIDATION_FAILED:找不到音乐搜索框。");
  await target.fill(value);
  await page.waitForTimeout(700);
  return listRecommendedMusic(page);
}

export async function selectMusic(page: Page, musicId: string): Promise<MusicActionResult> {
  const escaped = musicId.replace(/["\\]/g, "\\$&");
  const row = page.locator(`[data-music-id="${escaped}"],[data-id="${escaped}"]`);
  if (await row.count() !== 1 || !await row.first().isVisible().catch(() => false)) {
    throw new Error("VALIDATION_FAILED:没有唯一匹配该 music_id 的可见音乐。");
  }
  await row.click();
  await page.waitForTimeout(500);
  const result = await listRecommendedMusic(page);
  if (result.selected?.id !== musicId) throw new Error("VALIDATION_FAILED:音乐点击后没有挂载到当前作品。");
  return result;
}

export async function removeMusic(page: Page): Promise<MusicActionResult> {
  const button = page.getByRole("button", { name: /移除音乐|删除音乐|取消配乐|不使用音乐/ });
  const visible: number[] = [];
  for (let index = 0; index < await button.count(); index += 1) {
    if (await button.nth(index).isVisible().catch(() => false)) visible.push(index);
  }
  if (visible.length !== 1) throw new Error("VALIDATION_FAILED:无法唯一定位移除音乐按钮。");
  await button.nth(visible[0]).click();
  await page.waitForTimeout(500);
  const result = await listRecommendedMusic(page);
  if (result.selected) throw new Error("VALIDATION_FAILED:移除后仍检测到选中音乐。");
  return result;
}
