export type ProfileTabState = {
  postSelected: boolean;
  recommendSelected: boolean;
  likeSelected: boolean;
  videoSelected: boolean;
};

export function assertBoundPostTab(state: ProfileTabState): void {
  if (!state.postSelected || state.recommendSelected || state.likeSelected || !state.videoSelected) {
    throw new Error("WRONG_PROFILE_TAB:绑定主页没有稳定停留在“作品 > 作品”标签。");
  }
}

export function workLockMatches(
  lock: { workId: string; alias: string | null } | null | undefined,
  workId: string,
  alias?: string,
): boolean {
  if (!lock || lock.workId !== workId) return false;
  return alias == null || lock.alias === alias.trim().toLowerCase();
}

export function decideLikeTransition(beforeLiked: boolean, action: "like" | "unlike"): {
  targetLiked: boolean;
  changed: boolean;
} {
  const targetLiked = action === "like";
  return {
    targetLiked,
    changed: beforeLiked !== targetLiked,
  };
}

