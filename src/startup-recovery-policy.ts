import type { WriteGateMode } from "./write-gate.js";

export type StartupBindingDecision =
  | "persisted_target"
  | "unique_candidate"
  | "open_new"
  | "binding_conflict";

export function decideStartupBinding(
  persistedTargetVerified: boolean,
  candidateCount: number,
): StartupBindingDecision {
  if (persistedTargetVerified) return "persisted_target";
  if (candidateCount === 0) return "open_new";
  if (candidateCount === 1) return "unique_candidate";
  return "binding_conflict";
}

export function startupFailureMode(blockedReasons: string[]): WriteGateMode {
  if (blockedReasons.some(reason => reason.includes("PAGE_BINDING_CONFLICT"))) {
    return "binding_conflict";
  }
  if (blockedReasons.some(reason =>
    /WRONG_ACCOUNT|LOGIN_REQUIRED|账号校验失败/.test(reason))) {
    return "account_mismatch";
  }
  return blockedReasons.length > 0 ? "degraded" : "write_ready";
}
