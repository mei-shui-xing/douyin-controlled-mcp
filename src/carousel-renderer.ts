import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { CONFIG } from "./config.js";
import type { CarouselRenderResult } from "./types.js";

export type CarouselRenderOptions = {
  html?: string;
  htmlPath?: string;
  outputDir?: string;
  slideSelector?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  allowScripts?: boolean;
  waitTimeoutMs?: number;
};

function requireAbsolutePath(value: string, field: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${field} 必须是绝对路径。`);
  return path.resolve(value);
}

function withinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\bjavascript\s*:/gi, "");
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("渲染输出不是有效 PNG。");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function validateLocalReferences(html: string, resourceRoot: string | null): Promise<string[]> {
  const references = [
    ...[...html.matchAll(/\b(?:src|poster|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map(match => match[1] ?? match[2]),
    ...[...html.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/gi)]
      .map(match => match[1] ?? match[2] ?? match[3]),
  ].map(value => value.trim()).filter(Boolean);
  const warnings: string[] = [];
  for (const reference of references) {
    if (/^(?:data:|#|about:)/i.test(reference)) continue;
    if (/^https?:/i.test(reference)) {
      warnings.push(`已阻止外部网络资源：${reference}`);
      continue;
    }
    if (!resourceRoot) {
      throw new Error(`内联 HTML 不允许读取本地资源：${reference}。请改用 data URL，或通过 html_path 明确资源目录。`);
    }
    const filePath = reference.startsWith("file:")
      ? path.resolve(decodeURIComponent(new URL(reference).pathname.replace(/^\/([A-Za-z]:)/, "$1")))
      : path.resolve(resourceRoot, reference);
    if (!withinRoot(filePath, resourceRoot)) {
      throw new Error(`本地资源越过 html_path 所在目录，已拒绝：${reference}`);
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`HTML 引用的本地文件不存在或不可读：${filePath}`);
  }
  return warnings;
}

async function inlineLocalResources(html: string, resourceRoot: string | null): Promise<string> {
  if (!resourceRoot) return html;
  const references = [...new Set([
    ...[...html.matchAll(/\b(?:src|poster|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map(match => match[1] ?? match[2]),
    ...[...html.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/gi)]
      .map(match => match[1] ?? match[2] ?? match[3]),
  ].map(value => value.trim()).filter(Boolean))];
  const mimeByExtension: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".css": "text/css",
  };
  let output = html;
  for (const reference of references) {
    if (/^(?:data:|#|about:|https?:)/i.test(reference)) continue;
    const filePath = reference.startsWith("file:")
      ? path.resolve(decodeURIComponent(new URL(reference).pathname.replace(/^\/([A-Za-z]:)/, "$1")))
      : path.resolve(resourceRoot, reference);
    const mime = mimeByExtension[path.extname(filePath).toLowerCase()];
    if (!mime) continue;
    const data = await fs.readFile(filePath);
    const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
    output = output.split(reference).join(dataUrl);
  }
  return output;
}

function addBaseHref(html: string, resourceRoot: string | null): string {
  if (!resourceRoot) return html;
  const base = `<base href="${pathToFileURL(`${resourceRoot}${path.sep}`).href}">`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => `${match}${base}`)
    : `${base}${html}`;
}

export async function renderHtmlCarousel(options: CarouselRenderOptions): Promise<CarouselRenderResult> {
  const hasHtml = typeof options.html === "string";
  const hasPath = typeof options.htmlPath === "string" && options.htmlPath.trim().length > 0;
  if (hasHtml === hasPath) throw new Error("html 与 html_path 必须且只能提供一个。");

  const width = Math.max(320, Math.min(4096, Math.round(options.width ?? 1080)));
  const height = Math.max(320, Math.min(4096, Math.round(options.height ?? 1440)));
  const deviceScaleFactor = Math.max(0.5, Math.min(4, options.deviceScaleFactor ?? 1));
  const waitTimeoutMs = Math.max(1_000, Math.min(60_000, Math.round(options.waitTimeoutMs ?? 15_000)));
  const slideSelector = options.slideSelector?.trim() || "[data-slide]";
  const allowScripts = options.allowScripts === true;
  const htmlPath = hasPath ? requireAbsolutePath(options.htmlPath!, "html_path") : null;
  if (htmlPath) {
    const stat = await fs.stat(htmlPath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`html_path 不存在或不可读：${htmlPath}`);
  }
  const resourceRoot = htmlPath ? path.dirname(htmlPath) : null;
  const originalHtml = hasHtml ? options.html! : await fs.readFile(htmlPath!, "utf8");
  const warnings = await validateLocalReferences(originalHtml, resourceRoot);
  const inlinedHtml = await inlineLocalResources(originalHtml, resourceRoot);
  const safeHtml = addBaseHref(allowScripts ? inlinedHtml : stripScripts(inlinedHtml), resourceRoot);

  const requestedOutput = options.outputDir
    ? requireAbsolutePath(options.outputDir, "output_dir")
    : path.join(CONFIG.runtimeDir, "carousel-renders");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(requestedOutput, runId);
  await fs.mkdir(outputDir, { recursive: true });
  const sourceHtmlPath = path.join(outputDir, "source.html");
  await fs.writeFile(sourceHtmlPath, originalHtml, "utf8");

  const imagePaths: string[] = [];
  const pages: CarouselRenderResult["pages"] = [];
  const diagnostics: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    htmlPath,
    sourceHtmlPath,
    slideSelector,
    width,
    height,
    deviceScaleFactor,
    allowScripts,
  };
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
      javaScriptEnabled: allowScripts,
    });
    await context.route(/^https?:\/\//i, route => route.abort("blockedbyclient"));
    const page = await context.newPage();
    const failedRequests: string[] = [];
    page.on("requestfailed", request => {
      const url = request.url();
      if (!failedRequests.includes(url)) failedRequests.push(url);
    });
    await page.setContent(safeHtml, { waitUntil: "domcontentloaded", timeout: waitTimeoutMs });
    const loadState = await page.evaluate(async timeout => {
      const imageResults = await Promise.all(Array.from(document.images).map(async image => {
        try {
          if (!image.complete) {
            await Promise.race([
              image.decode(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("image timeout")), timeout)),
            ]);
          } else {
            await image.decode().catch(() => null);
          }
        } catch {
          // Reported below through naturalWidth.
        }
        return {
          source: image.currentSrc || image.src,
          loaded: image.complete && image.naturalWidth > 0,
        };
      }));
      let fontsReady = true;
      try {
        await Promise.race([
          document.fonts.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error("font timeout")), timeout)),
        ]);
        fontsReady = document.fonts.status === "loaded";
      } catch {
        fontsReady = false;
      }
      return {
        images: imageResults,
        fontsReady,
        fontFaces: Array.from(document.fonts).map(font => ({
          family: font.family,
          status: font.status,
        })),
      };
    }, waitTimeoutMs);
    for (const image of loadState.images.filter(item => !item.loaded)) {
      warnings.push(`图片加载失败：${image.source || "未命名图片"}`);
    }
    if (!loadState.fontsReady || loadState.fontFaces.some(font => font.status === "error")) {
      warnings.push("字体加载失败或等待超时。");
    }
    for (const failed of failedRequests) warnings.push(`资源请求失败：${failed}`);

    const locator = page.locator(slideSelector);
    const count = await locator.count().catch(error => {
      throw new Error(`slide_selector 不是有效 CSS 选择器：${String(error)}`);
    });
    if (count === 0) throw new Error(`页面数量为零：没有找到 ${slideSelector}。`);
    if (count > 100) throw new Error("页面数量超过 100，已停止渲染。");

    for (let index = 0; index < count; index += 1) {
      const state = await page.evaluate(({ selector, active, canvasWidth, canvasHeight }) => {
        const slides = Array.from(document.querySelectorAll<HTMLElement>(selector));
        slides.forEach((slide, slideIndex) => {
          slide.style.setProperty("display", slideIndex === active ? "block" : "none", "important");
          if (slideIndex === active) {
            slide.style.setProperty("position", "fixed", "important");
            slide.style.setProperty("inset", "0", "important");
            slide.style.setProperty("width", `${canvasWidth}px`, "important");
            slide.style.setProperty("height", `${canvasHeight}px`, "important");
            slide.style.setProperty("box-sizing", "border-box", "important");
            slide.style.setProperty("margin", "0", "important");
          }
        });
        document.documentElement.style.cssText = `margin:0;width:${canvasWidth}px;height:${canvasHeight}px;overflow:hidden`;
        document.body.style.cssText = `margin:0;width:${canvasWidth}px;height:${canvasHeight}px;overflow:hidden`;
        const selected = slides[active];
        if (!selected) throw new Error("目标页面在截图前消失。");
        const style = getComputedStyle(selected);
        const text = (selected.innerText || selected.textContent || "").trim();
        const hasImage = Boolean(selected.querySelector("img,svg,canvas,video"));
        const background = `${style.background} ${style.backgroundImage} ${style.backgroundColor}`;
        return {
          overflow: selected.scrollWidth > selected.clientWidth + 1 || selected.scrollHeight > selected.clientHeight + 1,
          blank: text.length === 0 && !hasImage && /rgba\(0,\s*0,\s*0,\s*0\)|transparent|none/.test(background),
          textLength: text.length,
        };
      }, { selector: slideSelector, active: index, canvasWidth: width, canvasHeight: height });
      const fileName = `slide_${String(index + 1).padStart(2, "0")}.png`;
      const imagePath = path.join(outputDir, fileName);
      const buffer = await page.locator(slideSelector).nth(index).screenshot({
        path: imagePath,
        type: "png",
        animations: "disabled",
        timeout: waitTimeoutMs,
      });
      const size = pngSize(buffer);
      const expectedWidth = Math.round(width * deviceScaleFactor);
      const expectedHeight = Math.round(height * deviceScaleFactor);
      if (size.width !== expectedWidth || size.height !== expectedHeight) {
        warnings.push(`${fileName} 输出尺寸异常：${size.width}×${size.height}，预期 ${expectedWidth}×${expectedHeight}`);
      }
      if (state.overflow) warnings.push(`${fileName} 内容溢出画布。`);
      if (state.blank) warnings.push(`${fileName} 疑似空白页面。`);
      imagePaths.push(imagePath);
      pages.push({
        index: index + 1,
        path: imagePath,
        width: size.width,
        height: size.height,
        overflow: state.overflow,
        blank: state.blank,
      });
    }

    const previewPage = await context.newPage();
    await previewPage.setViewportSize({ width: 960, height: 720 });
    const cards = await Promise.all(imagePaths.map(async (imagePath, index) => {
      const data = (await fs.readFile(imagePath)).toString("base64");
      return `<figure><img src="data:image/png;base64,${data}"><figcaption>${index + 1}</figcaption></figure>`;
    }));
    await previewPage.setContent(`<!doctype html><style>
      html,body{margin:0;background:#17181c;color:#fff;font-family:Arial,"Microsoft YaHei",sans-serif}
      main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;padding:24px}
      figure{margin:0;background:#22252b;border:1px solid #3b3f48;border-radius:12px;padding:10px}
      img{display:block;width:100%;height:auto;border-radius:8px}
      figcaption{text-align:center;padding-top:8px;font-size:20px}
    </style><main>${cards.join("")}</main>`, { waitUntil: "load" });
    const previewContactSheetPath = path.join(outputDir, "preview_contact_sheet.png");
    await previewPage.screenshot({ path: previewContactSheetPath, type: "png", fullPage: true });
    diagnostics.loadState = loadState;
    diagnostics.failedRequests = failedRequests;
    diagnostics.pages = pages;
    diagnostics.warnings = warnings;
    const diagnosticsPath = path.join(outputDir, "diagnostics.json");
    await fs.writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2), "utf8");
    return {
      outputDir,
      sourceHtmlPath,
      imagePaths,
      pages,
      pageCount: pages.length,
      width: pages[0]?.width ?? Math.round(width * deviceScaleFactor),
      height: pages[0]?.height ?? Math.round(height * deviceScaleFactor),
      deviceScaleFactor,
      warnings,
      previewContactSheetPath,
      diagnosticsPath,
    };
  } finally {
    await browser.close();
  }
}
