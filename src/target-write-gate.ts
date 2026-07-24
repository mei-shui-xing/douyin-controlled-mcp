import { randomUUID } from "node:crypto";
import { assertWriteReady } from "./write-gate.js";

export type TargetWriteScope = "own_post" | "bound_user_post" | "external_post";
export type TargetWriteAction =
  | "create_root_comment"
  | "reply_to_comment"
  | "like_comment"
  | "unlike_comment"
  | "delete_comment";

export type TargetWriteGate = {
  gateId: string;
  gate_id: string;
  scope: TargetWriteScope;
  actionType: TargetWriteAction;
  action_type: TargetWriteAction;
  actorAccount: string;
  actor_account: string;
  pageRole:
    | "operator_home"
    | "creator_center"
    | "codex_test"
    | "root_comment_clean";
  page_role:
    | "operator_home"
    | "creator_center"
    | "codex_test"
    | "root_comment_clean";
  pageTargetId: string;
  targetWorkId: string;
  target_work_id: string;
  targetWorkAuthor: string;
  target_work_author: string;
  targetCommentId: string | null;
  target_comment_id: string | null;
  parentCommentId: string | null;
  parent_comment_id: string | null;
  rootCommentId: string | null;
  root_comment_id: string | null;
  targetTextHash: string | null;
  target_text_hash: string | null;
  verifiedUrl: string;
  verified_url: string;
  verifiedAt: string;
  verified_at: string;
  expiresAt: string;
  expires_at: string;
  accountVerified: true;
  account_verified: true;
  workVerified: true;
  work_verified: true;
  commentVerified: boolean;
  comment_verified: boolean;
  pageLocked: true;
  page_locked: true;
  alias: string | null;
};

const gates = new Map<string, TargetWriteGate>();

export function createTargetWriteGate(input: {
  scope: TargetWriteScope;
  actionType: TargetWriteAction;
  actorAccount: string;
  pageRole: TargetWriteGate["pageRole"];
  pageTargetId: string;
  targetWorkId: string;
  targetWorkAuthor: string;
  targetCommentId?: string | null;
  parentCommentId?: string | null;
  rootCommentId?: string | null;
  targetTextHash?: string | null;
  verifiedUrl: string;
  commentVerified: boolean;
  alias?: string | null;
  ttlMs?: number;
}): TargetWriteGate {
  assertWriteReady();
  const gateId = randomUUID();
  const verifiedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 5 * 60_000)).toISOString();
  const gate: TargetWriteGate = {
    gateId,
    gate_id: gateId,
    scope: input.scope,
    actionType: input.actionType,
    action_type: input.actionType,
    actorAccount: input.actorAccount,
    actor_account: input.actorAccount,
    pageRole: input.pageRole,
    page_role: input.pageRole,
    pageTargetId: input.pageTargetId,
    targetWorkId: input.targetWorkId,
    target_work_id: input.targetWorkId,
    targetWorkAuthor: input.targetWorkAuthor,
    target_work_author: input.targetWorkAuthor,
    targetCommentId: input.targetCommentId ?? null,
    target_comment_id: input.targetCommentId ?? null,
    parentCommentId: input.parentCommentId ?? null,
    parent_comment_id: input.parentCommentId ?? null,
    rootCommentId: input.rootCommentId ?? null,
    root_comment_id: input.rootCommentId ?? null,
    targetTextHash: input.targetTextHash ?? null,
    target_text_hash: input.targetTextHash ?? null,
    verifiedUrl: input.verifiedUrl,
    verified_url: input.verifiedUrl,
    verifiedAt,
    verified_at: verifiedAt,
    expiresAt,
    expires_at: expiresAt,
    accountVerified: true,
    account_verified: true,
    workVerified: true,
    work_verified: true,
    commentVerified: input.commentVerified,
    comment_verified: input.commentVerified,
    pageLocked: true,
    page_locked: true,
    alias: input.alias ?? null,
  };
  gates.set(gateId, gate);
  return gate;
}

export function assertTargetWriteGate(
  gate: TargetWriteGate,
  expected: {
    scope: TargetWriteScope;
    actionType: TargetWriteAction;
    workId: string;
    commentId?: string | null;
    pageRole: TargetWriteGate["pageRole"];
    pageTargetId: string;
  },
): void {
  assertWriteReady();
  if (Date.parse(gate.expiresAt) <= Date.now()) {
    throw new Error("TARGET_GATE_EXPIRED:目标写门禁已过期，必须重新 prepare。");
  }
  if (gate.scope !== expected.scope
    || gate.actionType !== expected.actionType
    || gate.targetWorkId !== expected.workId
    || gate.targetCommentId !== (expected.commentId ?? null)
    || gate.pageRole !== expected.pageRole
    || gate.pageTargetId !== expected.pageTargetId
    || !gate.accountVerified
    || !gate.workVerified
    || !gate.pageLocked
    || (gate.actionType !== "create_root_comment" && !gate.commentVerified)) {
    throw new Error("TARGET_GATE_MISMATCH:目标门禁与当前页面、作品或评论不一致。");
  }
}

export function getTargetWriteGate(gateId: string): TargetWriteGate | null {
  const gate = gates.get(gateId) ?? null;
  if (gate && Date.parse(gate.expiresAt) <= Date.now()) gates.delete(gateId);
  return gate;
}
