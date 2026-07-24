export type ManualActionRisk = "interface" | "account" | "high_risk" | "unknown";

export type ManualTarget = {
  label: string;
  role: string;
  kind: "link" | "button" | "tab" | "video" | "input" | "other";
  href: string | null;
  pageUrl: string;
  contextText?: string;
};

export type ManualActionDecision = {
  risk: ManualActionRisk;
  requiresTransaction: boolean;
  requiresDedicatedWorkflow: boolean;
  reason: string;
};

export type ManualNetworkSignal = "read" | "background" | "mutation";

const MUTATING_ENDPOINT = /publish|upload|commit|create|delete|remove|comment|reply|message|send|follow|relation|favorite|collect|like|digg|draft|save|update|modify|schedule|post\/image|cover\/set|music\/select|permission\/set/i;
const BACKGROUND_ENDPOINT = /log|monitor|metric|event|track|report|config|setting|bootstrap|query|list|status|preload|recommend|notice|heartbeat|feature|experiment|abtest|permission\/get|auth\/status|account\/info|creator\/profile|user\/info/i;

export function classifyManualNetworkSignal(input: {
  method: string;
  url: string;
}): ManualNetworkSignal {
  const method = input.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return "read";
  if (MUTATING_ENDPOINT.test(input.url)) return "mutation";
  if (BACKGROUND_ENDPOINT.test(input.url)) return "background";
  return "mutation";
}

export type ManualEffectEvidence = {
  requestSignalCount: number;
  responseSignalCount: number;
  toastCount: number;
  urlChanged: boolean;
  domChanged: boolean;
  composerCleared: boolean;
  loadingTransition: boolean;
  disabledTransition: boolean;
  targetStillPresent: boolean;
};

const HIGH_RISK = /支付|付款|购买|下单|充值|打赏|送礼|发布作品|立即发布|删除|清空|注销|退出登录|账号安全|修改密码|实名|银行卡|pay|purchase|checkout|recharge|delete account|password/i;
const ACCOUNT_ACTION = /发送|提交|确认|接受邀请|点亮|合养|点赞|取消点赞|关注|取消关注|收藏|评论|回复|私信|发布|上传|选择音乐|移除音乐|举报|不感兴趣/i;
const INTERFACE_ACTION = /打开|关闭|返回|展开|收起|上一页|下一页|下一步|继续|跳过|切换|播放|暂停|取消|知道了|详情|更多|管理|中心|入口|菜单/i;
const CREATOR_INTERFACE_TRIGGER = /高清发布|发布方式|发布类型|创作入口|上传入口|发布视频|发布图文|发布全景视频|发布文章/i;

export function classifyManualTarget(target: ManualTarget): ManualActionDecision {
  const text = `${target.label} ${target.role} ${target.contextText ?? ""}`.trim();
  if (HIGH_RISK.test(text)) {
    return {
      risk: "high_risk",
      requiresTransaction: true,
      requiresDedicatedWorkflow: true,
      reason: "目标可能产生不可逆、高价值或账号安全相关操作。",
    };
  }
  const isCreatorInterfaceTrigger = target.kind === "button"
    && /creator\.douyin\.com\/creator-micro\//i.test(target.pageUrl)
    && CREATOR_INTERFACE_TRIGGER.test(text);
  if (isCreatorInterfaceTrigger) {
    return {
      risk: "interface",
      requiresTransaction: false,
      requiresDedicatedWorkflow: false,
      reason: "目标是创作者中心的发布入口或发布类型菜单触发器，不会直接提交作品。",
    };
  }
  if (ACCOUNT_ACTION.test(text)) {
    return {
      risk: "account",
      requiresTransaction: true,
      requiresDedicatedWorkflow: false,
      reason: "目标可能改变账号、会话、作品或草稿状态。",
    };
  }
  if (target.kind === "link" && target.href) {
    return {
      risk: "interface",
      requiresTransaction: false,
      requiresDedicatedWorkflow: false,
      reason: "目标是带明确地址的导航链接。",
    };
  }
  if (target.kind === "tab" || target.kind === "video" || INTERFACE_ACTION.test(text)) {
    return {
      risk: "interface",
      requiresTransaction: false,
      requiresDedicatedWorkflow: false,
      reason: "目标属于可逆的本地界面或媒体控制。",
    };
  }
  return {
    risk: "unknown",
    requiresTransaction: true,
    requiresDedicatedWorkflow: false,
    reason: "无法仅凭现场语义证明目标是纯界面操作。",
  };
}

export function pointInsideBox(input: {
  box: { x: number; y: number; width: number; height: number };
  offsetX?: number;
  offsetY?: number;
}): { x: number; y: number; offsetX: number; offsetY: number } {
  const offsetX = Math.min(0.95, Math.max(0.05, input.offsetX ?? 0.5));
  const offsetY = Math.min(0.95, Math.max(0.05, input.offsetY ?? 0.5));
  return {
    x: input.box.x + input.box.width * offsetX,
    y: input.box.y + input.box.height * offsetY,
    offsetX,
    offsetY,
  };
}

export function decideManualRetry(evidence: ManualEffectEvidence): {
  effect: "no_effect" | "possible_side_effect" | "state_changed" | "unknown";
  retryAllowed: boolean;
  reason: string;
} {
  const possibleSideEffect = evidence.requestSignalCount > 0
    || evidence.responseSignalCount > 0
    || evidence.toastCount > 0
    || evidence.composerCleared
    || evidence.loadingTransition
    || evidence.disabledTransition;
  if (possibleSideEffect) {
    return {
      effect: "possible_side_effect",
      retryAllowed: false,
      reason: "已经出现可能提交或写入的效果证据，只能停止并只读回查。",
    };
  }
  if (evidence.urlChanged || evidence.domChanged) {
    return {
      effect: "state_changed",
      retryAllowed: false,
      reason: "页面或界面状态已经变化，不应重复点击。",
    };
  }
  if (evidence.targetStillPresent) {
    return {
      effect: "no_effect",
      retryAllowed: true,
      reason: "没有发现副作用或状态变化，可在同一冻结目标内调整一次落点。",
    };
  }
  return {
    effect: "unknown",
    retryAllowed: false,
    reason: "目标消失但没有可验证结果，不能推断为未点击。",
  };
}

export type ManualPointElement = ManualTarget & {
  tag: string;
  box: { x: number; y: number; width: number; height: number };
  dataE2e: string | null;
  className: string;
  interactionSource?: "semantic" | "music_candidate_ancestor";
};

export type ManualPointInspection = {
  point: { x: number; y: number; xRatio: number; yRatio: number };
  target: ManualPointElement | null;
  stack: Array<{
    tag: string;
    role: string;
    label: string;
    dataE2e: string | null;
    pointerEvents: string;
  }>;
};
