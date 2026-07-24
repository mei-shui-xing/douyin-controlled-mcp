import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";

export type SafeSocialAction = {
  key: string;
  enabled: boolean;
  scope: "bound_message" | "current_page";
  alias?: string;
  label: string;
  contextContains: string;
  completedContextContains?: string;
  actionType: string;
};

const socialActionsFile = path.join(CONFIG.privateConfigDir, "douyin_social_actions.json");
const blockedLabels = /支付|购买|下单|充值|打赏|送礼|删除|清空|注销|退出登录|账号安全|修改密码|发布|上传|举报|不感兴趣|编辑资料|账号设置|复制链接|分享到|pay|purchase|buy|checkout|recharge|delete|remove account|password|security/i;

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`社交动作配置无效：${field} 不能为空。`);
  return value.trim();
}

export function loadSafeSocialActions(): Map<string, SafeSocialAction> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(socialActionsFile, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${path.basename(socialActionsFile)}：${String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("社交动作配置无效：顶层必须是对象。");
  }
  const result = new Map<string, SafeSocialAction>();
  for (const [key, value] of Object.entries(raw)) {
    const item = value as Record<string, unknown>;
    const label = requireText(item.label, `${key}.label`);
    if (blockedLabels.test(label)) {
      throw new Error(`社交动作配置拒绝危险标签：${key} -> ${label}`);
    }
    const scope = item.scope;
    if (scope !== "bound_message" && scope !== "current_page") {
      throw new Error(`社交动作配置无效：${key}.scope 只能是 bound_message 或 current_page。`);
    }
    const alias = typeof item.alias === "string" ? item.alias.trim().toLowerCase() : undefined;
    if (scope === "bound_message" && !alias) {
      throw new Error(`社交动作配置无效：${key}.alias 必填。`);
    }
    result.set(key, {
      key,
      enabled: item.enabled === true,
      scope,
      alias,
      label,
      contextContains: requireText(item.context_contains, `${key}.context_contains`),
      completedContextContains: typeof item.completed_context_contains === "string"
        ? item.completed_context_contains.trim() || undefined
        : undefined,
      actionType: requireText(item.action_type, `${key}.action_type`),
    });
  }
  return result;
}

export function getSafeSocialAction(key: string): SafeSocialAction {
  const action = loadSafeSocialActions().get(key);
  if (!action) throw new Error(`没有配置社交动作“${key}”。`);
  if (!action.enabled) throw new Error(`社交动作“${key}”当前未启用。`);
  return action;
}
