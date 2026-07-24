export type MessagePayloadKind =
  | "text"
  | "sticker"
  | "image"
  | "shared_work"
  | "comment_share"
  | "interaction_card"
  | "system_card"
  | "unknown";

export type InteractionKind =
  | "streak_invite"
  | "streak_started"
  | "pet_invite"
  | "pet_started"
  | null;

export type ImageResource = {
  imageId: string | null;
  urls: string[];
  width: number | null;
  height: number | null;
  animated: boolean;
};

export type MessagePayloadClassification = {
  aweType: number | null;
  kind: MessagePayloadKind;
  interactionKind: InteractionKind;
  interactionStatus: "pending" | "completed" | null;
  workId: string | null;
  commentId: string | null;
  image: ImageResource | null;
};

const WORK_ID_KEYS = [
  "item_id", "itemId", "aweme_id", "awemeId",
] as const;
const COMMENT_ID_KEYS = ["comment_id", "commentId", "cid"] as const;
const STRUCTURED_KEYS = [
  "parsedContent", "content", "message", "data", "raw_data", "rawData",
  "schema", "action", "extra", "props",
] as const;

function safeGet(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

export function primitiveText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

export function cleanNumericId(
  value: unknown,
  minimumLength = 8,
  maximumLength = 20,
): string | null {
  const text = primitiveText(value)?.trim() ?? "";
  const pattern = new RegExp(`^\\d{${minimumLength},${maximumLength}}$`);
  return pattern.test(text) ? text : null;
}

export function workIdFromPrimitive(value: unknown): string | null {
  const text = primitiveText(value);
  if (text == null) return null;
  return text.match(/(?:aweme[-_]?id|item[-_]?id)["'=:\\/%\s-]+(\d{16,20})/i)?.[1]
    ?? text.match(/\/(?:video|note|article|detaillist)\/(\d{16,20})/i)?.[1]
    ?? null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function extractImageResource(value: unknown): ImageResource | null {
  if (!value || typeof value !== "object") return null;
  const urlsValue = safeGet(value, "url_list");
  const urls = Array.isArray(urlsValue)
    ? urlsValue.filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item))
    : [];
  const uri = stringOrNull(safeGet(value, "uri"));
  if (!urls.length && !uri) return null;
  const imageId = uri
    ?? stringOrNull(safeGet(value, "image_id"))
    ?? stringOrNull(safeGet(value, "imageId"));
  return {
    imageId,
    urls: [...new Set(urls)].slice(0, 8),
    width: (() => {
      const width = numberOrNull(safeGet(value, "width"));
      return width != null && width > 0 ? width : null;
    })(),
    height: (() => {
      const height = numberOrNull(safeGet(value, "height"));
      return height != null && height > 0 ? height : null;
    })(),
    animated: Boolean(
      safeGet(value, "animated")
      || safeGet(value, "is_animated")
      || urls.some(url => /\.gif(?:\?|$)/i.test(url)),
    ),
  };
}

function isImageResource(value: unknown): boolean {
  return extractImageResource(value) !== null;
}

export function findWorkId(
  value: unknown,
  options: { maxDepth?: number; maxNodes?: number } = {},
): string | null {
  const maxDepth = options.maxDepth ?? 7;
  const maxNodes = options.maxNodes ?? 500;
  const seen = new WeakSet<object>();
  let visited = 0;

  // aweType 700/716 is used by sticker/text and sprite interaction payloads.
  // Its ordinary numeric fields are not work identity evidence.
  if ([700, 716].includes(aweTypeFrom(value) ?? -1)) return null;

  const visit = (current: unknown, depth: number): string | null => {
    const primitive = workIdFromPrimitive(current);
    if (primitive) return primitive;
    if (!current || typeof current !== "object" || depth > maxDepth) return null;
    if (seen.has(current) || visited >= maxNodes) return null;
    seen.add(current);
    visited += 1;
    if (isImageResource(current)) return null;

    for (const key of WORK_ID_KEYS) {
      const direct = cleanNumericId(safeGet(current, key), 16, 20);
      if (direct) return direct;
    }
    for (const key of ["href", "url"] as const) {
      const embedded = workIdFromPrimitive(safeGet(current, key));
      if (embedded) return embedded;
    }
    for (const key of STRUCTURED_KEYS) {
      const candidate = visit(safeGet(current, key), depth + 1);
      if (candidate) return candidate;
    }
    for (const key of safeKeys(current)) {
      if (key === "share_id" || key === "shareId") continue;
      if (depth > 3 && !/(content|message|parsed|data|schema|action|extra|props)/i.test(key)) {
        continue;
      }
      const candidate = visit(safeGet(current, key), depth + 1);
      if (candidate) return candidate;
    }
    return null;
  };

  return visit(value, 0);
}

export function findCommentId(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): string | null {
  if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return null;
  seen.add(value);
  for (const key of COMMENT_ID_KEYS) {
    const direct = cleanNumericId(safeGet(value, key), 8, 20);
    if (direct) return direct;
  }
  for (const key of STRUCTURED_KEYS) {
    const direct = findCommentId(safeGet(value, key), depth + 1, seen);
    if (direct) return direct;
  }
  return null;
}

function aweTypeFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const direct = safeGet(value, "aweType") ?? safeGet(value, "awe_type");
  if (typeof direct === "number" && Number.isSafeInteger(direct)) return direct;
  if (typeof direct === "string" && /^\d+$/.test(direct)) return Number(direct);
  return null;
}

function firstImageResource(value: unknown): ImageResource | null {
  if (!value || typeof value !== "object") return null;
  const direct = extractImageResource(value);
  if (direct) return direct;
  for (const key of ["url", "image", "cover_url", "cover", "content_thumb"] as const) {
    const nested = extractImageResource(safeGet(value, key));
    if (nested) return nested;
  }
  return null;
}

export function interactionFromAweType(aweType: number | null): {
  kind: InteractionKind;
  status: "pending" | "completed" | null;
} {
  switch (aweType) {
    case 110198:
      return { kind: "streak_invite", status: "pending" };
    case 110276:
      return { kind: "streak_started", status: "completed" };
    case 110182:
      return { kind: "pet_invite", status: "pending" };
    case 110279:
      return { kind: "pet_started", status: "completed" };
    default:
      return { kind: null, status: null };
  }
}

export function classifyMessagePayload(value: unknown): MessagePayloadClassification {
  const aweType = aweTypeFrom(value);
  const interaction = interactionFromAweType(aweType);
  const workId = findWorkId(value);
  const commentId = findCommentId(value);
  const image = firstImageResource(value);

  let kind: MessagePayloadKind = "unknown";
  if (aweType === 501 || (aweType === 700 && image)) kind = "sticker";
  else if (aweType === 10500) kind = "comment_share";
  else if (interaction.kind) kind = "interaction_card";
  else if (workId) kind = "shared_work";
  else if (image) kind = "image";
  else if (aweType === 701) kind = "system_card";

  return {
    aweType,
    kind,
    interactionKind: interaction.kind,
    interactionStatus: interaction.status,
    workId,
    commentId,
    image,
  };
}

export function messageMetadata(value: unknown): {
  serverId: string | null;
  senderId: string | null;
  conversationId: string | null;
  orderInConversation: string | null;
  createdAt: string | null;
  type: number | null;
} {
  if (!value || typeof value !== "object") {
    return {
      serverId: null,
      senderId: null,
      conversationId: null,
      orderInConversation: null,
      createdAt: null,
      type: null,
    };
  }
  const created = safeGet(value, "createdAt");
  const createdAt = created instanceof Date && Number.isFinite(created.getTime())
    ? created.toISOString()
    : typeof created === "string" && created.trim()
      ? created
      : typeof created === "number" && Number.isFinite(created)
        ? new Date(created > 10_000_000_000 ? created : created * 1_000).toISOString()
        : null;
  const rawType = safeGet(value, "type");
  return {
    serverId: cleanNumericId(safeGet(value, "serverId"), 8, 24),
    senderId: cleanNumericId(safeGet(value, "sender"), 1, 24),
    conversationId: primitiveText(safeGet(value, "conversationId"))?.trim() || null,
    orderInConversation: primitiveText(safeGet(value, "orderInConversation"))?.trim() || null,
    createdAt,
    type: typeof rawType === "number" && Number.isSafeInteger(rawType) ? rawType : null,
  };
}

export type RawBoundMessageCandidate = {
  domId: string | null;
  historyIndex: number | null;
  className: string;
  text: string;
  hrefs: string[];
  attributeValues: string[];
  cardDom: boolean;
  cover: boolean;
  systemCardDom: boolean;
  textDom: boolean;
  mediaKey: string;
  time: string | null;
  unread: boolean;
  nativeReferenceText: string;
  nativeReferenceMedia: boolean;
  parsedContent: unknown;
  serverId: string | null;
  senderId: string | null;
  conversationId: string | null;
  orderInConversation: string | null;
  createdAt: string | null;
  sdkType: number | null;
};

export type ParsedBoundMessage = {
  messageId: string;
  serverId: string | null;
  identitySource: "server_id" | "dom_id" | "fingerprint";
  senderId: string | null;
  conversationId: string | null;
  orderInConversation: string | null;
  createdAt: string | null;
  direction: "incoming" | "outgoing" | "unknown";
  messageType: MessagePayloadKind;
  aweType: number | null;
  mediaKind: "video" | "gallery" | "article" | "product_card" | "live_card" | "mini_game_card" | "unknown" | null;
  openable: boolean;
  availability: "available" | "unavailable" | "not_applicable";
  unavailableReason: "deleted" | "private" | "invalid" | "unavailable" | null;
  workId: string | null;
  workUrl: string | null;
  identificationSignals: Array<"aweme_id" | "href" | "card_dom" | "cover">;
  historyIndex: number | null;
  text: string;
  visual: ({ kind: "sticker" | "image" } & ImageResource) | null;
  interaction: { kind: Exclude<InteractionKind, null>; status: "pending" | "completed" } | null;
  commentShare: { commentId: string | null } | null;
  nativeReference: { previewText: string; mediaReference: boolean } | null;
  time: string | null;
  unread: boolean;
};

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hrefWork(input: RawBoundMessageCandidate): {
  workId: string | null;
  workUrl: string | null;
} {
  for (const rawHref of input.hrefs) {
    const workId = workIdFromPrimitive(rawHref);
    if (!workId) continue;
    try {
      const url = new URL(rawHref, "https://www.douyin.com");
      if (["douyin.com", "www.douyin.com"].includes(url.hostname.toLowerCase())) {
        return { workId, workUrl: url.toString() };
      }
    } catch {
      // Ignore malformed href candidates.
    }
  }
  return { workId: null, workUrl: null };
}

function mediaKindFromPayload(value: unknown, galleryDom: boolean): ParsedBoundMessage["mediaKind"] {
  let text = "";
  try {
    text = JSON.stringify(value ?? "");
  } catch {
    text = "";
  }
  if (/commodity|product|ecom|购物|商品/i.test(text)) return "product_card";
  if (/live_room|webcast|直播/i.test(text)) return "live_card";
  if (/mini_?game|microgame|小游戏/i.test(text)) return "mini_game_card";
  if (/article|图文文章|long_text/i.test(text)) return "article";
  if (galleryDom || /"awemeType"\s*:\s*68|"aweme_type"\s*:\s*68|photosTag/i.test(text)) {
    return "gallery";
  }
  return "video";
}

function fallbackText(kind: MessagePayloadKind): string {
  switch (kind) {
    case "sticker":
      return "[表情包]";
    case "image":
      return "[图片]";
    case "comment_share":
      return "[评论分享]";
    case "interaction_card":
      return "[互动卡片]";
    case "shared_work":
      return "[作品分享]";
    case "system_card":
      return "[系统消息]";
    default:
      return "[未知消息]";
  }
}

export function parseBoundMessageCandidate(
  input: RawBoundMessageCandidate,
  context: { operatorUid: string; boundUid: string },
): ParsedBoundMessage {
  const payload = classifyMessagePayload(input.parsedContent);
  const href = hrefWork(input);
  const attributeWorkId = input.attributeValues
    .map(workIdFromPrimitive)
    .find((value): value is string => Boolean(value)) ?? null;
  const excludedInteractionType = payload.aweType === 700
    || payload.aweType === 716
    || Boolean(payload.interactionKind);
  const candidateWorkId = excludedInteractionType
    ? null
    : payload.workId ?? href.workId ?? attributeWorkId;
  const unavailableReason = /(?:已删除|作品不存在|已失效|deleted)/i.test(input.text)
    ? "deleted" as const
    : /(?:私密|仅自己可见|private)/i.test(input.text)
      ? "private" as const
      : /(?:无法查看|已下架|内容不可用|unavailable)/i.test(input.text)
        ? "unavailable" as const
        : /(?:链接失效|invalid)/i.test(input.text)
          ? "invalid" as const
          : null;
  const workBacked = Boolean(
    candidateWorkId
    && !excludedInteractionType
    && (
      payload.kind === "shared_work"
      || payload.kind === "comment_share"
      || (payload.kind === "unknown" && (input.cardDom || input.cover || href.workId))
    ),
  );
  const identificationSignals: ParsedBoundMessage["identificationSignals"] = [];
  if (!excludedInteractionType && (payload.workId || attributeWorkId)) {
    identificationSignals.push("aweme_id");
  }
  if (href.workId) identificationSignals.push("href");
  if (input.cardDom) identificationSignals.push("card_dom");
  if (input.cover) identificationSignals.push("cover");
  if (!workBacked) identificationSignals.length = 0;

  let messageType = excludedInteractionType && payload.kind === "shared_work"
    ? "unknown" as MessagePayloadKind
    : payload.kind;
  if (payload.aweType === 716) messageType = "system_card";
  if (workBacked && messageType === "unknown") messageType = "shared_work";
  else if (messageType === "unknown" && input.systemCardDom) messageType = "system_card";
  else if (messageType === "unknown" && (input.textDom || input.text.trim())) messageType = "text";

  const className = input.className.toLowerCase();
  const direction = input.senderId === context.boundUid
    ? "incoming" as const
    : input.senderId === context.operatorUid
      ? "outgoing" as const
      : /isfromme|self|mine|right|outgoing/.test(className)
        ? "outgoing" as const
        : /other|left|incoming/.test(className)
          ? "incoming" as const
          : "unknown" as const;

  const workId = workBacked ? candidateWorkId : null;
  const workUrl = workBacked
    ? href.workUrl ?? (workId ? `https://www.douyin.com/video/${workId}` : null)
    : null;
  const text = input.text.replace(/\s+/g, " ").trim() || fallbackText(messageType);
  const identitySource = input.serverId
    ? "server_id" as const
    : input.domId
      ? "dom_id" as const
      : "fingerprint" as const;
  const messageId = input.serverId
    ?? input.domId
    ?? (workId
      ? `work-${workId}-${input.historyIndex ?? stableHash(input.mediaKey)}`
      : `message-${stableHash([
          direction,
          messageType,
          text,
          input.mediaKey,
          input.historyIndex ?? "",
        ].join("|"))}`);
  const visualKind = messageType === "sticker" || messageType === "image"
    ? messageType
    : null;
  const interaction = payload.interactionKind && payload.interactionStatus
    ? {
        kind: payload.interactionKind,
        status: payload.interactionStatus,
      }
    : null;

  return {
    messageId,
    serverId: input.serverId,
    identitySource,
    senderId: input.senderId,
    conversationId: input.conversationId,
    orderInConversation: input.orderInConversation,
    createdAt: input.createdAt,
    direction,
    messageType,
    aweType: payload.aweType,
    mediaKind: workBacked ? mediaKindFromPayload(input.parsedContent, false) : null,
    openable: workBacked && !unavailableReason && Boolean(workId || workUrl),
    availability: workBacked
      ? unavailableReason ? "unavailable" : "available"
      : "not_applicable",
    unavailableReason,
    workId,
    workUrl,
    identificationSignals,
    historyIndex: input.historyIndex,
    text,
    visual: visualKind && payload.image
      ? { kind: visualKind, ...payload.image }
      : null,
    interaction,
    commentShare: messageType === "comment_share"
      ? { commentId: payload.commentId }
      : null,
    nativeReference: input.nativeReferenceText
      ? {
          previewText: input.nativeReferenceText,
          mediaReference: input.nativeReferenceMedia,
        }
      : null,
    time: input.time,
    unread: input.unread,
  };
}

export function compareMessageRecency(
  left: Pick<ParsedBoundMessage, "createdAt" | "orderInConversation" | "historyIndex">,
  right: Pick<ParsedBoundMessage, "createdAt" | "orderInConversation" | "historyIndex">,
): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  try {
    if (left.orderInConversation && right.orderInConversation) {
      const leftOrder = BigInt(left.orderInConversation);
      const rightOrder = BigInt(right.orderInConversation);
      if (leftOrder !== rightOrder) return leftOrder > rightOrder ? -1 : 1;
    }
  } catch {
    // Fall back to the virtual-list index.
  }
  if (left.historyIndex == null && right.historyIndex == null) return 0;
  if (left.historyIndex == null) return 1;
  if (right.historyIndex == null) return -1;
  return left.historyIndex - right.historyIndex;
}
