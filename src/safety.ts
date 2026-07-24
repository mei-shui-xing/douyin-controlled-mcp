import type { InteractiveElement } from "./types.js";
import { CONFIG } from "./config.js";

const forbiddenPathFragments = [
  "/im",
  "/message",
  "/wallet",
  "/pay",
  "/payment",
  "/order",
  "/shopping",
  "/shop",
  "/mall",
  "/creator-micro",
  "/creator",
  "/upload",
  "/live",
  "/recharge",
];

const forbiddenWriteWords = [
  "点赞",
  "取消点赞",
  "关注",
  "取消关注",
  "发表评论",
  "发布评论",
  "发送评论",
  "回复",
  "私信",
  "发消息",
  "发布作品",
  "上传",
  "购物",
  "购买",
  "下单",
  "支付",
  "充值",
  "打赏",
  "送礼",
  "编辑资料",
  "账号设置",
  "删除",
  "编辑",
  "修改历史名称",
  "删除历史记录",
  "退出登录",
  "举报",
  "不感兴趣",
];

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function assertAllowedUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (process.env.DOUYIN_TEST_MODE === "1") return url;
  const normalized = normalizeHost(url.hostname);
  if (!CONFIG.allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`安全拦截：当前页面不属于允许域名（${url.hostname}）。`);
  }
  const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
  if (normalized === "douyin.com" && forbiddenPathFragments.some(fragment => pathAndQuery.includes(fragment))) {
    throw new Error("安全拦截：当前页面属于私信、钱包、订单、购物、直播或发布等禁区。");
  }
  return url;
}

export function assertDouyinWorkUrl(rawUrl: string): URL {
  const url = assertAllowedUrl(rawUrl);
  const host = normalizeHost(url.hostname);
  if (host !== "douyin.com") {
    throw new Error("只允许使用 douyin.com 或 www.douyin.com 的作品链接。");
  }
  return url;
}

export function assertDouyinPublishPage(rawUrl: string): URL {
  const url = assertAllowedUrl(rawUrl);
  if (process.env.DOUYIN_TEST_MODE === "1") return url;
  if (url.hostname.toLowerCase() !== "creator.douyin.com"
    || !url.pathname.startsWith("/creator-micro/content/")) {
    throw new Error("当前页面不是受控的抖音创作者内容发布页。");
  }
  return url;
}

export function assertCreatorCommentManagerPage(rawUrl: string): URL {
  const url = assertAllowedUrl(rawUrl);
  if (process.env.DOUYIN_TEST_MODE === "1") return url;
  if (url.hostname.toLowerCase() !== "creator.douyin.com"
    || ![
      "/creator-micro/interactive/comment",
      "/creator-micro/data/following/comment",
    ].includes(url.pathname)) {
    throw new Error("当前页面不是受控的抖音创作者中心评论管理页。");
  }
  return url;
}

function isProfileCollectionTab(element: InteractiveElement): boolean {
  const text = element.label.trim();
  if (!element.href) return false;
  const href = element.href.toLowerCase();
  return (text === "喜欢" || text === "收藏" || text === "作品") && href.includes("/user/");
}

export function assertSafeElement(element: InteractiveElement, currentUrl?: string): void {
  if (element.kind === "input") {
    throw new Error("安全拦截：请使用专门的输入工具，而不是直接点击输入框。");
  }

  if (element.href) assertAllowedUrl(element.href);
  if (isProfileCollectionTab(element)) return;

  const text = `${element.label} ${element.role}`.trim();
  if (forbiddenWriteWords.some(word => text.includes(word))) {
    throw new Error(`安全拦截：目标“${element.label || element.id}”可能产生账号写操作。`);
  }

  if (element.label.trim() === "收藏") {
    throw new Error("安全拦截：这个“收藏”更像作品操作按钮，不是收藏列表页签。");
  }

  if (/^(发送|提交|确定|确认)$/.test(element.label.trim())) {
    throw new Error("安全拦截：不能通过通用点击工具执行提交或确认操作。");
  }

  // Generic browser control is navigation-only. Account-affecting controls
  // must use a typed tool with its own target gate and durable operation.
  if (element.kind === "link" && element.href) return;
  if (element.kind === "tab") return;
  if (element.kind === "video") return;

  const safeLocalControls = new Set([
    "播放",
    "暂停",
    "展开",
    "收起",
    "返回",
    "上一页",
    "下一页",
    "关闭",
    "取消",
    "知道了",
  ]);
  if (element.kind === "button" && safeLocalControls.has(element.label.trim())) return;

  throw new Error(
    `GENERIC_CLICK_NOT_NAVIGATION:目标“${element.label || element.id}”不是明确的只读导航控件；请使用对应专用工具。`,
  );
}

export function describeSafety(): string {
  return [
    "只允许 douyin.com、www.douyin.com 和 creator.douyin.com。",
    "允许查看页面、打开作品、读取原生章节、完整时间轴抽帧、智能滚动、播放/暂停、提取可信文章正文，以及仅使用本机 faster-whisper 的本地转写。",
    "标签页工具只列出和切换 douyin.com、www.douyin.com 和 creator.douyin.com，不暴露其他私人网站。",
    "通用点击和通用输入仍禁止点赞、收藏、关注、评论、私信、发布、购物、付款、退出登录、删除历史、修改账号或编辑资料。",
    "专用动作工具只允许当前作品点赞/收藏、当前作者关注，以及对本地稳定 uid/sec_uid 绑定用户的单人分享和私信；每次都会校验 Operator 登录态、限流并写本地审计日志。",
    "文章发布只使用持久绑定的 publisher 与 operator_home 页面：preview 通过预检后锁定快照，最终发布还要求 action=publish、confirm_publish=true 和未改变的 preview_id；点击按钮不等于发布成功。",
    "评论写入统一经过 global gate、目标作用域 gate、SQLite prepare/commit 与发送后回读；任何 unknown_after_submit 只读恢复、绝不自动重发。",
    "通用浏览进入私信、钱包、订单、购物、直播、创作者或上传页面时仍会自动拦截；creator.douyin.com 只由专用发布及评论管理工具访问。",
  ].join(" ");
}
