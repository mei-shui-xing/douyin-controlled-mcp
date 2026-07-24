import type { Chapter } from "./types.js";

export const WORK_CONTEXT_CHANGED_ERROR =
  "作品上下文已切换，已停止读取，避免把不同作品内容混在一起。";

export const ARTICLE_PRIVACY_ERROR =
  "未找到可信文章正文区域，已停止提取以避免读取推荐内容或私人页面信息。";

export type ArticleCandidateQuality = {
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
};

const forbiddenArticleText =
  /(?:^|\n)\s*(?:推荐视频|推荐内容|全部评论|大家都在搜)(?:\s|[:：]|$)/m;

export function isTrustedArticleCandidate(candidate: ArticleCandidateQuality): boolean {
  const text = normalizeText(candidate.text);
  const recommendationStructure =
    candidate.recommendationPlaybackCount > 0
    || (candidate.recommendationDurationCount >= 2 && /(?:推荐|点赞|获赞|作者)/.test(text));
  return candidate.headingMatched
    && candidate.sameArticleRoot
    && candidate.titlePrecedesCandidate
    && candidate.forbiddenAncestorCount === 0
    && candidate.paragraphCount >= 3
    && candidate.naturalParagraphCount >= 3
    && candidate.paragraphTextRatio >= 0.55
    && text.length >= 300
    && text.length <= 50_000
    && !forbiddenArticleText.test(text)
    && !recommendationStructure;
}

export function selectTrustedArticleCandidate<T extends ArticleCandidateQuality>(
  candidates: T[],
): T | null {
  return candidates.filter(isTrustedArticleCandidate)
    .sort((a, b) =>
      b.naturalParagraphCount - a.naturalParagraphCount
      || b.paragraphTextRatio - a.paragraphTextRatio
      || b.depth - a.depth
      || a.text.length - b.text.length)[0] ?? null;
}

export function workIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get("modal_id")
      ?? url.searchParams.get("aweme_id")
      ?? url.pathname.match(/\/(?:video|note|article)\/(\d+)/)?.[1]
      ?? null;
  } catch {
    return null;
  }
}

export function assertWorkId(expectedWorkId: string, rawUrl: string): void {
  if (workIdFromUrl(rawUrl) !== expectedWorkId) {
    throw new Error(WORK_CONTEXT_CHANGED_ERROR);
  }
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const privateUiLinePatterns = [
  /^(?:通知|消息|私信|群聊|账号设置|设置|退出登录|用户菜单|个人资料|钱包|充值|投稿)$/,
  /^(?:推荐视频|热门搜索|大家都在搜|全部评论|评论区)(?:\s|$)/,
  /^(?:京ICP备|京公网安备|广播电视节目制作经营许可证)/,
  /^(?:精选|推荐|AI抖音|关注|朋友|我的|直播|放映厅|短剧|小游戏)(?:\s|$)/,
];

export function filterPrivateUiText(rawText: string, maxChars: number): {
  text: string;
  characterCount: number;
  truncated: boolean;
} {
  const source = normalizeText(rawText);
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const rawLine of source.split(/\n+/)) {
    const line = normalizeText(rawLine);
    if (!line || privateUiLinePatterns.some(pattern => pattern.test(line))) continue;
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    filtered.push(line);
  }
  const joined = filtered.join("\n");
  const limit = Math.max(200, maxChars);
  const text = joined.slice(0, limit);
  return {
    text,
    characterCount: text.length,
    truncated: joined.length > text.length,
  };
}

export function parseDouyinMetaDescription(description: string): {
  author: string | null;
  publishedAt: string | null;
} {
  const cleaned = normalizeText(description);
  const match = cleaned.match(/-\s*(.+?)于(\d{4})(\d{2})(\d{2})发布在抖音/);
  if (!match) return { author: null, publishedAt: null };
  return {
    author: normalizeText(match[1]),
    publishedAt: `${match[2]}-${match[3]}-${match[4]}`,
  };
}

export function timestampToSeconds(timestamp: string): number {
  const values = timestamp.split(":").map(value => Number(value));
  if (values.some(value => !Number.isFinite(value))) return 0;
  if (values.length === 3) return values[0] * 3600 + values[1] * 60 + values[2];
  return (values[0] ?? 0) * 60 + (values[1] ?? 0);
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function parseNativeChapters(rawText: string): { summary: string; chapters: Chapter[] } {
  const normalized = normalizeText(rawText);
  const markerIndex = normalized.indexOf("章节要点");
  if (markerIndex < 0) return { summary: "", chapters: [] };
  const section = normalized.slice(markerIndex + "章节要点".length)
    .replace(/内容由AI生成[\s\S]*$/i, "")
    .trim();
  const lines = section.split(/\n+/).map(normalizeText).filter(Boolean);
  const timestampLine = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
  const starts = lines.map((line, index) => ({ index, match: line.match(timestampLine) }))
    .filter((item): item is { index: number; match: RegExpMatchArray } => Boolean(item.match));
  if (starts.length >= 2) {
    const summary = normalizeText(lines.slice(0, starts[0].index).join(" "));
    const chapters = starts.map((start, position) => {
      const end = starts[position + 1]?.index ?? lines.length;
      const body = [start.match[2], ...lines.slice(start.index + 1, end)]
        .map(normalizeText)
        .filter(Boolean);
      const title = body.shift() ?? "";
      return {
        timestamp: start.match[1],
        seconds: timestampToSeconds(start.match[1]),
        title,
        summary: normalizeText(body.join(" ")),
      };
    }).filter(chapter => chapter.title.length > 0);
    return { summary, chapters };
  }

  const compactMatches = [...section.matchAll(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]*?)(?=(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s+)|$)/g)];
  if (compactMatches.length < 2) return { summary: section, chapters: [] };
  const firstTimestampIndex = section.indexOf(compactMatches[0][1]);
  const summary = normalizeText(section.slice(0, firstTimestampIndex));
  const chapters = compactMatches.map(match => {
    const words = normalizeText(match[2]).split(/\s+/);
    const title = words.shift() ?? "";
    return {
      timestamp: match[1],
      seconds: timestampToSeconds(match[1]),
      title,
      summary: normalizeText(words.join(" ")),
    };
  }).filter(chapter => chapter.title.length > 0);
  return { summary, chapters };
}

export function timelineSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const ratios = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 0.98];
  const maximum = Math.max(0, duration - Math.min(0.15, duration / 20));
  const values = ratios.map(ratio => Math.min(maximum, Math.max(0, duration * ratio)));
  if (duration < 15) values[values.length - 1] = Math.max(0, duration - 1);
  return [...new Set(values.map(value => Number(value.toFixed(3))))];
}
