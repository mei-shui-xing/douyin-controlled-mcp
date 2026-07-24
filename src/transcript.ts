import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Page } from "playwright-core";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import type { MediaProbe, TranscriptRecord } from "./types.js";

const MEDIA_URL_RE = /(?:\.mp4(?:$|\?)|\.m4a(?:$|\?)|\.mp3(?:$|\?)|\.m3u8(?:$|\?)|video\/tos|douyinvod|bytecdn|mime_type=video|playwm|play\/)/i;
const PUBLIC_SHARE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const PUBLIC_VIDEO_CACHE_TTL_MS = 5 * 60_000;
const TRANSCRIPT_MODELS = new Set(["tiny", "base", "small", "medium", "turbo", "large-v3"]);
const DEFAULT_TECHNICAL_GLOSSARY = [
  "ActionScript",
  "JavaScript",
  "HTML5",
  "Canvas",
  "Hugging Face",
  "OpenAI",
  "Anthropic",
  "Claude",
  "Codex",
  "Token",
];

export type PublicVideoResolution = {
  source: "iesdouyin-router-data";
  workId: string;
  canonicalUrl: string;
  title: string;
  author: string | null;
  durationSeconds: number | null;
  videoUrl: string;
  videoCandidates: string[];
  coverUrl: string | null;
};

const publicVideoCache = new Map<string, { expiresAt: number; value: PublicVideoResolution }>();

function assertTranscriptModel(model: string): string {
  if (!TRANSCRIPT_MODELS.has(model)) throw new Error(`INVALID_TRANSCRIPT_MODEL:${model}`);
  return model;
}

export function buildTranscriptInitialPrompt(input: {
  title?: string | null;
  author?: string | null;
  visibleText?: string | null;
  extraGlossary?: string[];
}): string {
  const hashtags = `${input.title ?? ""}\n${input.visibleText ?? ""}`
    .match(/#[^#\s，。！？、]{1,40}/g)
    ?.slice(0, 20) ?? [];
  const environmentGlossary = (process.env.DOUYIN_TRANSCRIPT_GLOSSARY ?? "")
    .split(/[,，;；\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  const terms = [...new Set([
    ...DEFAULT_TECHNICAL_GLOSSARY,
    ...environmentGlossary,
    ...(input.extraGlossary ?? []),
  ])].slice(0, 100);
  return [
    input.title ? `作品标题：${input.title}` : "",
    input.author ? `作者：${input.author}` : "",
    hashtags.length ? `话题：${hashtags.join(" ")}` : "",
    `术语表：${terms.join("、")}`,
    "请按原音准确转写；术语表只用于识别提示，不要添加音频中不存在的内容。",
  ].filter(Boolean).join("\n");
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return cleaned || createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function transcriptPath(transcriptId: string): string {
  return path.join(CONFIG.transcriptDir, safeId(transcriptId), "transcript.json");
}

export async function withTranscriptTemporaryDirectory<T>(
  transcriptId: string,
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = path.join(CONFIG.transcriptDir, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, `${safeId(transcriptId)}-`));
  try {
    return await task(temporaryDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function douyinWorkId(rawUrl: string): string | null {
  const direct = rawUrl.match(/\/(?:video|note|article)\/(\d{8,})/i)?.[1];
  if (direct) return direct;
  return rawUrl.match(/(?:modal_id|aweme_id)=(\d{8,})/i)?.[1] ?? null;
}

function assertPublicDouyinUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_DOUYIN_URL: 请输入完整的抖音作品或分享链接。");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(host === "douyin.com" || host.endsWith(".douyin.com") || host === "iesdouyin.com" || host.endsWith(".iesdouyin.com"))) {
    throw new Error("INVALID_DOUYIN_URL: 只允许解析 douyin.com 或 iesdouyin.com 的 HTTPS 链接。");
  }
  return parsed;
}

function extractAssignedJson(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("ROUTER_DATA_MISSING");
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error("ROUTER_DATA_INVALID");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error("ROUTER_DATA_INVALID");
}

function findItemRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findItemRecord(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const itemList = record.item_list;
  if (Array.isArray(itemList) && itemList[0] && typeof itemList[0] === "object") {
    return itemList[0] as Record<string, unknown>;
  }
  for (const child of Object.values(record)) {
    const found = findItemRecord(child);
    if (found) return found;
  }
  return null;
}

function collectMediaUrls(value: unknown, keyPath = "", output: Array<{ url: string; score: number }> = []): Array<{ url: string; score: number }> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && /^https?:\/\//i.test(item) && MEDIA_URL_RE.test(item)) {
        const pathScore = /play_addr|playapi|download_addr/i.test(keyPath) ? 100 : 0;
        const codecScore = /h264|play_addr(?!_bytevc)/i.test(keyPath) ? 20 : 0;
        const formatScore = /\.m3u8(?:$|\?)/i.test(item) ? -100 : 10;
        output.push({ url: item.replace(/playwm/gi, "play"), score: pathScore + codecScore + formatScore });
      } else {
        collectMediaUrls(item, keyPath, output);
      }
    }
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectMediaUrls(child, `${keyPath}.${key}`, output);
  }
  return output;
}

function firstUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const urls: string[] = [];
  const visit = (child: unknown): void => {
    if (typeof child === "string" && /^https?:\/\//i.test(child)) urls.push(child);
    else if (Array.isArray(child)) child.forEach(visit);
    else if (child && typeof child === "object") Object.values(child as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return urls[0] ?? null;
}

export function parsePublicShareHtml(html: string, requestedWorkId: string): PublicVideoResolution {
  const routerData = extractAssignedJson(html, "window._ROUTER_DATA");
  const item = findItemRecord(routerData);
  if (!item) throw new Error("PUBLIC_VIDEO_METADATA_MISSING: 分享页没有返回作品元数据。");
  const actualWorkId = String(item.aweme_id ?? item.item_id ?? "");
  if (actualWorkId && actualWorkId !== requestedWorkId) {
    throw new Error(`PUBLIC_VIDEO_ID_MISMATCH: 分享页返回了作品 ${actualWorkId}，目标是 ${requestedWorkId}。`);
  }
  const video = item.video;
  const candidates = collectMediaUrls(video)
    .sort((a, b) => b.score - a.score)
    .map(item => item.url);
  const videoCandidates = [...new Set(candidates)];
  if (!videoCandidates.length) throw new Error("PUBLIC_VIDEO_URL_MISSING: 分享页没有返回可下载的视频地址。");
  const authorRecord = item.author && typeof item.author === "object"
    ? item.author as Record<string, unknown>
    : null;
  const durationMs = video && typeof video === "object"
    ? Number((video as Record<string, unknown>).duration)
    : Number.NaN;
  const coverValue = video && typeof video === "object"
    ? ((video as Record<string, unknown>).cover ?? (video as Record<string, unknown>).origin_cover)
    : null;
  return {
    source: "iesdouyin-router-data",
    workId: actualWorkId || requestedWorkId,
    canonicalUrl: `https://www.douyin.com/video/${actualWorkId || requestedWorkId}`,
    title: String(item.desc ?? ""),
    author: authorRecord ? String(authorRecord.nickname ?? authorRecord.unique_id ?? "") || null : null,
    durationSeconds: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null,
    videoUrl: videoCandidates[0],
    videoCandidates,
    coverUrl: firstUrl(coverValue),
  };
}

export async function resolvePublicDouyinVideo(rawUrl: string): Promise<PublicVideoResolution> {
  const input = assertPublicDouyinUrl(rawUrl);
  let workId = douyinWorkId(input.href);
  if (!workId) {
    const resolved = await fetch(input, {
      redirect: "follow",
      headers: { "User-Agent": PUBLIC_SHARE_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(12_000),
    });
    workId = douyinWorkId(resolved.url) ?? douyinWorkId(await resolved.text());
  }
  if (!workId) throw new Error("WORK_ID_NOT_FOUND: 无法从分享链接解析作品 ID。");
  const cached = publicVideoCache.get(workId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const shareUrl = `https://www.iesdouyin.com/share/video/${workId}`;
  const response = await fetch(shareUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": PUBLIC_SHARE_UA,
      Referer: "https://www.douyin.com/",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`PUBLIC_VIDEO_FETCH_FAILED: 分享页返回 HTTP ${response.status}。`);
  const result = parsePublicShareHtml(await response.text(), workId);
  publicVideoCache.set(workId, { expiresAt: Date.now() + PUBLIC_VIDEO_CACHE_TTL_MS, value: result });
  return result;
}

async function readPythonPath(): Promise<string> {
  try {
    const value = (await readFile(CONFIG.transcriptPythonFile, "utf8")).trim();
    if (!value) throw new Error("empty");
    await stat(value);
    return value;
  } catch {
    throw new Error(
      "本地字幕组件尚未安装。请关闭桥后双击 INSTALL_TRANSCRIPT.cmd；安装完成后重新启动 START_BRIDGE.cmd。此组件使用本地 faster-whisper，不收 API 费用。",
    );
  }
}

async function captureNetworkCandidates(page: Page): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  const found = new Set<string>();
  const onResponse = (event: { response?: { url?: string; mimeType?: string } }) => {
    const url = event.response?.url ?? "";
    const mime = event.response?.mimeType ?? "";
    if (/^(video|audio)\//i.test(mime) || /mpegurl/i.test(mime) || MEDIA_URL_RE.test(url)) {
      if (/^https?:\/\//i.test(url)) found.add(url);
    }
  };

  try {
    await session.send("Network.enable");
    session.on("Network.responseReceived", onResponse);
    await page.evaluate(async () => {
      const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
      const visible = videos
        .map(video => ({ video, box: video.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 100 && box.height > 100 && box.bottom > 0 && box.top < innerHeight)
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]?.video;
      if (!visible) return;
      try {
        const originalMuted = visible.muted;
        visible.muted = true;
        if (Number.isFinite(visible.duration) && visible.duration > 2) {
          visible.currentTime = Math.min(visible.duration - 0.5, Math.max(0, visible.currentTime + 0.25));
        }
        await visible.play().catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 2200));
        visible.muted = originalMuted;
      } catch {
        // Network resources may already be present in performance entries.
      }
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
  } finally {
    session.off("Network.responseReceived", onResponse);
    await session.detach().catch(() => undefined);
  }
  return [...found];
}

async function browserHeaders(page: Page): Promise<Record<string, string>> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  return {
    "User-Agent": userAgent,
    Referer: page.url(),
    Accept: "*/*",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

async function downloadCandidateWithHeaders(
  url: string,
  targetWithoutExtension: string,
  headers: Record<string, string>,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("not-http");
  if (/\.m3u8(?:$|\?)/i.test(url)) throw new Error("hls-not-supported");
  let target: string | null = null;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      throw new Error(`unexpected-content-type:${contentType}`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > 1_500_000_000) throw new Error("media-too-large");
    const extension = contentType.includes("audio") ? ".m4a" : ".mp4";
    target = `${targetWithoutExtension}${extension}`;
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target));
    const downloaded = await stat(target);
    if (downloaded.size < 20_000) throw new Error("downloaded-file-too-small");
    return target;
  } catch (error) {
    if (target) await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function downloadCandidate(page: Page, url: string, targetWithoutExtension: string): Promise<string> {
  return downloadCandidateWithHeaders(url, targetWithoutExtension, await browserHeaders(page));
}

async function downloadCurrentMedia(page: Page, probe: MediaProbe, outputDir: string): Promise<string> {
  const initial = probe.mediaCandidates.filter(url => /^https?:\/\//i.test(url));
  const performanceUrls = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map(entry => entry.name)
      .filter(url => /^https?:\/\//i.test(url)),
  );
  const base = path.join(outputDir, "source");
  const failures: string[] = [];
  const attempted = new Set<string>();
  const tryCandidates = async (source: string, candidates: string[]): Promise<string | null> => {
    for (const candidate of [...new Set(candidates)].slice(0, 24)) {
      if (attempted.has(candidate)) continue;
      attempted.add(candidate);
      try {
        const file = await downloadCandidate(page, candidate, base);
        log("media_downloaded", { workId: probe.workId, source, candidate, file });
        return file;
      } catch (error) {
        failures.push(`${source}: ${candidate.slice(0, 120)} => ${String(error)}`);
      }
    }
    return null;
  };

  const fast = await tryCandidates("page", [
    ...initial,
    ...performanceUrls.filter(url => MEDIA_URL_RE.test(url)),
  ]);
  if (fast) return fast;

  const publicResult = await resolvePublicDouyinVideo(probe.url).catch(error => {
    failures.push(`public-share: ${String(error)}`);
    return null;
  });
  if (publicResult) {
    const publicFile = await tryCandidates("public-share", publicResult.videoCandidates);
    if (publicFile) return publicFile;
  }

  const network = await captureNetworkCandidates(page);
  const networkFile = await tryCandidates("network-capture", network);
  if (networkFile) return networkFile;

  throw new Error(
    `VIDEO_DOWNLOAD_FAILED: 页面媒体、公开分享页和实时网络捕获都未得到可下载视频。\n${failures.slice(0, 8).join("\n")}`,
  );
}

async function downloadPublicMedia(
  resolved: PublicVideoResolution,
  outputDir: string,
): Promise<string> {
  const failures: string[] = [];
  for (const candidate of resolved.videoCandidates.slice(0, 24)) {
    try {
      return await downloadCandidateWithHeaders(candidate, path.join(outputDir, "source"), {
        "User-Agent": PUBLIC_SHARE_UA,
        Referer: resolved.canonicalUrl,
        Accept: "*/*",
      });
    } catch (error) {
      failures.push(`${candidate.slice(0, 120)} => ${String(error)}`);
    }
  }
  throw new Error(`VIDEO_DOWNLOAD_FAILED:公开抖音作品没有可下载媒体。\n${failures.slice(0, 8).join("\n")}`);
}

async function runPython(python: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: CONFIG.projectRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`本地转写进程失败（退出码 ${code}）。\n${stderr.slice(-4000)}`));
    });
  });
}

async function transcribeMedia(input: {
  probe: MediaProbe;
  model: string;
  author?: string | null;
  download: (temporaryDirectory: string) => Promise<string>;
}): Promise<TranscriptRecord> {
  const model = assertTranscriptModel(input.model);
  const probe = input.probe;
  await mkdir(CONFIG.transcriptDir, { recursive: true });
  const transcriptId = safeId(probe.workId || probe.url);
  const outputDir = path.join(CONFIG.transcriptDir, transcriptId);
  const recordFile = transcriptPath(transcriptId);
  await mkdir(outputDir, { recursive: true });

  try {
    const cached = JSON.parse(await readFile(recordFile, "utf8")) as TranscriptRecord;
    if (cached?.segments?.length && cached.model === model) {
      log("transcript_cache_hit", { transcriptId, sourceUrl: probe.url, model });
      return { ...cached, method: "local-faster-whisper", cacheHit: true };
    }
    if (cached?.segments?.length) {
      log("transcript_cache_model_mismatch", {
        transcriptId,
        cachedModel: cached.model,
        requestedModel: model,
      });
    }
  } catch {
    // No valid cache yet.
  }

  const python = await readPythonPath();
  const script = path.join(CONFIG.projectRoot, "scripts", "transcribe_local.py");
  const metadataFile = path.join(outputDir, "source-meta.json");
  const initialPrompt = buildTranscriptInitialPrompt({
    title: probe.title,
    author: input.author,
    visibleText: probe.visibleText,
  });
  await writeFile(metadataFile, JSON.stringify({
    ...probe,
    author: input.author ?? null,
    model,
    method: "local-faster-whisper",
    initialPrompt,
  }, null, 2), "utf8");
  return withTranscriptTemporaryDirectory(transcriptId, async temporaryDirectory => {
    const mediaFile = await input.download(temporaryDirectory);
    const { stdout, stderr } = await runPython(python, [
      script,
      "--input", mediaFile,
      "--output", recordFile,
      "--transcript-id", transcriptId,
      "--work-id", probe.workId,
      "--source-url", probe.url,
      "--title", probe.title,
      "--author", input.author ?? "",
      "--model", model,
      "--model-cache", path.join(CONFIG.runtimeDir, "whisper-models"),
      "--initial-prompt", initialPrompt,
    ]);
    log("transcript_completed", { transcriptId, stdout: stdout.slice(-1000), stderr: stderr.slice(-1000) });
    const record = JSON.parse(await readFile(recordFile, "utf8")) as TranscriptRecord;
    if (!record.segments?.length) throw new Error("转写完成但没有生成有效字幕片段。");
    return { ...record, method: "local-faster-whisper", cacheHit: false };
  });
}

export async function transcribeCurrentMedia(
  page: Page,
  probe: MediaProbe,
  model = CONFIG.transcriptModel,
  author?: string | null,
): Promise<TranscriptRecord> {
  return transcribeMedia({
    probe,
    model,
    author,
    download: temporaryDirectory => downloadCurrentMedia(page, probe, temporaryDirectory),
  });
}

export async function transcribePublicLinkLocal(
  rawUrl: string,
  model = CONFIG.transcriptModel,
): Promise<TranscriptRecord> {
  const resolved = await resolvePublicDouyinVideo(rawUrl);
  const probe: MediaProbe = {
    url: resolved.canonicalUrl,
    title: resolved.title,
    workId: resolved.workId,
    durationSeconds: resolved.durationSeconds,
    currentTimeSeconds: null,
    paused: null,
    mediaCandidates: resolved.videoCandidates,
    visibleText: resolved.title,
    textSource: "iesdouyin-router-data",
    characterCount: resolved.title.length,
    truncated: false,
    chaptersAvailable: false,
    chapterCount: 0,
    galleryAvailable: false,
    galleryImageCount: 0,
  };
  return transcribeMedia({
    probe,
    model,
    author: resolved.author,
    download: temporaryDirectory => downloadPublicMedia(resolved, temporaryDirectory),
  });
}

export async function loadTranscript(transcriptId: string): Promise<TranscriptRecord> {
  const record = JSON.parse(await readFile(transcriptPath(transcriptId), "utf8")) as TranscriptRecord;
  if (!record?.segments) throw new Error(`找不到字幕 ${transcriptId}。`);
  return record;
}

export async function listTranscripts(): Promise<Array<Pick<TranscriptRecord, "transcriptId" | "workId" | "title" | "createdAt" | "durationSeconds">>> {
  await mkdir(CONFIG.transcriptDir, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(CONFIG.transcriptDir, { withFileTypes: true });
  const output: Array<Pick<TranscriptRecord, "transcriptId" | "workId" | "title" | "createdAt" | "durationSeconds">> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await loadTranscript(entry.name);
      output.push({
        transcriptId: record.transcriptId,
        workId: record.workId,
        title: record.title,
        createdAt: record.createdAt,
        durationSeconds: record.durationSeconds,
      });
    } catch {
      // Ignore incomplete jobs.
    }
  }
  return output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
