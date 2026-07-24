export type RootCommentSubmitClassification =
  | "confirmed"
  | "click_no_effect"
  | "possible_submit"
  | "unknown_after_submit"
  | "login_expired"
  | "risk_controlled"
  | "desktop_web_root_comment_restricted";

export type SanitizedRootCommentResponse = {
  endpoint: string;
  httpStatus: number;
  code: string | number | null;
  message: string | null;
  commentId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function scalar(
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): string | number | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
  }
  return null;
}

export function sanitizeRootCommentResponse(input: {
  endpoint: string;
  httpStatus: number;
  body: unknown;
}): SanitizedRootCommentResponse {
  const root = asRecord(input.body);
  const data = asRecord(root?.data);
  const comment = asRecord(root?.comment) ?? asRecord(data?.comment);
  const code = scalar(
    [root, data],
    ["status_code", "statusCode", "code", "err_no", "errno"],
  );
  const message = scalar(
    [root, data],
    ["status_msg", "statusMessage", "message", "msg", "description"],
  );
  const commentId = scalar(
    [comment, data, root],
    ["cid", "comment_id", "commentId", "id_str", "id"],
  );
  return {
    endpoint: input.endpoint,
    httpStatus: input.httpStatus,
    code,
    message: message == null ? null : String(message).slice(0, 300),
    commentId: commentId == null || !/^\d{8,}$/.test(String(commentId))
      ? null
      : String(commentId),
  };
}

export function isRootCommentSubmitEndpoint(
  urlValue: string,
  method: string,
): string | null {
  try {
    const url = new URL(urlValue);
    if (method.toUpperCase() !== "POST") return null;
    if (!/comment/iu.test(url.pathname)) return null;
    if (!/publish|create|commit|comment/iu.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

export function classifyRootCommentSubmit(input: {
  responses: SanitizedRootCommentResponse[];
  requestSeen: boolean;
  composerCleared: boolean;
  composerTextReadable: boolean;
  composerTextMatched: boolean;
  optimisticDomMatch: boolean;
}): RootCommentSubmitClassification {
  const messages = input.responses
    .map(response => response.message ?? "")
    .join(" ");
  if (input.responses.some(response =>
    response.httpStatus === 401
    || response.httpStatus === 419
    || /(?:login|passport|session).*(?:expired|invalid)|登录.*(?:失效|过期)|请.*登录/iu
      .test(response.message ?? ""))) {
    return "login_expired";
  }
  if (/captcha|risk|verify|security|frequen|风控|验证码|安全验证|操作频繁|异常行为/iu
    .test(messages)) {
    return "risk_controlled";
  }
  if (/desktop|web.*(?:unsupported|restricted)|网页版.*(?:暂不支持|禁止|受限)|桌面端.*(?:暂不支持|禁止|受限)|无评论权限|禁止评论/iu
    .test(messages)) {
    return "desktop_web_root_comment_restricted";
  }
  if (input.responses.some(response => response.commentId)
    || input.requestSeen
    || input.responses.length > 0
    || input.composerCleared
    || input.optimisticDomMatch) {
    return "possible_submit";
  }
  if (input.composerTextReadable && input.composerTextMatched) {
    return "click_no_effect";
  }
  return "unknown_after_submit";
}
