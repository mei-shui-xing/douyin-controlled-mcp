export type CommentDecision = {
  mode: "preview" | "send";
  shouldSend: boolean;
  duplicate: boolean;
  errorCode: "CONFIRMATION_REQUIRED" | "DUPLICATE_COMMENT" | null;
};

export function decideCommentAction(input: {
  action?: "preview" | "send";
  confirmSend?: boolean;
  text: string;
  existingTexts: string[];
}): CommentDecision {
  const text = input.text.trim();
  if (!text || text.length > 500) throw new Error("评论必须是 1-500 个字符。");
  const duplicate = input.existingTexts.some(existing => existing.trim() === text);
  if ((input.action ?? "preview") !== "send") {
    return { mode: "preview", shouldSend: false, duplicate, errorCode: null };
  }
  if (input.confirmSend !== true) {
    return { mode: "send", shouldSend: false, duplicate, errorCode: "CONFIRMATION_REQUIRED" };
  }
  if (duplicate) {
    return { mode: "send", shouldSend: false, duplicate: true, errorCode: "DUPLICATE_COMMENT" };
  }
  return { mode: "send", shouldSend: true, duplicate: false, errorCode: null };
}
