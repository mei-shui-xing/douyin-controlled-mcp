export type PlatformCommentTextMatch =
  | "exact"
  | "platform_normalized"
  | "server_id_only";

export function normalizePlatformCommentText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function stripFilteredTrailingEmoji(value: string): string {
  return value.replace(
    /(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200D\u20E3])+$/u,
    "",
  ).trimEnd();
}

export function classifyPlatformCommentText(
  requestText: string,
  serverDisplayText: string,
): PlatformCommentTextMatch {
  if (requestText === serverDisplayText) return "exact";
  const request = normalizePlatformCommentText(requestText);
  const server = normalizePlatformCommentText(serverDisplayText);
  if (request === server) return "platform_normalized";
  const withoutTrailingEmoji = stripFilteredTrailingEmoji(request);
  if (withoutTrailingEmoji !== request && withoutTrailingEmoji === server) {
    return "platform_normalized";
  }
  return "server_id_only";
}
